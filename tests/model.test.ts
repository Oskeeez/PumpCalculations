import { describe, expect, it } from 'vitest';
import { speedSweep } from '../src/analysis';
import { compute, defaultProject, newNode, newPipe } from '../src/model';

describe('UI model', () => {
  it('solves the default looped example network with a pump, demands and two tanks', () => {
    const c = compute(defaultProject());
    expect(c.error).toBeUndefined();
    expect(c.result?.converged).toBe(true);
    expect(c.result?.nodes).toHaveLength(8);
    expect(c.result?.valves).toHaveLength(1);
    expect(c.result?.pumps[0].flowM3s).toBeGreaterThan(0);
    expect(c.pumpCurves).toHaveLength(1);
    expect(c.pumpCurves[0].op).toBeDefined();
  });

  it('reports readable errors for an invalid or incomplete network', () => {
    const p = defaultProject();
    expect(compute({ ...p, nodes: p.nodes.filter((n) => n.kind !== 'tank'), edges: [] }).error).toMatch(/tank/i);
    expect(compute({ ...p, temperatureC: 150 }).error).toMatch(/temperature/i);
    const bad = { ...p, edges: p.edges.map((e) => (e.kind === 'pipe' && e.name === 'Pipe A' ? { ...e, diameterMm: 0 } : e)) };
    expect(compute(bad).error).toMatch(/Pipe A.*diameter/);
  });

  it('flags an island with no path to a tank', () => {
    const p = defaultProject();
    const x = newNode('junction', 10, 10, p.nodes.map((n) => n.name));
    const y = newNode('junction', 50, 10, [...p.nodes.map((n) => n.name), x.name]);
    const c = compute({ ...p, nodes: [...p.nodes, x, y], edges: [...p.edges, newPipe(x.uid, y.uid, p.edges.map((e) => e.name))] });
    expect(c.error).toMatch(/not connected/);
  });

  it('flips the sign of flow, not its magnitude, when a pipe direction is swapped', () => {
    const p = defaultProject();
    const base = compute(p).result!;
    const swapped = compute({ ...p, edges: p.edges.map((e) => (e.name === 'Cross link' ? { ...e, from: e.to, to: e.from } : e)) }).result!;
    const a = base.pipes.find((q) => q.id === 'Cross link')!.flowM3s;
    const b = swapped.pipes.find((q) => q.id === 'Cross link')!.flowM3s;
    expect(b).toBeCloseTo(-a, 9);
  });
});

import { blankProject, parseProject, serializeProject } from '../src/model';

describe('project save / load', () => {
  it('round-trips the example project exactly, and the loaded copy solves to the same answer', () => {
    const p = defaultProject();
    const back = parseProject(serializeProject(p));
    expect(back).toEqual(p);
    expect(compute(back).result?.pumps[0].flowM3s).toBeCloseTo(compute(p).result!.pumps[0].flowM3s, 12);
  });

  it('rejects malformed, foreign and inconsistent files with readable messages', () => {
    const p = defaultProject();
    expect(() => parseProject('not json')).toThrow(/not valid JSON/);
    expect(() => parseProject('{"a":1}')).toThrow(/not a pipe network/);
    expect(() => parseProject(JSON.stringify({ format: 'pipe-network-project', version: 99, project: p }))).toThrow(/version/);
    const dangling = { ...p, edges: p.edges.map((e, i) => (i === 0 ? { ...e, to: 'u999999' } : e)) };
    expect(() => parseProject(serializeProject(dangling))).toThrow(/not in the file/);
    const badNode = { ...p, nodes: p.nodes.map((n, i) => (i === 0 ? { ...n, x: 'left' as unknown as number } : n)) };
    expect(() => parseProject(serializeProject(badNode))).toThrow(/node.*malformed/);
  });

  it('does not reuse the ids of a loaded project for new items', () => {
    const loaded = parseProject(serializeProject(defaultProject()));
    const used = new Set([...loaded.nodes.map((n) => n.uid), ...loaded.edges.map((e) => e.uid)]);
    expect(used.has(newNode('junction', 0, 0, []).uid)).toBe(false);
  });

  it('an empty project reports that a tank is needed', () => {
    expect(compute(blankProject()).error).toMatch(/tank/i);
  });
});

describe('fluids, valves and design alerts in the UI model', () => {
  it('changing the fluid changes the result (thicker glycol lowers pump flow)', () => {
    const p = defaultProject();
    const water = compute(p).result!.pumps[0].flowM3s;
    const glycol = compute({ ...p, fluid: { ...p.fluid, id: 'eg50' } }).result!.pumps[0].flowM3s;
    expect(glycol).toBeLessThan(water);
  });

  it('reports a clear error when the temperature is outside the fluid data range', () => {
    const p = defaultProject();
    expect(compute({ ...p, fluid: { ...p.fluid, id: 'seawater' }, temperatureC: 60 }).error).toMatch(/Seawater.*between 0 and 40/);
  });

  it('supports a custom fluid with constant properties', () => {
    const p = defaultProject();
    const c = compute({ ...p, fluid: { ...p.fluid, id: 'custom', customDensity: 850, customViscosityMPas: 8, customVaporKPa: 1 } });
    expect(c.error).toBeUndefined();
    expect(c.model?.fluid.density).toBe(850);
    expect(c.model?.fluid.dynamicViscosity).toBeCloseTo(0.008, 12);
  });

  it('closing the throttle valve changes the flow split; opening it wide restores more flow to Tank C', () => {
    const p = defaultProject();
    const qc = (cv: number) => {
      const r = compute({ ...p, edges: p.edges.map((e) => (e.kind === 'valve' ? { ...e, lossValue: cv } : e)) }).result!;
      return r.pipes.find((x) => x.id === 'To Tank C')!.flowM3s;
    };
    expect(qc(20)).toBeLessThan(qc(250));
    expect(qc(250)).toBeLessThan(qc(5000));
  });

  it('a closed valve in the example loop leaves the network solvable (the loop provides another path)', () => {
    const p = defaultProject();
    const c = compute({ ...p, edges: p.edges.map((e) => (e.kind === 'valve' ? { ...e, open: false } : e)) });
    expect(c.error).toBeUndefined();
    expect(c.result?.valves[0].status).toBe('closed');
    expect(c.result?.valves[0].flowM3s).toBe(0);
  });

  it('raises a velocity design alert only when the limit is exceeded, and not when disabled', () => {
    const p = defaultProject();
    const base = compute(p);
    const vmax = Math.max(...base.result!.pipes.map((x) => x.flow.velocity));
    expect(compute({ ...p, maxVelocityMps: vmax * 2 }).alerts).toHaveLength(0);
    expect(compute({ ...p, maxVelocityMps: vmax * 0.5 }).alerts.length).toBeGreaterThan(0);
    expect(compute({ ...p, maxVelocityMps: 0 }).alerts).toHaveLength(0);
  });
});

import { insertOnPipe } from '../src/model';

describe('insert onto a pipe', () => {
  const pipeA = (p: ReturnType<typeof defaultProject>) => p.edges.find((e) => e.name === 'Pipe A')!;

  it('splits a pipe around a valve, keeps the network solvable and shares the length', () => {
    const p = defaultProject();
    const a = pipeA(p);
    const base = compute(p).result!;
    const { project, selectUid } = insertOnPipe(p, a.uid, 'valve', 540, 195);
    expect(project.nodes).toHaveLength(p.nodes.length + 2);
    expect(project.edges).toHaveLength(p.edges.length + 2);
    const v = project.edges.find((e) => e.uid === selectUid)!;
    expect(v.kind).toBe('valve');
    const head = project.edges.find((e) => e.uid === a.uid)!;
    const tail = project.edges.find((e) => e.kind === 'pipe' && e.from === v.to)!;
    expect(head.to).toBe(v.from);
    expect(tail.to).toBe(a.to);
    if (head.kind === 'pipe' && tail.kind === 'pipe' && a.kind === 'pipe') {
      expect(head.lengthM + tail.lengthM).toBeLessThan(a.lengthM);
      expect(head.lengthM + tail.lengthM).toBeGreaterThan(a.lengthM * 0.5);
      expect(tail.diameterMm).toBe(a.diameterMm);
    }
    const c = compute(project);
    expect(c.error).toBeUndefined();
    // a low-loss open valve barely changes the pump flow
    expect(c.result!.pumps[0].flowM3s).toBeCloseTo(base.pumps[0].flowM3s, 2);
  });

  it('inserts a junction without changing hydraulics, and rejects non-pipes', () => {
    const p = defaultProject();
    const a = pipeA(p);
    const { project } = insertOnPipe(p, a.uid, 'junction', 500, 200);
    expect(project.nodes).toHaveLength(p.nodes.length + 1);
    expect(project.edges).toHaveLength(p.edges.length + 1);
    expect(compute(project).result!.pumps[0].flowM3s).toBeCloseTo(compute(p).result!.pumps[0].flowM3s, 6);
    const pump = p.edges.find((e) => e.kind === 'pump')!;
    expect(() => insertOnPipe(p, pump.uid, 'valve', 0, 0)).toThrow(/pipe/);
  });

  it('inserts a pump', () => {
    const p = defaultProject();
    const { project, selectUid } = insertOnPipe(p, pipeA(p).uid, 'pump', 520, 200);
    expect(project.edges.find((e) => e.uid === selectUid)?.kind).toBe('pump');
    expect(compute(project).error).toBeUndefined();
  });
});

import { connectToNewNode, makeEdge, placeStandalone } from '../src/model';

describe('placing elements', () => {
  it('splits a pipe with a tank', () => {
    const p = defaultProject();
    const pipe = p.edges.find((e) => e.name === 'Pipe A')!;
    const { project, selectUid } = insertOnPipe(p, pipe.uid, 'tank', 520, 200);
    const t = project.nodes.find((n) => n.uid === selectUid)!;
    expect(t.kind).toBe('tank');
    expect(project.nodes).toHaveLength(p.nodes.length + 1);
    expect(project.edges).toHaveLength(p.edges.length + 1);
    expect(compute(project).error).toBeUndefined();
  });

  it('places a pump, valve or orifice on its own with two end nodes, suction on the left', () => {
    const p = defaultProject();
    for (const kind of ['pump', 'valve', 'orifice'] as const) {
      const { project, selectUid } = placeStandalone(p, kind, 300, 500);
      expect(project.nodes).toHaveLength(p.nodes.length + 2);
      const e = project.edges.find((x) => x.uid === selectUid)!;
      const a = project.nodes.find((n) => n.uid === e.from)!;
      const b = project.nodes.find((n) => n.uid === e.to)!;
      expect(a.x).toBeLessThan(b.x);
      expect(e.kind).toBe(kind === 'pump' ? 'pump' : 'valve');
    }
    expect(placeStandalone(p, 'pump', 300, 500).project.nodes.slice(-2).map((n) => n.name)).toEqual(['Suction 1', 'Discharge 1']);
  });

  it('drag from a node into empty space creates a new end node at that point, at the start elevation', () => {
    const p = defaultProject();
    const j2 = p.nodes.find((n) => n.name === 'J2')!;
    const { project, selectUid } = connectToNewNode(p, 'pipe', j2.uid, 700, 60);
    const e = project.edges.find((x) => x.uid === selectUid)!;
    expect(e.from).toBe(j2.uid);
    const end = project.nodes.find((n) => n.uid === e.to)!;
    expect([end.x, end.y, end.elevationM]).toEqual([700, 60, j2.elevationM]);
    expect(() => connectToNewNode(p, 'pipe', 'nope', 0, 0)).toThrow(/no longer exists/);
    expect(makeEdge('orifice', 'a', 'b', [], 80)).toMatchObject({ kind: 'valve', lossType: 'orifice', diameterMm: 80 });
  });
});

import { connectBlank } from '../src/model';

describe('drag across blank canvas', () => {
  it('creates two new nodes and a pipe between them, start to end', () => {
    const p = defaultProject();
    const { project, selectUid } = connectBlank(p, 'pipe', { x: 100, y: 500 }, { x: 300, y: 500 });
    expect(project.nodes).toHaveLength(p.nodes.length + 2);
    expect(project.edges).toHaveLength(p.edges.length + 1);
    const e = project.edges.find((x) => x.uid === selectUid)!;
    const a = project.nodes.find((n) => n.uid === e.from)!;
    const b = project.nodes.find((n) => n.uid === e.to)!;
    expect([a.x, a.y, b.x, b.y]).toEqual([100, 500, 300, 500]);
    expect(e.kind).toBe('pipe');
  });
  it('ending the drag on an existing node reuses it and only adds the start node', () => {
    const p = defaultProject();
    const j2 = p.nodes.find((n) => n.name === 'J2')!;
    const { project, selectUid } = connectBlank(p, 'pump', { x: 100, y: 500 }, { uid: j2.uid });
    expect(project.nodes).toHaveLength(p.nodes.length + 1);
    const e = project.edges.find((x) => x.uid === selectUid)!;
    expect(e.to).toBe(j2.uid);
    expect(e.kind).toBe('pump');
    expect(() => connectBlank(p, 'pipe', { x: 0, y: 0 }, { uid: 'nope' })).toThrow(/no longer exists/);
  });
});

describe('pump on / off and speed control in the app model', () => {
  const pumpOf = (p: ReturnType<typeof defaultProject>) => p.edges.find((e) => e.kind === 'pump')!;
  const withPump = (p: ReturnType<typeof defaultProject>, patch: object) => ({ ...p, edges: p.edges.map((e) => (e.kind === 'pump' ? { ...e, ...patch } : e)) });

  it('a pump that is switched off carries no flow and the result says so', () => {
    const p = defaultProject();
    // add a second, parallel pump so the network still has a source when one is off
    const pump = pumpOf(p);
    if (pump.kind !== 'pump') throw new Error();
    const second = { ...pump, uid: 'u9001', name: 'Pump 2' };
    const two = { ...p, edges: [...p.edges, second] };
    const off = { ...two, edges: two.edges.map((e) => (e.uid === 'u9001' ? { ...e, running: false } : e)) };
    const c = compute(off);
    expect(c.error).toBeUndefined();
    expect(c.result!.pumps.find((x) => x.id === 'Pump 2')!.flowM3s).toBe(0);
    expect(c.result!.warnings.join(' ')).toMatch(/Pump 2.*switched off/);
    expect(c.result!.pumps.find((x) => x.id === 'Pump 1')!.flowM3s).toBeGreaterThan(compute(two).result!.pumps.find((x) => x.id === 'Pump 1')!.flowM3s);
  });

  it('holds a flow by changing the pump speed, and reports the speed it found', () => {
    const p = defaultProject();
    const base = compute(p).result!.pumps[0].flowM3s * 1000; // L/s at rated speed
    const target = base * 0.8;
    const c = compute(withPump(p, { control: { mode: 'flow', lps: target, minRatio: 0.3, maxRatio: 1 } }));
    expect(c.error).toBeUndefined();
    expect(c.result!.pumps[0].flowM3s * 1000).toBeCloseTo(target, 3);
    expect(c.result!.pumps[0].speedRatio).toBeLessThan(1);
    expect(c.alerts.filter((a) => /speed/.test(a))).toEqual([]);
  });

  it('holds a node pressure, and tells the user when the pump cannot reach it', () => {
    const p = defaultProject();
    const j3 = p.nodes.find((n) => n.name === 'J3')!;
    const here = compute(p).result!.nodes.find((n) => n.id === 'J3')!.gaugePressurePa / 1000;
    const ok = compute(withPump(p, { control: { mode: 'pressure', nodeUid: j3.uid, kPaG: here - 10, minRatio: 0.3, maxRatio: 1.2 } }));
    expect(ok.result!.nodes.find((n) => n.id === 'J3')!.gaugePressurePa / 1000).toBeCloseTo(here - 10, 1);
    const tooHigh = compute(withPump(p, { control: { mode: 'pressure', nodeUid: j3.uid, kPaG: 5000, minRatio: 0.3, maxRatio: 1 } }));
    expect(tooHigh.alerts.join(' ')).toMatch(/maximum speed.*cannot reach 5000\.0 kPa at "J3"/);
  });

  it('validates the control settings with readable messages', () => {
    const p = defaultProject();
    expect(compute(withPump(p, { control: { mode: 'flow', lps: 0, minRatio: 0.3, maxRatio: 1 } })).error).toMatch(/flow to hold/);
    expect(compute(withPump(p, { control: { mode: 'flow', lps: 5, minRatio: 1, maxRatio: 0.5 } })).error).toMatch(/speed limits/);
    expect(compute(withPump(p, { control: { mode: 'pressure', nodeUid: 'nope', kPaG: 100, minRatio: 0.3, maxRatio: 1 } })).error).toMatch(/choose a node/);
  });

  it('a speed sweep ignores the control, so every speed is really tried', () => {
    const p = defaultProject();
    const pump = pumpOf(p);
    const controlled = withPump(p, { control: { mode: 'flow', lps: 20, minRatio: 0.3, maxRatio: 1 } });
    const sweep = speedSweep(controlled, pump.uid, [0.7, 0.9, 1])!;
    expect(sweep.rows.map((r) => r.speedRatio)).toEqual([0.7, 0.9, 1]);
    expect(sweep.rows[0].flowLps!).toBeLessThan(sweep.rows[2].flowLps!);
  });

  it('control and running survive save and load', () => {
    const p = withPump(defaultProject(), { running: false, control: { mode: 'flow', lps: 5, minRatio: 0.4, maxRatio: 0.9 } });
    const back = parseProject(serializeProject(p));
    const pump = back.edges.find((e) => e.kind === 'pump')!;
    expect(pump.kind === 'pump' && pump.running).toBe(false);
    expect(pump.kind === 'pump' && pump.control).toEqual({ mode: 'flow', lps: 5, minRatio: 0.4, maxRatio: 0.9 });
  });
});

import { COPPER_L, PIPE_SERIES, SCH40, SCH80, matchPipeSize } from '../src/library';

describe('pipe size series and pressure rating', () => {
  it('has Sch 80 walls thicker (smaller bore) than Sch 40 at every shared size, and finds sizes by diameter', () => {
    for (const s of SCH80) {
      const s40 = SCH40.find((x) => x.nps === s.nps);
      if (s40) expect(s.idMm).toBeLessThan(s40.idMm);
    }
    expect(SCH80.find((x) => x.nps === '4"')!.idMm).toBeCloseTo(97.18, 1); // 3.826 in
    expect(COPPER_L.find((x) => x.nps === '1"')!.idMm).toBeCloseTo(26.04, 1);
    expect(PIPE_SERIES.map((x) => x.id)).toEqual(['sch40', 'sch80', 'copperL']);
    expect(matchPipeSize(102.26)).toEqual({ series: 'sch40', nps: '4"' });
    expect(matchPipeSize(97.18)).toEqual({ series: 'sch80', nps: '4"' });
    expect(matchPipeSize(77.0)).toBeUndefined();
  });

  it('raises an alert where the solved pressure exceeds a pipe rating, and not otherwise', () => {
    const p = defaultProject();
    const highest = Math.max(...compute(p).result!.nodes.map((n) => n.gaugePressurePa / 1000));
    const rate = (kPa: number) => ({ ...p, edges: p.edges.map((e) => (e.kind === 'pipe' && e.name === 'Pipe A' ? { ...e, ratingKPaG: kPa } : e)) });
    expect(compute(rate(highest + 500)).alerts.filter((a) => /rating/.test(a))).toEqual([]);
    const pa = compute(p).result!.nodes.find((n) => n.id === 'J1')!.gaugePressurePa / 1000; // the pipe starts at J1
    const alerts = compute(rate(pa - 20)).alerts.filter((a) => /rating/.test(a));
    expect(alerts[0]).toMatch(/Pipe "Pipe A": pressure \d+ kPa at "J1" exceeds its rating of/);
  });
});
