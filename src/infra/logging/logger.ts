import { DateTime } from "luxon";

function logPrefix(level: "INFO" | "ERROR"): string {
  const ts = DateTime.local().setZone("Europe/Moscow").toFormat("yy-LL-dd HH:mm:ss");
  return `${ts} [check_url][${level}]`;
}

function formatExtra(payload?: unknown): string {
  if (payload === undefined) {
    return "";
  }
  if (payload === null) {
    return " null";
  }
  if (typeof payload === "string") {
    return ` ${payload}`;
  }
  return ` ${JSON.stringify(payload)}`;
}

export const logger = {
  info(message: string, payload?: unknown): void {
    console.log(`${logPrefix("INFO")} ${message}${formatExtra(payload)}`);
  },
  error(message: string, payload?: unknown): void {
    console.error(`${logPrefix("ERROR")} ${message}${formatExtra(payload)}`);
  }
};
