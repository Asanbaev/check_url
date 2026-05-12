import fs from "node:fs";
import path from "node:path";
import type { MonitorTarget, SearchMode } from "../config/targets";
import { logger } from "../infra/logging/logger";

const STATE_DIR = path.resolve(__dirname, "../../state");
export const VGIK_TARGETS_STATE_FILE = path.join(STATE_DIR, "vgik_targets.json");

export type VgikWorkshop = "merzlikin" | "fyodorov";

export interface PersistedVgikTarget extends MonitorTarget {
  vgikDynamic?: boolean;
  vgikRegistrationFilled?: boolean;
  vgikWorkshop?: VgikWorkshop;
  vgikSubmitReserved?: boolean;
  vgikSubmitOnly?: boolean;
}

export type VgikDynamicStored = Pick<
  PersistedVgikTarget,
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
  | "vgikDynamic"
  | "vgikRegistrationFilled"
  | "vgikWorkshop"
  | "vgikSubmitReserved"
  | "vgikSubmitOnly"
>;

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
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
    if (!fs.existsSync(VGIK_TARGETS_STATE_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(VGIK_TARGETS_STATE_FILE, "utf8").trim();
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
    ensureStateDir();
    fs.writeFileSync(VGIK_TARGETS_STATE_FILE, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  } catch (error) {
    logger.error("vgik_dynamic_targets: write failed", { error: String(error) });
  }
}

function applyStoredRow(base: MonitorTarget, row: VgikDynamicStored): PersistedVgikTarget {
  return {
    ...base,
    enabled: row.enabled !== false,
    requested: false,
    requestedTime: row.requestedTime ?? base.requestedTime,
    stage: row.stage ?? base.stage,
    submitting: row.submitting === true,
    vgikDynamic: false,
    vgikRegistrationFilled: row.vgikRegistrationFilled === true,
    vgikWorkshop: row.vgikWorkshop,
    vgikSubmitReserved: row.vgikSubmitReserved === true,
    vgikSubmitOnly: row.vgikSubmitOnly === true
  };
}

/** Слияние: статические таргеты + persisted state по URL + dynamic VGIK target-ы, которых нет в static. */
export function mergeStaticWithDynamicTargets(staticTargets: MonitorTarget[]): PersistedVgikTarget[] {
  const fromFile = readJsonFile();
  const rowsByUrl = new Map(fromFile.map((row) => [row.url, row]));
  const mergedStatic: PersistedVgikTarget[] = staticTargets.map((target) => {
    const row = rowsByUrl.get(target.url);
    if (!row) {
      return { ...target };
    }
    return applyStoredRow(target, row);
  });
  const staticUrls = new Set(mergedStatic.map((t) => t.url));
  const extras: PersistedVgikTarget[] = [];
  for (const row of fromFile) {
    if (!row.url || staticUrls.has(row.url) || row.vgikDynamic !== true) {
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
      submitting: row.submitting === true,
      vgikDynamic: true,
      vgikRegistrationFilled: row.vgikRegistrationFilled === true,
      vgikWorkshop: row.vgikWorkshop,
      vgikSubmitReserved: row.vgikSubmitReserved === true,
      vgikSubmitOnly: row.vgikSubmitOnly === true
    });
  }
  return [...mergedStatic, ...extras];
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
  template: Pick<MonitorTarget, "msgElapsedHours">
): PersistedVgikTarget {
  const normalizedUrl = eventUrl.replace(/\/?$/, "/");
  return {
    name: `Timepad_${eventId}`,
    theaterId: "VGIK",
    url: normalizedUrl,
    enabled: true,
    submitting: false,
    searchText: "регистрация на предварительное прослушивание закрыта, так как все места уже заняты!",
    searchMode: "contains",
    waitForSelector: true,
    requested: false,
    requestedTime: "2026-04-01 15:00:00",
    stage: 0,
    msgElapsedHours: template.msgElapsedHours,
    successText: "%%__NO_MATCH__QWERTY_ЪЫЬ_92731__%%",
    vgikDynamic: true,
    vgikRegistrationFilled: false,
    vgikSubmitReserved: false,
    vgikSubmitOnly: false
  };
}

export function findReservedWorkshopTargetUrl(workshop: VgikWorkshop): string | undefined {
  return readJsonFile().find((row) => row.vgikWorkshop === workshop && row.vgikSubmitReserved === true)?.url;
}

export function toStoredRow(t: PersistedVgikTarget): VgikDynamicStored {
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
    submitting: t.submitting === true,
    vgikDynamic: t.vgikDynamic === true,
    vgikRegistrationFilled: t.vgikRegistrationFilled === true,
    vgikWorkshop: t.vgikWorkshop,
    vgikSubmitReserved: t.vgikSubmitReserved === true,
    vgikSubmitOnly: t.vgikSubmitOnly === true
  };
}
