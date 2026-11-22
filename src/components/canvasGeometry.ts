/** Where an edge is drawn: a straight line, or a curve fanned out when several edges join the same two nodes. */
interface P {
  x: number;
  y: number;
}

export interface EdgeGeometry {
  /** SVG path (a quadratic curve through the control point). */
  path: string;
  /** Midpoint of the curve: where the icon and labels go. */
  mx: number;
  my: number;
  /** Direction of the straight line from `from` to `to`, in degrees. */
  dirDeg: number;
}

export const FAN_SPACING = 46;

/** Key shared by every edge between the same two nodes (in either direction). */
export const pairKey = (from: string, to: string): string => [from, to].sort().join('|');

/**
 * `index` is this edge's position among the `count` edges between the same two nodes (0 for a single edge).
 * Edges are spread evenly either side of the straight line.
 */
export function edgeGeometry(from: string, to: string, a: P, b: P, index: number, count: number): EdgeGeometry {
  const off = (index - (count - 1) / 2) * FAN_SPACING;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const sgn = from < to ? 1 : -1;
  const nx = (-dy / len) * sgn;
  const ny = (dx / len) * sgn;
  const cx = (a.x + b.x) / 2 + nx * off * 2;
  const cy = (a.y + b.y) / 2 + ny * off * 2;
  return {
    path: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`,
    mx: 0.25 * a.x + 0.5 * cx + 0.25 * b.x,
    my: 0.25 * a.y + 0.5 * cy + 0.25 * b.y,
    dirDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
  };
}
