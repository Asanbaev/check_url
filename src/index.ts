import "dotenv/config";
import { targets } from "./config/targets";
import { runMonitor } from "./core/monitor";
import { runStatusSummaryDbPoller } from "./core/statusSummaryDbPoller";
import { listenStatusSummaryServer } from "./http/statusSummaryServer";
import { InboundTransportRequest } from "./infra/db/inboundTransportRequest.model";
import { OutboundPostRequest } from "./infra/db/outboundPostRequest.model";
import { ResourceStatusLog } from "./infra/db/resourceStatusLog.model";
import { ResourceTarget } from "./infra/db/resourceTarget.model";
import { withDbRetry } from "./infra/db/retryDb";
import { sequelize } from "./infra/db/sequelize";
import { transportSequelize } from "./infra/db/transportSequelize";
import { logger } from "./infra/logging/logger";

async function bootstrap(): Promise<void> {
  try {
    await withDbRetry("bootstrap.sequelize.authenticate", async () => sequelize.authenticate());
    await withDbRetry("bootstrap.ResourceTarget.sync", async () => ResourceTarget.sync());
    await withDbRetry("bootstrap.ResourceStatusLog.sync", async () => ResourceStatusLog.sync());
    await withDbRetry("bootstrap.OutboundPostRequest.sync", async () => OutboundPostRequest.sync());
    logger.info("Database initialized");
  } catch (error) {
    logger.error("Database init failed, continue without guaranteed DB writes", { error: String(error) });
  }

  const ingressMode = (process.env.STATUS_SUMMARY_INGRESS_MODE ?? "http").trim().toLowerCase();
  if (ingressMode === "db") {
    try {
      await withDbRetry("bootstrap.transportSequelize.authenticate", async () => transportSequelize.authenticate());
      await withDbRetry("bootstrap.InboundTransportRequest.sync", async () => InboundTransportRequest.sync());
      logger.info("Transport DB initialized");
      await runStatusSummaryDbPoller();
    } catch (error) {
      logger.error("Transport DB init failed, fallback to HTTP ingress", { error: String(error) });
      const port = Number(process.env.PORT ?? "1342");
      listenStatusSummaryServer(port);
    }
  } else {
    const port = Number(process.env.PORT ?? "1342");
    listenStatusSummaryServer(port);
  }

  await runMonitor(targets);
}

bootstrap().catch((error) => {
  logger.error("Fatal startup error", error);
  process.exit(1);
});
