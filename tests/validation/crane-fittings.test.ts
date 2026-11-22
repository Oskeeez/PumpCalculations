import { describe, expect, it } from 'vitest';
import { FITTING_LIBRARY, VALVE_TYPES, craneFT, elbowK, fittingK, flangedBendNft, reducerK, teeBranchK, teeRunK, valveTypeK } from '../../src/fittings';

/**
 * Loss coefficients checked against the published Crane TP-410 tables (Appendix A, pp. A-26 to A-29): the friction factors fT,
 * and the K = n x fT values for elbows, bends, tees, valves, entrances, and the contraction / expansion formulas.
 * The numbers below were transcribed from the table as reproduced in public references; check them against your own copy of
 * TP-410 before relying on them for a design.
 */

// nominal size -> inside diameter of Schedule 40 pipe [mm], and Crane's fT for that size
const SIZES: [string, number, number][] = [
  ['1/2"', 15.8, 0.027], ['3/4"', 20.93, 0.025], ['1"', 26.64, 0.023], ['1-1/4"', 35.05, 0.022], ['1-1/2"', 40.89, 0.021], ['2"', 52.5, 0.019],
  ['2-1/2"', 62.71, 0.018], ['3"', 77.93, 0.018], ['4"', 102.26, 0.017], ['5"', 128.19, 0.016], ['6"', 154.05, 0.015],
  ['8"', 202.72, 0.014], ['10"', 254.51, 0.014], ['12"', 303.23, 0.013], ['16"', 387.4, 0.013], ['18"', 438.2, 0.012], ['24"', 575, 0.012],
];

describe('Crane TP-410 friction factors fT', () => {
  for (const [nps, d, fT] of SIZES) it(`${nps}`, () => expect(craneFT(d)).toBe(fT));
});

describe('Crane TP-410 K = n fT', () => {
  const d4 = 102.26;
  const f4 = 0.017;
  it('standard elbows and the return bend', () => {
    expect(elbowK(90, 'standard', d4)).toBeCloseTo(30 * f4, 10);
    expect(elbowK(45, 'standard', d4)).toBeCloseTo(16 * f4, 10);
    expect(elbowK(180, 'standard', d4)).toBeCloseTo(50 * f4, 10);
  });
  it('a 2 inch 90 degree standard elbow is 0.57', () => {
    expect(elbowK(90, 'standard', 52.5)).toBeCloseTo(0.57, 2);
  });
  it('flanged or butt-welded 90 degree bends by r/D (p. A-29)', () => {
    const table: [number, number][] = [[1, 20], [1.5, 14], [2, 12], [3, 12], [4, 14], [6, 17], [8, 24], [10, 30], [12, 34], [14, 38], [16, 42], [20, 50]];
    for (const [r, n] of table) {
      expect(flangedBendNft(r)).toBe(n);
      expect(elbowK(90, 'flanged', d4, r)).toBeCloseTo(n * f4, 10);
    }
    // between table points the value is interpolated
    expect(flangedBendNft(5)).toBeCloseTo(15.5, 10);
  });
  it('a flanged bend turned through more than 90 degrees follows the Crane multi-bend formula', () => {
    const k90 = 14 * f4;
    const expected = (2 - 1) * (0.25 * Math.PI * f4 * 1.5 + 0.5 * k90) + k90;
    expect(elbowK(180, 'flanged', d4, 1.5)).toBeCloseTo(expected, 10);
  });
  it('mitre bends', () => {
    for (const [a, n] of [[30, 8], [45, 15], [60, 25], [75, 40], [90, 60]] as [number, number][]) expect(elbowK(a, 'mitre', d4)).toBeCloseTo(n * f4, 10);
  });
  it('tees: run 20 fT, branch 60 fT', () => {
    expect(teeRunK(d4)).toBeCloseTo(20 * f4, 10);
    expect(teeBranchK(90, d4)).toBeCloseTo(60 * f4, 10);
  });
  it('valves, fully open', () => {
    const n: Record<string, number> = { gate: 8, globe: 340, angle: 150, ball: 3, plug: 18, 'swing-check': 100, 'lift-check': 600, 'stop-check': 400, foot: 420, 'foot-hinged': 75 };
    for (const [id, v] of Object.entries(n)) expect(valveTypeK(id, d4)).toBeCloseTo(v * f4, 10);
  });
  it('butterfly and tilting-disc check values depend on the size band', () => {
    expect(valveTypeK('butterfly', 102.26)).toBeCloseTo(45 * 0.017, 10); // 4 in
    expect(valveTypeK('butterfly', 254.51)).toBeCloseTo(35 * 0.014, 10); // 10 in
    expect(valveTypeK('butterfly', 387.4)).toBeCloseTo(25 * 0.013, 10); // 16 in
    expect(valveTypeK('tilting-check', 102.26)).toBeCloseTo(40 * 0.017, 10);
    expect(valveTypeK('tilting-check', 303.23)).toBeCloseTo(30 * 0.013, 10);
    expect(valveTypeK('tilting-check', 438.2)).toBeCloseTo(20 * 0.012, 10);
  });
  it('the library gives the same numbers as the formulas', () => {
    const by = (name: string) => FITTING_LIBRARY.find((f) => f.name === name)!;
    expect(fittingK(by('90° elbow, standard'), d4)).toBeCloseTo(elbowK(90, 'standard', d4), 10);
    expect(fittingK(by('Tee, flow through branch'), d4)).toBeCloseTo(teeBranchK(90, d4), 10);
    expect(fittingK(by('Swing check valve'), d4)).toBeCloseTo(valveTypeK('swing-check', d4)!, 10);
    expect(fittingK(by('Butterfly valve'), 254.51)).toBeCloseTo(valveTypeK('butterfly', 254.51)!, 10);
  });
  it('every library entry says where it comes from', () => {
    for (const f of FITTING_LIBRARY) expect(f.source.length).toBeGreaterThan(0);
    for (const v of VALVE_TYPES) expect(v.source.length).toBeGreaterThan(0);
  });
  it('pipe entrances and exit', () => {
    const k = (name: string) => FITTING_LIBRARY.find((f) => f.name === name)!.k;
    expect(k('Entrance, flush, sharp-edged')).toBe(0.5);
    expect(k('Entrance, inward projecting')).toBe(0.78);
    expect(k('Entrance, rounded r/d = 0.02')).toBe(0.28);
    expect(k('Entrance, rounded r/d = 0.04')).toBe(0.24);
    expect(k('Entrance, rounded r/d = 0.06')).toBe(0.15);
    expect(k('Entrance, rounded r/d = 0.10')).toBe(0.09);
    expect(k('Entrance, rounded r/d 0.15 or more')).toBe(0.04);
    expect(k('Exit into a tank or open air')).toBe(1);
  });
});

describe('Crane TP-410 contraction and enlargement (K referred to the smaller pipe)', () => {
  const beta = 0.5; // d1 / d2
  const b2 = beta * beta;
  it('sudden contraction K1 = 0.5 (1 - beta^2)', () => expect(reducerK(50, 100, 180, 'contraction')).toBeCloseTo(0.5 * (1 - b2), 12));
  it('gradual contraction, 45 degrees or less: K1 = 0.8 sin(theta/2) (1 - beta^2)', () => {
    for (const th of [10, 20, 30, 45]) expect(reducerK(50, 100, th, 'contraction')).toBeCloseTo(0.8 * Math.sin((th * Math.PI) / 360) * (1 - b2), 12);
  });
  it('contraction between 45 and 180 degrees: K1 = 0.5 sqrt(sin(theta/2)) (1 - beta^2)', () => {
    for (const th of [60, 90, 120, 180]) expect(reducerK(50, 100, th, 'contraction')).toBeCloseTo(0.5 * Math.sqrt(Math.sin((th * Math.PI) / 360)) * (1 - b2), 12);
  });
  it('sudden enlargement K1 = (1 - beta^2)^2', () => expect(reducerK(50, 100, 180, 'expansion')).toBeCloseTo((1 - b2) ** 2, 12));
  it('gradual enlargement, 45 degrees or less: K1 = 2.6 sin(theta/2) (1 - beta^2)^2', () => {
    for (const th of [10, 20, 30, 45]) expect(reducerK(50, 100, th, 'expansion')).toBeCloseTo(2.6 * Math.sin((th * Math.PI) / 360) * (1 - b2) ** 2, 12);
  });
  it('the limits: a pipe into a tank loses one velocity head', () => expect(reducerK(1, 1e9, 180, 'expansion')).toBeCloseTo(1, 6));
});
