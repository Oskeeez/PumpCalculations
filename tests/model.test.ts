import { describe, expect, it } from 'vitest';
import { compute, defaultProject, newNode, newPipe } from '../src/model';

describe('UI model', () => {
  it('solves the default looped example network with a pump, demands and two tanks', () => {
    const c = compute(defaultProject());
    expect(c.error).toBeUndefined();
    expect(c.result?.converged).toBe(true);
    expect(c.result?.nodes).toHaveLength(7);
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
