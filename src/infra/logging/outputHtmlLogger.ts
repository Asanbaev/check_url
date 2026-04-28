import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";

function resolveOutputsDir(): string {
  return path.resolve(__dirname, "../../../outputs");
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9а-яА-Я._-]+/g, "-");
}

export async function saveHtmlSnapshot(status: string, targetCode: string, html: string): Promise<string> {
  const outputsDir = resolveOutputsDir();
  fs.mkdirSync(outputsDir, { recursive: true });

  const yyyymmddhhmmss = DateTime.local().setZone("Europe/Moscow").toFormat("yyyyLLdd_HHmmss");
  const safeStatus = sanitizeFilePart(status);
  const safeTargetCode = sanitizeFilePart(targetCode);
  const fileName = `${yyyymmddhhmmss}_${safeStatus}_${safeTargetCode}.html`;
  const fullPath = path.join(outputsDir, fileName);

  await fs.promises.writeFile(fullPath, html, "utf8");
  return fullPath;
}
