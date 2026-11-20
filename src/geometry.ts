/**
 * Plan geometry. Canvas pixels map to metres through a single scale (metres per pixel).
 * World axes: X east (canvas right), Y north (canvas up, origin at the bottom-left corner), Z up (node elevation).
 */

export const DEFAULT_SCALE_M_PER_PX = 0.1;
export const DEFAULT_CANVAS = { w: 1100, h: 620 };

export interface PlanPoint {
  /** Canvas position [px]. */
  x: number;
  y: number;
  /** Elevation [m]. */
  elevationM: number;
}

export interface World {
  x: number;
  y: number;
  z: number;
}

export function nodeWorld(n: PlanPoint, scaleMPerPx: number, canvasH: number): World {
  return { x: n.x * scaleMPerPx, y: (canvasH - n.y) * scaleMPerPx, z: n.elevationM };
}

export function planDistancePx(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Straight-line length between two nodes in 3D [m]: plan distance from the canvas scale plus the elevation difference. */
export function lengthFromCanvas(a: PlanPoint, b: PlanPoint, scaleMPerPx: number): number {
  const plan = planDistancePx(a, b) * scaleMPerPx;
  return Math.hypot(plan, b.elevationM - a.elevationM);
}

/** Scale [m/px] from two calibration points and the real distance between them [m]. */
export function calibrate(a: { x: number; y: number }, b: { x: number; y: number }, realMetres: number): number | undefined {
  const px = planDistancePx(a, b);
  return px > 0 && realMetres > 0 && Number.isFinite(realMetres) ? realMetres / px : undefined;
}
