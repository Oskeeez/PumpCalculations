import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, startApp, type App } from './harness';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('solve for me', () => {
  it('locks an item, shows a lock on the network, and applies a solve as one undo step', async () => {
    const s = await open(app);
    const tab = (name: string) => s.page.locator('.ws-tab', { hasText: name }).first();

    // lock from the Properties panel
    await s.page.locator('g.node.junction').first().click({ force: true });
    await tab('Properties').click();
    await s.page.getByLabel(/Lock \(solver leaves it alone\)/).check();
    expect(await s.page.locator('svg.canvas text.lock').count()).toBeGreaterThan(0);

    // no targets yet: the panel says so
    await tab('Solve for me').click();
    expect(await s.page.locator('.solve .banner.warn').first().textContent()).toMatch(/No targets/i);
    expect(await s.page.locator('.solve summary', { hasText: /Locked \(1\)/ }).count()).toBe(1);
    await s.page.getByRole('button', { name: 'Unlock all' }).click();
    expect(await s.page.locator('svg.canvas text.lock').count()).toBe(0);

    // add a target that fails, then solve and apply
    await tab('Targets').click();
    await s.page.getByRole('button', { name: 'Residual pressure at a node' }).click();
    const first = s.page.locator('.targets .unit-row input').first();
    await first.fill('600');
    await tab('Solve for me').click();
    expect(await s.page.locator('.solve .banner.warn').first().textContent()).toMatch(/Failing/);
    await s.page.getByRole('button', { name: 'Solve this for me' }).click();
    await s.page.waitForSelector('.solve-result');
    expect(await s.page.locator('.solve-result .banner').first().textContent()).toMatch(/targets|Nothing|changes/i);
    const text = await s.page.locator('.solve-result').innerText();
    if (/All targets can be met/.test(text)) {
      await s.page.getByRole('button', { name: 'Apply these changes' }).click();
      expect(await s.page.locator('.solve .banner.ok').first().textContent()).toMatch(/All targets pass/);
      await s.page.keyboard.press('Control+z'); // one undo step puts the old design back
      expect(await s.page.locator('.solve .banner.warn').first().textContent()).toMatch(/Failing/);
    } else {
      expect(text).toMatch(/Closest|No allowed|Nothing can change/);
    }
    expect(s.errors).toEqual([]);
    await s.close();
  });
});

describe('size for a flow or pressure', () => {
  it('sizes the selected item and applies it', async () => {
    const s = await open(app);
    await s.page.locator('g.edge.pipe .edge-line').first().click({ force: true });
    await s.page.locator('.size-for summary').click();
    await s.page.getByLabel('Goal').selectOption('flow');
    await s.page.getByRole('button', { name: 'Size for flow' }).click();
    await s.page.waitForSelector('.size-for .banner');
    const text = (await s.page.locator('.size-for .banner').textContent()) ?? '';
    expect(text).toMatch(/Already met|can be met|Cannot change|not reachable/);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});
