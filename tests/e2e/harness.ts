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
  // A cold dev server optimises its dependencies on the first visit and can reload the page part-way through a test.
  // Visit once now, and wait until it is quiet, so that tests start against a settled server.
  const warm = await browser.newPage();
  await warm.goto(url);
  await warm.waitForSelector('svg.canvas', { timeout: 55_000 });
  await warm.waitForLoadState('networkidle');
  await warm.waitForTimeout(1500);
  await warm.close();
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

/**
 * Drag a tab onto another tile by firing the HTML5 drag events directly. Playwright's own dragTo depends on the browser build's
 * drag-and-drop emulation, which hangs in the headless shell that CI installs.
 */
export async function dragTab(page: Page, source: Locator, targetGroup: Locator, at: { x: number; y: number }): Promise<void> {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  const box = (await targetGroup.boundingBox())!;
  const point = { clientX: box.x + at.x, clientY: box.y + at.y };
  await source.dispatchEvent('dragstart', { dataTransfer: dt });
  const drop = targetGroup.locator('.ws-drop');
  await drop.waitFor();
  await drop.dispatchEvent('dragenter', { dataTransfer: dt, ...point });
  await drop.dispatchEvent('dragover', { dataTransfer: dt, ...point });
  await drop.dispatchEvent('drop', { dataTransfer: dt, ...point });
  await source.dispatchEvent('dragend', { dataTransfer: dt });
}

/** A point on the drawn line of an SVG path (half way along it), in page coordinates. */
export async function pointOnPath(path: Locator): Promise<{ x: number; y: number }> {
  return path.evaluate((el) => {
    const p = el as SVGPathElement;
    const pt = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  });
}
