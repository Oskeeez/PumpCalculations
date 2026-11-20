import { describe, expect, it } from 'vitest';
import { compute, defaultProject, insertOnPipe, newOrifice } from '../../src/model';
import { orificeKMeasured, orificeKPermanent } from '../../src/solver';

describe('orifice plate', () => {
  it('matches hand calculation for beta = 0.5, Cd = 0.61', () => {
    // K_meas = (1 - 0.0625) / (0.3721 * 0.0625) = 40.31
    expect(orificeKMeasured(0.5, 0.61)).toBeCloseTo(40.31, 1);
    // s = sqrt(1 - 0.0625*0.6279) = 0.98018; ratio = (0.98018 - 0.1525) / (0.98018 + 0.1525) = 0.7307
    expect(orificeKPermanent(0.5, 0.61)).toBeCloseTo(40.31 * 0.7307, 1);
  });
  it('permanent loss is below the measured differential and rises as the bore shrinks', () => {
    expect(orificeKPermanent(0.5)).toBeLessThan(orificeKMeasured(0.5));
    expect(orificeKPermanent(0.3)).toBeGreaterThan(orificeKPermanent(0.5));
    expect(orificeKPermanent(0.8)).toBeLessThan(orificeKPermanent(0.5));
  });
  it('rejects a bore not smaller than the pipe', () => {
    expect(() => orificeKPermanent(1)).toThrow(/smaller/);
    expect(() => orificeKPermanent(0)).toThrow(/smaller/);
  });
  it('inserted in a pipe it throttles the flow and the drop equals K v^2/2g', () => {
    const p = defaultProject();
    const base = compute(p).result!;
    const pipe = p.edges.find((e) => e.name === 'Pipe A')!;
    const { project, selectUid } = insertOnPipe(p, pipe.uid, 'orifice', 520, 200);
    const o = project.edges.find((e) => e.uid === selectUid)!;
    expect(o.kind === 'valve' && o.lossType).toBe('orifice');
    const r = compute(project);
    expect(r.error).toBeUndefined();
    expect(r.result!.pumps[0].flowM3s).toBeLessThan(base.pumps[0].flowM3s);
    const v = r.result!.valves.find((x) => x.id === o.name)!;
    const k = orificeKPermanent(o.kind === 'valve' ? o.lossValue / o.diameterMm : 0);
    expect(v.headDropM).toBeCloseTo((k * v.velocity ** 2) / (2 * 9.80665), 3);
  });
  it('reports a readable error for a bore larger than the pipe', () => {
    const p = defaultProject();
    const o = { ...newOrifice(p.nodes[2].uid, p.nodes[4].uid, []), lossValue: 200, diameterMm: 100 };
    expect(compute({ ...p, edges: [...p.edges, o] }).error).toMatch(/bore/);
  });
});
