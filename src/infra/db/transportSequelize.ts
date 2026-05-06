import { Sequelize } from "sequelize";

export const transportSequelize = new Sequelize(
  process.env.TA_DB_NAME ?? "telegram_alert_api",
  process.env.TA_DB_USER ?? "alerts_user",
  process.env.TA_DB_PASSWORD ?? "alerts_password",
  {
    host: process.env.TA_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.TA_DB_PORT ?? "3306"),
    dialect: "mysql",
    logging: false
  }
);
