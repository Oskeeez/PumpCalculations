import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, startApp, type App } from './harness';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('fittings and pipe library', () => {
  it('turns a junction into an elbow from the drop-down and shows it on the network', async () => {
    const s = await open(app);
    await s.page.locator('g.node.junction').first().click({ force: true });
    await s.page.locator('.ws-tab', { hasText: 'Properties' }).first().click();
    await s.page.getByLabel('Junction fitting').selectOption('elbow');
    expect(await s.page.locator('.side .editor input').first().inputValue()).toMatch(/^Elbow/);
    expect(await s.page.locator('svg.canvas .t-sub', { hasText: /Elbow/ }).count()).toBeGreaterThan(0);
    await s.page.getByLabel('Junction fitting').selectOption('none');
    expect(await s.page.locator('svg.canvas .t-sub', { hasText: /Elbow/ }).count()).toBe(0);
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('chooses the type of junction to place from the toolbar', async () => {
    const s = await open(app);
    await s.page.getByLabel('Junction type').selectOption('tee');
    expect(await s.page.getByLabel('Junction type').inputValue()).toBe('tee');
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('imports company pipe sizes from an Excel file and offers them in the pipe editor', async () => {
    const s = await open(app);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sizes');
    ws.addRow(['Series', 'Nominal size', 'Inside diameter (mm)', 'Roughness (mm)']);
    ws.addRow(['Acme PE', 'DN40', 36.2, 0.0015]);
    ws.addRow(['Acme PE', 'DN75', 66.0, 0.0015]);
    ws.addRow(['Acme PE', 'bad', 'x', '']);
    const nodeBuffer = (globalThis as unknown as { Buffer: { from: (b: ArrayBuffer) => never } }).Buffer; // Playwright wants a Buffer; the project has no Node typings
    const buffer = nodeBuffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    await s.page.locator('.ws-tab', { hasText: 'Pipe sizes' }).first().click();
    await s.page.getByLabel('Pipe size file').setInputFiles({ name: 'sizes.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await s.page.waitForSelector('.pipelib .banner');
    expect(await s.page.locator('.pipelib .banner').textContent()).toMatch(/Imported 2 sizes/);
    await s.page.getByLabel('Standard pipe list').selectOption({ label: 'Acme PE' });

    await s.page.locator('g.edge.pipe .edge-line').first().click({ force: true });
    await s.page.locator('.ws-tab', { hasText: 'Properties' }).first().click();
    await s.page.getByLabel('Pipe size series').selectOption({ label: 'Acme PE' });
    await s.page.getByLabel('Nominal pipe size').selectOption('DN40');
    expect(await s.page.getByLabel('Inner diameter').first().inputValue()).toMatch(/36\.2/);

    // the standard-size finder uses the same list
    await s.page.locator('.size-for summary').click();
    await s.page.getByLabel('Goal').selectOption('limits');
    await s.page.getByRole('button', { name: 'Find standard size' }).click();
    expect(await s.page.locator('.size-for .banner').first().textContent()).toMatch(/DN40|DN75|No size/);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});

describe('fitting library', () => {
  it('imports company fittings from Excel and offers them on a pipe, and lets a junction use its own loss', async () => {
    const s = await open(app);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Fittings');
    ws.addRow(['Category', 'Name', 'K', 'L/D', 'Source']);
    ws.addRow(['Acme', 'Acme knife gate', 0.12, '', 'Datasheet 7']);
    ws.addRow(['Acme', 'Acme cast elbow', '', 14, 'Datasheet 8']);
    ws.addRow(['Acme', 'broken', '', '', '']);
    const nodeBuffer = (globalThis as unknown as { Buffer: { from: (b: ArrayBuffer) => never } }).Buffer;
    const buffer = nodeBuffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    await s.page.locator('.ws-tab', { hasText: 'Fittings' }).first().click();
    await s.page.getByLabel('Fitting file').setInputFiles({ name: 'fittings.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await s.page.waitForSelector('.pipelib .banner');
    expect(await s.page.locator('.pipelib .banner').textContent()).toMatch(/Imported 2 fittings/);
    expect(await s.page.locator('.pipelib td', { hasText: 'Datasheet 7' }).count()).toBe(1);

    await s.page.locator('g.edge.pipe .edge-line').first().click({ force: true });
    await s.page.locator('.ws-tab', { hasText: 'Properties' }).first().click();
    await s.page.locator('select').filter({ has: s.page.locator('option', { hasText: 'Acme knife gate' }) }).first().selectOption({ label: 'Acme knife gate (K 0.12)' });
    expect(await s.page.locator('.side td input').last().inputValue()).not.toBe('');
    expect(await s.page.locator('.side input[value="Acme knife gate"]').count()).toBe(1);

    await s.page.locator('g.node.junction').first().click({ force: true });
    await s.page.getByLabel('Junction fitting').selectOption('elbow');
    await s.page.getByLabel('Use my own loss values').check();
    expect(await s.page.getByLabel('Fill loss from list').count()).toBe(1);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});

describe('EPANET files', () => {
  it('opens an .inp file and exports one', async () => {
    const s = await open(app);
    const nodeBuffer = (globalThis as unknown as { Buffer: { from: (b: string) => never } }).Buffer;
    const text = `[JUNCTIONS]\n J1 0 2\n[RESERVOIRS]\n R1 30\n[PIPES]\n P1 R1 J1 200 100 0.05 0 Open\n[OPTIONS]\n Units LPS\n Headloss D-W\n[COORDINATES]\n R1 0 0\n J1 100 0\n[END]\n`;
    await s.page.getByLabel('Open project file').setInputFiles({ name: 'net.inp', mimeType: 'text/plain', buffer: nodeBuffer.from(text) });
    await expect.poll(() => s.page.locator('g.node').count()).toBe(2);
    expect(await s.page.locator('g.edge.pipe').count()).toBe(1);
    const [dl] = await Promise.all([s.page.waitForEvent('download'), s.page.getByRole('button', { name: 'Export .inp' }).click()]);
    expect(dl.suggestedFilename()).toBe('network.inp');
    expect(s.errors).toEqual([]);
    await s.close();
  });
});

describe('plots', () => {
  it('draws the system curve on the pump chart and an HGL profile between two nodes', async () => {
    const s = await open(app);
    await s.page.locator('.ws-tab', { hasText: 'Pump curve' }).first().click();
    await expect.poll(() => s.page.locator('.chart polyline[stroke-dasharray]').count()).toBeGreaterThan(0);
    expect(await s.page.locator('.chart text', { hasText: /system/ }).count()).toBeGreaterThan(0);
    await s.page.locator('.ws-tab', { hasText: 'HGL profile' }).first().click();
    const tankOptions = await s.page.getByLabel('Profile from').locator('option').allTextContents();
    await s.page.getByLabel('Profile to').selectOption({ label: tankOptions[tankOptions.length - 1] });
    await s.page.getByLabel('Profile from').selectOption({ label: tankOptions[0] });
    await expect.poll(() => s.page.locator('svg.profile-chart polyline').count()).toBe(3);
    expect(await s.page.locator('.profile tbody tr').count()).toBeGreaterThan(1);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});

describe('calculation record', () => {
  it('issues a revision and shows when the model changes afterwards', async () => {
    const s = await open(app);
    await s.page.locator('.ws-tab', { hasText: 'Report' }).first().click();
    await s.page.getByLabel('Calculation no.').fill('CALC-7');
    await s.page.getByLabel('Prepared by').fill('A. Engineer');
    await s.page.getByLabel('Revision description').fill('First issue');
    await s.page.getByRole('button', { name: 'Issue revision A' }).click();
    await expect.poll(() => s.page.locator('.report-preview .state').textContent()).toMatch(/As issued at revision A/);
    expect(await s.page.locator('.report-preview').textContent()).toContain('CALC-7');
    // change the network
    await s.page.locator('g.node.junction').first().click({ force: true });
    await s.page.locator('.ws-tab', { hasText: 'Properties' }).first().click();
    await s.page.getByLabel('Height (z)').first().fill('3.5');
    await s.page.locator('.ws-tab', { hasText: 'Report' }).first().click();
    await expect.poll(() => s.page.locator('.report-preview .state').textContent()).toMatch(/Changed since revision A/);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});
