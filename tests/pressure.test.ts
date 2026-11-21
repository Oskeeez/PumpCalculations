import { describe, expect, it } from 'vitest';
import { PRESSURE_UNITS, fromKPa, isPressureUnit, toKPa } from '../src/pressure';

describe('pressure units', () => {
  it('converts 100 kPa into the usual units', () => {
    expect(fromKPa('Pa', 100, 998)).toBeCloseTo(100000, 6);
    expect(fromKPa('MPa', 100, 998)).toBeCloseTo(0.1, 9);
    expect(fromKPa('bar', 100, 998)).toBeCloseTo(1, 9);
    expect(fromKPa('mbar', 100, 998)).toBeCloseTo(1000, 6);
    expect(fromKPa('psi', 100, 998)).toBeCloseTo(14.5038, 3);
    expect(fromKPa('atm', 101.325, 998)).toBeCloseTo(1, 9);
    expect(fromKPa('kgfcm2', 98.0665, 998)).toBeCloseTo(1, 9);
    expect(fromKPa('mH2O', 9.80665, 998)).toBeCloseTo(1, 9);
    expect(fromKPa('mmHg', 101.325, 998)).toBeCloseTo(760, 0);
    expect(fromKPa('inH2O', 0.24908891, 998)).toBeCloseTo(1, 6);
  });

  it('head units use the fluid density: the same pressure is a taller column of a lighter fluid', () => {
    expect(fromKPa('mhead', 100, 998.2)).toBeCloseTo(10.2155, 3);
    expect(fromKPa('mhead', 100, 800)).toBeGreaterThan(fromKPa('mhead', 100, 998.2));
    expect(fromKPa('fthead', 100, 998.2)).toBeCloseTo(10.2155 * 3.28084, 2);
    // water at 4 degrees (999.97 kg/m3) is within 0.1 % of standard m H2O
    expect(Math.abs(fromKPa('mhead', 100, 999.97) / fromKPa('mH2O', 100, 999.97) - 1)).toBeLessThan(0.001);
  });

  it('every unit round-trips, for any density', () => {
    for (const u of PRESSURE_UNITS) {
      for (const rho of [650, 998.2, 1250]) {
        expect(toKPa(u.id, fromKPa(u.id, 217.3, rho), rho)).toBeCloseTo(217.3, 9);
      }
      expect(isPressureUnit(u.id)).toBe(true);
    }
  });

  it('rejects an unknown unit', () => {
    expect(() => fromKPa('furlongs', 1, 998)).toThrow(/Unknown pressure unit/);
    expect(isPressureUnit('furlongs')).toBe(false);
  });
});
