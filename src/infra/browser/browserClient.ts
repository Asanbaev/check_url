import puppeteer, { Browser, Page } from "puppeteer";
import { MonitorTarget, targetDisplayLabel } from "../../config/targets";
import { ResourceStatus } from "../db/resourceStatusLog.model";
import { logger } from "../logging/logger";

export interface RuntimeTarget extends MonitorTarget {
  page?: Page;
  lastRequestedTimeBeforeUpdate?: string;
  /** Московское время последней строки ResourceStatusLog по этому таргету */
  lastStatusDbLoggedAt?: string;
  /** Последний статус, который реально был записан в ResourceStatusLog */
  lastStatusDbLoggedStatus?: ResourceStatus;
  /** Простая state-machine доступности, чтобы не слать противоречивые алерты подряд */
  availabilityState?: "up" | "down";
  /** Антидребезг: последний отправленный в Telegram доменный статус по таргету */
  lastAlertResourceStatus?: ResourceStatus;
  /** Пер-таргет интервал отправки (чтобы один таргет не глушил другой) */
  lastUserNotifyAt?: string;
  /** VGIK: страница на паузе из‑за Cloudflare / проверки человека — без reload до прохождения */
  vgikCfChallengePaused?: boolean;
  /** VGIK: одноразовое уведомление о паузе по Cloudflare на инцидент */
  vgikCfChallengeNotifySent?: boolean;
  /** Cookie-строка для priemvgik.timepad.ru (обновляется общей процедурой sync). */
  priemvgikCookieHeader?: string;
  /** VGIK HTML-submit: не раньше этого времени (ms) следующая попытка */
  nextVgikSubmitAtMs?: number;
  /** Таргет добавлен из persisted VGIK state file. */
  vgikDynamic?: boolean;
  /** Уже выполнено первичное заполнение анкеты Timepad */
  vgikRegistrationFilled?: boolean;
  /** Уже зафиксирована «закрытая регистрация» (чтобы не слать повторно) */
  vgikDynamicClosedHandled?: boolean;
  /** Мастерская, вычисленная по содержимому страницы/виджета. */
  vgikWorkshop?: "merzlikin" | "fyodorov";
  /** Этот target зарезервирован как единственная submit-страница своей мастерской. */
  vgikSubmitReserved?: boolean;
  /** Target выведен из обычной ротации и живёт только своим submit/fill state. */
  vgikSubmitOnly?: boolean;
  /** Подряд идущие navigation timeout для решения, когда сохранять debug snapshot. */
  navigationTimeoutStreak?: number;
}

export class BrowserClient {
  private browser?: Browser;
  private browserConnectOptionsLogged = false;

  private resolveBrowserConnectOptions(): { browserURL: string; protocolTimeout: number } {
    const kindRaw = (process.env.BROWSER_KIND ?? "chrome").trim().toLowerCase();
    const browserKind =
      kindRaw === "firefox" || kindRaw === "chrome" || kindRaw === "opera" ? kindRaw : "chrome";

    if (browserKind !== kindRaw) {
      logger.info("Warning: unknown BROWSER_KIND value, fallback to chrome", { provided: kindRaw });
    }

    const fallbackUrl =
      browserKind === "firefox"
        ? "http://127.0.0.1:9223"
        : browserKind === "opera"
          ? "http://127.0.0.1:9224"
          : "http://127.0.0.1:9222";
    const connectOptions = {
      browserURL: process.env.BROWSER_URL ?? fallbackUrl,
      protocolTimeout: Number(process.env.BROWSER_PROTOCOL_TIMEOUT_MS ?? "180000")
    };

    if (!this.browserConnectOptionsLogged) {
      this.browserConnectOptionsLogged = true;
      logger.info("Browser connect options resolved", {
        browserKind,
        browserURL: connectOptions.browserURL,
        protocolTimeout: connectOptions.protocolTimeout
      });
    }

    return connectOptions;
  }

  private normalizeMatchKey(url: string): string {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`.replace(/\/+$/, "");
    } catch {
      return url.replace(/\/+$/, "");
    }
  }

  private pageMatchesTarget(pageUrl: string, targetUrl: string): boolean {
    if (pageUrl.includes(targetUrl)) {
      return true;
    }
    return this.normalizeMatchKey(pageUrl) === this.normalizeMatchKey(targetUrl);
  }

  // Безопасно читаем URL вкладки: некоторые вкладки сразу после connect ещё без main frame.
  private safeGetPageUrl(page: Page): string {
    try {
      const targetUrl = page.target().url();
      if (targetUrl) {
        return targetUrl;
      }
    } catch {
      // ignore and fallback below
    }
    try {
      return page.url();
    } catch (error) {
      logger.info("Skip tab URL read: main frame not ready yet", { error: String(error) });
      return "";
    }
  }

  private isNetworkEnableTimeout(error: unknown): boolean {
    return String(error).includes("Network.enable timed out");
  }

  private async reconnect(): Promise<void> {
    try {
      await this.browser?.disconnect();
    } catch {
      // ignore reconnect cleanup errors
    }
    this.browser = await puppeteer.connect(this.resolveBrowserConnectOptions());
  }

  async connect(): Promise<void> {
    const attempts = Math.max(1, Number(process.env.BROWSER_CONNECT_RETRIES ?? "3"));
    let lastError: unknown;
    for (let i = 1; i <= attempts; i += 1) {
      try {
        this.browser = await puppeteer.connect(this.resolveBrowserConnectOptions());
        return;
      } catch (error) {
        lastError = error;
        logger.error("Browser connect failed", { attempt: i, attempts, error: String(error) });
        if (i < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async bindPages(targets: RuntimeTarget[]): Promise<void> {
    if (!this.browser) {
      throw new Error("Browser is not connected");
    }
    let pages: Page[] = [];
    try {
      pages = await this.browser.pages();
    } catch (error) {
      if (!this.isNetworkEnableTimeout(error)) {
        throw error;
      }
      logger.error("browser.pages failed with Network.enable timeout, reconnecting", {
        error: String(error)
      });
      await this.reconnect();
      if (!this.browser) {
        throw new Error("Browser reconnect failed");
      }
      pages = await this.browser.pages();
    }

    for (const target of targets) {
      for (const page of pages) {
        const pageUrl = this.safeGetPageUrl(page);
        if (!pageUrl) {
          // Пропускаем вкладки, которые ещё не инициализировались после attach.
          continue;
        }
        const matched = this.pageMatchesTarget(pageUrl, target.url);
        if (matched) {
          target.page = page;
          break;
        }
      }
      if (!target.page) {
        try {
          target.page = await this.browser.newPage();
        } catch (error) {
          if (!this.isNetworkEnableTimeout(error)) {
            throw error;
          }
          logger.error("newPage failed with Network.enable timeout, reconnecting", {
            target: targetDisplayLabel(target),
            error: String(error)
          });
          await this.reconnect();
          if (!this.browser) {
            throw new Error("Browser reconnect failed");
          }
          target.page = await this.browser.newPage();
        }
        try {
          await target.page.goto(target.url, {
            waitUntil: "networkidle2",
            timeout: Number(process.env.BROWSER_PAGE_GOTO_TIMEOUT_MS ?? "20000")
          });
          logger.info("Initial page navigated", { target: targetDisplayLabel(target), action: "goto", url: target.url });
        } catch (error) {
          logger.error("Initial goto failed", {
            target: targetDisplayLabel(target),
            url: target.url,
            error: String(error)
          });
        }
      }
    }
  }

  async rebindGitisTargetPage(target: RuntimeTarget): Promise<boolean> {
    if (target.theaterId !== "GITIS") {
      return false;
    }
    return this.rebindTargetPage(target);
  }

  async rebindTargetPage(target: RuntimeTarget): Promise<boolean> {
    if (!this.browser) {
      return false;
    }
    let pages: Page[] = [];
    try {
      pages = await this.browser.pages();
    } catch (error) {
      if (!this.isNetworkEnableTimeout(error)) {
        logger.error("rebindTargetPage: browser.pages failed", {
          target: targetDisplayLabel(target),
          error: String(error)
        });
        return false;
      }
      logger.error("rebindTargetPage: Network.enable timeout, reconnecting", {
        target: targetDisplayLabel(target),
        error: String(error)
      });
      await this.reconnect();
      if (!this.browser) {
        return false;
      }
      pages = await this.browser.pages();
    }

    for (const page of pages) {
      const pageUrl = this.safeGetPageUrl(page);
      if (!pageUrl) {
        // На ребинде тоже не падаем из-за "Requesting main frame too early".
        continue;
      }
      const matched = this.pageMatchesTarget(pageUrl, target.url);
      if (matched) {
        target.page = page;
        return true;
      }
    }
    return false;
  }

  async closeTargetPage(target: RuntimeTarget): Promise<boolean> {
    const page = target.page;
    if (!page) {
      return false;
    }
    try {
      await page.close({ runBeforeUnload: false });
      target.page = undefined;
      return true;
    } catch (error) {
      logger.error("closeTargetPage failed", {
        target: targetDisplayLabel(target),
        url: target.url,
        error: String(error)
      });
      return false;
    }
  }
}
