import { DateTime } from "luxon";
import { Op } from "sequelize";
import { MonitorTarget } from "../config/targets";
import { loadGitisContentWithDelay } from "./gitisModule";
import { publishAlert } from "../infra/publisher/alertPublisher";
import { logger } from "../infra/logging/logger";
import { saveHtmlSnapshot } from "../infra/logging/outputHtmlLogger";
import { BrowserClient, RuntimeTarget } from "../infra/browser/browserClient";
import { ResourceStatus, ResourceStatusLog } from "../infra/db/resourceStatusLog.model";
import { ResourceTarget } from "../infra/db/resourceTarget.model";

let datePast: string | undefined;
let dateNow = "";
let intHour = Number(process.env.MSG_MIN_HOURS ?? "3");
const msgMinValue = Number(process.env.MSG_MIN_HOURS ?? "3");
const nonCriticalStatusWriteIntervalMin = Number(process.env.NON_CRITICAL_STATUS_WRITE_INTERVAL_MIN ?? "1");
const requestStuckTimeoutMs = Number(process.env.REQUEST_STUCK_TIMEOUT_MS ?? "60000");
const quietHoursStart = Number(process.env.QUIET_HOURS_START ?? "22");
const quietHoursEnd = Number(process.env.QUIET_HOURS_END ?? "7");
const nightIntervalMultiplier = Number(process.env.NIGHT_INTERVAL_MULTIPLIER ?? "60");
let intTime = Number(process.env.CHECK_INTERVAL_MS ?? "20000");
let urlPast: boolean[] = [];
let targetIdMap = new Map<string, number>();
let lastCleanupMinute: string | null = null;

function nowMoscowString(): string {
  return DateTime.local().setZone("Europe/Moscow").toFormat("yyyy-LL-dd HH:mm:ss");
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

function detectStatusType(msg: string): ResourceStatus {
  if (msg.includes("Дату не нашёл")) {
    return "key_error";
  }
  if (msg.includes("Требуется авторизация")) {
    return "auth";
  }
  if (msg.includes("Похоже есть свободные даты") || msg.includes("открыта регистрация")) {
    return "key_false";
  }
  if (msg.includes("недоступен")) {
    return "unreachable";
  }
  if (msg.includes("Ошибка") || msg.includes("error_")) {
    return "error";
  }
  return "key_ok";
}

function isBrowserErrorPage(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("err_connection_timed_out") ||
    normalized.includes("err_name_not_resolved") ||
    normalized.includes("err_internet_disconnected") ||
    normalized.includes("net::err_") ||
    normalized.includes("this site can't be reached") ||
    normalized.includes("не удается получить доступ к сайту")
  );
}

async function writeStatusLog(target: RuntimeTarget, status: ResourceStatus, details: string): Promise<void> {
  const targetId = targetIdMap.get(target.url);
  if (!targetId) {
    return;
  }
  await ResourceStatusLog.create({
    target_id: targetId,
    status,
    details,
    detected_at: new Date()
  });
}

async function cleanupOldStatusLogs(): Promise<void> {
  const minuteKey = DateTime.local().setZone("Europe/Moscow").toFormat("yyyy-LL-dd HH:mm");
  if (lastCleanupMinute === minuteKey) {
    return;
  }
  lastCleanupMinute = minuteKey;
  const threshold = DateTime.local().setZone("Europe/Moscow").minus({ days: 2 }).toJSDate();
  await ResourceStatusLog.destroy({
    where: {
      created_at: {
        [Op.lt]: threshold
      }
    }
  });
}

async function sentUser(msg: string, status: number, updDP: boolean, target: RuntimeTarget): Promise<void> {
  const statusType = detectStatusType(msg);
  const isKeyOkStatus = statusType === "key_ok";

  if (isKeyOkStatus) {
    const now = DateTime.fromISO(nowMoscowString().replace(" ", "T"));
    const baseRequestedTime = target.lastRequestedTimeBeforeUpdate ?? target.requestedTime;
    const elapsedMin =
      Math.round(
        now.diff(DateTime.fromISO(baseRequestedTime.replace(" ", "T")), "minutes").minutes * 100
      ) / 100;

    if (elapsedMin < nonCriticalStatusWriteIntervalMin) {
      logger.info("key_ok status skipped by interval", {
        target: target.name,
        status: statusType,
        elapsedMin,
        thresholdMin: nonCriticalStatusWriteIntervalMin
      });
      return;
    }
    target.requestedTime = now.toFormat("yyyy-LL-dd HH:mm:ss");
  }

  await writeStatusLog(target, statusType, msg);
  const targetId = targetIdMap.get(target.url);
  if (targetId) {
    await publishAlert({
      targetId,
      targetName: target.name,
      targetUrl: target.url,
      status: statusType,
      message: msg
    });
  }
  logger.info("Status registered", {
    target: target.name,
    status: statusType,
    message: msg,
    at: DateTime.local().setZone("Europe/Moscow").toFormat("yy-LL-dd HH:mm:ss")
  });
  target.stage = status;
  if (updDP) {
    datePast = dateNow;
  }
  if (target.waitForSelector) {
    target.datePast = dateNow;
  }
}

async function findDate(content: string): Promise<string> {
  const regex = /<td><span class="available"><span><input type="radio" name="dt" id="dt_(\d{4}\-\d{2}\-\d{2})/g;
  const dates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    dates.push(match[1]);
  }
  return dates.join(":");
}

async function puppeteerDebug(target: RuntimeTarget): Promise<void> {
  if (!target.page) {
    throw new Error(`Page is not initialized for ${target.name}`);
  }
  try {
    target.requested = true;
    await target.page.setViewport({ width: 1920, height: 1080 });
    const shouldNavigate = !target.page.url().includes(target.url);
    if (shouldNavigate) {
      await target.page.goto(target.url, {
        waitUntil: "networkidle2",
        timeout: Number(process.env.BROWSER_PAGE_GOTO_TIMEOUT_MS ?? "30000")
      });
    } else {
      await target.page.reload({ waitUntil: "networkidle2", timeout: 0 });
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
        logger.error("error_puppeteerDebug не дождался", { dateNow, target: target.name, error: String(error) });
        exists = true;
      } finally {
        target.requested = false;
      }

      if (!exists) {
        await sentUser(`${target.name}: проверь, похоже открыта регистрация !!!!`, 0, true, target);
      } else if (target.intHour >= msgMinValue || target.stage !== 0) {
        await sentUser(`${target.name}: закрыто`, 0, true, target);
      }
      return;
    }

    const rawContent = await target.page.content();
    let content = rawContent.toLowerCase();
    if (isBrowserErrorPage(content)) {
      await sentUser(`Сайт _${target.name}_ недоступен (browser_error_page)`, 1, true, target);
      return;
    }

    if (target.theaterId === "GITIS") {
      const gitis = await loadGitisContentWithDelay(target.page);
      content = gitis.content;
      if (!gitis.hasOneCourse) {
        await sentUser(
          `Дату не нашёл !! ${target.name} (модалка не открыта, .one-course не найден)`,
          0,
          true,
          target
        );
        const savedPath = await saveHtmlSnapshot("key_error", target.name, rawContent);
        logger.info("Saved key_error html snapshot (.one-course missing)", { target: target.name, path: savedPath });
        return;
      }
    }
    if (content.indexOf(target.searchText.toLowerCase()) !== -1) {
      if (target.searchMode === "not_contains") {
        await sentUser(`${target.name}: Поиск слова '${target.searchText}' положительный, открыли запись!!!`, 0, true, target);
      } else if (intHour >= msgMinValue || target.stage !== 0) {
        await sentUser(`${target.name}: Свободных дат пока нет`, 0, true, target);
      }
    } else if (target.searchMode === "not_contains") {
      if (intHour >= msgMinValue || target.stage !== 0) {
        await sentUser(`${target.name}: Запись на<b><u>${target.searchText}</u></b>не открыта`, 0, true, target);
      }
    } else if (content.indexOf("прослушивание доступна зарегистрированным пользователям") === -1) {
      if (target.theaterId === "GITIS") {
        const dates = await findDate(content);
        if (dates !== "") {
          if (!(target.name === "GITIS_Пирогов" && dates === "2026-05-20")) {
            await sentUser(`!!! ${target.name}: Похоже есть свободные даты ${dates} !!!`, 2, true, target);
          }
        } else {
          await sentUser(`Дату не нашёл !! ${target.name}`, 0, true, target);
          const savedPath = await saveHtmlSnapshot("key_error", target.name, rawContent);
          logger.info("Saved key_error html snapshot", { target: target.name, path: savedPath });
        }
      }
    } else {
      await sentUser(`Требуется авторизация на сайте!! ${target.name}`, 0, true, target);
      const savedPath = await saveHtmlSnapshot("auth", target.name, rawContent);
      logger.info("Saved auth html snapshot", { target: target.name, path: savedPath });
    }
  } catch (error) {
    const message = String(error);
    logger.error("error_puppeteerDebug", { dateNow, target: target.name, error: message });
    if (
      message.includes("ERR_NAME_NOT_RESOLVED") ||
      message.includes("ERR_CONNECTION") ||
      message.includes("ERR_INTERNET") ||
      message.includes("Navigation timeout")
    ) {
      await sentUser(`Сайт _${target.name}_ недоступен (${message})`, 1, true, target);
    } else {
      await sentUser(`error_puppeteerDebug : ${dateNow} ${target.name}`, 1, true, target);
    }
  } finally {
    target.requested = false;
  }
}

async function checkURL(target: RuntimeTarget): Promise<void> {
  try {
    if (target.requested) {
      logger.info("checkURL skipped: request already in progress", { target: target.name, at: nowMoscowString() });
      return;
    }
    target.lastRequestedTimeBeforeUpdate = target.requestedTime;
    target.requestedTime = dateNow;

    if (target.datePast) {
      target.intHour = Math.round(
        DateTime.fromISO(dateNow.replace(" ", "T"))
          .diff(DateTime.fromISO(target.datePast.replace(" ", "T")), "hours")
          .hours * 100
      ) / 100;
    }

    await puppeteerDebug(target);
  } catch (error) {
    logger.error("error_checkURL", { dateNow, target: target.name, error: String(error) });
    await sentUser(`error_checkURL : ${dateNow}`, 1, true, target);
  }
}

async function checkSelect(target: RuntimeTarget): Promise<void> {
  if (!target.page) {
    return;
  }
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
    logger.error("error_options", { target: target.name, error: String(error) });
  }

  if (options[0] && options[0].text === "В настоящий момент свободных дат для записи нет. Ждите.") {
    await sentUser("нету дат", 0, false, target);
  } else if (options[0]) {
    await sentUser("проверь похоже есть дата", 0, false, target);
  }
}


// главный цикл планировщика.
// ставит текущий таймштамп цикла, проходит по всем таргетам и решает, кому запускать checkURL(),
// контролирует «застревание» через requested + timeout, запускает очистку старых логов,
// и в конце планирует следующий запуск setTimeout(..., nextCycleMs())
async function checkSite(targets: RuntimeTarget[]): Promise<void> {
  let text = "";
  dateNow = nowMoscowString();
  try {
    const nextMs = nextCycleMs();
    logger.info("Check cycle tick", { at: dateNow, nextCycleMs: nextMs });

    for (let i = 0; i < targets.length; i += 1) {
      if (urlPast[i] && !targets[i].waitForSelector) {
        text += `${targets[i].name} : ${urlPast[i]}; `;
      }
      urlPast[i] = targets[i].requested;
    }

    if (datePast) { // нужен как глобальная метка времени последнего “значимого” события, чтобы считать intHour (сколько часов прошло) и не слать/не писать одинаковые не-критичные статусы слишком часто.
      intHour = Math.round(
        DateTime.fromISO(dateNow.replace(" ", "T")).diff(DateTime.fromISO(datePast.replace(" ", "T")), "hours").hours * 100
      ) / 100;
    }

    for (let i = 0; i < targets.length; i += 1) {
      const elapsedMs = DateTime.fromISO(dateNow.replace(" ", "T"))
        .diff(DateTime.fromISO(targets[i].requestedTime.replace(" ", "T")), "milliseconds")
        .milliseconds;
      if (targets[i].requested && elapsedMs >= requestStuckTimeoutMs) {
        logger.error("Request stuck timeout reached, forcing unlock", {
          target: targets[i].name,
          elapsedMs: Math.round(elapsedMs),
          timeoutMs: requestStuckTimeoutMs
        });
        targets[i].requested = false;
      }
      if (!targets[i].requested) {
        setTimeout(() => void checkURL(targets[i]), 1000 * i);
      }
    }
    await cleanupOldStatusLogs();
    if (text !== "") {
      await sentUser(`Страницы не обновляются ${text}`, 1, true, targets[0]);
    }
  } catch (error) {
    logger.error("error_checkSite", { dateNow, error: String(error) });
    await sentUser(`error_checkSite : ${dateNow}`, 1, true, targets[0]);
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
  const runtimeTargets: RuntimeTarget[] = targets.filter((target) => target.enabled).map((target) => ({ ...target }));
  if (runtimeTargets.length === 0) {
    throw new Error("No enabled targets in config/targets.ts");
  }
  urlPast = new Array(runtimeTargets.length).fill(false);

  const browserClient = new BrowserClient();
  await browserClient.connect();
  await browserClient.bindPages(runtimeTargets);

  for (const target of runtimeTargets) {
    const [row] = await ResourceTarget.findOrCreate({
      where: { url: target.url },
      defaults: { code: target.name, theater_id: target.theaterId, url: target.url, enabled: target.enabled }
    });
    targetIdMap.set(target.url, row.id);
    if (
      row.code !== target.name ||
      row.url !== target.url ||
      row.enabled !== target.enabled ||
      row.theater_id !== target.theaterId
    ) {
      row.code = target.name;
      row.theater_id = target.theaterId;
      row.url = target.url;
      row.enabled = target.enabled;
      await row.save();
    }
  }

  const mode = process.env.MONITOR_MODE ?? "general";
  if (mode === "rgsi") {
    await checkSiteRgsi(runtimeTargets);
    return;
  }
  await checkSite(runtimeTargets);
}
