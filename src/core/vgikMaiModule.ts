import axios from "axios";
import { Browser, Page } from "puppeteer";
import { saveHtmlSnapshot } from "../infra/logging/outputHtmlLogger";
import { logger } from "../infra/logging/logger";
import { getVgikMode4Step1Payload } from "./vgikMode4Payloads";

/** Страница факультета, где в таблице появляются май и ссылки на Timepad */
export const VGIK_MAI_FACULTY_PAGE_URL = "https://vgik.info/abiturient/higher/spetsialitet/aktyerskiy-fakultet/";
const VGIK_SUBMIT_RETRY_MS = Number(
  process.env.VGIK_SUBMIT_RETRY_MS ?? process.env.VGIK_MODE3_POLL_MS ?? "20000"
);
const VGIK_MODE4_KEY_PHRASES = (process.env.VGIK_MODE4_KEY_PHRASES ?? "мест нет|ошибка|больше не осталось")
  .split("|")
  .map((phrase) => phrase.replace(/\s+/g, " ").trim().toLowerCase())
  .filter(Boolean);
const vgikMode4LoopState = new Map<string, { lastCombinedResponse: string | null; active: boolean }>();

function normalizeUrlPath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "";
    return `${u.origin}${path}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

export function isVgikMaiFacultyPage(pageUrl: string): boolean {
  return normalizeUrlPath(pageUrl) === normalizeUrlPath(VGIK_MAI_FACULTY_PAGE_URL);
}

/** Маркер страницы проверки Cloudflare (Timepad / см. сохранённые HTML). */
// здесь надо проверять подтвердите что вы человек, но текст надо точно скопировать 
const VGIK_CLOUDFLARE_HTML_MARKER = "использует сервис безопасности для защиты";

const VGIK_CLOUDFLARE_VERIFYING_MARKER = "выполнение проверки безопасности";

export function pageLooksLikeVgikCloudflareChallenge(html: string): boolean {
  const collapsed = html.replace(/\s+/g, " ").toLowerCase();
  return collapsed.includes(VGIK_CLOUDFLARE_HTML_MARKER);
}

/**
 * Промежуточный этап Cloudflare: страница ещё проверяет посетителя перед пропуском дальше.
 */
export function pageShowsVgikCloudflareVerifying(html: string): boolean {
  const collapsed = html.replace(/\s+/g, " ").toLowerCase();
  return collapsed.includes(VGIK_CLOUDFLARE_VERIFYING_MARKER);
}

/**
 * Ищет в HTML ссылки priemvgik.timepad.ru/event/{id}/ с id строго больше exclusiveFloor
 * (верхняя граница уже известных номеров из VGIK_MAI_MAX_TIMEPAD_EVENT_ID),
 * возвращает URL события с максимальным id (самый «новый» номер на странице).
 */
export function collectNewTimepadEventUrls(html: string, exclusiveFloor: number): string[] {
  const re = /https:\/\/priemvgik\.timepad\.ru\/event\/(\d+)\/?/gi;
  const ids = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = Number.parseInt(m[1], 10);
    if (Number.isFinite(id) && id > exclusiveFloor) {
      ids.add(id);
    }
  }
  return [...ids]
    .sort((a, b) => b - a)
    .map((id) => `https://priemvgik.timepad.ru/event/${id}/`);
}

export function pickBestNewTimepadEventUrl(html: string, exclusiveFloor: number): string | null {
  const urls = collectNewTimepadEventUrls(html, exclusiveFloor);
  return urls.length > 0 ? urls[0] : null;
}

function encodeFormData(payload: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    p.set(k, v);
  }
  return p.toString();
}

function normalizeMode4ResponseText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

async function buildCookieHeader(page: Page): Promise<string> {
  const cookies = await page.cookies("https://priemvgik.timepad.ru/");
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function buildMode4Headers(page: Page, payload: Record<string, string>): Promise<Record<string, string>> {
  const cookie = await buildCookieHeader(page);
  const referer = payload.referer || payload["stat_metadata[widget_consumer_url]"] || page.url() || "https://priemvgik.timepad.ru/";
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "Mozilla/5.0");
  return {
    Accept: "*/*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Origin: "https://priemvgik.timepad.ru",
    Referer: referer,
    Cookie: cookie,
    "User-Agent": userAgent,
    "X-Requested-With": "XMLHttpRequest"
  };
}

/** VGIK_MAI_MODE=4: один POST каждые N мс, пока ответ не изменится. */
export function runVgikMode4SubmitLoop(
  stateKey: string,
  messageLabel: string,
  page: Page,
  onStepResult?: (message: string) => Promise<void>
): void {
  const state = vgikMode4LoopState.get(stateKey);
  if (state?.active) {
    return;
  }
  vgikMode4LoopState.set(stateKey, { lastCombinedResponse: null, active: true });

  const step1Url =
    process.env.VGIK_MODE4_STEP1_URL ??
    process.env.VGIK_MODE3_STEP1_URL ??
    "https://priemvgik.timepad.ru/event/widget_register/3951181";

  const tick = async () => {
    const current = vgikMode4LoopState.get(stateKey);
    if (!current?.active) {
      return;
    }
    try {
      const step1Payload = getVgikMode4Step1Payload();
      const headers = await buildMode4Headers(page, step1Payload);
      const step1 = await axios.post(step1Url, encodeFormData(step1Payload), {
        headers,
        timeout: 20000,
        validateStatus: () => true
      });

      const body1 = typeof step1.data === "string" ? step1.data : JSON.stringify(step1.data);
      const combined = `${step1.status}|${body1.slice(0, 1500)}`;
      const responseText = body1.replace(/\s+/g, " ").trim().slice(0, 500);
      const normalizedResponse = normalizeMode4ResponseText(body1);
      const matchedKeyPhrases = VGIK_MODE4_KEY_PHRASES.filter((phrase) => normalizedResponse.includes(phrase));

      logger.info("VGIK MODE4 step1", {
        target: messageLabel,
        url: step1Url,
        status: step1.status,
        responseText,
        matchedKeyPhrases
      });
      if (onStepResult && matchedKeyPhrases.length === 0) {
        await onStepResult(`${messageLabel}: не найдены ключевые фразы`);
      }

      if (current.lastCombinedResponse !== null && current.lastCombinedResponse !== combined) {
        logger.info("VGIK MODE4 response changed, stopping loop", { target: messageLabel });
        vgikMode4LoopState.set(stateKey, { lastCombinedResponse: combined, active: false });
        return;
      }
      vgikMode4LoopState.set(stateKey, { lastCombinedResponse: combined, active: true });
    } catch (error) {
      if (error instanceof AggregateError) {
        logger.error("VGIK MODE4 submit loop AggregateError", {
          target: messageLabel,
          errors: error.errors.map((e) => String(e))
        });
      } else {
        logger.error("VGIK MODE4 submit loop error", { target: messageLabel, error: String(error) });
      }
    } finally {
      if (vgikMode4LoopState.get(stateKey)?.active) {
        setTimeout(() => void tick(), VGIK_SUBMIT_RETRY_MS);
      }
    }
  };
  void tick();
}

async function snapshotTimepadInNewTab(browser: Browser, timepadUrl: string, targetName: string): Promise<void> {
  const gotoTimeout = Number(process.env.BROWSER_PAGE_GOTO_TIMEOUT_MS ?? "30000");
  const iframeTimeout = Number(
    process.env.VGIK_MAI_TIMEPAD_IFRAME_WAIT_MS ?? String(gotoTimeout)
  );

  try {
    const tab = await browser.newPage();
    await tab.setViewport({ width: 1920, height: 1080 });
    await tab.goto(timepadUrl, {
      waitUntil: "networkidle2",
      timeout: gotoTimeout
    });
    try {
      await tab.waitForSelector('iframe[name^="tpw__"]', { timeout: iframeTimeout });
    } catch (error) {
      logger.info("VGIK Mai Timepad: iframe tpw__ не появился за отведённое время, сохраняем HTML как есть", {
        target: targetName,
        url: timepadUrl,
        error: String(error)
      });
    }
    // const html = await tab.content();
    // const savedPath = await saveHtmlSnapshot("vgik_mai_timepad", targetName, html);
    // logger.info("Saved VGIK Mai Timepad HTML snapshot", {
    //   target: targetName,
    //   path: savedPath,
    //   timepadUrl
    // });
  } catch (error) {
    logger.error("VGIK Mai Timepad: вкладка / снимок не удались", {
      target: targetName,
      url: timepadUrl,
      error: String(error)
    });
  }
}

/** Тот же маркер, что searchText у таргета VGIK_Май в targets.ts — не путать с именем потока «Май» (май). */
const VGIK_MAI_ROW_MARKER = " мая ";

/**
 * Если в разметке есть маркер строки (как в мониторинге) и подходящая ссылка Timepad — открывает её в новой вкладке,
 * ждёт виджет как у таргетов waitForSelector (iframe tpw__), сохраняет полный HTML в outputs/.
 * Вкладку после сохранения не закрывает.
 * Остальная логика мониторинга вызывается отдельно в monitor.
 */
export async function runVgikMaiFacultyFlow(browser: Browser, pageHtml: string, targetName: string): Promise<void> {
  const htmlLower = pageHtml.toLowerCase();
  if (!htmlLower.includes(VGIK_MAI_ROW_MARKER)) {
    return;
  }

  const rawMax = Number(process.env.VGIK_MAI_MAX_TIMEPAD_EVENT_ID ?? "3931025");
  const exclusiveFloor = Number.isFinite(rawMax) ? rawMax : 3931025;

  const timepadUrl = pickBestNewTimepadEventUrl(pageHtml, exclusiveFloor);
  if (!timepadUrl) {
    logger.info(
      "VGIK Mai: в HTML есть маркер « мая » (как у таргета; возможны и даты вида «… мая …»), но нет ссылки priemvgik.timepad.ru/event с id выше порога",
      {
        target: targetName,
        maxEventIdExclusiveFloor: exclusiveFloor
      }
    );
    return;
  }

  logger.info("VGIK Mai: открытие Timepad во вкладке", { target: targetName, timepadUrl });
  await snapshotTimepadInNewTab(browser, timepadUrl, targetName);
}
