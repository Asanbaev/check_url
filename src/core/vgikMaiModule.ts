import axios from "axios";
import { Browser, Page } from "puppeteer";
import { saveHtmlSnapshot } from "../infra/logging/outputHtmlLogger";
import { logger } from "../infra/logging/logger";

/** Страница факультета, где в таблице появляются май и ссылки на Timepad */
export const VGIK_MAI_FACULTY_PAGE_URL = "https://vgik.info/abiturient/higher/spetsialitet/aktyerskiy-fakultet/";
const VGIK_MODE3_POLL_MS = 20000;
const vgikMode3LoopState = new Map<string, { lastCombinedResponse: string | null; active: boolean }>();

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
export function pickBestNewTimepadEventUrl(html: string, exclusiveFloor: number): string | null {
  const re = /https:\/\/priemvgik\.timepad\.ru\/event\/(\d+)\/?/gi;
  let bestId = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = Number.parseInt(m[1], 10);
    if (Number.isFinite(id) && id > exclusiveFloor && id > bestId) {
      bestId = id;
    }
  }
  if (bestId < 0) {
    return null;
  }
  return `https://priemvgik.timepad.ru/event/${bestId}/`;
}

function encodeFormData(payload: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    p.set(k, v);
  }
  return p.toString();
}

function getMode3Step1Payload(): Record<string, string> {
  return {
    re_id: "8073541",
    "user_forms[0][surname]": "Асанбаева",
    "user_forms[0][name]": "Софья",
    "user_forms[0][question11179814]": "Вадимовна",
    "user_forms[0][question11179815]": "18918490730",
    "user_forms[0][question11179816]": "8022494594",
    "user_forms[0][question11179817]": "18 лет",
    "user_forms[0][question11179818]": "Уфа",
    "user_forms[0][question11179819]": "+79374745034",
    "user_forms[0][mail]": "sofaasanbai@gmail.com",
    payment_method: "yookassa_sbp_v2",
    subscribe_digest: "on",
    accepted_terms: "on",
    "tickets[0][re_id]": "8073541",
    locale: "ru",
    "aux[use_ticket_remind]": "1",
    referer:
      "https://priemvgik.timepad.ru/event/3951176/?__cf_chl_tk=C.EeP6NPXUkvDfnAU9oU8VlvhC7QTXuUWTyOphA1HSg-1777453251-1.0.1.1-0oiMwsgdChfYuk8l68xscGgUN8lPCFfPSscy4ktYHp8",
    "stat_metadata[event_id]": "3951176",
    "stat_metadata[org_id]": "332401",
    "stat_metadata[event_cats]": "525",
    "stat_metadata[reg_count]": "1",
    "stat_metadata[questions_count]": "9",
    "stat_metadata[max_price]": "0",
    "stat_metadata[from]": "isInTimepad",
    "stat_metadata[widget_mode]": "default",
    "stat_metadata[widget_id]": "",
    "stat_metadata[widget_consumer_url]": "https://priemvgik.timepad.ru/event/3951176/",
    "stat_metadata[use_multireg]": "false",
    "stat_metadata[widget_use_multiank]": "false"
  };
}

function getMode3Step2Payload(): Record<string, string> {
  return {
    re_id: "8073544",
    "user_forms[0][surname]": "Асанбаева",
    "user_forms[0][name]": "Полина",
    "user_forms[0][question11179841]": "Вадимовна",
    "user_forms[0][question11179842]": "18918490730",
    "user_forms[0][question11179843]": "8022494594",
    "user_forms[0][question11179844]": "18 лет",
    "user_forms[0][question11179845]": "Уфа",
    "user_forms[0][question11179846]": "+79374745034",
    "user_forms[0][mail]": "sofaasanbai@gmail.com",
    payment_method: "yookassa_sbp_v2",
    subscribe_digest: "on",
    accepted_terms: "on",
    "tickets[0][re_id]": "8073544",
    locale: "ru",
    "aux[use_ticket_remind]": "1",
    referer: "",
    "stat_metadata[event_id]": "3951179",
    "stat_metadata[org_id]": "332401",
    "stat_metadata[event_cats]": "525",
    "stat_metadata[reg_count]": "1",
    "stat_metadata[questions_count]": "9",
    "stat_metadata[max_price]": "0",
    "stat_metadata[from]": "isInTimepad",
    "stat_metadata[widget_mode]": "default",
    "stat_metadata[widget_id]": "",
    "stat_metadata[widget_consumer_url]": "https://priemvgik.timepad.ru/event/3951179/",
    "stat_metadata[use_multireg]": "false",
    "stat_metadata[widget_use_multiank]": "false"
  };
}

async function buildCookieHeader(page: Page): Promise<string> {
  const cookies = await page.cookies("https://priemvgik.timepad.ru/");
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** MODE=3: два POST каждые 20с, пока ответ не изменится; всё логируем в консоль.
 * `stateKey` — стабильный ключ состояния (URL таргета); `messageLabel` — текст в сообщениях. */
export function runVgikMode3SubmitLoop(
  stateKey: string,
  messageLabel: string,
  page: Page,
  onStepResult?: (message: string) => Promise<void>
): void {
  const state = vgikMode3LoopState.get(stateKey);
  if (state?.active) {
    return;
  }
  vgikMode3LoopState.set(stateKey, { lastCombinedResponse: null, active: true });

  const step1Url = process.env.VGIK_MODE3_STEP1_URL ?? "https://priemvgik.timepad.ru/event/widget_register/3951176";
  const step2Url = process.env.VGIK_MODE3_STEP2_URL ?? "https://priemvgik.timepad.ru/event/widget_register/3951179";

  const tick = async () => {
    const current = vgikMode3LoopState.get(stateKey);
    if (!current?.active) {
      return;
    }
    try {
      const cookie = await buildCookieHeader(page);
      const headers = {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: "https://priemvgik.timepad.ru",
        Referer: "https://priemvgik.timepad.ru/",
        Cookie: cookie
      };

      const step1 = await axios.post(step1Url, encodeFormData(getMode3Step1Payload()), {
        headers,
        timeout: 20000,
        validateStatus: () => true
      });
      const step2 = await axios.post(step2Url, encodeFormData(getMode3Step2Payload()), {
        headers,
        timeout: 20000,
        validateStatus: () => true
      });

      const body1 = typeof step1.data === "string" ? step1.data : JSON.stringify(step1.data);
      const body2 = typeof step2.data === "string" ? step2.data : JSON.stringify(step2.data);
      const combined = `${step1.status}|${body1.slice(0, 1500)}||${step2.status}|${body2.slice(0, 1500)}`;

      console.log("[VGIK MODE3] step1", { target: messageLabel, url: step1Url, status: step1.status });
      console.log("[VGIK MODE3] step2", { target: messageLabel, url: step2Url, status: step2.status });
      if (onStepResult) {
        await onStepResult(`${messageLabel}: VGIK mode3 step1 status=${step1.status}`);
        await onStepResult(`${messageLabel}: VGIK mode3 step2 status=${step2.status}`);
      }

      if (current.lastCombinedResponse !== null && current.lastCombinedResponse !== combined) {
        console.log("[VGIK MODE3] response changed, stopping loop", { target: messageLabel });
        if (onStepResult) {
          await onStepResult(`${messageLabel}: VGIK mode3 ответ изменился, цикл остановлен`);
        }
        vgikMode3LoopState.set(stateKey, { lastCombinedResponse: combined, active: false });
        return;
      }
      vgikMode3LoopState.set(stateKey, { lastCombinedResponse: combined, active: true });
    } catch (error) {
      console.log("[VGIK MODE3] submit loop error", { target: messageLabel, error: String(error) });
    } finally {
      if (vgikMode3LoopState.get(stateKey)?.active) {
        setTimeout(() => void tick(), VGIK_MODE3_POLL_MS);
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
