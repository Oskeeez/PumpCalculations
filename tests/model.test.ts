import { describe, expect, it } from 'vitest';
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
