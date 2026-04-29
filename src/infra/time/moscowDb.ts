import { DateTime } from "luxon";
import { literal } from "sequelize";

/** Строка DATETIME Europe/Moscow для MySQL (наивное «настенное» время). */
export function moscowWallClockForDb(): string {
  return DateTime.now().setZone("Europe/Moscow").toFormat("yyyy-LL-dd HH:mm:ss");
}

/** SQL-литерал, чтобы драйвер не пересобирал значение в TZ процесса Node. */
export function moscowWallClockLiteralForDb(): Date {
  const s = moscowWallClockForDb().replace(/'/g, "''");
  return literal(`'${s}'`) as unknown as Date;
}
