import axios from "axios";
import { DateTime } from "luxon";
import { QueryTypes } from "sequelize";
import { ResourceStatus } from "../infra/db/resourceStatusLog.model";
import { sequelize } from "../infra/db/sequelize";
import { logger } from "../infra/logging/logger";

export interface LatestTargetRow {
  theater_id: string;
  code: string;
  url: string;
  status: ResourceStatus | null;
  details: string | null;
  detected_at: Date | null;
}

/** Экранирование для Telegram HTML (parse_mode HTML). */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttr(s: string): string {
  return escapeTelegramHtml(s).replace(/"/g, "&quot;");
}

/** Короткое имя мастера: суффикс кода после `<theater_id>_`. */
export function masterLabelFromCode(theaterId: string, code: string): string {
  const prefix = `${theaterId}_`;
  if (code.startsWith(prefix)) {
    return code.slice(prefix.length);
  }
  return code;
}

export async function queryLatestStatusPerTarget(): Promise<LatestTargetRow[]> {
  const rows = (await sequelize.query(
    `
    SELECT t.theater_id AS theater_id, t.code AS code, t.url AS url,
           sl.status AS status, sl.details AS details, sl.detected_at AS detected_at
    FROM \`target\` t
    LEFT JOIN (
      SELECT sl1.*
      FROM status_log sl1
      INNER JOIN (
        SELECT target_id, MAX(id) AS max_id FROM status_log GROUP BY target_id
      ) x ON sl1.target_id = x.target_id AND sl1.id = x.max_id
    ) sl ON sl.target_id = t.id
    WHERE t.enabled = 1
    ORDER BY t.theater_id ASC, t.code ASC
    `,
    { type: QueryTypes.SELECT }
  )) as LatestTargetRow[];
  return rows;
}

function statusTextOnly(status: ResourceStatus | null): string {
  if (!status) {
    return "нет записей";
  }
  const map: Record<ResourceStatus, string> = {
    key_ok: "key_ok",
    key_false: "key_false",
    unreachable: "unreachable",
    error: "error",
    auth: "auth",
    key_error: "key_error"
  };
  return map[status] ?? status;
}

/** Текст для колонки «Статус»: сообщение из лога (`details`), иначе код статуса / «нет записей». */
function statusMessageFromLog(r: LatestTargetRow): string {
  const d = r.details?.trim();
  if (d) {
    return d.replace(/\s+/g, " ");
  }
  if (!r.status) {
    return "нет записей";
  }
  return statusTextOnly(r.status);
}

/** Убирает фрагмент до первого `_` (префикс вида `GITIS_` / `VGIK_` в тексте лога), раз театр уже в заголовке секции. */
function stripLeadingBeforeFirstUnderscore(text: string): string {
  const t = text.trim();
  const i = t.indexOf("_");
  if (i === -1) {
    return t;
  }
  return t.slice(i + 1).trim();
}

/** Секции по театру: заголовок + строки «дата/время и текст из лога» (без `<pre>`-таблицы). */
export function buildStatusSummaryHtml(rows: LatestTargetRow[]): string {
  const nowLine = DateTime.now().setZone("Europe/Moscow").toFormat("dd.MM.yy HH:mm");

  if (rows.length === 0) {
    return `<b>Сводка мониторинга</b>\n<i>Москва: ${escapeTelegramHtml(nowLine)}</i>\n\n<i>В базе нет включённых таргетов.</i>`;
  }

  const byTheater = new Map<string, LatestTargetRow[]>();
  for (const r of rows) {
    const tid = r.theater_id || "?";
    const list = byTheater.get(tid);
    if (list) {
      list.push(r);
    } else {
      byTheater.set(tid, [r]);
    }
  }

  const theaterOrder = Array.from(byTheater.keys()).sort((a, b) => a.localeCompare(b, "ru"));

  const blocks: string[] = [];
  blocks.push("<b>Сводка мониторинга</b>");
  blocks.push("");

  for (const tid of theaterOrder) {
    const group = byTheater.get(tid)!;
    blocks.push(`<b>${escapeTelegramHtml(tid)}</b>`);
    for (const r of group) {
      let datePart: string;
      if (r.detected_at) {
        const dt = DateTime.fromJSDate(new Date(r.detected_at)).setZone("Europe/Moscow");
        datePart = dt.isValid ? dt.toFormat("dd.MM.yy HH:mm") : "—";
      } else {
        datePart = "—";
      }
      const msg = stripLeadingBeforeFirstUnderscore(statusMessageFromLog(r));
      const safeUrl = (r.url ?? "").trim();
      const msgHtml =
        safeUrl.length > 0
          ? `<a href="${escapeTelegramHtmlAttr(safeUrl)}">${escapeTelegramHtml(msg)}</a>`
          : escapeTelegramHtml(msg);
      blocks.push(`${escapeTelegramHtml(datePart)} ${msgHtml}`);
    }
    blocks.push("");
  }

  let body = blocks.join("\n").trimEnd();
  const maxLen = 3900;
  if (body.length > maxLen) {
    body = `${body.slice(0, maxLen - 40)}\n<i>… обрезано</i>`;
  }
  return body;
}

export async function enqueueTelegramHtmlReply(tgChatId: string, htmlMessage: string): Promise<void> {
  const requestUrl = (process.env.TELEGRAM_ALERT_URL ?? "").trim();
  if (!requestUrl) {
    throw new Error(
      "TELEGRAM_ALERT_URL пустой — сводка не может поставить ответ в очередь telegram_alert (укажите URL POST /v1/queue/message, тот же что для алертов)"
    );
  }
  const token = (process.env.TELEGRAM_ALERT_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("TELEGRAM_ALERT_TOKEN пустой — отклонение 401 от telegram_alert_api");
  }
  try {
    const response = await axios.post(
      requestUrl,
      {
        appCode: process.env.TELEGRAM_ALERT_APP_CODE ?? "check_url",
        botCode: process.env.TELEGRAM_ALERT_BOT_CODE ?? "main_bot",
        tgChatId,
        message: htmlMessage,
        parseMode: "html",
        payload: { source: "check_url_status_summary" }
      },
      {
        headers: {
          "x-app-token": token,
          "content-type": "application/json"
        },
        timeout: 15000,
        validateStatus: (s) => s < 500
      }
    );
    if (response.status >= 400) {
      const body =
        typeof response.data === "object" && response.data !== null
          ? JSON.stringify(response.data)
          : String(response.data);
      throw new Error(`telegram_alert_api ответил ${response.status} ${body}`);
    }
    logger.info(`Сводка: ответ поставлен в очередь telegram_alert tgChatId=${tgChatId} http=${response.status} bytes=${htmlMessage.length}`);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const data = error.response.data;
      const body =
        typeof data === "object" && data !== null ? JSON.stringify(data) : String(data ?? "");
      logger.error(
        `Сводка: ошибка POST telegram_alert ${error.response.status} ${body.slice(0, 500)}`
      );
    } else {
      logger.error(`Сводка: ошибка POST telegram_alert ${String(error)}`);
    }
    throw error;
  }
}
