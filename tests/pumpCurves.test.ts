import { describe, expect, it } from 'vitest';
import { applyCurve, checkCurve, curveFromPump, curveFromRows, genericCurve, newCurve, parseCurveText, rowsFromCurve, summarize } from '../src/pumpCurves';
import { compute, defaultProject, newPump, parseProject, serializeProject } from '../src/model';

describe('pump curve rows', () => {
  it('merges head, efficiency and NPSHr into rows by flow and splits them back unchanged', () => {
    const c = newCurve('x', { head: [{ q: 0, h: 50 }, { q: 10, h: 40 }, { q: 20, h: 25 }], efficiency: [{ q: 10, eta: 60 }, { q: 20, eta: 70 }], npshr: [{ q: 20, h: 3 }] });
    const rows = rowsFromCurve(c);
    expect(rows).toEqual([{ q: 0, h: 50 }, { q: 10, h: 40, eta: 60 }, { q: 20, h: 25, eta: 70, npshr: 3 }]);
    expect(curveFromRows(rows)).toEqual({ head: c.head, efficiency: c.efficiency, npshr: c.npshr });
  });
});

describe('pasted curve text', () => {
  it('reads tab-separated columns with a header, in any column order', () => {
    const r = parseCurveText('Head\tFlow\tEff\n50\t0\t\n40\t10\t60\n25\t20\t70');
    expect(r.rows.map((x) => [x.q, x.h, x.eta])).toEqual([[0, 50, undefined], [10, 40, 60], [20, 25, 70]]);
  });
  it('reads comma lists without a header as flow, head, efficiency, NPSHr', () => {
    const r = parseCurveText('0, 50\n10, 40, 60, 2\n20, 25, 70, 3');
    expect(r.rows[1]).toEqual({ q: 10, h: 40, eta: 60, npshr: 2 });
  });
  it('converts a fractional efficiency to percent and says so', () => {
    const r = parseCurveText('10 40 0.6\n20 25 0.7');
    expect(r.rows[0].eta).toBeCloseTo(60, 9);
    expect(r.warnings.join(' ')).toMatch(/fraction/);
  });
  it('accepts decimal commas and skips junk lines with a warning', () => {
    const r = parseCurveText('10;40,5\nrubbish 12');
    expect(r.rows[0]).toEqual({ q: 10, h: 40.5, eta: undefined, npshr: undefined });
    expect(parseCurveText('').warnings[0]).toMatch(/No numbers/);
  });
});

describe('curve checks and summary', () => {
  it('explains what is wrong with a curve', () => {
    expect(checkCurve({ head: [{ q: 1, h: 5 }], efficiency: [], npshr: [] }).errors[0]).toMatch(/at least 2 points/);
    expect(checkCurve({ head: [{ q: 0, h: 5 }, { q: 1, h: 4 }], efficiency: [{ q: 0, eta: 120 }, { q: 1, eta: 50 }], npshr: [] }).errors[0]).toMatch(/0 and 100/);
    expect(checkCurve({ head: [{ q: 0, h: 5 }, { q: 1, h: 4 }], efficiency: [{ q: 1, eta: 50 }], npshr: [] }).warnings[0]).toMatch(/One efficiency point/);
  });
  it('summarises a generic curve: shutoff 1.25 x BEP head, BEP at the requested flow', () => {
    const g = genericCurve('G', 10, 30, 70);
    const s = summarize(g);
    expect(s.shutoffHeadM).toBeCloseTo(37.5, 1);
    expect(s.bepFlowLps).toBeCloseTo(10, 0);
    expect(s.peakEfficiencyPct).toBeCloseTo(70, 0);
  });
});

describe('using a library curve on a pump', () => {
  it('copies the points onto the pump, records the curve id and solves with them', () => {
    const p = defaultProject();
    const pump = p.edges.find((e) => e.kind === 'pump')!;
    if (pump.kind !== 'pump') throw new Error();
    const weak = newCurve('Weak', { head: [{ q: 0, h: 30 }, { q: 10, h: 25 }, { q: 20, h: 15 }, { q: 30, h: 2 }] });
    const strong = genericCurve('Strong', 20, 60);
    const base = compute(p).result!.pumps[0].flowM3s;
    const withWeak = { ...p, edges: p.edges.map((e) => (e.uid === pump.uid ? applyCurve(pump, weak) : e)) };
    const withStrong = { ...p, edges: p.edges.map((e) => (e.uid === pump.uid ? applyCurve(pump, strong) : e)) };
    const qWeak = compute(withWeak).result!.pumps[0].flowM3s;
    const qStrong = compute(withStrong).result!.pumps[0].flowM3s;
    expect(qWeak).toBeLessThan(base);
    expect(qStrong).toBeGreaterThan(qWeak);
    const applied = withWeak.edges.find((e) => e.uid === pump.uid)!;
    expect(applied.kind === 'pump' && applied.curveId).toBe(weak.id);
  });

  it('saves a pump curve to the library, and the library survives save and load', () => {
    const p = defaultProject();
    const pump = p.edges.find((e) => e.kind === 'pump')!;
    if (pump.kind !== 'pump') throw new Error();
    const entry = curveFromPump(pump, 'From pump');
    expect(entry.head).toEqual(pump.head);
    const back = parseProject(serializeProject({ ...p, pumpCurves: [entry] }));
    expect(back.pumpCurves).toEqual([entry]);
    expect(() => parseProject(serializeProject({ ...p, pumpCurves: [{ id: 'x', name: 'bad' } as never] }))).toThrow(/pump curve/);
    expect(newPump('a', 'b', []).curveId).toBeUndefined();
  });
});
