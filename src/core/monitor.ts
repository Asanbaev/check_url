import { DateTime } from "luxon";
import { Op, literal } from "sequelize";
import { moscowWallClockLiteralForDb } from "../infra/time/moscowDb";
import { MonitorTarget, targetDisplayLabel } from "../config/targets";
import { runGitisPipeline } from "./gitisModule";
import {
  isVgikMaiFacultyPage,
  pageLooksLikeVgikCloudflareChallenge,
  pickBestNewTimepadEventUrl,
  runVgikMaiFacultyFlow,
  runVgikMode3SubmitLoop
} from "./vgikMaiModule";
import { publishAlert } from "../infra/publisher/alertPublisher";
import { logger } from "../infra/logging/logger";
import { saveHtmlSnapshot } from "../infra/logging/outputHtmlLogger";
import { BrowserClient, RuntimeTarget } from "../infra/browser/browserClient";
import { ResourceStatus, ResourceStatusLog } from "../infra/db/resourceStatusLog.model";
import { ResourceTarget } from "../infra/db/resourceTarget.model";

let datePast: string | undefined;
let dateNow = "";
let msgElapsedHours = Number(process.env.MSG_MIN_HOURS ?? "3");
const msgMinValue = Number(process.env.MSG_MIN_HOURS ?? "3");
/** Максимальная частота записи строк в ResourceStatusLog (по каждому таргету), по умолчанию 5 мин. */
const statusDbLogIntervalMin = Math.max(
  0,
  Number(process.env.STATUS_DB_LOG_INTERVAL_MIN ?? "5") || 5
);
/** Полный HTML страницы в outputs/ при статусе key_false (см. SAVE_PAGE_HTML в .env). */
const keyFalseSaveFullPageHtml =
  process.env.SAVE_PAGE_HTML === "1" || process.env.SAVE_PAGE_HTML === "true";
const requestStuckTimeoutMs = Number(process.env.REQUEST_STUCK_TIMEOUT_MS ?? "60000");
const pageGotoTimeoutMs = Number(process.env.BROWSER_PAGE_GOTO_TIMEOUT_MS ?? "20000");
const vgikMaiMode = Number(process.env.VGIK_MAI_MODE ?? "1");
const quietHoursStart = Number(process.env.QUIET_HOURS_START ?? "22");
const quietHoursEnd = Number(process.env.QUIET_HOURS_END ?? "7");
const nightIntervalMultiplier = Number(process.env.NIGHT_INTERVAL_MULTIPLIER ?? "60");
let intTime = Number(process.env.CHECK_INTERVAL_MS ?? "20000");
let urlPast: boolean[] = [];
let targetIdMap = new Map<string, number>();
let lastCleanupMinute: string | null = null;
let browserClientRef: BrowserClient | null = null;

function nowMoscowString(): string {
  return DateTime.local().setZone("Europe/Moscow").toFormat("yyyy-LL-dd HH:mm:ss");
}

function parseMoscowTimestamp(s: string) {
  return DateTime.fromFormat(s, "yyyy-LL-dd HH:mm:ss", { zone: "Europe/Moscow" });
}

function elapsedHoursFrom(lastTs?: string): number {
  if (!lastTs) {
    return Number.POSITIVE_INFINITY;
  }
  const now = parseMoscowTimestamp(nowMoscowString());
  const last = parseMoscowTimestamp(lastTs);
  if (!now.isValid || !last.isValid) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.round(now.diff(last, "hours").hours * 100) / 100;
}

function nextCycleMs(): number {
  const hour = DateTime.local().setZone("Europe/Moscow").hour;
  intTime = Number(process.env.CHECK_INTERVAL_MS ?? "20000");
  const isQuietHours = hour >= quietHoursStart || hour < quietHoursEnd;
  if (isQuietHours) {
    intTime = intTime * nightIntervalMultiplier;
  }
  return intTime;
}

/** Для Telegram Bot API parse_mode=HTML (видимые символы <>&) */
function escapeTelegramHtmlPlain(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttr(s: string): string {
  return escapeTelegramHtmlPlain(s).replace(/"/g, "&quot;");
}

/** Сообщение с подставленными HTML-тегами из monitor оставляем; иначе экранируем как обычный текст */
function bodyForTelegramHtmlMode(msg: string): string {
  if (/<[a-z]/i.test(msg) && /<\/[a-z]/i.test(msg)) {
    return msg;
  }
  return escapeTelegramHtmlPlain(msg);
}

function clickableTelegramMessage(msg: string, targetUrl: string, telegramParseMode?: "HTML"): string {
  const url = targetUrl.trim();
  if (!url) {
    return telegramParseMode === "HTML" ? bodyForTelegramHtmlMode(msg) : escapeTelegramHtmlPlain(msg);
  }
  const body = telegramParseMode === "HTML" ? bodyForTelegramHtmlMode(msg) : escapeTelegramHtmlPlain(msg);
  return `<a href="${escapeTelegramHtmlAttr(url)}">${body}</a>`;
}

function isBrowserErrorPage(content: string): boolean {
  const normalized = content.toLowerCase();
  if (normalized.length < 150) {
    return true;
  }
  return (
    normalized.includes("err_connection_timed_out") ||
    normalized.includes("err_name_not_resolved") ||
    normalized.includes("err_internet_disconnected") ||
    normalized.includes("net::err_") ||
    normalized.includes("this site can't be reached") ||
    normalized.includes("не удается получить доступ к сайту") ||
    normalized.includes("502 bad gateway") ||
    normalized.includes("503 service unavailable") ||
    normalized.includes("504 gateway timeout") ||
    normalized.includes("cloudflare") ||
    normalized.includes("attention required") ||
    normalized.includes("just a moment") ||
    normalized.includes("temporarily unavailable")
  );
}

async function writeStatusLog(target: RuntimeTarget, status: ResourceStatus, details: string): Promise<boolean> {
  const targetId = targetIdMap.get(target.url);
  if (!targetId) {
    logger.error("writeStatusLog: target_id not found for url (status_log not written)", {
      target: targetDisplayLabel(target),
      url: target.url
    });
    return false;
  }
  try {
    const moscowDt = moscowWallClockLiteralForDb();
    await ResourceStatusLog.create({
      target_id: targetId,
      status,
      details,
      /** SQL-литерал Europe/Moscow: драйвер не должен пересобирать instant в TZ процесса */
      detected_at: moscowDt,
      created_at: moscowDt
    });
    return true;
  } catch (error) {
    logger.error("writeStatusLog: insert failed", {
      target: targetDisplayLabel(target),
      url: target.url,
      error: String(error)
    });
    return false;
  }
}

/** Запись в БД не чаще чем STATUS_DB_LOG_INTERVAL_MIN (на таргет). Исключение: `key_false` — пишем всегда, без ожидания интервала. */
async function writeStatusLogIfDue(
  target: RuntimeTarget,
  status: ResourceStatus,
  details: string
): Promise<boolean> {
  const nowIso = nowMoscowString();
  const last = target.lastStatusDbLoggedAt;
  const bypassInterval = status === "key_false";
  if (last && !bypassInterval) {
    const tNow = parseMoscowTimestamp(nowIso);
    const tLast = parseMoscowTimestamp(last);
    if (!tNow.isValid || !tLast.isValid) {
      logger.error("writeStatusLogIfDue: invalid timestamp for interval", { nowIso, last, target: targetDisplayLabel(target) });
    } else {
      const elapsedMin = Math.round(tNow.diff(tLast, "minutes").minutes * 100) / 100;
      if (elapsedMin < statusDbLogIntervalMin) {
        return false;
      }
    }
  }
  const inserted = await writeStatusLog(target, status, details);
  if (inserted) {
    target.lastStatusDbLoggedAt = nowIso;
  }
  return inserted;
}

async function cleanupOldStatusLogs(): Promise<void> {
  const minuteKey = DateTime.local().setZone("Europe/Moscow").toFormat("yyyy-LL-dd HH:mm");
  if (lastCleanupMinute === minuteKey) {
    return;
  }
  lastCleanupMinute = minuteKey;
  const thresholdStr = DateTime.now().setZone("Europe/Moscow").minus({ days: 2 }).toFormat("yyyy-LL-dd HH:mm:ss");
  const esc = thresholdStr.replace(/'/g, "''");
  await ResourceStatusLog.destroy({
    where: {
      created_at: {
        [Op.lt]: literal(`'${esc}'`)
      }
    }
  });
}

async function sentUser(
  msg: string,
  stage: number,
  updDP: boolean,
  target: RuntimeTarget,
  resourceStatus: ResourceStatus,
  telegramParseMode?: "HTML"
): Promise<void> {
  await writeStatusLogIfDue(target, resourceStatus, msg);

  if (keyFalseSaveFullPageHtml && resourceStatus === "key_false" && target.page) {
    try {
      const snap = await target.page.content();
      const savedPath = await saveHtmlSnapshot("key_false", targetDisplayLabel(target), snap);
      logger.info("Saved key_false html snapshot", { target: targetDisplayLabel(target), path: savedPath });
    } catch (error) {
      logger.error("key_false html snapshot failed", { target: targetDisplayLabel(target), error: String(error) });
    }
  } else if (keyFalseSaveFullPageHtml && resourceStatus === "key_false" && !target.page) {
    logger.error("key_false html snapshot skipped: no page handle", { target: targetDisplayLabel(target) });
  }

  const intervalDue = elapsedHoursFrom(target.lastUserNotifyAt) >= msgMinValue;
  const sameResourceStatusAsLastNotify = target.lastAlertResourceStatus === resourceStatus;
  const shouldNotify = !sameResourceStatusAsLastNotify || intervalDue;

  if (shouldNotify) {
    const targetId = targetIdMap.get(target.url);
    const telegramMessage = clickableTelegramMessage(msg, target.url, telegramParseMode);
    if (targetId) {
      await publishAlert({
        targetId,
        targetName: targetDisplayLabel(target),
        targetUrl: target.url,
        status: resourceStatus,
        message: telegramMessage,
        telegramParseMode: "HTML"
      });
    }
    target.lastAlertResourceStatus = resourceStatus;
    target.lastUserNotifyAt = nowMoscowString();
  } else {
    logger.info("Notify suppressed (same resourceStatus / interval)", {
      target: targetDisplayLabel(target),
      resourceStatus,
      stageBefore: target.stage,
      intervalDue
    });
  }
  logger.info(`Status registered ${targetDisplayLabel(target)} ${resourceStatus} ${msg}`);
  target.stage = stage;
  if (updDP) {
    datePast = dateNow;
  }
  if (target.waitForSelector) {
    target.datePast = dateNow;
  }
}

async function sendTelegramStepNotification(
  target: RuntimeTarget,
  msg: string,
  resourceStatus: ResourceStatus
): Promise<void> {
  const targetId = targetIdMap.get(target.url);
  if (!targetId) {
    logger.error("sendTelegramStepNotification: target_id not found", { target: targetDisplayLabel(target), url: target.url });
    return;
  }
  await publishAlert({
    targetId,
    targetName: targetDisplayLabel(target),
    targetUrl: target.url,
    status: resourceStatus,
    message: clickableTelegramMessage(msg, target.url),
    telegramParseMode: "HTML"
  });
}

async function puppeteerDebug(target: RuntimeTarget): Promise<void> {
  if (!target.page) {
    throw new Error(`Page is not initialized for ${targetDisplayLabel(target)}`);
  }
  try {
    target.requested = true;
    await target.page.setViewport({ width: 1920, height: 1080 });

    const vgikCf = target.theaterId === "VGIK";
    let skipReload = false;
    let rawContent: string | undefined;

    if (vgikCf && target.vgikCfChallengePaused) {
      rawContent = await target.page.content();
      if (pageLooksLikeVgikCloudflareChallenge(rawContent)) {
        target.requested = false;
        return;
      }
      target.vgikCfChallengePaused = false;
      target.vgikCfChallengeNotifySent = false;
      skipReload = true;
      logger.info("VGIK Cloudflare: пауза снята, контент без маркера проверки", { target: targetDisplayLabel(target) });
    }

    if (!skipReload) {
      const shouldNavigate = !target.page.url().includes(target.url);
      if (shouldNavigate) {
        await target.page.goto(target.url, {
          waitUntil: "networkidle2",
          timeout: Number(process.env.BROWSER_PAGE_GOTO_TIMEOUT_MS ?? "20000")
        });
        logger.info(`Page navigated ${targetDisplayLabel(target)}`);
      } else {
        await target.page.reload({ waitUntil: "networkidle2", timeout: 0 });
        logger.info(`Page navigated ${targetDisplayLabel(target)}`);
      }
    }

    if (target.waitForSelector && vgikCf) {
      const preWaitHtml = await target.page.content();
      if (pageLooksLikeVgikCloudflareChallenge(preWaitHtml)) {
        target.vgikCfChallengePaused = true;
        if (!target.vgikCfChallengeNotifySent) {
          await sentUser(
            `${targetDisplayLabel(target)}: Cloudflare`,
            0,
            true,
            target,
            "auth"
          );
          target.vgikCfChallengeNotifySent = true;
        }
        target.requested = false;
        return;
      }
    }

    if (target.waitForSelector) {
      let exists = false;
      try {
        await target.page.waitForSelector('iframe[name^="tpw__"]');
        const iframeElement = await target.page.$('iframe[name^="tpw__"]');
        const frame = await iframeElement?.contentFrame();
        if (frame) {
          exists = await frame.evaluate(() => {
            const pTags = Array.from(document.querySelectorAll("p"));
            return pTags.some((p) =>
              (p.textContent ?? "").includes(
                "Регистрация на предварительное прослушивание закрыта, так как все места уже заняты!"
              )
            );
          });
        }
      } catch (error) {
        logger.error("error_puppeteerDebug не дождался", { dateNow, target: targetDisplayLabel(target), error: String(error) });
        exists = true;
      } finally {
        target.requested = false;
      }

      if (!exists) {
        await sentUser(`${targetDisplayLabel(target)}: проверь, похоже открыта регистрация !!!!`, 0, true, target, "key_false");
      } else if (target.msgElapsedHours >= msgMinValue || target.stage !== 0) {
        await sentUser(`${targetDisplayLabel(target)}: закрыто`, 0, true, target, "key_ok");
      }
      return;
    }

    if (rawContent === undefined) {
      rawContent = await target.page.content();
    }

    if (vgikCf && pageLooksLikeVgikCloudflareChallenge(rawContent)) {
      target.vgikCfChallengePaused = true;
      if (!target.vgikCfChallengeNotifySent) {
        await sentUser(
          `${targetDisplayLabel(target)}: Cloudflare`,
          0,
          true,
          target,
          "auth"
        );
        target.vgikCfChallengeNotifySent = true;
      }
      target.requested = false;
      return;
    }

    const wasDownBeforeCheck = target.availabilityState === "down";
    let content = rawContent.toLowerCase();
    if (isBrowserErrorPage(content)) {
      target.availabilityState = "down";
      await sentUser(`Сайт _${targetDisplayLabel(target)}_ недоступен (browser_error_page)`, 1, true, target, "unreachable");
      return;
    }
    target.availabilityState = "up";

    if (isVgikMaiFacultyPage(target.url)) {
      if (vgikMaiMode === 2 || vgikMaiMode === 3) {
        const rawMax = Number(process.env.VGIK_MAI_MAX_TIMEPAD_EVENT_ID ?? "3931025");
        const exclusiveFloor = Number.isFinite(rawMax) ? rawMax : 3931025;
        const timepadUrl = pickBestNewTimepadEventUrl(rawContent, exclusiveFloor);
        if (timepadUrl) {
          await sentUser(`${targetDisplayLabel(target)}: Найдена новая ссылка на май ${timepadUrl}`, 0, true, target, "key_false", "HTML");
          if (vgikMaiMode === 3 && target.page) {
            runVgikMode3SubmitLoop(target.url, targetDisplayLabel(target), target.page, async (stepMsg) => {
              const stepStatus: ResourceStatus = stepMsg.includes("ответ изменился") ? "key_false" : "key_ok";
              await sendTelegramStepNotification(target, stepMsg, stepStatus);
            });
          }
          // const browser = target.page.browser();
          // if (browser) {
          //   await runVgikMaiFacultyFlow(browser, rawContent, targetDisplayLabel(target));
          // }
        } else if (msgElapsedHours >= msgMinValue || target.stage !== 0) {
          await sentUser(`${targetDisplayLabel(target)}: Новых дат на май пока нет`, 0, true, target, "key_ok");
        }
        return;
      }
      // const browser = target.page.browser();
      // if (browser) {
      //   await runVgikMaiFacultyFlow(browser, rawContent, targetDisplayLabel(target));
      // }
    }

    if (target.theaterId === "GITIS") {
      const gitisResult = await runGitisPipeline(target.page, targetDisplayLabel(target));
      if (gitisResult.kind === "modal_missing") {
        if (wasDownBeforeCheck) {
          await sentUser(`Сайт _${targetDisplayLabel(target)}_ недоступен (browser_error_page)`, 1, true, target, "unreachable");
          return;
        }
        await sentUser(gitisResult.message, 0, true, target, "key_error");
        const snap = await target.page.content();
        const savedPath = await saveHtmlSnapshot("key_error", targetDisplayLabel(target), snap);
        logger.info("Saved key_error html snapshot (.one-course missing)", { target: targetDisplayLabel(target), path: savedPath });
        return;
      }
      if (gitisResult.kind === "registered_users_auth") {
        await sentUser(gitisResult.message, 0, true, target, "auth");
        const snap = await target.page.content();
        const savedPath = await saveHtmlSnapshot("auth", targetDisplayLabel(target), snap);
        logger.info("Saved auth html snapshot", { target: targetDisplayLabel(target), path: savedPath });
        return;
      }
      if (gitisResult.kind === "free_dates") {
        await sentUser(gitisResult.message, gitisResult.statusCode, true, target, "key_false");
        return;
      }
      content = gitisResult.contentLowercase;
    }

    if (content.indexOf(target.searchText.toLowerCase()) !== -1) {
      if (target.searchMode === "not_contains") {
        await sentUser(
          `${targetDisplayLabel(target)}: Поиск слова '${target.searchText}' положительный, открыли запись!!!, запускайте поиск ссылки !!`,
          0,
          true,
          target,
          "key_false"
        );
      } else {
        const msgNoFreeDates = `${targetDisplayLabel(target)}: Свободных дат пока нет`;
        await writeStatusLogIfDue(target, "key_ok", msgNoFreeDates);
        if (msgElapsedHours >= msgMinValue || target.stage !== 0) {
          await sentUser(msgNoFreeDates, 0, true, target, "key_ok");
        }
      }
    } else if (target.searchMode === "not_contains") {
      const msgNotOpen = `${targetDisplayLabel(target)}: Запись на<b><u>${target.searchText}</u></b>не открыта`;
      await writeStatusLogIfDue(target, "key_ok", msgNotOpen);
      if (msgElapsedHours >= msgMinValue || target.stage !== 0) {
        await sentUser(msgNotOpen, 0, true, target, "key_ok", "HTML");
      }
    } else if (target.theaterId === "GITIS") {
      await sentUser(`Дату не нашёл !! ${targetDisplayLabel(target)}`, 0, true, target, "key_error");
      const snap = await target.page.content();
      const savedPath = await saveHtmlSnapshot("key_error", targetDisplayLabel(target), snap);
      logger.info("Saved key_error html snapshot", { target: targetDisplayLabel(target), path: savedPath });
    }
  } catch (error) {
    const message = String(error);
    logger.error("error_puppeteerDebug", { dateNow, target: targetDisplayLabel(target), error: message });
    if (
      message.includes("ERR_NAME_NOT_RESOLVED") ||
      message.includes("ERR_CONNECTION") ||
      message.includes("ERR_INTERNET") ||
      message.includes("Navigation timeout")
    ) {
      target.availabilityState = "down";
      await sentUser(`Сайт _${targetDisplayLabel(target)}_ недоступен (${message})`, 1, true, target, "unreachable");
    } else {
      target.availabilityState = "down";
      await sentUser(`Сайт _${targetDisplayLabel(target)}_ недоступен (${message})`, 1, true, target, "unreachable");
    }
  } finally {
    target.requested = false;
  }
}

async function checkURL(target: RuntimeTarget): Promise<void> {
  try {
    if (!target.page) {
      if (target.theaterId === "GITIS" && browserClientRef) {
        const rebound = await browserClientRef.rebindGitisTargetPage(target);
        if (rebound) {
          logger.info("GITIS page rebound by URL match", { target: targetDisplayLabel(target), url: target.url });
        }
      }
    }
    if (!target.page) {
      logger.info("checkURL skipped: no bound page", { target: targetDisplayLabel(target), theaterId: target.theaterId });
      return;
    }
    if (target.requested) {
      logger.info("checkURL skipped: request already in progress", { target: targetDisplayLabel(target), at: nowMoscowString() });
      return;
    }
    target.lastRequestedTimeBeforeUpdate = target.requestedTime;
    target.requestedTime = dateNow;

    if (target.datePast) {
      target.msgElapsedHours = Math.round(
        DateTime.fromISO(dateNow.replace(" ", "T"))
          .diff(DateTime.fromISO(target.datePast.replace(" ", "T")), "hours")
          .hours * 100
      ) / 100;
    }

    await puppeteerDebug(target);
  } catch (error) {
    logger.error("error_checkURL", { dateNow, target: targetDisplayLabel(target), error: String(error) });
    await sentUser(`error_checkURL : ${dateNow}`, 1, true, target, "error");
  }
}

async function checkSelect(target: RuntimeTarget): Promise<void> {
  if (!target.page) {
    return;
  }
  logger.info("RGSI selector check tick", {
    target: targetDisplayLabel(target),
    url: target.page.url()
  });
  await target.page.setViewport({ width: 1920, height: 1080 });
  await target.page.waitForSelector("#select2-theaterdata-choose_date-container", { visible: true });
  await target.page.click("#select2-theaterdata-choose_date-container");
  await new Promise((resolve) => setTimeout(resolve, 1500));

  let options: Array<{ text: string; class: string }> = [];
  try {
    options = await target.page.evaluate(() =>
      Array.from(document.querySelectorAll(".select2-results__option")).map((el) => ({
        text: (el as HTMLElement).innerText.trim(),
        class: (el as HTMLElement).className
      }))
    );
  } catch (error) {
    logger.error("error_options", { target: targetDisplayLabel(target), error: String(error) });
  }

  if (options[0] && options[0].text === "В настоящий момент свободных дат для записи нет. Ждите.") {
    await sentUser("нету дат", 0, false, target, "key_ok");
  } else if (options[0]) {
    await sentUser("проверь похоже есть дата", 0, false, target, "key_false");
  }
}


// главный цикл планировщика.
// ставит текущий таймштамп цикла, проходит по всем таргетам и решает, кому запускать checkURL(),
// контролирует «застревание» через requested + timeout, запускает очистку старых логов,
// и в конце планирует следующий запуск setTimeout(..., nextCycleMs())
async function checkSite(targets: RuntimeTarget[]): Promise<void> {
  let stuckText = "";
  const effectiveStuckTimeoutMs = Math.max(requestStuckTimeoutMs, pageGotoTimeoutMs + 5000);
  dateNow = nowMoscowString();
  try {
    const nextMs = nextCycleMs();
    // logger.info("Check cycle tick", { at: dateNow, nextCycleMs: nextMs });

    if (datePast) { // нужен как глобальная метка времени последнего “значимого” события, чтобы считать msgElapsedHours (сколько часов прошло) и не слать/не писать одинаковые не-критичные статусы слишком часто.
      msgElapsedHours = Math.round(
        DateTime.fromISO(dateNow.replace(" ", "T")).diff(DateTime.fromISO(datePast.replace(" ", "T")), "hours").hours * 100
      ) / 100;
    }

    for (let i = 0; i < targets.length; i += 1) {
      const elapsedMs = DateTime.fromISO(dateNow.replace(" ", "T"))
        .diff(DateTime.fromISO(targets[i].requestedTime.replace(" ", "T")), "milliseconds")
        .milliseconds;
      if (targets[i].requested && elapsedMs >= effectiveStuckTimeoutMs) {
        if (!targets[i].waitForSelector && targets[i].availabilityState !== "down" && targets[i].stage !== 1) {
          stuckText += `${targetDisplayLabel(targets[i])} : true; `;
        }
        logger.error("Request stuck timeout reached, forcing unlock", {
          target: targetDisplayLabel(targets[i]),
          elapsedMs: Math.round(elapsedMs),
          timeoutMs: effectiveStuckTimeoutMs
        });
        targets[i].requested = false;
      }
      urlPast[i] = targets[i].requested;
      if (!targets[i].requested) {
        setTimeout(() => void checkURL(targets[i]), 1000 * i);
      }
    }
    await cleanupOldStatusLogs();
    if (stuckText !== "") {
      await sentUser(`Страницы не обновляются ${stuckText}`, 1, true, targets[0], "error");
    }
  } catch (error) {
    logger.error("error_checkSite", { dateNow, error: String(error) });
    await sentUser(`error_checkSite : ${dateNow}`, 1, true, targets[0], "error");
  } finally {
    const nextMs = nextCycleMs();
    setTimeout(() => void checkSite(targets), nextMs);
  }
}

async function checkSiteRgsi(targets: RuntimeTarget[]): Promise<void> {
  for (let i = 0; i < targets.length; i += 1) {
    setTimeout(() => void checkSelect(targets[i]), 1000 * i);
  }
  setTimeout(() => void checkSiteRgsi(targets), nextCycleMs());
}

export async function runMonitor(targets: MonitorTarget[]): Promise<void> {
  const urlToTargetId = new Map<string, number>();

  for (const target of targets) {
    const desiredCode = targetDisplayLabel(target);
    const [row] = await ResourceTarget.findOrCreate({
      where: { url: target.url },
      defaults: {
        code: desiredCode,
        theater_id: target.theaterId,
        url: target.url,
        enabled: target.enabled
      }
    });
    row.set({
      code: desiredCode,
      theater_id: target.theaterId,
      url: target.url,
      enabled: target.enabled
    });
    await row.save();
    urlToTargetId.set(target.url, row.id);
  }

  const runtimeTargets: RuntimeTarget[] = targets.filter((target) => target.enabled).map((target) => ({ ...target }));
  if (runtimeTargets.length === 0) {
    throw new Error("No enabled targets in config/targets.ts");
  }
  urlPast = new Array(runtimeTargets.length).fill(false);

  targetIdMap.clear();
  for (const target of runtimeTargets) {
    const id = urlToTargetId.get(target.url);
    if (id === undefined) {
      throw new Error(`target id missing after sync: ${target.url}`);
    }
    targetIdMap.set(target.url, id);
  }

  const browserClient = new BrowserClient();
  browserClientRef = browserClient;
  await browserClient.connect();
  await browserClient.bindPages(runtimeTargets);

  const mode = process.env.MONITOR_MODE ?? "general";
  if (mode === "rgsi") {
    await checkSiteRgsi(runtimeTargets);
    return;
  }
  await checkSite(runtimeTargets);
}
