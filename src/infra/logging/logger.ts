import { DateTime } from "luxon";

function logPrefix(level: "INFO" | "ERROR"): string {
  const ts = DateTime.local().setZone("Europe/Moscow").toFormat("yy-LL-dd HH:mm:ss");
  return `${ts} [check_url][${level}]`;
}

export const logger = {
  info(message: string, payload?: unknown): void {
    console.log(`${logPrefix("INFO")} ${message}`, payload ?? "");
  },
  error(message: string, payload?: unknown): void {
    console.error(`${logPrefix("ERROR")} ${message}`, payload ?? "");
  }
};
