import axios from "axios";
import { OutboundPostRequest } from "../db/outboundPostRequest.model";
import { withDbRetry } from "../db/retryDb";
import { ResourceStatus } from "../db/resourceStatusLog.model";
import { logger } from "../logging/logger";
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

/** Вадим — все алерты; Софья — только key_false (дополнительно, если id отличается от Vadim). */
function resolveRecipientChatIds(status: ResourceStatus): string[] {
  const vadim = (process.env.TG_CHAT_ID_VADIM ?? "").trim();
  const sofa = (process.env.TG_CHAT_ID_SOFA ?? "").trim();
  const ids: string[] = [];
  if (vadim.length > 0) {
    ids.push(vadim);
  }
  if (status === "key_false" && sofa.length > 0 && sofa !== vadim) {
    ids.push(sofa);
  }
  return ids;
}

export async function publishAlert(input: PublishAlertInput): Promise<void> {
  const requestUrl = process.env.TELEGRAM_ALERT_URL ?? "";
  if (!requestUrl) {
    return;
  }

  const tgChatIds = resolveRecipientChatIds(input.status);

  if (tgChatIds.length === 0) {
    logger.info("publishAlert: нет получателей (TG_CHAT_ID_VADIM обязателен; при key_false добавляется TG_CHAT_ID_SOFA)", {
      target: input.targetName,
      status: input.status
    });
    try {
      const moscowDt = moscowWallClockLiteralForDb();
      const outbound = await withDbRetry(`publishAlert.createNoRecipient targetId=${input.targetId}`, async () =>
        OutboundPostRequest.create({
          target_id: input.targetId,
          req_body: { action: "resolve_recipients", result: "empty", status: input.status },
          status: "failed",
          created_at: moscowDt,
          updated_at: moscowDt
        })
      );
      outbound.error_text = "no_recipients_from_env";
      await withDbRetry(`publishAlert.saveNoRecipient targetId=${input.targetId}`, async () => outbound.save());
    } catch (error) {
      logger.error("publishAlert: failed to persist no-recipient outbound row", {
        target: input.targetName,
        targetId: input.targetId,
        error: String(error)
      });
    }
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
    let outbound: OutboundPostRequest | null = null;
    try {
      const moscowDt = moscowWallClockLiteralForDb();
      outbound = await withDbRetry(`publishAlert.create targetId=${input.targetId} tgChatId=${tgChatId}`, async () =>
        OutboundPostRequest.create({
          target_id: input.targetId,
          req_body: requestBody,
          status: "pending",
          created_at: moscowDt,
          updated_at: moscowDt
        })
      );
    } catch (error) {
      logger.error("publishAlert: failed to create outbound row", {
        target: input.targetName,
        targetId: input.targetId,
        tgChatId,
        error: String(error)
      });
    }
    if (!outbound) {
      continue;
    }
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
    try {
      await withDbRetry(`publishAlert.save targetId=${input.targetId} tgChatId=${tgChatId}`, async () => outbound.save());
    } catch (error) {
      logger.error("publishAlert: failed to save outbound row", {
        target: input.targetName,
        targetId: input.targetId,
        tgChatId,
        error: String(error)
      });
    }
  }
}
