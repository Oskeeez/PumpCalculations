import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, startApp, type App } from './harness';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('pump curve library', () => {
  it('creates generic and pasted curves, applies them to a pump, and keeps pumps in step with edits', async () => {
    const s = await open(app);
    const pumpLabel = async () => ((await s.page.locator('g.edge.pump text.t-res').first().textContent()) ?? '').trim();
    const flowOf = async () => Number((await pumpLabel()).split(' ')[0]);
    const base = await flowOf();

    await s.page.locator('g.edge.pump .edge-line').first().click({ force: true });
    expect(await s.page.locator('select[aria-label="Pump curve"]').inputValue()).toBe('');
    await s.page.getByRole('button', { name: /Add \/ edit curves/ }).click();

    await s.page.getByRole('button', { name: 'Generic curve…' }).click();
    await s.page.getByLabel('BEP flow').fill('30');
    await s.page.getByLabel('BEP head').fill('40');
    await s.page.getByRole('button', { name: 'Create curve' }).click();
    expect(await s.page.locator('.pc-list li').count()).toBe(1);
    await s.page.locator('.pc-editor .toolbar button.primary').click(); // use for the pump
    const strong = await flowOf();
    expect(strong).toBeGreaterThan(base);

    await s.page.getByRole('button', { name: 'Paste from a table…' }).click();
    await s.page.locator('.pc textarea').fill('Flow\tHead\tEff\tNPSHr\n0\t30\t\t\n10\t26\t55\t1.5\n20\t18\t68\t2.5\n30\t6\t60\t4');
    await s.page.getByRole('button', { name: 'Make a new curve' }).click();
    expect(await s.page.locator('.pc-table tbody tr').count()).toBe(4);
    await s.page.locator('.pc-editor .toolbar button.primary').click();
    const weak = await flowOf();
    expect(weak).toBeLessThan(strong);

    await s.page.getByLabel('Head 2').fill('36'); // edit the curve: the pump follows
    expect(await flowOf()).toBeGreaterThan(weak);

    await s.page.getByLabel('Head 1').fill('');
    await s.page.getByLabel('Head 2').fill('');
    const keep = await flowOf();
    await s.page.getByLabel('Head 3').fill(''); // one point left: invalid, so the pump keeps its last good curve
    expect(await s.page.locator('.pc-editor .banner.error').first().textContent()).toMatch(/at least 2 points/);
    expect(await flowOf()).toBe(keep);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});
