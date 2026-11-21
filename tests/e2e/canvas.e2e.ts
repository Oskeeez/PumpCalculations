import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { center, count, drag, open, startApp, type App, type Session } from './harness';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

/** A button of the network toolbar (not the panels' close buttons). */
const tool = (s: Session, name: string) => s.page.locator('.net-panel .toolbar button', { hasText: name }).first();
const canvasBox = async (s: Session) => (await s.page.locator('svg.canvas').boundingBox())!;
const pressed = (s: Session, name: string) => tool(s, name).getAttribute('aria-pressed');
const viewBoxWidth = async (s: Session) => Number((await s.page.locator('svg.canvas').getAttribute('viewBox'))!.split(' ')[2]);

describe('drawing tools', () => {
  it('stay active after placing, and Escape or right-click ends them', async () => {
    const s = await open(app);
    const n0 = await count(s.page, 'g.node');
    const c = await canvasBox(s);
    await tool(s, 'Junction').click();
    await s.page.mouse.click(c.x + c.width * 0.1, c.y + c.height * 0.9);
    await s.page.mouse.click(c.x + c.width * 0.2, c.y + c.height * 0.9);
    expect(await count(s.page, 'g.node')).toBe(n0 + 2);
    expect(await pressed(s, 'Junction')).toBe('true');
    await s.page.keyboard.press('Escape');
    expect(await pressed(s, 'Select')).toBe('true');
    await tool(s, 'Junction').click();
    const c2 = await canvasBox(s); // the hint bar above the canvas has appeared, so measure again
    await s.page.mouse.click(c2.x + c2.width * 0.5, c2.y + c2.height * 0.97, { button: 'right' });
    expect(await pressed(s, 'Select')).toBe('true');
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('split a pipe with a tank, and make nodes by dragging across blank space', async () => {
    const s = await open(app);
    const n0 = await count(s.page, 'g.node');
    const e0 = await count(s.page, 'g.edge');
    await tool(s, 'Tank').click();
    await s.page.mouse.click((await center(s.page.locator('g.edge.pipe .edge-hit').nth(2))).x, (await center(s.page.locator('g.edge.pipe .edge-hit').nth(2))).y);
    expect(await count(s.page, 'g.node')).toBe(n0 + 1);
    expect(await count(s.page, 'g.edge')).toBe(e0 + 1);
    await s.page.keyboard.press('Escape');

    const c = await canvasBox(s);
    const n1 = await count(s.page, 'g.node');
    const e1 = await count(s.page, 'g.edge');
    await tool(s, 'Pipe').click();
    await drag(s.page, { x: c.x + c.width * 0.1, y: c.y + c.height * 0.92 }, { x: c.x + c.width * 0.1 + 160, y: c.y + c.height * 0.92 });
    expect(await count(s.page, 'g.node')).toBe(n1 + 2);
    expect(await count(s.page, 'g.edge')).toBe(e1 + 1);
    // a plain click in pipe mode adds nothing
    await s.page.mouse.click(c.x + c.width * 0.5, c.y + c.height * 0.95);
    expect(await count(s.page, 'g.node')).toBe(n1 + 2);
    await s.close();
  });

  it('place a pump on its own and reverse its direction', async () => {
    const s = await open(app);
    const n0 = await count(s.page, 'g.node');
    const c = await canvasBox(s);
    await tool(s, 'Pump').click();
    await s.page.mouse.click(c.x + c.width * 0.2, c.y + c.height * 0.9);
    expect(await count(s.page, 'g.node')).toBe(n0 + 2);
    await s.page.keyboard.press('Escape');
    await s.page.locator('g.edge.pump.sel').first().waitFor();
    expect(await count(s.page, 'button:has-text("Reverse direction")')).toBe(1);
    expect(await count(s.page, 'text.t-end')).toBe(2);
    const before = await s.page.locator('.dir-end b').allTextContents();
    await s.page.locator('g.reverse-btn').dispatchEvent('pointerdown');
    expect(await s.page.locator('.dir-end b').allTextContents()).toEqual([...before].reverse());
    await s.close();
  });
});

describe('viewport', () => {
  it('fits the network to the tile, zooms with wheel and buttons, pans, and resizes symbols without zooming', async () => {
    const s = await open(app);
    const c = await canvasBox(s);
    const nodes = await s.page.locator('g.node').all();
    let minX = 1e9, maxX = -1e9;
    for (const n of nodes) { const b = (await n.boundingBox())!; minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.width); }
    expect((maxX - minX) / c.width).toBeGreaterThan(0.7); // cropped to the network, not the fixed drawing area

    const w0 = await viewBoxWidth(s);
    const p = await center(nodes[2]);
    await s.page.mouse.move(p.x, p.y);
    await s.page.mouse.wheel(0, -400);
    const w1 = await viewBoxWidth(s);
    expect(w1).toBeLessThan(w0);
    const p2 = await center(nodes[2]);
    expect(Math.abs(p2.x - p.x)).toBeLessThan(2); // the node under the pointer stays put
    expect(Math.abs(p2.y - p.y)).toBeLessThan(2);

    await s.page.getByRole('button', { name: 'Zoom in' }).click();
    expect(await viewBoxWidth(s)).toBeLessThan(w1);
    await s.page.getByRole('button', { name: 'Zoom out' }).click();
    const zb = (await s.page.getByRole('button', { name: 'Zoom in' }).boundingBox())!;
    expect(Math.min(zb.width, zb.height)).toBeGreaterThanOrEqual(36); // easy to hit

    const vb = (await s.page.locator('svg.canvas').getAttribute('viewBox'))!;
    await drag(s.page, { x: c.x + 60, y: c.y + 60 }, { x: c.x + 200, y: c.y + 130 }, 6);
    expect(await s.page.locator('svg.canvas').getAttribute('viewBox')).not.toBe(vb);

    await s.page.getByRole('button', { name: 'Fit the network to the window' }).click();
    const fitW = await viewBoxWidth(s);
    const n0 = (await nodes[0].boundingBox())!.width;
    await s.page.getByRole('button', { name: 'Larger symbols' }).click();
    await s.page.getByRole('button', { name: 'Larger symbols' }).click();
    expect((await nodes[0].boundingBox())!.width).toBeGreaterThan(n0 * 1.3);
    expect(await viewBoxWidth(s)).toBe(fitW); // zoom unchanged
    expect(s.errors).toEqual([]);
    await s.close();
  });
});

describe('images', () => {
  // a 300 x 200 picture, big enough to grab
  const nodeBuffer = (globalThis as unknown as { Buffer: { from: (s: string) => never } }).Buffer; // Playwright wants a Buffer; the project has no Node typings
  const img = nodeBuffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#c33"/></svg>');

  it('cannot be moved or selected until Adjust is pressed', async () => {
    const s = await open(app);
    await s.page.locator('.toolbar input[type=file]').setInputFiles({ name: 'plan.svg', mimeType: 'image/svg+xml', buffer: img });
    await s.page.waitForSelector('svg.canvas image');
    const x = () => s.page.locator('svg.canvas image').getAttribute('x');
    const x0 = await x();
    const b = (await s.page.locator('svg.canvas image').boundingBox())!;
    await drag(s.page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + 80, y: b.y + b.height / 2 + 40 }, 5);
    expect(await x()).toBe(x0);
    await s.page.locator('.toolbar button:has-text("Adjust image")').click();
    expect(await count(s.page, '.adjust-bar')).toBe(1);
    const b2 = (await s.page.locator('svg.canvas image').boundingBox())!;
    await drag(s.page, { x: b2.x + b2.width / 2, y: b2.y + b2.height / 2 }, { x: b2.x + b2.width / 2 + 80, y: b2.y + b2.height / 2 + 40 }, 5);
    expect(await x()).not.toBe(x0);
    await s.page.locator('.adjust-bar').getByRole('button', { name: 'Done' }).click();
    expect(await count(s.page, '.adjust-bar')).toBe(0);
    await s.close();
  });
});

describe('pick on the network', () => {
  it('chooses a target node, and only pumps for a pump field, from the canvas', async () => {
    const s = await open(app);
    await s.page.getByRole('tab', { name: /Targets/ }).click();
    await s.page.getByRole('button', { name: 'Residual pressure at a node' }).click();
    const before = await s.page.locator('.target-row select').first().inputValue();
    await s.page.locator('.pick-btn').first().click();
    expect(await count(s.page, '.pick-bar')).toBe(1);
    await s.page.locator('g.node.pickable').nth(3).click();
    expect(await s.page.locator('.target-row select').first().inputValue()).not.toBe(before);
    expect(await count(s.page, '.pick-bar')).toBe(0);

    await s.page.getByRole('button', { name: 'Pump operating range' }).click();
    await s.page.locator('.target-row').nth(1).locator('.pick-btn').click();
    expect(await count(s.page, 'g.edge.pickable')).toBe(1);
    expect(await count(s.page, 'g.node.pickable')).toBe(0);
    await s.page.keyboard.press('Escape');
    expect(await count(s.page, '.pick-bar')).toBe(0);
    await s.close();
  });
});
