import express, { Request, Response } from "express";
import {
  buildStatusSummaryHtml,
  enqueueTelegramHtmlReply,
  queryLatestStatusPerTarget
} from "../core/statusSummaryReply";
import { logger } from "../infra/logging/logger";

function requireAlertToken(req: Request): void {
  const token = req.header("x-app-token");
  const expected = process.env.TELEGRAM_ALERT_TOKEN ?? "";
  if (!token || !expected || token !== expected) {
    throw new Error("unauthorized");
  }
}

export function createStatusSummaryApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  /** Вызывается из telegram_alert при любом тексте от пользователя: сводка → очередь ответа этому tgChatId. */
  app.post("/v1/status-summary", async (req: Request, res: Response) => {
    try {
      requireAlertToken(req);
      const tgChatIdRaw = req.body?.tgChatId;
      const tgChatId = tgChatIdRaw !== undefined && tgChatIdRaw !== null ? String(tgChatIdRaw).trim() : "";
      if (!tgChatId) {
        return res.status(400).json({ ok: false, error: { code: "VALIDATION_ERROR", message: "tgChatId required" } });
      }

      logger.info(`Получен запрос от telegram_alert (status-summary), tgChatId=${tgChatId}`);

      const rows = await queryLatestStatusPerTarget();
      const html = buildStatusSummaryHtml(rows);
      logger.info(`Сводка: собрано таргетов ${rows.length}, длина HTML ${html.length}`);
      // ВРЕМЕННО: полный текст сводки (убрать после отладки)
      logger.info(`Сводка HTML..`);
      await enqueueTelegramHtmlReply(tgChatId, html);

      return res.json({ ok: true, data: { targets: rows.length } });
    } catch (error) {
      if (String(error).includes("unauthorized")) {
        return res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "invalid x-app-token" } });
      }
      logger.error("status-summary handler failed", { error: String(error) });
      return res.status(500).json({ ok: false, error: { code: "INTERNAL", message: String(error) } });
    }
  });

  return app;
}

export function listenStatusSummaryServer(port: number): void {
  const app = createStatusSummaryApp();
  app.listen(port, () => {
    logger.info("Status summary HTTP listening", { port, path: "/v1/status-summary" });
  });
}
