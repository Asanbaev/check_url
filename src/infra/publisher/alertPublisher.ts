import axios from "axios";
import { QueryTypes } from "sequelize";
import { OutboundPostRequest } from "../db/outboundPostRequest.model";
import { ResourceStatus } from "../db/resourceStatusLog.model";
import { sequelize } from "../db/sequelize";
import { moscowWallClockLiteralForDb } from "../time/moscowDb";

export interface PublishAlertInput {
  targetId: number;
  targetName: string;
  targetUrl: string;
  status: ResourceStatus;
  message: string;
  /** Для сообщений через telegram_alert_api как parse_mode при отправке в Telegram Bot API */
  telegramParseMode?: "HTML";
}

async function loadEnabledTgChatIdsFromCheckUrlDb(): Promise<string[]> {
  const rows = (await sequelize.query(
    "SELECT telegram_id FROM `user` WHERE enabled = 1 ORDER BY id ASC",
    { type: QueryTypes.SELECT }
  )) as Array<{ telegram_id: string | number | null }>;
  return rows.map((r) => String(r.telegram_id ?? "").trim()).filter((id) => id.length > 0);
}

export async function publishAlert(input: PublishAlertInput): Promise<void> {
  const requestUrl = process.env.TELEGRAM_ALERT_URL ?? "";
  if (!requestUrl) {
    return;
  }

  let tgChatIds: string[] = [];
  try {
    tgChatIds = await loadEnabledTgChatIdsFromCheckUrlDb();
  } catch (error) {
    const moscowDt = moscowWallClockLiteralForDb();
    const outbound = await OutboundPostRequest.create({
      target_id: input.targetId,
      req_body: { action: "load_enabled_recipients_from_check_url_db" },
      status: "failed",
      created_at: moscowDt,
      updated_at: moscowDt
    });
    outbound.error_text = `enabled_recipients_load_failed: ${String(error)}`;
    await outbound.save();
    return;
  }

  if (tgChatIds.length === 0) {
    const moscowDt = moscowWallClockLiteralForDb();
    const outbound = await OutboundPostRequest.create({
      target_id: input.targetId,
      req_body: { action: "load_enabled_recipients_from_check_url_db", result: "empty" },
      status: "failed",
      created_at: moscowDt,
      updated_at: moscowDt
    });
    outbound.error_text = "no_enabled_recipients_in_check_url_db";
    await outbound.save();
    return;
  }

  for (const tgChatId of tgChatIds) {
    const requestBody: Record<string, unknown> = {
      appCode: process.env.TELEGRAM_ALERT_APP_CODE ?? "check_url",
      botCode: process.env.TELEGRAM_ALERT_BOT_CODE ?? "main_bot",
      tgChatId,
      message: input.message,
      payload: {
        targetCode: input.targetName,
        url: input.targetUrl,
        status: input.status
      }
    };
    if (input.telegramParseMode === "HTML") {
      requestBody.parseMode = "html";
    }
    const moscowDt = moscowWallClockLiteralForDb();
    const outbound = await OutboundPostRequest.create({
      target_id: input.targetId,
      req_body: requestBody,
      status: "pending",
      created_at: moscowDt,
      updated_at: moscowDt
    });
    try {
      const response = await axios.post(requestUrl, requestBody, {
        headers: {
          "x-app-token": process.env.TELEGRAM_ALERT_TOKEN ?? "",
          "content-type": "application/json"
        },
        timeout: 15000
      });
      outbound.status = "sent";
      outbound.http_status = response.status;
      outbound.res_body = response.data as Record<string, unknown>;
      outbound.error_text = null;
    } catch (error) {
      outbound.status = "failed";
      outbound.error_text = String(error);
    }
    await outbound.save();
  }
}
