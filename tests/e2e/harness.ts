import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

export interface App {
  url: string;
  browser: Browser;
  close: () => Promise<void>;
}

/** Start the dev server and a headless browser. Call once per test file. */
export async function startApp(): Promise<App> {
  const server: ViteDevServer = await createServer({ server: { port: 0 }, logLevel: 'error' });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('The dev server did not report a URL.');
  const browser = await chromium.launch();
  return { url, browser, close: async () => { await browser.close(); await server.close(); } };
}

export interface Session {
  page: Page;
  context: BrowserContext;
  errors: string[];
  /** Page errors seen so far (uncaught exceptions). */
  close: () => Promise<void>;
}

/** A fresh browser context (empty storage) with the app open and ready. */
export async function open(app: App, viewport = { width: 1920, height: 1080 }): Promise<Session> {
  const context = await app.browser.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(app.url);
  await page.waitForSelector('svg.canvas');
  await page.waitForTimeout(250); // first fit of the view
  return { page, context, errors, close: () => context.close() };
}

export const count = (page: Page, selector: string): Promise<number> => page.locator(selector).count();

export async function center(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('Element has no box (is it visible?)');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Drag with the mouse in small steps so the app sees a real drag. */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** True if the page itself scrolls (it must never). */
export function pageScrolls(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollHeight > d.clientHeight + 1 || document.body.scrollWidth > d.clientWidth + 1;
  });
}

export const tabNames = async (page: Page): Promise<string[]> => (await page.locator('.ws-tab').allTextContents()).map((t) => t.replace('×', '').trim());
