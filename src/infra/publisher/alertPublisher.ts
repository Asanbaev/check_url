import axios from "axios";
import { OutboundPostRequest } from "../db/outboundPostRequest.model";
import { ResourceStatus } from "../db/resourceStatusLog.model";

export interface PublishAlertInput {
  targetId: number;
  targetName: string;
  targetUrl: string;
  status: ResourceStatus;
  message: string;
}

export async function publishAlert(input: PublishAlertInput): Promise<void> {
  const requestUrl = process.env.TELEGRAM_ALERT_URL ?? "";
  const requestBody = {
    appCode: process.env.TELEGRAM_ALERT_APP_CODE ?? "check_url",
    botCode: process.env.TELEGRAM_ALERT_BOT_CODE ?? "main_bot",
    tgChatId: Number(process.env.DEFAULT_TG_CHAT_ID ?? "0"),
    message: input.message,
    payload: {
      targetCode: input.targetName,
      url: input.targetUrl,
      status: input.status
    }
  };

  const outbound = await OutboundPostRequest.create({
    target_id: input.targetId,
    url: requestUrl || "telegram_alert_disabled",
    req_body: requestBody,
    status: "pending"
  });

  if (!requestUrl) {
    outbound.status = "failed";
    outbound.error_text = "telegram_alert_api_url_missing";
    await outbound.save();
    return;
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
  await outbound.save();
}
