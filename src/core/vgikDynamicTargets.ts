import fs from "node:fs";
import path from "node:path";
import type { MonitorTarget, SearchMode } from "../config/targets";
import { logger } from "../infra/logging/logger";

const OUTPUTS_DIR = path.resolve(__dirname, "../../outputs");
export const VGIK_DYNAMIC_TARGETS_FILE = path.join(OUTPUTS_DIR, "vgik_dynamic_targets.json");

export type VgikDynamicStored = Pick<
  MonitorTarget,
  | "name"
  | "theaterId"
  | "url"
  | "enabled"
  | "searchText"
  | "searchMode"
  | "waitForSelector"
  | "requested"
  | "requestedTime"
  | "stage"
  | "msgElapsedHours"
  | "successText"
  | "submitting"
>;

function ensureOutputsDir(): void {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

export function parseTimepadEventId(url: string): number | null {
  try {
    const m = url.match(/priemvgik\.timepad\.ru\/event\/(\d+)/i);
    if (!m) {
      return null;
    }
    const id = Number.parseInt(m[1], 10);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function readJsonFile(): VgikDynamicStored[] {
  try {
    if (!fs.existsSync(VGIK_DYNAMIC_TARGETS_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(VGIK_DYNAMIC_TARGETS_FILE, "utf8").trim();
    if (!raw) {
      return [];
    }
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) {
      return [];
    }
    return data as VgikDynamicStored[];
  } catch (error) {
    logger.error("vgik_dynamic_targets: read failed", { error: String(error) });
    return [];
  }
}

export function writeDynamicTargetsFile(rows: VgikDynamicStored[]): void {
  try {
    ensureOutputsDir();
    fs.writeFileSync(VGIK_DYNAMIC_TARGETS_FILE, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  } catch (error) {
    logger.error("vgik_dynamic_targets: write failed", { error: String(error) });
  }
}

/** Слияние: статические таргеты + записи из файла, которых нет в static по url. */
export function mergeStaticWithDynamicTargets(staticTargets: MonitorTarget[]): MonitorTarget[] {
  const fromFile = readJsonFile();
  const staticUrls = new Set(staticTargets.map((t) => t.url));
  const extras: MonitorTarget[] = [];
  for (const row of fromFile) {
    if (!row.url || staticUrls.has(row.url)) {
      continue;
    }
    extras.push({
      name: row.name,
      theaterId: row.theaterId ?? "VGIK",
      url: row.url,
      enabled: row.enabled !== false,
      searchText: row.searchText,
      searchMode: (row.searchMode ?? "contains") as SearchMode,
      waitForSelector: row.waitForSelector ?? false,
      requested: false,
      requestedTime: row.requestedTime ?? "2026-04-01 15:00:00",
      stage: row.stage ?? 0,
      msgElapsedHours: row.msgElapsedHours ?? 3,
      successText: row.successText ?? "%%__NO_MATCH__QWERTY_ЪЫЬ_92731__%%",
      submitting: row.submitting === true
    });
  }
  return [...staticTargets, ...extras];
}

export function upsertDynamicTargetRow(row: VgikDynamicStored): void {
  const rows = readJsonFile();
  const idx = rows.findIndex((r) => r.url === row.url);
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...row };
  } else {
    rows.push(row);
  }
  writeDynamicTargetsFile(rows);
}

export function buildNewTimepadDynamicTarget(
  eventUrl: string,
  eventId: number,
  template: Pick<MonitorTarget, "searchText" | "searchMode" | "msgElapsedHours" | "successText">
): MonitorTarget {
  const normalizedUrl = eventUrl.replace(/\/?$/, "/");
  return {
    name: `Timepad_${eventId}`,
    theaterId: "VGIK",
    url: normalizedUrl,
    enabled: true,
    submitting: false,
    searchText: template.searchText,
    searchMode: template.searchMode,
    waitForSelector: false,
    requested: false,
    requestedTime: "2026-04-01 15:00:00",
    stage: 0,
    msgElapsedHours: template.msgElapsedHours,
    successText: template.successText
  };
}

export function toStoredRow(t: MonitorTarget): VgikDynamicStored {
  return {
    name: t.name,
    theaterId: t.theaterId,
    url: t.url,
    enabled: t.enabled,
    searchText: t.searchText,
    searchMode: t.searchMode,
    waitForSelector: t.waitForSelector,
    requested: false,
    requestedTime: t.requestedTime,
    stage: t.stage,
    msgElapsedHours: t.msgElapsedHours,
    successText: t.successText,
    submitting: t.submitting === true
  };
}
