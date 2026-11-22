/**
 * Canvas viewport: which part of the drawing is on screen. `scale` is screen pixels per canvas unit, (cx, cy) the canvas point at the
 * centre of the view. The SVG viewBox is derived from the view and the pixel size of the canvas, so there is no letterboxing and
 * the drawing always fills its tile. Pure functions, tested without a browser.
 */
export interface View {
  cx: number;
  cy: number;
  scale: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_SCALE = 0.04;
export const MAX_SCALE = 24;

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** The SVG viewBox string for a view in a canvas of the given pixel size. */
export function viewBox(v: View, size: Size): string {
  const w = size.w / v.scale;
  const h = size.h / v.scale;
  return `${v.cx - w / 2} ${v.cy - h / 2} ${w} ${h}`;
}

/** The view that shows `b` as large as possible, centred, with `marginPx` of space around it. */
export function fitView(b: Bounds, size: Size, marginPx = 24): View {
  const bw = Math.max(b.maxX - b.minX, 1);
  const bh = Math.max(b.maxY - b.minY, 1);
  const s = Math.min(Math.max(size.w - 2 * marginPx, 40) / bw, Math.max(size.h - 2 * marginPx, 40) / bh);
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: clampScale(s) };
}

/** Zoom by `factor`, keeping the canvas point (ax, ay) at the same place on screen. */
export function zoomAbout(v: View, factor: number, ax: number, ay: number): View {
  const scale = clampScale(v.scale * factor);
  const k = v.scale / scale;
  return { scale, cx: ax - (ax - v.cx) * k, cy: ay - (ay - v.cy) * k };
}

/** Move the view by a screen-pixel drag (the drawing follows the pointer). */
export function panBy(v: View, dxPx: number, dyPx: number): View {
  return { ...v, cx: v.cx - dxPx / v.scale, cy: v.cy - dyPx / v.scale };
}

interface Positioned {
  x: number;
  y: number;
}

/**
 * What a "fit" should show: the nodes with room for their labels (which scale with the symbol size), else the images, else the whole
 * canvas.
 */
export function contentBounds(nodes: Positioned[], images: { x: number; y: number; width: number; height: number }[], canvas: Size, symbolScale = 1): Bounds {
  if (nodes.length) {
    const padX = 70 * symbolScale;
    return {
      minX: Math.min(...nodes.map((n) => n.x)) - padX,
      maxX: Math.max(...nodes.map((n) => n.x)) + padX,
      minY: Math.min(...nodes.map((n) => n.y)) - 40 * symbolScale,
      maxY: Math.max(...nodes.map((n) => n.y)) + 75 * symbolScale,
    };
  }
  if (images.length) {
    return {
      minX: Math.min(...images.map((i) => i.x)),
      minY: Math.min(...images.map((i) => i.y)),
      maxX: Math.max(...images.map((i) => i.x + i.width)),
      maxY: Math.max(...images.map((i) => i.y + i.height)),
    };
  }
  return { minX: 0, minY: 0, maxX: canvas.w, maxY: canvas.h };
}
