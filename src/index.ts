import "dotenv/config";
import { targets } from "./config/targets";
import { runMonitor } from "./core/monitor";
import { OutboundPostRequest } from "./infra/db/outboundPostRequest.model";
import { ResourceStatusLog } from "./infra/db/resourceStatusLog.model";
import { ResourceTarget } from "./infra/db/resourceTarget.model";
import { sequelize } from "./infra/db/sequelize";
import { logger } from "./infra/logging/logger";

async function bootstrap(): Promise<void> {
  await sequelize.authenticate();
  await ResourceTarget.sync();
  await ResourceStatusLog.sync();
  await OutboundPostRequest.sync();
  logger.info("Database initialized");
  await runMonitor(targets);
}

bootstrap().catch((error) => {
  logger.error("Fatal startup error", error);
  process.exit(1);
});
