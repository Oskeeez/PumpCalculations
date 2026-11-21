import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, contentBounds, fitView, panBy, viewBox, zoomAbout } from '../src/viewport';

const size = { w: 1000, h: 600 };

describe('viewport', () => {
  it('fit shows the whole box, centred, with no letterboxing', () => {
    const b = { minX: 100, minY: 50, maxX: 700, maxY: 350 };
    const v = fitView(b, size, 20);
    const [x, y, w, h] = viewBox(v, size).split(' ').map(Number);
    expect(x).toBeLessThanOrEqual(b.minX);
    expect(y).toBeLessThanOrEqual(b.minY);
    expect(x + w).toBeGreaterThanOrEqual(b.maxX);
    expect(y + h).toBeGreaterThanOrEqual(b.maxY);
    expect(w / h).toBeCloseTo(size.w / size.h, 9); // viewBox aspect equals the pixel aspect
    expect(v.cx).toBe(400);
    expect(v.cy).toBe(200);
  });

  it('a wide box is limited by width, a tall one by height', () => {
    expect(fitView({ minX: 0, minY: 0, maxX: 2000, maxY: 100 }, size, 0).scale).toBeCloseTo(0.5, 9);
    expect(fitView({ minX: 0, minY: 0, maxX: 100, maxY: 1200 }, size, 0).scale).toBeCloseTo(0.5, 9);
  });

  it('zooming about a point keeps that point fixed on screen', () => {
    const v = { cx: 300, cy: 200, scale: 1.5 };
    const ax = 420;
    const ay = 260;
    const screen = (w: typeof v, px: number, py: number) => ({ sx: (px - w.cx) * w.scale, sy: (py - w.cy) * w.scale });
    const z = zoomAbout(v, 1.7, ax, ay);
    expect(z.scale).toBeCloseTo(2.55, 9);
    expect(screen(z, ax, ay).sx).toBeCloseTo(screen(v, ax, ay).sx, 9);
    expect(screen(z, ax, ay).sy).toBeCloseTo(screen(v, ax, ay).sy, 9);
  });

  it('zoom is limited at both ends, and in then out returns to the start', () => {
    const v = { cx: 0, cy: 0, scale: 1 };
    expect(zoomAbout(v, 1e6, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAbout(v, 1e-6, 0, 0).scale).toBe(MIN_SCALE);
    const back = zoomAbout(zoomAbout(v, 1.25, 50, 80), 1 / 1.25, 50, 80);
    expect(back.scale).toBeCloseTo(1, 9);
    expect(back.cx).toBeCloseTo(0, 9);
    expect(back.cy).toBeCloseTo(0, 9);
  });

  it('panning moves the drawing with the pointer', () => {
    const v = panBy({ cx: 100, cy: 100, scale: 2 }, 40, -20);
    expect(v).toEqual({ cx: 80, cy: 110, scale: 2 });
  });

  it('content bounds: nodes with label room, else images, else the canvas', () => {
    const b = contentBounds([{ x: 100, y: 100 }, { x: 300, y: 200 }], [], { w: 1100, h: 620 });
    expect(b.minX).toBe(30);
    expect(b.maxX).toBe(370);
    expect(b.minY).toBe(60);
    expect(b.maxY).toBe(275);
    expect(contentBounds([{ x: 100, y: 100 }], [], { w: 1, h: 1 }, 2).maxX).toBe(240); // labels grow with the symbol size
    expect(contentBounds([], [{ x: 10, y: 20, width: 100, height: 50 }], { w: 1100, h: 620 })).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
    expect(contentBounds([], [], { w: 1100, h: 620 })).toEqual({ minX: 0, minY: 0, maxX: 1100, maxY: 620 });
  });
});
