/** Quadratic y = a0 + a1*x + a2*x^2 and least-squares fitting. */
export interface Quadratic {
  a0: number;
  a1: number;
  a2: number;
}

export interface XY {
  x: number;
  y: number;
}

export interface FitResult {
  poly: Quadratic;
  /** Root-mean-square residual in y units. */
  rmse: number;
}

export function evalQuadratic(c: Quadratic, x: number): number {
  return c.a0 + c.a1 * x + c.a2 * x * x;
}

export function dQuadratic(c: Quadratic, x: number): number {
  return c.a1 + 2 * c.a2 * x;
}

/** Solve A x = b by Gaussian elimination with partial pivoting (small dense systems). */
function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    if (Math.abs(M[p][k]) < 1e-300) throw new Error('fitQuadratic: singular system (need distinct x values)');
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/**
 * Least-squares fit of up to a quadratic. Degree is min(2, n_distinct - 1):
 * 2 points -> straight line (a2 = 0); >= 3 points -> quadratic.
 * x is internally normalised for conditioning (flows are ~1e-2 m^3/s, squares ~1e-4).
 */
export function fitQuadratic(points: readonly XY[]): FitResult {
  const distinct = new Set(points.map((p) => p.x)).size;
  if (points.length < 2 || distinct < 2) {
    throw new Error('fitQuadratic: need at least 2 points with distinct x values');
  }
  const m = Math.min(3, distinct); // number of coefficients
  const xs = Math.max(...points.map((p) => Math.abs(p.x))) || 1;
  const A: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const b = new Array<number>(m).fill(0);
  for (const { x, y } of points) {
    const u = x / xs;
    for (let i = 0; i < m; i++) {
      b[i] += y * u ** i;
      for (let j = 0; j < m; j++) A[i][j] += u ** (i + j);
    }
  }
  const c = solveDense(A, b);
  const poly: Quadratic = { a0: c[0], a1: c[1] / xs, a2: m > 2 ? c[2] / (xs * xs) : 0 };
  const sse = points.reduce((s, p) => s + (evalQuadratic(poly, p.x) - p.y) ** 2, 0);
  return { poly, rmse: Math.sqrt(sse / points.length) };
}
