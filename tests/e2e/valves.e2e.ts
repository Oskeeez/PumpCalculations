import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, startApp, type App } from './harness';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('valve sizing and pipe rating', () => {
  it('sizes a control valve from a flow and a pressure drop, and applies it', async () => {
    const s = await open(app);
    await s.page.locator('g.edge.valve .edge-line').first().click({ force: true });
    await s.page.locator('summary:has-text("Size this valve")').click();
    expect(await s.page.locator('.sizing p b').first().textContent()).toMatch(/Cv [\d.]+/);
    await s.page.getByRole('button', { name: /^Use Cv/ }).click();
    expect(await s.page.locator('label:has-text("Loss by") select').inputValue()).toBe('Cv');
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('sizes an orifice bore, and shows a clear message when no plate can do it', async () => {
    const s = await open(app);
    await s.page.locator('g.edge.valve .edge-line').first().click({ force: true });
    await s.page.locator('label:has-text("Loss by") select').selectOption('orifice');
    await s.page.locator('summary:has-text("Size this orifice")').click();
    expect(await s.page.locator('.sizing p').nth(1).textContent()).toMatch(/Bore needed:/);
    await s.page.getByRole('button', { name: 'Use this bore' }).click();
    // an impossible drop explains itself instead of failing
    const drop = s.page.locator('.sizing .grid input').nth(1);
    await drop.fill('99999999');
    expect(await s.page.locator('.sizing .banner').first().textContent()).toMatch(/more than any orifice/);
    await s.close();
  });

  it('flags a pipe whose rating is below the pressure it sees', async () => {
    const s = await open(app);
    await s.page.locator('g.edge.pipe .edge-line').first().click({ force: true });
    await s.page.getByLabel(/Pressure rating/).check();
    const rating = s.page.locator('.field.opt input[type=text]');
    await rating.fill('1');
    await s.page.getByRole('tab', { name: /^Results/ }).click();
    expect(await s.page.locator('.banner.warn:has-text("exceeds its rating")').count()).toBeGreaterThan(0);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});
