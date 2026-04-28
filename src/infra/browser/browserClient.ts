import puppeteer, { Browser, Page } from "puppeteer";
import { MonitorTarget } from "../../config/targets";

export interface RuntimeTarget extends MonitorTarget {
  page?: Page;
  lastRequestedTimeBeforeUpdate?: string;
}

export class BrowserClient {
  private browser?: Browser;

  async connect(): Promise<void> {
    this.browser = await puppeteer.connect({
      browserURL: process.env.BROWSER_URL ?? "http://127.0.0.1:9222",
      protocolTimeout: Number(process.env.BROWSER_PROTOCOL_TIMEOUT_MS ?? "60000")
    });
  }

  async bindPages(targets: RuntimeTarget[]): Promise<void> {
    if (!this.browser) {
      throw new Error("Browser is not connected");
    }
    const pages = await this.browser.pages();

    for (const target of targets) {
      for (const page of pages) {
        if (page.url().includes(target.url)) {
          target.page = page;
          break;
        }
      }
      if (!target.page) {
        target.page = await this.browser.newPage();
        await target.page.goto(target.url);
      }
    }
  }
}
