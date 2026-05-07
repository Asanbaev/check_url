import { Op } from "sequelize";
import { buildStatusSummaryHtml, enqueueTelegramHtmlReply, queryLatestStatusPerTarget } from "./statusSummaryReply";
import { InboundTransportRequest } from "../infra/db/inboundTransportRequest.model";
import { withDbRetry } from "../infra/db/retryDb";
import { logger } from "../infra/logging/logger";

const TRANSPORT_CODE = "status_summary";

export async function runStatusSummaryDbPoller(): Promise<void> {
  const pollMs = Number(process.env.STATUS_SUMMARY_DB_POLL_MS ?? "10000");
  const batchSize = Math.max(1, Number(process.env.STATUS_SUMMARY_DB_POLL_BATCH_SIZE ?? "20"));
  const appCode = (process.env.STATUS_SUMMARY_TRANSPORT_APP_CODE ?? "check_url").trim();
  const maxAttempts = Math.max(1, Number(process.env.STATUS_SUMMARY_DB_MAX_ATTEMPTS ?? "10"));

  async function tick(): Promise<void> {
    try {
      const rows = await withDbRetry(`statusSummaryDbPoller.findAll app=${appCode}`, async () =>
        InboundTransportRequest.findAll({
          where: {
            transport_code: TRANSPORT_CODE,
            app_code: appCode,
            status: { [Op.in]: ["pending", "failed"] },
            attempts: { [Op.lt]: maxAttempts }
          },
          order: [["id", "ASC"]],
          limit: batchSize
        })
      );

      for (const row of rows) {
        const [lockedCount] = await withDbRetry(`statusSummaryDbPoller.lock id=${row.id}`, async () =>
          InboundTransportRequest.update(
            { status: "processing", error_text: null },
            { where: { id: row.id, status: row.status } }
          )
        );
        if (lockedCount === 0) {
          continue;
        }

        try {
          const tgChatId = (row.tg_chat_id ?? "").trim();
          if (!tgChatId) {
            throw new Error("tg_chat_id_missing");
          }

          const summaryRows = await queryLatestStatusPerTarget();
          const html = buildStatusSummaryHtml(summaryRows);
          await enqueueTelegramHtmlReply(tgChatId, html);

          row.status = "done";
          row.processed_at = new Date();
          row.error_text = null;
        } catch (error) {
          row.status = "failed";
          row.error_text = String(error);
          logger.error("status-summary db poller request failed", {
            id: row.id,
            tgChatId: row.tg_chat_id,
            error: String(error)
          });
        } finally {
          row.attempts += 1;
          await withDbRetry(`statusSummaryDbPoller.save id=${row.id}`, async () => row.save());
        }
      }
    } catch (error) {
      logger.error("status-summary db poller tick failed", { error: String(error) });
    } finally {
      setTimeout(() => void tick(), pollMs);
    }
  }

  logger.info("Status-summary DB poller started", { pollMs, batchSize, appCode, maxAttempts });
  await tick();
}
