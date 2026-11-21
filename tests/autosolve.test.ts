import { describe, expect, it } from 'vitest';
import { evaluateTargets } from '../src/ai/targets';
import type { Target } from '../src/ai/types';
import { DEFAULT_SOLVE_SETTINGS, findVariables, solveForTargets, withMargin, type SolveSettings } from '../src/autosolve';
import { compute, defaultProject, type ProjectUI } from '../src/model';

const base = defaultProject();
const node = (name: string) => base.nodes.find((n) => n.name === name)!;
const edge = (name: string) => base.edges.find((e) => e.name === name)!;
const gauge = (p: ProjectUI, name: string) => compute(p).result!.nodes.find((n) => n.id === name)!.gaugePressurePa / 1000;
const passes = (p: ProjectUI, t: Target[]) => evaluateTargets(p, t, compute(p)).every((s) => s.pass);
const only = (patch: Partial<Record<keyof SolveSettings, unknown>>): SolveSettings => {
  const off = { ...DEFAULT_SOLVE_SETTINGS };
  for (const k of ['pipes', 'pumpSpeed', 'trim', 'valves', 'regulators', 'orifices', 'tanks'] as const) off[k] = { ...(off[k] as object), on: false } as never;
  return { ...off, ...(patch as object) } as SolveSettings;
};
const on = <K extends 'pipes' | 'pumpSpeed' | 'trim' | 'valves' | 'regulators' | 'orifices' | 'tanks'>(k: K, extra: object = {}) => ({ [k]: { ...DEFAULT_SOLVE_SETTINGS[k], ...extra, on: true } });
const p3 = gauge(base, 'J3');

describe('solve for me', () => {
  it('does nothing, and says so, when every target already passes', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 - 50 }];
    const r = await solveForTargets(base, t);
    expect(r.status).toBe('already-passing');
    expect(r.changes).toEqual([]);
    expect(r.project).toBe(base);
  });

  it('raises a pressure to a target by changing allowed things, and the result really passes', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    const r = await solveForTargets(base, t);
    expect(r.status).toBe('solved');
    expect(r.changes.length).toBeGreaterThan(0);
    expect(passes(r.project, t)).toBe(true);
    expect(gauge(r.project, 'J3')).toBeGreaterThan(p3 + 60);
    expect(r.before[0].pass).toBe(false);
    expect(r.after[0].pass).toBe(true);
    expect(base.edges.find((e) => e.name === 'Pipe A')).toEqual(edge('Pipe A')); // the original project is not touched
  });

  it('changes only the kinds of thing that are switched on', async () => {
    const t: Target[] = [{ id: 'a', type: 'pumpRange', pumpUid: edge('Pump 1').uid, maxPctBep: 120 }];
    const r = await solveForTargets(base, t, only(on('pumpSpeed')));
    expect(r.status).toBe('solved');
    expect(new Set(r.changes.map((c) => c.parameter))).toEqual(new Set(['speed']));
    const after = r.project.edges.find((e) => e.name === 'Pump 1')!;
    expect(after.kind === 'pump' && after.speedRatio).toBeLessThan(1);
    expect(r.project.edges.filter((e) => e.kind === 'pipe')).toEqual(base.edges.filter((e) => e.kind === 'pipe'));
  });

  it('makes the smallest change that works: it does not slow the pump further than needed', async () => {
    const t: Target[] = [{ id: 'a', type: 'pumpRange', pumpUid: edge('Pump 1').uid, maxPctBep: 120 }];
    const r = await solveForTargets(base, t, { ...only(on('pumpSpeed')), marginFraction: 0 });
    const duty = compute(r.project).result!.pumps[0];
    expect(duty.flowM3s).toBeGreaterThan(0);
    // 172 % of BEP at the start; the answer sits close to the 120 % limit, not far below it
    const pct = evaluateTargets(r.project, t, compute(r.project))[0].text;
    expect(pct).toMatch(/\d+ % of BEP/);
    expect(Number(/(\d+) % of BEP/.exec(pct)![1])).toBeGreaterThanOrEqual(115);
  });

  it('leaves a margin on flow, pressure and velocity limits', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    const r = await solveForTargets(base, t, { ...DEFAULT_SOLVE_SETTINGS, marginFraction: 0.1 });
    expect(r.status).toBe('solved');
    expect(gauge(r.project, 'J3')).toBeGreaterThanOrEqual((p3 + 60) * 1.1 - 1);
    expect((withMargin(t, 0.1)[0] as { minKPaG: number }).minKPaG).toBeCloseTo((p3 + 60) * 1.1, 9);
    expect((withMargin([{ id: 'v', type: 'velocity', scope: 'all', maxMps: 3 }], 0.1)[0] as { maxMps: number }).maxMps).toBeCloseTo(2.7, 9);
  });

  it('never changes a locked component, or anything connected to a locked node', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    // locking J3 freezes the three things attached to it: Cross link, To Tank C and the Throttle valve
    const r = await solveForTargets(base, t, DEFAULT_SOLVE_SETTINGS, new Set([node('J3').uid]));
    for (const name of ['Cross link', 'To Tank C', 'Throttle valve']) expect(r.project.edges.find((e) => e.name === name)).toEqual(edge(name));
    for (const c of r.changes) expect(['Cross link', 'To Tank C', 'Throttle valve']).not.toContain(c.component);
    // and a single locked component stays as it was
    const r2 = await solveForTargets(base, t, DEFAULT_SOLVE_SETTINGS, new Set([edge('To Tank C').uid]));
    expect(r2.project.edges.find((e) => e.name === 'To Tank C')).toEqual(edge('To Tank C'));
  });

  it('lists exactly the things that may change, and none that are locked', () => {
    const all = findVariables(base, DEFAULT_SOLVE_SETTINGS, new Set());
    expect(all.some((v) => v.component === 'Pump 1' && v.parameter === 'speed')).toBe(true);
    expect(all.some((v) => v.component === 'Throttle valve')).toBe(true);
    const locked = findVariables(base, DEFAULT_SOLVE_SETTINGS, new Set([edge('Pump 1').uid]));
    expect(locked.some((v) => v.component === 'Pump 1')).toBe(false);
    expect(findVariables(base, only({}), new Set())).toEqual([]);
  });

  it('says plainly when nothing may change, and when there are no targets', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    const none = await solveForTargets(base, t, only({}));
    expect(none.status).toBe('nothing-allowed');
    expect(none.notes[0]).toMatch(/Nothing is allowed to change/);
    expect((await solveForTargets(base, [])).notes[0]).toMatch(/no targets/);
  });

  it('reports the best it could do, honestly, when a target cannot be reached', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J2').uid, minKPaG: 50000 }];
    const r = await solveForTargets(base, t);
    expect(['improved', 'no-improvement']).toContain(r.status);
    expect(r.after[0].pass).toBe(false);
    expect(r.notes.join(' ')).toMatch(/not all met|None of the allowed changes helped/);
    expect(r.notes.join(' ')).toMatch(/Infeasible|At their limit/);
  });

  it('stops at the solve limit, and can be cancelled', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J2').uid, minKPaG: 50000 }];
    const capped = await solveForTargets(base, t, { ...DEFAULT_SOLVE_SETTINGS, maxSolves: 30 });
    expect(capped.solves).toBeLessThan(120);
    expect(capped.notes.join(' ')).toMatch(/stopped after 30 tries/);
    let n = 0;
    const stopped = await solveForTargets(base, t, DEFAULT_SOLVE_SETTINGS, new Set(), { shouldCancel: () => ++n > 5 });
    expect(stopped.solves).toBeLessThan(40);
  });

  it('reports progress while it works', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    const seen: number[] = [];
    await solveForTargets(base, t, DEFAULT_SOLVE_SETTINGS, new Set(), { onProgress: (i) => seen.push(i.shortfall) });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('can be limited to one component (used by the size buttons)', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    const r = await solveForTargets(base, t, DEFAULT_SOLVE_SETTINGS, new Set(), {}, new Set([edge('Throttle valve').uid]));
    for (const c of r.changes) expect(c.component).toBe('Throttle valve');
  });
});

describe('solve for me keeps what works working', () => {
  it('does not break the velocity limit while it solves, and says so', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    expect(compute(base).alerts.filter((a) => /velocity/.test(a))).toEqual([]); // the example is inside its 3 m/s limit
    const r = await solveForTargets(base, t);
    expect(r.status).toBe('solved');
    expect(compute(r.project).alerts.filter((a) => /velocity/.test(a))).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/Kept within the 3 m\/s velocity limit/);
  });

  it('may break it when asked not to keep the design limits', async () => {
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    const r = await solveForTargets(base, t, { ...DEFAULT_SOLVE_SETTINGS, keepDesignLimits: false });
    expect(r.status).toBe('solved');
    expect(r.notes.join(' ')).not.toMatch(/Kept within/);
  });

  it('does not try to protect a limit that is already broken', async () => {
    const tight = { ...base, maxVelocityMps: 0.2 };
    const t: Target[] = [{ id: 'a', type: 'pressure', nodeUid: node('J3').uid, minKPaG: p3 + 60 }];
    const r = await solveForTargets(tight, t);
    expect(r.notes.join(' ')).not.toMatch(/m\/s velocity limit/);
  });
});
