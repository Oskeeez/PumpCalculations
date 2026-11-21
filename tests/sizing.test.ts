import { describe, expect, it } from 'vitest';
import { compute, defaultProject, insertOnPipe } from '../src/model';
import { orificeBoreForDrop, requiredCv, requiredKv, specificGravity } from '../src/sizing';

describe('control valve sizing', () => {
  it('matches the definitions: 1 psi drop at Cv gpm, 1 bar drop at Kv m3/h (water)', () => {
    // 100 gpm = 6.30902 L/s at a 1 psi (6.89476 kPa) drop needs Cv = 100
    expect(requiredCv(6.30902, 6.89476, 999)).toBeCloseTo(100, 2);
    // 10 m3/h = 2.77778 L/s at 1 bar (100 kPa) needs Kv = 10
    expect(requiredKv(2.77778, 100, 999)).toBeCloseTo(10, 3);
    expect(requiredCv(5, 50, 999)).toBeCloseTo(requiredKv(5, 50, 999) * 1.1561, 1); // Cv = 1.1561 Kv
  });

  it('a denser liquid needs a larger Cv for the same drop, by the square root of the specific gravity', () => {
    const sg = specificGravity(1200);
    expect(requiredCv(5, 50, 1200) / requiredCv(5, 50, 999)).toBeCloseTo(Math.sqrt(sg), 6);
  });

  it('a valve sized this way gives that drop in the solver', () => {
    const p = defaultProject();
    const pipe = p.edges.find((e) => e.kind === 'pipe' && e.name === 'Pipe A')!;
    const { project, selectUid } = insertOnPipe(p, pipe.uid, 'valve', 520, 200);
    const solved = compute(project);
    const v = project.edges.find((e) => e.uid === selectUid)!;
    if (v.kind !== 'valve') throw new Error();
    const q = Math.abs(solved.result!.valves.find((x) => x.id === v.name)!.flowM3s) * 1000;
    const rho = solved.model!.fluid.density;
    const cv = requiredCv(q, 25, rho);
    const sized = { ...project, edges: project.edges.map((e) => (e.uid === v.uid ? { ...e, lossType: 'Cv' as const, lossValue: cv } : e)) };
    const drop = compute(sized).result!.valves.find((x) => x.id === v.name)!;
    // the flow changes slightly once the valve is added, so size at the flow it ends up with and allow a few percent
    const q2 = Math.abs(drop.flowM3s) * 1000;
    expect(drop.pressureDropPa / 1000).toBeCloseTo(25 * (q2 / q) ** 2, 0);
  });

  it('rejects a zero flow or drop', () => {
    expect(() => requiredCv(0, 10, 999)).toThrow(/flow/);
    expect(() => requiredKv(5, 0, 999)).toThrow(/pressure drop/);
  });
});

describe('orifice sizing', () => {
  it('the bore it finds, used in the solver, gives the wanted permanent drop', () => {
    const p = defaultProject();
    const pipe = p.edges.find((e) => e.kind === 'pipe' && e.name === 'Pipe A')!;
    if (pipe.kind !== 'pipe') throw new Error();
    const rho = compute(p).model!.fluid.density;
    const s = orificeBoreForDrop(8, 40, pipe.diameterMm, rho);
    expect(s.boreMm).toBeLessThan(pipe.diameterMm);
    expect(s.measuredDropKPa).toBeGreaterThan(40); // a meter reads more than the permanent loss
    // put exactly that orifice in a pipe at that flow: the loss across it is 40 kPa
    const { project, selectUid } = insertOnPipe(p, pipe.uid, 'orifice', 520, 200);
    const o = project.edges.find((e) => e.uid === selectUid)!;
    if (o.kind !== 'valve') throw new Error();
    const fixed = { ...project, edges: project.edges.map((e) => (e.uid === o.uid ? { ...e, lossValue: s.boreMm } : e)) };
    const r = compute(fixed).result!.valves.find((x) => x.id === o.name)!;
    const q = Math.abs(r.flowM3s) * 1000;
    const again = orificeBoreForDrop(q, r.pressureDropPa / 1000, pipe.diameterMm, rho);
    expect(again.boreMm).toBeCloseTo(s.boreMm, 3); // self-consistent at the flow the plate actually passes
  });

  it('a bigger drop needs a smaller bore, and warns when beta or velocity is extreme', () => {
    const a = orificeBoreForDrop(10, 20, 100, 998);
    const b = orificeBoreForDrop(10, 200, 100, 998);
    expect(b.boreMm).toBeLessThan(a.boreMm);
    const extreme = orificeBoreForDrop(10, 3000, 100, 998);
    expect(extreme.warnings.length).toBeGreaterThan(0);
  });

  it('explains when no plate can give the drop', () => {
    expect(() => orificeBoreForDrop(10, 1e7, 100, 998)).toThrow(/more than any orifice/);
    expect(() => orificeBoreForDrop(10, 0.001, 100, 998)).toThrow(/no orifice is needed/);
    expect(() => orificeBoreForDrop(10, 20, 0, 998)).toThrow(/pipe diameter/);
  });
});
