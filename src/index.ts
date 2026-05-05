import "dotenv/config";
import { targets } from "./config/targets";
import { runMonitor } from "./core/monitor";
import { listenStatusSummaryServer } from "./http/statusSummaryServer";
import { OutboundPostRequest } from "./infra/db/outboundPostRequest.model";
import { ResourceStatusLog } from "./infra/db/resourceStatusLog.model";
import { ResourceTarget } from "./infra/db/resourceTarget.model";
import { sequelize } from "./infra/db/sequelize";
import { logger } from "./infra/logging/logger";

async function bootstrap(): Promise<void> {
  try {
    await sequelize.authenticate();
    await ResourceTarget.sync();
    await ResourceStatusLog.sync();
    await OutboundPostRequest.sync();
    logger.info("Database initialized");
  } catch (error) {
    logger.error("Database init failed, continue without guaranteed DB writes", { error: String(error) });
  }

  const port = Number(process.env.PORT ?? "1342");
  listenStatusSummaryServer(port);

  await runMonitor(targets);
}

bootstrap().catch((error) => {
  logger.error("Fatal startup error", error);
  process.exit(1);
});
