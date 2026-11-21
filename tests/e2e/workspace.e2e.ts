import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, drag, open, pageScrolls, startApp, tabNames, type App } from './harness';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('workspace', () => {
  it('never scrolls the page, at two common screen sizes', async () => {
    const s = await open(app);
    expect(await pageScrolls(s.page)).toBe(false);
    await s.page.setViewportSize({ width: 1366, height: 768 });
    await s.page.waitForTimeout(200);
    expect(await pageScrolls(s.page)).toBe(false);
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('docks a tab to the edge of another tile, and resizes with the bars', async () => {
    const s = await open(app);
    const net = s.page.locator('.ws-group').filter({ has: s.page.locator('.ws-tab:has-text("Network")') }).first();
    const nb = (await net.boundingBox())!;
    const before = await count(s.page, '.ws-group');
    await s.page.locator('.ws-tab:has-text("Results")').first().dragTo(net, { targetPosition: { x: 20, y: nb.height / 2 } });
    expect(await count(s.page, '.ws-group')).toBe(before + 1);
    const first = s.page.locator('.ws-group').first();
    expect(await first.locator('.ws-tab').allTextContents()).toEqual([expect.stringContaining('Results')]);
    expect((await first.boundingBox())!.x).toBeLessThan((await net.boundingBox())!.x);

    const bar = (await s.page.locator('.ws-div.row').first().boundingBox())!;
    const w0 = (await first.boundingBox())!.width;
    await drag(s.page, { x: bar.x + 3, y: bar.y + bar.height / 2 }, { x: bar.x + 153, y: bar.y + bar.height / 2 }, 6);
    expect((await first.boundingBox())!.width).toBeGreaterThan(w0 + 100);
    expect(await pageScrolls(s.page)).toBe(false);
    await s.close();
  });

  it('closes and re-opens panels, remembers the layout and offers presets', async () => {
    const s = await open(app);
    await s.page.locator('.ws-tab:has-text("Scale & images") .ws-x').click();
    expect(await tabNames(s.page)).not.toContain('Scale & images');
    await s.page.getByRole('button', { name: /^Panels/ }).click();
    await s.page.locator('.ws-check:has-text("Scale & images") input').check();
    expect(await tabNames(s.page)).toContain('Scale & images');
    await s.page.keyboard.press('Escape');

    // move something so the saved layout differs from the default, then reload
    const net = s.page.locator('.ws-group').filter({ has: s.page.locator('.ws-tab:has-text("Network")') }).first();
    await s.page.locator('.ws-tab:has-text("Results")').first().dragTo(net, { targetPosition: { x: 20, y: 200 } });
    await s.page.waitForTimeout(500);
    await s.page.reload();
    await s.page.waitForSelector('svg.canvas');
    expect(await s.page.locator('.ws-group').first().locator('.ws-tab').allTextContents()).toEqual([expect.stringContaining('Results')]);

    await s.page.getByRole('button', { name: /^Layout/ }).click();
    await s.page.getByRole('menuitem', { name: /Network \+ 3D view/ }).click();
    await s.page.waitForTimeout(500);
    expect(await count(s.page, '.ws-group')).toBe(3);
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('shows the build id and no "solved in n iterations" line', async () => {
    const s = await open(app);
    expect(await s.page.locator('.build-id').textContent()).toMatch(/build \w+/);
    expect(await count(s.page, 'text=/Solved in \\d+ iterations/')).toBe(0);
    await s.close();
  });
});
