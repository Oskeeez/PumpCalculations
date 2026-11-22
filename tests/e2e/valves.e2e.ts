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
    expect(await s.page.locator('.sizing p').first().textContent()).toMatch(/Bore needed:/);
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

describe('report', () => {
  it('shows a printable summary with a print button', async () => {
    const s = await open(app);
    await s.page.getByRole('tab', { name: /^Report/ }).click();
    await s.page.waitForSelector('.report-preview .rp');
    expect(await s.page.locator('.report-preview h1').textContent()).toBe('Pipe network calculation');
    expect(await s.page.locator('.report-preview table').count()).toBeGreaterThan(3);
    expect(await s.page.getByRole('button', { name: /Print/ }).count()).toBe(1);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});

describe('pressure units', () => {
  it('lets a pressure be typed in bar and shows the same pressure in other units, including metres of head', async () => {
    const s = await open(app);
    await s.page.getByRole('tab', { name: /Targets/ }).click();
    await s.page.getByRole('button', { name: 'Residual pressure at a node' }).click();
    const unit = s.page.locator('.target-row select[aria-label$="unit"]').first();
    const field = s.page.locator('.target-row .unit-row input').first();
    await unit.selectOption('bar');
    await field.fill('2.5');
    await unit.selectOption('kPa');
    expect(await field.inputValue()).toBe('250');
    await unit.selectOption('Pa');
    expect(await field.inputValue()).toBe('250000');
    await unit.selectOption('psi');
    expect(Number(await field.inputValue())).toBeCloseTo(36.2594, 3);
    await unit.selectOption('mhead');
    const m = Number(await field.inputValue());
    expect(m).toBeGreaterThan(25); // 250 kPa of water is about 25.5 m
    expect(m).toBeLessThan(26);
    // the unit choice is remembered for every pressure field, and survives a reload (wait for the autosave first)
    await s.page.waitForTimeout(800);
    await s.page.reload();
    await s.page.waitForSelector('svg.canvas');
    await s.page.getByRole('tab', { name: /Targets/ }).click();
    expect(await s.page.locator('.target-row select[aria-label$="unit"]').first().inputValue()).toBe('mhead');
    expect(s.errors).toEqual([]);
    await s.close();
  });
});
