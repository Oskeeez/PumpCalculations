import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { center, count, drag, open, startApp, tabNames, type App, type Session } from './harness';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

const canvasBox = async (s: Session) => (await s.page.locator('svg.canvas').boundingBox())!;

describe('multi-select, copy and paste', () => {
  it('selects with a shift-drag box, moves the group, copies, pastes and deletes', async () => {
    const s = await open(app);
    const c = await canvasBox(s);
    const nodes0 = await count(s.page, 'g.node');
    const edges0 = await count(s.page, 'g.edge');

    // shift + drag a box around the right-hand part of the example (J2, J3 and the two tanks)
    await s.page.keyboard.down('Shift');
    await drag(s.page, { x: c.x + c.width * 0.55, y: c.y + c.height * 0.05 }, { x: c.x + c.width * 0.97, y: c.y + c.height * 0.86 });
    await s.page.keyboard.up('Shift');
    const picked = await count(s.page, 'g.node.multi');
    expect(picked).toBeGreaterThanOrEqual(3);
    expect(await s.page.locator('.side h3').first().textContent()).toMatch(/\d+ nodes selected/);

    // dragging one of them moves all of them
    const one = s.page.locator('g.node.multi').first();
    const two = s.page.locator('g.node.multi').nth(1);
    const a0 = await center(one);
    const b0 = await center(two);
    await drag(s.page, a0, { x: a0.x - 60, y: a0.y + 30 }, 6);
    const a1 = await center(one);
    const b1 = await center(two);
    expect(Math.round(a1.x - a0.x)).toBe(Math.round(b1.x - b0.x));
    expect(Math.round(a1.y - a0.y)).toBe(Math.round(b1.y - b0.y));

    // copy and paste: more nodes and the pipes between them, and the pasted group is selected
    await s.page.keyboard.press('Control+c');
    await s.page.keyboard.press('Control+v');
    expect(await count(s.page, 'g.node')).toBe(nodes0 + picked);
    expect(await count(s.page, 'g.edge')).toBeGreaterThan(edges0);
    expect(await count(s.page, 'g.node.multi')).toBe(picked);

    // delete the pasted group: back to the start
    await s.page.keyboard.press('Delete');
    expect(await count(s.page, 'g.node')).toBe(nodes0);
    expect(await count(s.page, 'g.edge')).toBe(edges0);
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('shift-click adds a node to the selection and a click on empty space clears it', async () => {
    const s = await open(app);
    await s.page.locator('g.node').nth(2).click();
    await s.page.locator('g.node').nth(4).click({ modifiers: ['Shift'] });
    expect(await count(s.page, 'g.node.multi')).toBe(2);
    const c = await canvasBox(s);
    await s.page.mouse.click(c.x + c.width * 0.05, c.y + c.height * 0.05);
    expect(await count(s.page, 'g.node.multi')).toBe(0);
    await s.close();
  });
});

describe('view options, find, help', () => {
  it('cycles the label level, hides the grid and turns snapping off, and remembers them', async () => {
    const s = await open(app);
    expect(await count(s.page, 'text.t-res')).toBeGreaterThan(0);
    await s.page.getByRole('button', { name: /^Labels:/ }).click(); // names only
    expect(await count(s.page, 'text.t-res')).toBe(0);
    expect(await count(s.page, 'text.t-name')).toBeGreaterThan(0);
    await s.page.getByRole('button', { name: /^Labels:/ }).click(); // none
    expect(await count(s.page, 'text.t-name')).toBe(0);
    await s.page.getByRole('button', { name: 'Show the grid' }).click();
    expect(await s.page.getByRole('button', { name: 'Show the grid' }).getAttribute('aria-pressed')).toBe('false');
    await s.page.getByRole('button', { name: 'Snap to the grid' }).click();
    await s.page.reload();
    await s.page.waitForSelector('svg.canvas');
    expect(await count(s.page, 'text.t-name')).toBe(0);
    expect(await s.page.getByRole('button', { name: 'Snap to the grid' }).getAttribute('aria-pressed')).toBe('false');
    await s.close();
  });

  it('finds a node by name, selects it and shows it in Properties', async () => {
    const s = await open(app);
    const find = s.page.getByLabel('Find a node or pipe by name');
    await find.fill('Tank C');
    await s.page.waitForSelector('.side .editor');
    expect(await s.page.locator('.side input').first().inputValue()).toBe('Tank C');
    expect(await find.inputValue()).toBe('');
    await s.close();
  });

  it('opens the help dialog from the button and the ? key, and closes it with Esc', async () => {
    const s = await open(app);
    await s.page.getByRole('button', { name: 'Help' }).click();
    expect(await count(s.page, '.modal')).toBe(1);
    await s.page.keyboard.press('Escape');
    expect(await count(s.page, '.modal')).toBe(0);
    await s.page.locator('body').click({ position: { x: 5, y: 600 } });
    await s.page.keyboard.press('?');
    expect(await count(s.page, '.modal')).toBe(1);
    expect(await s.page.locator('.modal').textContent()).toMatch(/Shift \+ drag on empty space/);
    await s.close();
  });
});

describe('tiles', () => {
  it('maximises a tile and restores it with Esc', async () => {
    const s = await open(app);
    const groups0 = await count(s.page, '.ws-group');
    expect(groups0).toBeGreaterThan(1);
    await s.page.locator('.ws-group').first().getByRole('button', { name: 'Maximise this tile' }).click();
    expect(await count(s.page, '.ws-group')).toBe(1);
    await s.page.keyboard.press('Escape');
    expect(await count(s.page, '.ws-group')).toBe(groups0);
    await s.close();
  });

  it('saves the layout under a name, and brings it back after a reset', async () => {
    const s = await open(app);
    s.page.on('dialog', (d) => void d.accept('Wide network'));
    // make a recognisable layout: close Scale & images
    await s.page.locator('.ws-tab:has-text("Scale & images") .ws-x').click();
    await s.page.getByRole('button', { name: /^Layout/ }).click();
    await s.page.getByRole('menuitem', { name: 'Save this layout as…' }).click();
    await s.page.getByRole('button', { name: /^Layout/ }).click();
    await s.page.getByRole('menuitem', { name: /^Default/ }).click();
    expect(await tabNames(s.page)).toContain('Scale & images');
    await s.page.getByRole('button', { name: /^Layout/ }).click();
    await s.page.getByRole('menuitem', { name: 'Wide network' }).click();
    expect(await tabNames(s.page)).not.toContain('Scale & images');
    expect(s.errors).toEqual([]);
    await s.close();
  });
});
