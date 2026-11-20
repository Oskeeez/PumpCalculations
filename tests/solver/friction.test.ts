import { describe, expect, it } from 'vitest';
import { colebrookFrictionFactor, darcyFrictionFactor, flowRegime } from '../../src/solver';

/** Independent reference: bisection directly on f (no Newton, no 1/sqrt(f) substitution). */
function colebrookByBisection(re: number, rr: number): number {
  const resid = (f: number) => 1 / Math.sqrt(f) + 2 * Math.log10(rr / 3.7 + 2.51 / (re * Math.sqrt(f)));
  let lo = 1e-4;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    // resid decreases as f increases
    if (resid(mid) > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

describe('Colebrook-White (Newton on 1/sqrt(f))', () => {
  const cases: [number, number][] = [
    [4e3, 0],
    [1e4, 0],
    [1e5, 0],
    [1e6, 0],
    [1e5, 1e-3],
    [1e6, 1e-3],
    [1e7, 1e-4],
    [1e8, 5e-2],
    [5e4, 2e-2],
  ];
  it.each(cases)('matches independent bisection: Re=%g, e/D=%g', (re, rr) => {
    expect(colebrookFrictionFactor(re, rr)).toBeCloseTo(colebrookByBisection(re, rr), 10);
  });

  it('matches published Moody-chart values (smooth pipe)', () => {
    expect(colebrookFrictionFactor(1e5, 0)).toBeCloseTo(0.018, 3); // 0.01799
    expect(colebrookFrictionFactor(1e6, 0)).toBeCloseTo(0.0116, 4); // 0.01162
  });

  it('approaches the fully-rough (von Karman) limit at very high Re', () => {
    const rr = 0.01;
    const fRough = 1 / (2 * Math.log10(3.7 / rr)) ** 2;
    expect(colebrookFrictionFactor(1e12, rr)).toBeCloseTo(fRough, 6);
  });

  it('satisfies the Colebrook equation to near machine precision', () => {
    const re = 2.5e5;
    const rr = 7e-4;
    const f = colebrookFrictionFactor(re, rr);
    const lhs = 1 / Math.sqrt(f);
    const rhs = -2 * Math.log10(rr / 3.7 + 2.51 / (re * Math.sqrt(f)));
    expect(Math.abs(lhs - rhs)).toBeLessThan(1e-12);
  });
});

describe('darcyFrictionFactor regimes', () => {
  it('is 64/Re in laminar flow', () => {
    expect(darcyFrictionFactor(1000, 1e-3)).toBeCloseTo(0.064, 12);
  });

  it('is continuous at the transition boundaries (no solver-upsetting jumps)', () => {
    const rr = 5e-4;
    const eps = 1e-6;
    expect(darcyFrictionFactor(2300 - eps, rr)).toBeCloseTo(darcyFrictionFactor(2300 + eps, rr), 6);
    expect(darcyFrictionFactor(4000 - eps, rr)).toBeCloseTo(darcyFrictionFactor(4000 + eps, rr), 6);
  });

  it('gives head loss f*Re^2 that increases monotonically through the transition', () => {
    let prev = -Infinity;
    for (let re = 1500; re <= 6000; re += 10) {
      const v = darcyFrictionFactor(re, 1e-3) * re * re; // head loss is proportional to f Re^2 for fixed geometry
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('classifies regimes and handles zero flow', () => {
    expect(flowRegime(0)).toBe('zero');
    expect(flowRegime(1000)).toBe('laminar');
    expect(flowRegime(3000)).toBe('transitional');
    expect(flowRegime(1e5)).toBe('turbulent');
    expect(darcyFrictionFactor(0, 1e-3)).toBe(Infinity);
  });
});
