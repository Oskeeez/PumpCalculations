import { describe, expect, it } from 'vitest';
import {
  brent,
  fitQuadratic,
  RootNotBracketedError,
  solveSparseSpd,
  water,
} from '../../src/solver';

describe('water properties', () => {
  it('matches handbook values at 20 degC', () => {
    const w = water(20);
    expect(w.density).toBeCloseTo(998.2, 0);
    expect(w.dynamicViscosity).toBeCloseTo(1.002e-3, 5);
    expect(Math.abs(w.vaporPressure - 2339)).toBeLessThan(20); // Antoine fit, ~0.4 %
  });
  it('matches handbook values at 80 degC', () => {
    const w = water(80);
    expect(w.density).toBeCloseTo(971.8, 0);
    expect(w.dynamicViscosity).toBeCloseTo(0.355e-3, 5);
    expect(w.vaporPressure).toBeGreaterThan(47000);
    expect(w.vaporPressure).toBeLessThan(48000);
  });
  it('rejects temperatures outside the correlation range', () => {
    expect(() => water(120)).toThrow(RangeError);
  });
});

describe('fitQuadratic', () => {
  it('recovers exact quadratic coefficients', () => {
    const f = (q: number) => 40 - 5000 * q - 1e6 * q * q;
    const pts = [0, 0.001, 0.002, 0.003].map((x) => ({ x, y: f(x) }));
    const { poly, rmse } = fitQuadratic(pts);
    expect(poly.a0).toBeCloseTo(40, 9);
    expect(poly.a1).toBeCloseTo(-5000, 5);
    expect(poly.a2).toBeCloseTo(-1e6, 2);
    expect(rmse).toBeLessThan(1e-9);
  });
  it('falls back to a straight line for two points', () => {
    const { poly } = fitQuadratic([{ x: 0, y: 10 }, { x: 2, y: 4 }]);
    expect(poly).toEqual({ a0: 10, a1: -3, a2: 0 });
  });
  it('rejects degenerate input', () => {
    expect(() => fitQuadratic([{ x: 1, y: 1 }])).toThrow();
    expect(() => fitQuadratic([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toThrow();
  });
});

describe('brent', () => {
  it('finds cos(x) = x', () => {
    expect(brent((x) => Math.cos(x) - x, 0, 1)).toBeCloseTo(0.7390851332151607, 12);
  });
  it('throws when the root is not bracketed', () => {
    expect(() => brent((x) => x * x + 1, -1, 1)).toThrow(RootNotBracketedError);
  });
});

describe('solveSparseSpd', () => {
  it('solves a small SPD system with fill-in', () => {
    // Tridiagonal + an extra coupling (0,3) so elimination creates fill-in.
    const A = [
      [4, -1, 0, -1],
      [-1, 4, -1, 0],
      [0, -1, 4, -1],
      [-1, 0, -1, 4],
    ];
    const x = [1, 2, 3, 4];
    const b = A.map((row) => row.reduce((s, a, j) => s + a * x[j], 0));
    const rows = A.map((row) => new Map(row.map((v, j) => [j, v] as [number, number]).filter(([, v]) => v !== 0)));
    const sol = solveSparseSpd(rows, b);
    sol.forEach((v, i) => expect(v).toBeCloseTo(x[i], 12));
  });
});
