import { describe, expect, it } from 'vitest';
import { fromDisplay, makeUnits, toDisplay, unitFactor, unitLabel, type Quantity } from '../src/units';

const ALL: Quantity[] = ['length', 'elevation', 'head', 'diameter', 'roughness', 'flow', 'pressure', 'temperature', 'velocity', 'viscosity', 'density', 'power'];

describe('unit conversions (canonical -> US)', () => {
  it.each([
    ['length', 1, 3.280839895],
    ['head', 10, 32.80839895],
    ['diameter', 25.4, 1], // mm -> in
    ['roughness', 0.0254, 1], // mm -> mil (0.001 in)
    ['flow', 1, 15.8503232], // L/s -> gpm
    ['flow', 63.0901964, 1000], // 63.09 L/s = 1000 gpm
    ['pressure', 100, 14.50377377], // kPa -> psi
    ['pressure', 101.325, 14.6959488], // atmosphere
    ['temperature', 20, 68],
    ['temperature', 100, 212],
    ['temperature', -40, -40],
    ['velocity', 1, 3.280839895],
    ['viscosity', 1.002, 1.002], // mPa.s = cP
    ['density', 998.2, 62.3156], // kg/m3 -> lb/ft3 (water at 20 °C is 62.32 lb/ft3)
    ['power', 1, 1.34102209],
  ] as [Quantity, number, number][])('%s: %f -> %f', (q, canonical, us) => {
    expect(toDisplay(q, canonical, 'us')).toBeCloseTo(us, 3);
  });

  it('SI display equals the canonical value', () => {
    for (const q of ALL) expect(toDisplay(q, 12.5, 'si')).toBe(12.5);
  });

  it('round-trips every quantity in both systems', () => {
    for (const q of ALL) for (const s of ['si', 'us'] as const) for (const v of [0, 0.37, 12.5, 1234.5, -15]) expect(fromDisplay(q, toDisplay(q, v, s), s)).toBeCloseTo(v, 9);
  });

  it('labels, formatting and axis factors', () => {
    expect(unitLabel('flow', 'us')).toBe('gpm');
    expect(unitLabel('temperature', 'si')).toBe('°C');
    const us = makeUnits('us');
    expect(us.f('flow', 10, 2)).toBe('158.50');
    expect(us.fu('pressure', 100, 1)).toBe('14.5 psi');
    expect(us.f('flow', undefined)).toBe('–');
    expect(us.f('head', Number.NaN)).toBe('–');
    expect(unitFactor('flow', 'us')).toBeCloseTo(15.8503232, 6);
    expect(us.from('length', us.to('length', 7.7))).toBeCloseTo(7.7, 12);
  });
});
