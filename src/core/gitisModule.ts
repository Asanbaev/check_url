import { Page } from "puppeteer";

export interface GitisContentResult {
  /** HTML в нижнем регистре для парсинга */
  content: string;
  /** Блок модалки с курсом появился в DOM */
  hasOneCourse: boolean;
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
