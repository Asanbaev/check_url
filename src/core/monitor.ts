import { DateTime } from "luxon";
import { Op, literal } from "sequelize";
import { moscowWallClockLiteralForDb } from "../infra/time/moscowDb";
import { MonitorTarget, targetDisplayLabel } from "../config/targets";
import {
  clickFirstAvailableGitisDate,
  clickFirstAvailableGitisTime,
  clickGitisConfirmButton,
  runGitisPipeline
} from "./gitisModule";
import {
  isVgikMaiFacultyPage,
  pageLooksLikeVgikCloudflareChallenge,
  pageShowsVgikCloudflareVerifying,
  pickBestNewTimepadEventUrl,
  runVgikMaiFacultyFlow,
  runVgikMode4SubmitLoop
} from "./vgikMaiModule";
import {
  buildNewTimepadDynamicTarget,
  mergeStaticWithDynamicTargets,
  parseTimepadEventId,
  toStoredRow,
  upsertDynamicTargetRow
} from "./vgikDynamicTargets";
import {
  isPriemvgikEventUrl,
  runVgikSubmittingTick,
  tryVgikTimepadRegistrationFlow
} from "./vgikTimepadFlow";
import { publishAlert } from "../infra/publisher/alertPublisher";
import { logger } from "../infra/logging/logger";
import { saveHtmlSnapshot } from "../infra/logging/outputHtmlLogger";
import { BrowserClient, RuntimeTarget } from "../infra/browser/browserClient";
import { withDbRetry } from "../infra/db/retryDb";
import { OutboundPostRequest } from "../infra/db/outboundPostRequest.model";
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
const waitForIframeTimeoutMs = Number(process.env.WAIT_FOR_IFRAME_TIMEOUT_MS ?? "12000");
const saveCloudflareHtml =
  process.env.SAVE_CLOUDFLARE_HTML === "1" || process.env.SAVE_CLOUDFLARE_HTML === "true";
const logPageNavigated =
  process.env.PAGE_NAVIGATED_LOG_ENABLED === "1" || process.env.PAGE_NAVIGATED_LOG_ENABLED === "true";
const notifySuppressedLogEnabled =
  process.env.NOTIFY_SUPPRESSED_LOG_ENABLED === "1" ||
  (process.env.NOTIFY_SUPPRESSED_LOG_ENABLED ?? "false").trim().toLowerCase() === "true";
const gitisSubmitEnabled =
  (process.env.GITIS_SUBMIT_ENABLED ?? "false").trim().toLowerCase() === "true";
const gitisSubmitBeforeDate = (process.env.GITIS_SUBMIT_BEFORE_DATE ?? "2026-06-01").trim();
const vgikMaiMode = Number(process.env.VGIK_MAI_MODE ?? "1");
const vgikHtmlSubmitEnabled =
  (process.env.VGIK_HTML_SUBMIT_ENABLED ?? "false").trim().toLowerCase() === "true";
const quietHoursStart = Number(process.env.QUIET_HOURS_START ?? "22");
const quietHoursEnd = Number(process.env.QUIET_HOURS_END ?? "7");
const nightIntervalMultiplier = Number(process.env.NIGHT_INTERVAL_MULTIPLIER ?? "60");
let intTime = Number(process.env.CHECK_INTERVAL_MS ?? "20000");
let urlPast: boolean[] = [];
let targetIdMap = new Map<string, number>();
let lastCleanupHour: string | null = null;
let browserClientRef: BrowserClient | null = null;
let runtimeTargetsRef: RuntimeTarget[] = [];

async function ensureRuntimeTargetForNewVgikTimepad(eventUrl: string): Promise<RuntimeTarget | null> {
  const normalizedUrl = eventUrl.replace(/\/?$/, "/");
  const existing = runtimeTargetsRef.find((target) => target.url === normalizedUrl);
  if (existing) {
    return existing;
  }
  const eventId = parseTimepadEventId(normalizedUrl);
  if (!eventId) {
    return null;
  }
  const dynamicTarget = buildNewTimepadDynamicTarget(normalizedUrl, eventId, {
    msgElapsedHours: msgMinValue
  }) as RuntimeTarget;
  runtimeTargetsRef.push(dynamicTarget);
  upsertDynamicTargetRow(toStoredRow(dynamicTarget));
  if (browserClientRef) {
    await browserClientRef.bindPages([dynamicTarget]);
  }
  return dynamicTarget;
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

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

function clickableTelegramMessage(
  msg: string,
  targetUrl: string,
  telegramParseMode?: "HTML",
  resourceStatus?: ResourceStatus
): string {
  const url = targetUrl.trim();
  const isKeyFalse = resourceStatus === "key_false";
  const emphasize = (text: string) => (isKeyFalse ? `🔴 <b>${text}</b>` : text);
  if (!url) {
    if (telegramParseMode === "HTML") {
      return emphasize(bodyForTelegramHtmlMode(msg));
    }
    return escapeTelegramHtmlPlain(msg);
  }
  const body = telegramParseMode === "HTML"
    ? emphasize(bodyForTelegramHtmlMode(msg))
    : escapeTelegramHtmlPlain(msg);
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

function isChromeErrorUrl(url: string): boolean {
  return url.startsWith("chrome-error://");
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
    await withDbRetry(`writeStatusLog.create target=${targetDisplayLabel(target)}`, async () =>
      ResourceStatusLog.create({
        target_id: targetId,
        status,
        details,
        /** SQL-литерал Europe/Moscow: драйвер не должен пересобирать instant в TZ процесса */
        detected_at: moscowDt,
        created_at: moscowDt
      })
    );
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

/** Читает последний статус из status_log по target_id, чтобы отфильтровать дубли между инстансами. */
async function getLastDbStatusForTarget(target: RuntimeTarget): Promise<ResourceStatus | null> {
  const targetId = targetIdMap.get(target.url);
  if (!targetId) {
    return null;
  }
  try {
    const lastRow = await withDbRetry(
      `getLastDbStatusForTarget.findOne target=${targetDisplayLabel(target)}`,
      async () =>
        ResourceStatusLog.findOne({
          where: { target_id: targetId },
          attributes: ["status"],
          order: [["id", "DESC"]]
        })
    );
    return lastRow?.status ?? null;
  } catch (error) {
    logger.error("getLastDbStatusForTarget: select failed", {
      target: targetDisplayLabel(target),
      url: target.url,
      error: String(error)
    });
    return null;
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
  const statusChangedSinceLastDbWrite = target.lastStatusDbLoggedStatus !== undefined
    && target.lastStatusDbLoggedStatus !== status;
  const bypassInterval = status === "key_false" || statusChangedSinceLastDbWrite;
  let intervalElapsed = true;
  if (last && !bypassInterval) {
    const tNow = parseMoscowTimestamp(nowIso);
    const tLast = parseMoscowTimestamp(last);
    if (!tNow.isValid || !tLast.isValid) {
      logger.error("writeStatusLogIfDue: invalid timestamp for interval", { nowIso, last, target: targetDisplayLabel(target) });
    } else {
      const elapsedMin = Math.round(tNow.diff(tLast, "minutes").minutes * 100) / 100;
      if (elapsedMin < statusDbLogIntervalMin) {
        intervalElapsed = false;
        return false;
      }
    }
  }

  const lastDbStatus = await getLastDbStatusForTarget(target);
  if (lastDbStatus === status && !bypassInterval && !intervalElapsed) {
    target.lastStatusDbLoggedAt = nowIso;
    target.lastStatusDbLoggedStatus = status;
    return false;
  }

  const inserted = await writeStatusLog(target, status, details);
  if (inserted) {
    target.lastStatusDbLoggedAt = nowIso;
    target.lastStatusDbLoggedStatus = status;
  }
  return inserted;
}

async function cleanupOldStatusLogs(): Promise<void> {
  const hourKey = DateTime.local().setZone("Europe/Moscow").toFormat("yyyy-LL-dd HH");
  if (lastCleanupHour === hourKey) {
    return;
  }
  const thresholdStr = DateTime.now().setZone("Europe/Moscow").minus({ days: 2 }).toFormat("yyyy-LL-dd HH:mm:ss");
  const esc = thresholdStr.replace(/'/g, "''");
  try {
    await withDbRetry(`cleanupOldStatusLogs.destroy threshold=${thresholdStr}`, async () =>
      ResourceStatusLog.destroy({
        where: {
          created_at: {
            [Op.lt]: literal(`'${esc}'`)
          }
        }
      })
    );
    await withDbRetry(`cleanupOldStatusLogs.destroy request threshold=${thresholdStr}`, async () =>
      OutboundPostRequest.destroy({
        where: {
          created_at: {
            [Op.lt]: literal(`'${esc}'`)
          }
        }
      })
    );
    lastCleanupHour = hourKey;
  } catch (error) {
    logger.error("cleanupOldStatusLogs: delete failed", { error: String(error), thresholdStr });
  }
}

async function disableTargetInDb(target: RuntimeTarget): Promise<void> {
  const targetId = targetIdMap.get(target.url);
  if (!targetId) {
    logger.error("disableTargetInDb: target_id not found", {
      target: targetDisplayLabel(target),
      url: target.url
    });
    return;
  }
  try {
    await withDbRetry(`disableTargetInDb.update target=${targetDisplayLabel(target)} id=${targetId}`, async () =>
      ResourceTarget.update({ enabled: false }, { where: { id: targetId } })
    );
    logger.info("Target disabled in DB after GITIS submit", {
      target: targetDisplayLabel(target),
      targetId
    });
  } catch (error) {
    logger.error("disableTargetInDb: update failed", {
      target: targetDisplayLabel(target),
      targetId,
      error: String(error)
    });
  }
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

  const statusChanged = target.lastAlertResourceStatus !== resourceStatus;
  const intervalDue = elapsedHoursFrom(target.lastUserNotifyAt) >= msgMinValue;
  const shouldNotify = statusChanged || intervalDue || target.stage !== 0;

  if (shouldNotify) {
    const targetId = targetIdMap.get(target.url);
    const telegramMessage = clickableTelegramMessage(msg, target.url, telegramParseMode, resourceStatus);
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
    if (notifySuppressedLogEnabled) {
      logger.info("Notify suppressed (same resourceStatus / interval)", {
        target: targetDisplayLabel(target),
        resourceStatus,
        stageBefore: target.stage,
        statusChanged,
        intervalDue
      });
    }
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
    message: clickableTelegramMessage(msg, target.url, undefined, resourceStatus),
    telegramParseMode: "HTML"
  });
}

async function saveCloudflareSnapshotIfEnabled(
  target: RuntimeTarget,
  html: string,
  phase: "paused" | "pre_wait" | "post_wait"
): Promise<void> {
  if (!saveCloudflareHtml) {
    return;
  }
  try {
    const savedPath = await saveHtmlSnapshot(`auth_cloudflare_${phase}`, targetDisplayLabel(target), html);
    logger.info("Saved Cloudflare html snapshot", {
      target: targetDisplayLabel(target),
      phase
    });
  } catch (error) {
    logger.error("Cloudflare html snapshot failed", {
      target: targetDisplayLabel(target),
      phase,
      error: String(error)
    });
  }
}

/**
 * Временный debug: сохраняем HTML при Navigation timeout только для VGIK_Федоров_14.
 */
async function saveVgikFedorov14TimeoutSnapshotIfNeeded(
  target: RuntimeTarget,
  message: string
): Promise<void> {
  const isFedorov14 =
    targetDisplayLabel(target) === "VGIK_Федоров_14" || /\/event\/3951191(?:\/|$|\?)/.test(target.url);
  const isNavigationTimeout = /navigation timeout/i.test(message);
  if (!isFedorov14 || !isNavigationTimeout) {
    return;
  }
  const fallbackHtml = [
    "<html><body>",
    `<h3>unreachable timeout debug</h3>`,
    `<p>target: ${targetDisplayLabel(target)}</p>`,
    `<p>url: ${target.url}</p>`,
    `<p>message: ${message.replace(/</g, "&lt;")}</p>`,
    `<p>at: ${nowMoscowString()}</p>`,
    "</body></html>"
  ].join("");

  if (!target.page) {
    try {
      const savedPath = await saveHtmlSnapshot(
        "unreachable_timeout_debug_no_page",
        targetDisplayLabel(target),
        fallbackHtml
      );
      logger.info("Saved timeout debug html snapshot (no page)", {
        target: targetDisplayLabel(target),
        path: savedPath,
        reason: "navigation_timeout"
      });
    } catch (error) {
      logger.error("Timeout debug html snapshot failed (no page)", {
        target: targetDisplayLabel(target),
        error: String(error)
      });
    }
    return;
  }
  try {
    const html = await Promise.race<string>([
      target.page.content(),
      new Promise<string>((resolve) => setTimeout(() => resolve(fallbackHtml), 2000))
    ]);
    const savedPath = await saveHtmlSnapshot("unreachable_timeout_debug", targetDisplayLabel(target), html);
    logger.info("Saved timeout debug html snapshot", {
      target: targetDisplayLabel(target),
      path: savedPath,
      reason: "navigation_timeout"
    });
  } catch (error) {
    logger.error("Timeout debug html snapshot failed, saving fallback", {
      target: targetDisplayLabel(target),
      error: String(error)
    });
    try {
      const savedPath = await saveHtmlSnapshot(
        "unreachable_timeout_debug_fallback",
        targetDisplayLabel(target),
        fallbackHtml
      );
      logger.info("Saved timeout debug fallback html snapshot", {
        target: targetDisplayLabel(target),
        path: savedPath,
        reason: "navigation_timeout_content_error"
      });
    } catch (fallbackError) {
      logger.error("Timeout debug fallback html snapshot failed", {
        target: targetDisplayLabel(target),
        error: String(fallbackError)
      });
    }
  }
}

type VgikCloudflareVerifyingResult = {
  resolved: boolean;
  confirmedHtml?: string;
};

/**
 * Если видим промежуточный экран Cloudflare, ждём его завершения (7x3с) и продолжаем проверку.
 */
async function waitForVgikCloudflareVerifyingToFinish(
  target: RuntimeTarget,
  html: string
): Promise<VgikCloudflareVerifyingResult> {
  if (!pageShowsVgikCloudflareVerifying(html) || !target.page) {
    return { resolved: false };
  }
  for (let i = 0; i < 7; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const nextHtml = await target.page.content();
    if (!pageShowsVgikCloudflareVerifying(nextHtml)) {
      // Double-check after a short delay: Cloudflare may switch back to verification/challenge.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const confirmHtml = await target.page.content();
      if (pageShowsVgikCloudflareVerifying(confirmHtml)) {
        logger.info("Cloudflare verifying phrase returned on confirm pass", {
          target: targetDisplayLabel(target),
          attemptsUsed: i + 1
        });
        return { resolved: false };
      }
      logger.info("Cloudflare-disappeared, continue..", {
        target: targetDisplayLabel(target),
        attemptsUsed: i + 1
      });
      return { resolved: true };
    }
  }
  const confirmedHtml = await target.page.content();
  if (pageShowsVgikCloudflareVerifying(confirmedHtml)) {
    return { resolved: false, confirmedHtml };
  }
  return { resolved: false };
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
        const verifying = await waitForVgikCloudflareVerifyingToFinish(target, rawContent);
        if (verifying.resolved) {
          target.vgikCfChallengePaused = false;
          target.vgikCfChallengeNotifySent = false;
          skipReload = true;
          logger.info("VGIK Cloudflare: verification text disappeared in pause mode", {
            target: targetDisplayLabel(target)
          });
        } else {
          const snapshotHtml = verifying.confirmedHtml ?? rawContent;
          logger.info("Saving Cloudflare snapshot after unresolved challenge", {
            target: targetDisplayLabel(target),
            phase: "paused"
          });
          await saveCloudflareSnapshotIfEnabled(target, snapshotHtml, "paused");
          target.requested = false;
          return;
        }
      }
      target.vgikCfChallengePaused = false;
      target.vgikCfChallengeNotifySent = false;
      skipReload = true;
      logger.info("VGIK Cloudflare: пауза снята, контент без маркера проверки", { target: targetDisplayLabel(target) });
    }

    if (!skipReload) {
      const currentUrl = target.page.url();
      const shouldNavigate = isChromeErrorUrl(currentUrl) || !currentUrl.includes(target.url);
      if (shouldNavigate) {
        if (isChromeErrorUrl(currentUrl)) {
          logger.error("Detected chrome-error page, forcing goto recovery", {
            target: targetDisplayLabel(target),
            currentUrl
          });
        }
        await target.page.goto(target.url, {
          waitUntil: "networkidle2",
          timeout: Number(process.env.BROWSER_PAGE_GOTO_TIMEOUT_MS ?? "20000")
        });
        if (logPageNavigated) {
          logger.info(`Page navigated ${targetDisplayLabel(target)}`);
        }
      } else {
        await target.page.reload({
          waitUntil: "networkidle2",
          timeout: Number(process.env.BROWSER_PAGE_GOTO_TIMEOUT_MS ?? "20000")
        });
        if (logPageNavigated) {
          logger.info(`Page navigated ${targetDisplayLabel(target)}`);
        }
      }
    }

    if (target.waitForSelector && vgikCf) {
      const preWaitHtml = await target.page.content();
      if (pageLooksLikeVgikCloudflareChallenge(preWaitHtml)) {
        const verifying = await waitForVgikCloudflareVerifyingToFinish(target, preWaitHtml);
        if (verifying.resolved) {
          logger.info("VGIK Cloudflare: disappeared before wS1", {
            target: targetDisplayLabel(target)
          });
        } else {
          const snapshotHtml = verifying.confirmedHtml ?? preWaitHtml;
          logger.info("Saving Cloudflare snapshot after unresolved challenge", {
            target: targetDisplayLabel(target),
            phase: "pre_wait"
          });
          await saveCloudflareSnapshotIfEnabled(target, snapshotHtml, "pre_wait");
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
    }

    if (target.waitForSelector) {
      let exists = false;
      let selectorTimedOut = false;
      try {
        await target.page.waitForSelector('iframe[name^="tpw__"]', {
          timeout: waitForIframeTimeoutMs
        });

        if (vgikCf && vgikHtmlSubmitEnabled && isPriemvgikEventUrl(target.url)) {
          const notify = async (message: string, status: ResourceStatus) => {
            await sentUser(message, 0, true, target, status);
          };

          // прописывается конкретный таргет для фетч
          if (vgikMaiMode === 4 && target.url.includes("/3951181/")) {
            runVgikMode4SubmitLoop(target.url, targetDisplayLabel(target), target.page, async (stepMsg: string) => {
              await sentUser(stepMsg, 0, true, target, "key_false");
            });
          }
          if (target.submitting) {
            await runVgikSubmittingTick(target, notify);
            return;
          }
          const rawHtml = await target.page.content();
          const handled = await tryVgikTimepadRegistrationFlow(target, rawHtml.toLowerCase(), notify);
          if (handled) {
            return;
          }
        }

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
        const waitError = String(error);
        const isSelectorTimeout =
          waitError.includes("Waiting for selector") || waitError.includes("timeout") || waitError.includes("TimeoutError");
        if (isSelectorTimeout) {
          selectorTimedOut = true;
          logger.error("waitForSelector timeout", {
            dateNow,
            target: targetDisplayLabel(target),
            timeoutMs: waitForIframeTimeoutMs,
            error: waitError
          });
        } else {
          throw error;
        }
      } finally {
        target.requested = false;
      }

      if (selectorTimedOut) {
        await writeStatusLogIfDue(
          target,
          "key_error",
          `${targetDisplayLabel(target)}: waitForSelector timeout ${waitForIframeTimeoutMs}ms (iframe not ready)`
        );
        return;
      }

      if (!exists) {
        await sentUser(`${targetDisplayLabel(target)}: проверь, похоже открыта регистрация !!!!`, 0, true, target, "key_false");
      } else {
        // Всегда пишем в БД каждые 5 минут
        await writeStatusLogIfDue(target, "key_ok", `${targetDisplayLabel(target)}: закрыто`);
        // Уведомления отправляются если статус изменился, прошел интервал, или это первый цикл
        await sentUser(`${targetDisplayLabel(target)}: закрыто`, 0, true, target, "key_ok");
      }
      return;
    }

    if (rawContent === undefined) {
      rawContent = await target.page.content();
    }

    if (vgikCf && pageLooksLikeVgikCloudflareChallenge(rawContent)) {
      const verifying = await waitForVgikCloudflareVerifyingToFinish(target, rawContent);
      if (verifying.resolved) {
        logger.info("VGIK Cloudflare: verification text disappeared after content read", {
          target: targetDisplayLabel(target)
        });
      } else {
        const snapshotHtml = verifying.confirmedHtml ?? rawContent;
        logger.info("Saving Cloudflare snapshot after unresolved challenge", {
          target: targetDisplayLabel(target),
          phase: "post_wait"
        });
        await saveCloudflareSnapshotIfEnabled(target, snapshotHtml, "post_wait");
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

    const wasDownBeforeCheck = target.availabilityState === "down";
    let content = rawContent.toLowerCase();
    if (isBrowserErrorPage(content)) {
      target.availabilityState = "down";
      await sentUser(`${targetDisplayLabel(target)}_ недоступен (browser_error_page)`, 1, true, target, "unreachable");
      return;
    }
    target.availabilityState = "up";

    if (isVgikMaiFacultyPage(target.url)) {
        const rawMax = Number(process.env.VGIK_MAI_MAX_TIMEPAD_EVENT_ID ?? "3931025");
        const exclusiveFloor = Number.isFinite(rawMax) ? rawMax : 3931025;
        const timepadUrl = pickBestNewTimepadEventUrl(rawContent, exclusiveFloor);
        if (timepadUrl) {
          await sentUser(`${targetDisplayLabel(target)}: Найдена новая ссылка на май ${timepadUrl}`, 0, true, target, "key_false", "HTML");
          const dynamicTarget = await ensureRuntimeTargetForNewVgikTimepad(timepadUrl);
          if (dynamicTarget && dynamicTarget.page && vgikHtmlSubmitEnabled && !dynamicTarget.vgikRegistrationFilled) {
            const notify = async (message: string, status: ResourceStatus) => {
              await sendTelegramStepNotification(dynamicTarget, message, status);
            };
            const dynamicRawHtml = await dynamicTarget.page.content().catch(() => "");
            await tryVgikTimepadRegistrationFlow(dynamicTarget, dynamicRawHtml.toLowerCase(), notify);
          }
        } else {
          await writeStatusLogIfDue(target, "key_ok", `${targetDisplayLabel(target)}: Новых дат на май пока нет`);
          // Уведомления отправляются если статус изменился, прошел интервал, или это первый цикл
          await sentUser(`${targetDisplayLabel(target)}: Новых дат на май пока нет`, 0, true, target, "key_ok");
        }
        return;
    }

    if (target.theaterId === "GITIS") {
      const gitisResult = await runGitisPipeline(target.page, targetDisplayLabel(target), target.successText);
      if (gitisResult.kind === "booking_success") {
        // После submit может быть уже отправлен key_false; сбрасываем, чтобы success-уведомление не подавилось как дубль.
        target.lastAlertResourceStatus = undefined;
        await sentUser(gitisResult.message, 2, true, target, "key_false");
        try {
          const snap = await target.page.content();
          const savedPath = await saveHtmlSnapshot("key_false_success", targetDisplayLabel(target), snap);
          logger.info("Saved key_false_success html snapshot", {
            target: targetDisplayLabel(target),
            path: savedPath
          });
        } catch (error) {
          logger.error("key_false_success html snapshot failed", {
            target: targetDisplayLabel(target),
            error: String(error)
          });
        }
        await disableTargetInDb(target);
        target.enabled = false;
        target.requested = false;
        logger.info("GITIS booking_success: target disabled, tab left open", {
          target: targetDisplayLabel(target)
        });
        return;
      }
      if (gitisResult.kind === "modal_missing") {
        if (wasDownBeforeCheck) {
          await sentUser(`${targetDisplayLabel(target)}_ недоступен (browser_error_page)`, 1, true, target, "unreachable");
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
        if (target.page) {
          const pickedDate = await clickFirstAvailableGitisDate(target.page);
          if (pickedDate) {
            logger.info("GITIS key_false: выбрана первая доступная дата в календаре", {
              target: targetDisplayLabel(target),
              pickedDate
            });
            const canSubmitByDate = isIsoDate(gitisSubmitBeforeDate) && pickedDate < gitisSubmitBeforeDate;
            if (!isIsoDate(gitisSubmitBeforeDate)) {
              logger.error("GITIS submit date threshold is invalid, submit disabled by date", {
                target: targetDisplayLabel(target),
                gitisSubmitBeforeDate
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
            try {
              const snapAfter = await target.page.content();
              const pathAfter = await saveHtmlSnapshot(
                "key_false_date_click",
                targetDisplayLabel(target),
                snapAfter
              );
              logger.info("Saved key_false_date_click html snapshot", {
                target: targetDisplayLabel(target),
                pickedDate,
                gitisSubmitBeforeDate,
                submitAllowed: canSubmitByDate,
                path: pathAfter
              });
            } catch (error) {
              logger.error("key_false_date_click html snapshot failed", {
                target: targetDisplayLabel(target),
                error: String(error)
              });
            }
            if (!canSubmitByDate) {
              const skipMsg = `${targetDisplayLabel(target)}: submit пропущен, дата ${pickedDate} не раньше порога ${gitisSubmitBeforeDate}`;
              logger.info(skipMsg, {
                target: targetDisplayLabel(target),
                pickedDate,
                gitisSubmitBeforeDate
              });
              await sentUser(skipMsg, gitisResult.statusCode, true, target, "key_ok");
              return;
            }

            if (gitisSubmitEnabled) {
              const pickedTime = await clickFirstAvailableGitisTime(target.page);
              if (!pickedTime) {
                logger.error("GITIS submit flow: no available time slot found", {
                  target: targetDisplayLabel(target)
                });
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 300));
              const submitted = await clickGitisConfirmButton(target.page);
              if (!submitted) {
                logger.error("GITIS submit flow: confirm button not found/clicked", {
                  target: targetDisplayLabel(target)
                });
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 400));
              try {
                const submitSnap = await target.page.content();
                const submitPath = await saveHtmlSnapshot(
                  "key_false_submit",
                  targetDisplayLabel(target),
                  submitSnap
                );
                logger.info("Saved key_false_submit html snapshot", {
                  target: targetDisplayLabel(target),
                  path: submitPath
                });
              } catch (error) {
                logger.error("key_false_submit html snapshot failed", {
                  target: targetDisplayLabel(target),
                  error: String(error)
                });
              }
              await new Promise((resolve) => setTimeout(resolve, 400));
              try {
                const submitResultSnap = await target.page.content();
                const submitResultPath = await saveHtmlSnapshot(
                  "ey_false_submit_result",
                  targetDisplayLabel(target),
                  submitResultSnap
                );
                logger.info("Saved ey_false_submit_result html snapshot", {
                  target: targetDisplayLabel(target),
                  path: submitResultPath
                });
              } catch (error) {
                logger.error("ey_false_submit_result html snapshot failed", {
                  target: targetDisplayLabel(target),
                  error: String(error)
                });
              }
              await sentUser(
                `${targetDisplayLabel(target)}: submit выполнен, ожидаем подтверждение фразой успешной записи`,
                gitisResult.statusCode,
                true,
                target,
                "key_false"
              );
              logger.info("GITIS submit completed: target kept enabled until booking_success phrase", {
                target: targetDisplayLabel(target),
                pickedDate,
                gitisSubmitBeforeDate
              });
            } else {
              logger.info("GITIS submit disabled by env flag after date threshold check", {
                target: targetDisplayLabel(target),
                pickedDate,
                gitisSubmitBeforeDate
              });
            }
          }
        }
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
        const msgOk =
          target.theaterId === "GITIS"
            ? `${targetDisplayLabel(target)}: Свободных дат пока нет`
            : `${targetDisplayLabel(target)}: Анкеты не принимаются`;
        await writeStatusLogIfDue(target, "key_ok", msgOk);
        // Уведомления отправляются если статус изменился, прошел интервал, или это первый цикл
        await sentUser(msgOk, 0, true, target, "key_ok");
      }
    } else if (target.searchMode === "not_contains") {
      const msgNotOpen = `${targetDisplayLabel(target)}: Запись на<b><u>${target.searchText}</u></b>не открыта`;
      await writeStatusLogIfDue(target, "key_ok", msgNotOpen);
      // Уведомления отправляются если статус изменился, прошел интервал, или это первый цикл
      await sentUser(msgNotOpen, 0, true, target, "key_ok", "HTML");
    } else if (target.theaterId === "GITIS" || target.theaterId === "SHEPKIN") {
      const msgOk2 =
      target.theaterId === "GITIS"
        ? `Дату не нашёл !! ${targetDisplayLabel(target)}`
        : `Фразу, что сбор Анкет прекращён не нашёл, проверь !! ${targetDisplayLabel(target)}`;
      await sentUser(msgOk2, 0, true, target, "key_error");
      const snap = await target.page.content();
      const savedPath = await saveHtmlSnapshot("key_error", targetDisplayLabel(target), snap);
      logger.info("Saved key_error html snapshot", { target: targetDisplayLabel(target), path: savedPath });
    } 
  } catch (error) {
    const message = String(error);
    logger.error("error_puppeteerDebug", { dateNow, target: targetDisplayLabel(target), error: message });
    await saveVgikFedorov14TimeoutSnapshotIfNeeded(target, message);
    if (
      message.includes("ERR_NAME_NOT_RESOLVED") ||
      message.includes("ERR_CONNECTION") ||
      message.includes("ERR_INTERNET") ||
      message.includes("Navigation timeout")
    ) {
      target.availabilityState = "down";
      await sentUser(`${targetDisplayLabel(target)}_ недоступен (${message})`, 1, true, target, "unreachable");
    } else {
      target.availabilityState = "down";
      await sentUser(`${targetDisplayLabel(target)}_ недоступен (${message})`, 1, true, target, "unreachable");
    }
  } finally {
    target.requested = false;
  }
}

async function checkURL(target: RuntimeTarget): Promise<void> {
  try {
    if (!target.enabled) {
      return;
    }
    if (!target.page && browserClientRef) {
      const rebound = await browserClientRef.rebindTargetPage(target);
      if (rebound) {
        logger.info("Target page rebound by URL match", { target: targetDisplayLabel(target), url: target.url });
      }
    }
    if (!target.page) {
      logger.info("checkURL skipped: no bound page", { target: targetDisplayLabel(target), theaterId: target.theaterId });
      await writeStatusLogIfDue(target, "error", `${targetDisplayLabel(target)}: page not bound`);
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
      if (!targets[i].enabled) {
        continue;
      }
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
    cleanupOldStatusLogs().catch((error) => {
      logger.error("cleanupOldStatusLogs: async call failed", { error: String(error) });
    });
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
  logger.info("GITIS submit date threshold configured", {
    gitisSubmitBeforeDate,
    gitisSubmitEnabled
  });

  const mergedTargets = mergeStaticWithDynamicTargets(targets);

  const urlToTargetId = new Map<string, number>();

  for (const target of mergedTargets) {
    const desiredCode = targetDisplayLabel(target);
    try {
      const [row] = await withDbRetry(`runMonitor.findOrCreate target=${desiredCode}`, async () =>
        ResourceTarget.findOrCreate({
          where: { url: target.url },
          defaults: {
            code: desiredCode,
            theater_id: target.theaterId,
            url: target.url,
            enabled: target.enabled
          }
        })
      );
      row.set({
        code: desiredCode,
        theater_id: target.theaterId,
        url: target.url,
        enabled: target.enabled
      });
      await withDbRetry(`runMonitor.save target=${desiredCode} id=${row.id}`, async () => row.save());
      urlToTargetId.set(target.url, row.id);
    } catch (error) {
      logger.error("runMonitor: ResourceTarget sync failed", {
        target: targetDisplayLabel(target),
        url: target.url,
        error: String(error)
      });
      // Уведомление о падении БД
      try {
        await publishAlert({
          targetName: targetDisplayLabel(target),
          targetUrl: target.url,
          status: "error",
          message: `❗️ Ошибка при работе с БД: ${String(error)}`,
          telegramParseMode: "HTML"
        });
      } catch (alertError) {
        logger.error("runMonitor: failed to send DB down alert", {
          target: targetDisplayLabel(target),
          url: target.url,
          error: String(alertError)
        });
      }
    }
  }

  const runtimeTargets: RuntimeTarget[] = mergedTargets.filter((target) => target.enabled).map((target) => ({ ...target }));
  if (runtimeTargets.length === 0) {
    throw new Error("No enabled targets in config/targets.ts");
  }
  runtimeTargetsRef = runtimeTargets;
  urlPast = new Array(runtimeTargets.length).fill(false);

  targetIdMap.clear();
  for (const target of runtimeTargets) {
    const id = urlToTargetId.get(target.url);
    if (id === undefined) {
      logger.error("runMonitor: target id missing after sync, disabling runtime target", {
        target: targetDisplayLabel(target),
        url: target.url
      });
      target.enabled = false;
      continue;
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
