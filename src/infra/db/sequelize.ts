import { Sequelize } from "sequelize";

export const sequelize = new Sequelize(
  process.env.DB_NAME ?? "check_url",
  process.env.DB_USER ?? "alerts_user",
  process.env.DB_PASSWORD ?? "alerts_password",
  {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? "3306"),
    dialect: "mysql",
    logging: false
  }
);
