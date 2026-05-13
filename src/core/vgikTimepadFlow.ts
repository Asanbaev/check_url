import type { Frame, Page } from "puppeteer";
import type { ResourceStatus } from "../infra/db/resourceStatusLog.model";
import { logger } from "../infra/logging/logger";
import { saveHtmlSnapshot } from "../infra/logging/outputHtmlLogger";
import type { RuntimeTarget } from "../infra/browser/browserClient";
import { targetDisplayLabel } from "../config/targets";
import type { VgikSubmitForm } from "./vgikSubmitForm";
import { DEFAULT_VGIK_SUBMIT_FORM } from "./vgikSubmitForm";
import {
  findReservedWorkshopTargetUrl,
  parseTimepadEventId,
  toStoredRow,
  upsertDynamicTargetRow,
  type VgikWorkshop
} from "./vgikDynamicTargets";

const SURNAME_MARKER = "user_forms[0][surname]";
const VGIK_SUBMIT_SUCCESS_MARKERS = [
  "вы только что зарегистрировались",
  "ваша регистрация прошла успешно",
  "регистрация прошла успешно",
  "билет отправлен",
  "ваше сообщение успешно отправлено"
];
// по идее надо привязаться к этому маркеру :
// Произошла неизвестная ошибка при отправке, попробуйте еще.
const VGIK_SUBMIT_BLOCKING_MARKERS = ["мест нет", "ошибка", "больше не осталось"];

export function isPriemvgikEventUrl(url: string): boolean {
  return /priemvgik\.timepad\.ru\/event\/\d+/i.test(url);
}

export async function syncPriemvgikCookiesToTarget(target: RuntimeTarget): Promise<void> {
  if (!target.page) {
    return;
  }
  try {
    const cookies = await target.page.cookies("https://priemvgik.timepad.ru/");
    target.priemvgikCookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (error) {
    logger.info("syncPriemvgikCookiesToTarget: skip", {
      target: targetDisplayLabel(target),
      error: String(error)
    });
  }
}

export async function getTimepadRegisterFrame(page: Page): Promise<Frame | null> {
  const iframeTimeout = Number(
    process.env.VGIK_MAI_TIMEPAD_IFRAME_WAIT_MS ?? process.env.BROWSER_PAGE_GOTO_TIMEOUT_MS ?? "30000"
  );
  try {
    await page.waitForSelector('iframe[name^="tpw__"]', { timeout: iframeTimeout });
  } catch {
    return null;
  }
  const handle = await page.$('iframe[name^="tpw__"]');
  if (!handle) {
    return null;
  }
  return handle.contentFrame();
}

async function findTimepadRegisterFrame(page: Page): Promise<Frame | null> {
  const handle = await page.$('iframe[name^="tpw__"]');
  if (!handle) {
    return null;
  }
  return handle.contentFrame();
}

function workshopFromText(text: string): VgikWorkshop | null {
  const t = text.toLowerCase();
  if (t.includes("мерзликин")) {
    return "merzlikin";
  }
  if (t.includes("фёдоров") || t.includes("федоров")) {
    return "fyodorov";
  }
  return null;
}

type NotifyFn = (msg: string, status: ResourceStatus) => Promise<void>;

function labelToSemanticKey(labelNorm: string): keyof VgikSubmitForm | null {
  if (labelNorm.includes("фамил")) {
    return "surname";
  }
  if (labelNorm.match(/\bимя\b/) || (labelNorm.includes("имя") && !labelNorm.includes("фамили"))) {
    return "name";
  }
  if (labelNorm.includes("отчеств")) {
    return "patronymic";
  }
  if (labelNorm.includes("снилс")) {
    return "snils";
  }
  if (labelNorm.includes("паспорт")) {
    return "passportSeriesNumber";
  }
  if (labelNorm.includes("возраст")) {
    return "age";
  }
  if (labelNorm.includes("город")) {
    return "city";
  }
  if (labelNorm.includes("телефон") || labelNorm.includes("номер")) {
    return "phone";
  }
  if (labelNorm.includes("e-mail") || labelNorm.includes("email") || labelNorm.includes("почт")) {
    return "mail";
  }
  return null;
}

async function collectPostPayloadFromFrame(frame: Frame): Promise<Record<string, string>> {
  return frame.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>("form#eventreg_form");
    if (!form) {
      return {};
    }
    const out: Record<string, string> = {};
    const fd = new FormData(form);
    fd.forEach((v, k) => {
      out[k] = typeof v === "string" ? v : "";
    });
    return out;
  });
}

async function applyPresetToFrame(frame: Frame, preset: VgikSubmitForm, questionMap: Record<string, keyof VgikSubmitForm>): Promise<void> {
  await frame.evaluate(
    (p, qmap) => {
      const form = document.querySelector<HTMLFormElement>("form#eventreg_form");
      if (!form) {
        return;
      }
      const setVal = (name: string, value: string) => {
        const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          `[name="${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`
        );
        if (!el || !("value" in el)) {
          return;
        }
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      setVal("user_forms[0][surname]", p.surname);
      setVal("user_forms[0][name]", p.name);
      for (const [qname, sem] of Object.entries(qmap)) {
        const v = p[sem as keyof typeof p];
        if (typeof v === "string") {
          setVal(qname, v);
        }
      }
      setVal("user_forms[0][mail]", p.mail);
      const sub = form.querySelector<HTMLInputElement>('input[name="subscribe_digest"]');
      if (sub && p.subscribeDigest) {
        sub.checked = true;
      }
      const acc = form.querySelector<HTMLInputElement>('input[name="accepted_terms"]');
      if (acc && p.acceptedTerms) {
        acc.checked = true;
      }
    },
    preset,
    questionMap
  );
}

async function buildQuestionMapFromFrame(frame: Frame): Promise<Record<string, keyof VgikSubmitForm>> {
  return frame.evaluate(() => {
    const map: Record<string, string> = {};
    const rows = document.querySelectorAll<HTMLElement>(".control-group.b-reg-row[data-formname]");
    rows.forEach((row) => {
      const formName = row.getAttribute("data-formname") ?? "";
      if (!formName.includes("user_forms[0][question")) {
        return;
      }
      const label = row.querySelector(".b-registration__question");
      const labelText = (label?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      map[formName] = labelText;
    });
    return map;
  }).then((raw) => {
    const out: Record<string, keyof VgikSubmitForm> = {};
    for (const [name, labelNorm] of Object.entries(raw)) {
      const k = labelToSemanticKey(labelNorm);
      if (k && k !== "subscribeDigest" && k !== "acceptedTerms") {
        out[name] = k;
      }
    }
    return out;
  });
}

function normalizeVgikText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function getVgikBlockingMarkers(target: RuntimeTarget): string[] {
  return [...new Set([target.searchText, ...VGIK_SUBMIT_BLOCKING_MARKERS].map(normalizeVgikText).filter(Boolean))];
}

async function collectVgikCombinedLowerText(target: RuntimeTarget, frame?: Frame | null): Promise<string> {
  const pageHtml = target.page ? await target.page.content().catch(() => "") : "";
  const frameText = frame
    ? await frame
        .evaluate(() => (document.body?.innerText ?? document.documentElement.textContent ?? ""))
        .catch(() => "")
    : "";
  return normalizeVgikText(`${pageHtml}\n${frameText}`);
}

export async function saveVgikFormFillPayloadJson(
  targetLabel: string,
  eventId: number,
  payload: Record<string, string>
): Promise<string> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { DateTime } = await import("luxon");
  const dir = path.resolve(__dirname, "../../outputs");
  fs.mkdirSync(dir, { recursive: true });
  const ts = DateTime.local().setZone("Europe/Moscow").toFormat("yyyyLLdd_HHmmss");
  const safe = targetLabel.replace(/[^a-zA-Z0-9а-яА-Я._-]+/g, "-");
  const fileName = `${ts}_form_fill_${eventId}_${safe}.json`;
  const full = path.join(dir, fileName);
  await fs.promises.writeFile(full, JSON.stringify(payload, null, 2), "utf8");
  return full;
}

/**
 * Один тик HTML submit: делаем попытку и считаем успехом исчезновение блокирующего текста.
 */
export async function runVgikSubmittingTick(
  target: RuntimeTarget,
  onNotify: NotifyFn
): Promise<void> {
  const retryMs = Math.max(
    3000,
    Number(process.env.VGIK_SUBMIT_RETRY_MS ?? process.env.VGIK_MODE3_POLL_MS ?? "20000")
  );
  const now = Date.now();
  if (target.nextVgikSubmitAtMs !== undefined && now < target.nextVgikSubmitAtMs) {
    return;
  }

  if (!target.page) {
    return;
  }

  await syncPriemvgikCookiesToTarget(target);

  const frame = await getTimepadRegisterFrame(target.page);
  if (!frame) {
    await onNotify(
      `${targetDisplayLabel(target)}: submitting: iframe tpw__ не найден`,
      "key_error"
    );
    target.nextVgikSubmitAtMs = now + retryMs;
    upsertDynamicTargetRow(toStoredRow(target));
    return;
  }

  const hasForm = await frame.evaluate(() => !!document.querySelector("form#eventreg_form"));
  const hasBtn = await frame.evaluate(
    () => !!document.querySelector("#eventreg_submit, button[name='submit_register']")
  );
  if (!hasForm || !hasBtn) {
    await onNotify(
      `${targetDisplayLabel(target)}: submitting: форма или кнопка не найдены (form=${hasForm} btn=${hasBtn})`,
      "key_false"
    );
    try {
      const snap = await target.page.content();
      await saveHtmlSnapshot("vgik_submitting_missing_form", targetDisplayLabel(target), snap);
    } catch {
      // ignore
    }
    target.nextVgikSubmitAtMs = now + retryMs;
    upsertDynamicTargetRow(toStoredRow(target));
    return;
  }

  let status: number | null = null;
  try {
    const waitNav = target.page.waitForNavigation({ waitUntil: "networkidle0", timeout: 25000 }).catch(() => null);
    const respPromise = target.page
      .waitForResponse(
        (r) => r.url().includes("widget_register") && ["POST", "GET"].includes(r.request().method()),
        { timeout: 25000 }
      )
      .catch(() => null);

    await frame.click("#eventreg_submit, button[name='submit_register']");

    const resp = await respPromise;
    await waitNav;
    await new Promise((resolve) => setTimeout(resolve, 800));
    status = resp ? resp.status() : null;
  } catch (error) {
    logger.error("runVgikSubmittingTick: submit click failed", {
      target: targetDisplayLabel(target),
      error: String(error)
    });
  }

  const postFrame = await findTimepadRegisterFrame(target.page);
  const combinedLower = await collectVgikCombinedLowerText(target, postFrame);
  const blockingMarkers = getVgikBlockingMarkers(target);
  const matchedMarkers = blockingMarkers.filter((marker) => combinedLower.includes(marker));
  const successMatched = VGIK_SUBMIT_SUCCESS_MARKERS.some((marker) => combinedLower.includes(marker));

  if (successMatched || matchedMarkers.length === 0) {
    await onNotify(`${targetDisplayLabel(target)}: успешная запись`, "key_false");
    target.submitting = false;
    target.enabled = false;
    target.nextVgikSubmitAtMs = undefined;
    target.vgikSubmitOnly = true;
    upsertDynamicTargetRow(toStoredRow(target));
    return;
  }

  const code = status === null ? "нет ответа" : String(status);
  await onNotify(
    `${targetDisplayLabel(target)}: сделана попытка сабмита с формы html, код=${code}, блокеры=${matchedMarkers.join(" | ") || "нет"}`,
    "key_false"
  );
  try {
    const snap = await target.page.content();
    await saveHtmlSnapshot(`vgik_html_submit_${code.replace(/\W+/g, "_")}`, targetDisplayLabel(target), snap);
  } catch {
    // ignore
  }
  target.nextVgikSubmitAtMs = now + retryMs;
  upsertDynamicTargetRow(toStoredRow(target));
}

/**
 * Первичная регистрация на VGIK Timepad-таргете: поиск формы, fill, JSON, уведомления.
 * @returns true если обработано (ветка завершена, дальше не идти в общий searchText).
 */
export async function tryVgikTimepadRegistrationFlow(
  target: RuntimeTarget,
  rawContentLower: string,
  onNotify: NotifyFn
): Promise<boolean> {
  const flowEnabled =
    (process.env.VGIK_TIMEPAD_FLOW_ENABLED ?? process.env.VGIK_HTML_SUBMIT_ENABLED ?? "false")
      .trim()
      .toLowerCase() === "true";
  if (!flowEnabled) {
    return false;
  }
  if (target.theaterId !== "VGIK" || !isPriemvgikEventUrl(target.url) || target.vgikRegistrationFilled) {
    return false;
  }
  if (!target.page) {
    return false;
  }

  const frame = await getTimepadRegisterFrame(target.page);
  const widgetHtml = frame
    ? await frame.evaluate(() => document.documentElement.outerHTML).catch(() => "")
    : "";
  const combinedLower = `${rawContentLower}\n${widgetHtml.toLowerCase()}`;

  const searchLower = target.searchText.toLowerCase();
  const closedFound = combinedLower.includes(searchLower);
  if (target.searchMode === "contains" && closedFound) {
      await onNotify(`${targetDisplayLabel(target)}: закрыто`, "key_ok");
    return true;
  }

  if (!combinedLower.includes(SURNAME_MARKER)) {
    await onNotify(
      `${targetDisplayLabel(target)}: неуспешная попытка найти текст «user_forms[0][surname]»`,
      "key_error"
    );
    target.vgikRegistrationFilled = true;
    return true;
  }

  if (!frame) {
    await onNotify(`${targetDisplayLabel(target)}: форма: iframe не найден`, "key_error");
    return true;
  }

  // Как только подтвержден этап формы, исключаем таргет из общего цикла reload/goto.
  target.enabled = false;
  upsertDynamicTargetRow(toStoredRow(target));

  const preset = DEFAULT_VGIK_SUBMIT_FORM;
  const qmap = await buildQuestionMapFromFrame(frame);
  await applyPresetToFrame(frame, preset, qmap);

  const payload = await collectPostPayloadFromFrame(frame);
  const eventId = parseTimepadEventId(target.url) ?? 0;
  try {
    const pathSaved = await saveVgikFormFillPayloadJson(targetDisplayLabel(target), eventId, payload);
    logger.info("VGIK form_fill json saved", { path: pathSaved, target: targetDisplayLabel(target) });
  } catch (error) {
    logger.error("saveVgikFormFillPayloadJson failed", { error: String(error) });
  }

  target.vgikRegistrationFilled = true;
  upsertDynamicTargetRow(toStoredRow(target));

  await onNotify(
    `${targetDisplayLabel(target)}: Форма анкеты заполнена, делается попытка сабмит отдельной формы`,
    "key_false"
  );

  const htmlSubmitEnv = (process.env.VGIK_HTML_SUBMIT_ENABLED ?? "false").trim().toLowerCase() === "true";
  const mainHtml = await target.page.content();
  const workshop = workshopFromText(mainHtml + widgetHtml);

  if (!htmlSubmitEnv) {
    target.enabled = false;
    upsertDynamicTargetRow(toStoredRow(target));
    return true;
  }

  if (!workshop) {
    target.enabled = false;
    upsertDynamicTargetRow(toStoredRow(target));
    return true;
  }

  target.vgikWorkshop = workshop;
  const reservedUrl = findReservedWorkshopTargetUrl(workshop);
  if (reservedUrl && reservedUrl !== target.url) {
    target.vgikSubmitReserved = false;
    target.enabled = false;
    upsertDynamicTargetRow(toStoredRow(target));
    await onNotify(`${targetDisplayLabel(target)}: форма заполнена, нажимайте регистрацию`, "key_false");
    return true;
  }

  if (workshop === "merzlikin") {
    target.submitting = true;
    target.vgikSubmitReserved = true;
    target.nextVgikSubmitAtMs = Date.now();
    upsertDynamicTargetRow(toStoredRow(target));
    await runVgikSubmittingTick(target, onNotify);
    return true;
  }

  if (workshop === "fyodorov") {
    target.submitting = true;
    target.vgikSubmitReserved = true;
    target.nextVgikSubmitAtMs = Date.now();
    upsertDynamicTargetRow(toStoredRow(target));
    await runVgikSubmittingTick(target, onNotify);
    return true;
  }

  return true;
}
