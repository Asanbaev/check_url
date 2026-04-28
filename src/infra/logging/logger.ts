export const logger = {
  info(message: string, payload?: unknown): void {
    console.log(`[check_url][INFO] ${message}`, payload ?? "");
  },
  error(message: string, payload?: unknown): void {
    console.error(`[check_url][ERROR] ${message}`, payload ?? "");
  }
};
