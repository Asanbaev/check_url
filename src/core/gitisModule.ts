import { Page } from "puppeteer";

const GITIS_REGISTERED_USERS_ONLY_MARKER = "прослушивание доступна зарегистрированным пользователям";

export interface GitisContentResult {
  /** HTML в нижнем регистре для парсинга */
  content: string;
  /** Блок модалки с курсом появился в DOM */
  hasOneCourse: boolean;
}

/** Результат полного GITIS-пайплайна до общей проверки searchText (contains / not_contains). */
export type RunGitisPipelineResult =
  | { kind: "modal_missing"; message: string }
  | { kind: "registered_users_auth"; message: string }
  | { kind: "free_dates"; message: string; statusCode: number }
  | /** Модалка ок, не режим только для зарегистрированных, слотов по разметке нет — дальше общий поиск текста цели */
    { kind: "continue_search"; contentLowercase: string };

function classifyGitisContentTail(contentLowercase: string): "registered_users_auth" | "date_discovery" {
  if (contentLowercase.includes(GITIS_REGISTERED_USERS_ONLY_MARKER)) {
    return "registered_users_auth";
  }
  return "date_discovery";
}

/**
 * Разбор свободных дат из разметки модалки GITIS (радиокнопки с id dt_YYYY-MM-DD).
 * Ячейка календаря: `<span class="available">` или `<span class="available short">`.
 */
export function findGitisSlotDates(contentLowercase: string): string {
  const regex =
    /<td><span class="available(?: short)?"><span><input type="radio" name="dt" id="dt_(\d{4}\-\d{2}\-\d{2})/g;
  const dates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(contentLowercase)) !== null) {
    dates.push(match[1]);
  }
  return dates.join(":");
}

/**
 * GITIS подгружает модалку с задержкой: ждём и перечитываем HTML,
 * пока не появится `.one-course` или не истекут попытки.
 */
export async function loadGitisContentWithDelay(page: Page): Promise<GitisContentResult> {
  const waitMs = Number(process.env.GITIS_MODAL_WAIT_MS ?? "1500");
  const maxAttempts = Number(process.env.GITIS_MODAL_RELOAD_ATTEMPTS ?? "2");

  let content = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    content = (await page.content()).toLowerCase();
    if (content.includes("one-course")) {
      return { content, hasOneCourse: true };
    }
  }
  return { content, hasOneCourse: false };
}

/**
 * Модалка → авторизация (только зарегистрированные) → слоты по разметке.
 * При отсутствии слотов в DOM возвращает `continue_search` для общего совпадения с `searchText` в мониторе.
 */
export async function runGitisPipeline(page: Page, targetName: string): Promise<RunGitisPipelineResult> {
  const gitis = await loadGitisContentWithDelay(page);
  if (!gitis.hasOneCourse) {
    return {
      kind: "modal_missing",
      message: `Дату не нашёл !! ${targetName} (модалка не открыта, .one-course не найден)`
    };
  }

  const content = gitis.content;
  if (classifyGitisContentTail(content) === "registered_users_auth") {
    return {
      kind: "registered_users_auth",
      message: `Требуется авторизация на сайте!! ${targetName}`
    };
  }

  const dates = findGitisSlotDates(content);
  if (dates !== "") {
    return {
      kind: "free_dates",
      message: `!!! ${targetName}: Похоже есть свободные даты ${dates} !!!`,
      statusCode: 2
    };
  }

  return { kind: "continue_search", contentLowercase: content };
}

/**
 * После уведомления key_false: программно выбрать первую доступную дату (radio `name="dt"`).
 * Нужно для отображения следующего шага записи в SPA без повторной загрузки страницы.
 */
export async function clickFirstAvailableGitisDate(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>(
        'input[type="radio"][name="dt"][id^="dt_"]'
      );
      if (!input) {
        return false;
      }
      input.scrollIntoView({ block: "center", behavior: "instant" });
      input.click();
      return true;
    });
  } catch {
    return false;
  }
}
