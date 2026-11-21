import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, open, startApp, type App } from './harness';

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app.close(); });

describe('3D view', () => {
  it('loads, and every camera view can be selected without errors', async () => {
    const s = await open(app);
    await s.page.getByRole('tab', { name: /3D view/ }).click();
    await s.page.waitForSelector('.v3-stage canvas');
    for (const v of ['Plan', 'Front', 'Side', 'Isometric']) {
      await s.page.getByRole('button', { name: v, exact: true }).click();
      await s.page.waitForTimeout(150);
    }
    expect(await count(s.page, '.v3-stage canvas')).toBeGreaterThan(0);
    await s.page.getByRole('tab', { name: /3D coordinates/ }).click();
    await s.page.waitForSelector('.coords3d table');
    expect(await count(s.page, '.coords3d table')).toBeGreaterThan(0);
    expect(s.errors).toEqual([]);
    await s.close();
  });
});
