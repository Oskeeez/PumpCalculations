import { describe, expect, it } from 'vitest';
import { compareScenarios, snapshotScenario, speedRatios, speedSweep } from '../src/analysis';
import { compute, defaultProject, parseProject, serializeProject } from '../src/model';

describe('pump speed sweep', () => {
  const p = defaultProject();
  const pump = p.edges.find((e) => e.kind === 'pump')!;

  it('builds a speed list from a range', () => {
    expect(speedRatios(60, 100, 10)).toEqual([0.6, 0.7, 0.8, 0.9, 1]);
    expect(speedRatios(100, 50, 10)).toEqual([]);
    expect(speedRatios(50, 100, 0)).toEqual([]);
  });

  it('the 100 % row equals the ordinary solution', () => {
    const sweep = speedSweep(p, pump.uid, [1])!;
    const base = compute(p).result!.pumps[0];
    expect(sweep.rows[0].flowLps).toBeCloseTo(base.flowM3s * 1000, 9);
    expect(sweep.rows[0].headM).toBeCloseTo(base.headM, 9);
    expect(sweep.rows[0].shaftKw).toBeCloseTo((base.shaftPowerW as number) / 1000, 9);
  });

  it('flow, head and power rise with speed; each operating point lies on its affinity-scaled curve', () => {
    const ratios = [0.7, 0.8, 0.9, 1.0, 1.1];
    const sweep = speedSweep(p, pump.uid, ratios)!;
    const rows = sweep.rows;
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].flowLps!).toBeGreaterThan(rows[i - 1].flowLps!);
      expect(rows[i].headM!).toBeGreaterThan(rows[i - 1].headM!);
      expect(rows[i].shaftKw!).toBeGreaterThan(rows[i - 1].shaftKw!);
    }
    // a pump curve point at speed r: H(Q) = a0 r^2 + a1 r Q + a2 Q^2 -> read it from the plotted curve
    const s = sweep.series.find((x) => x.name === '80 %')!;
    const op = s.op!;
    const near = s.pts.reduce((a, b) => (Math.abs(b.q - op.q) < Math.abs(a.q - op.q) ? b : a));
    expect(Math.abs(near.h - op.h) / op.h).toBeLessThan(0.02); // within sampling resolution of the curve
    expect(sweep.series[sweep.series.length - 1].name).toBe('System operating points');
    expect(rows.every((r) => r.rpm === r.speedRatio * 1450)).toBe(true);
  });

  it('reports an unusable speed as an error row instead of throwing', () => {
    const sweep = speedSweep(p, pump.uid, [1, 0])!;
    expect(sweep.rows[1].error).toMatch(/speed ratio/i);
  });

  it('returns undefined for a non-pump', () => {
    expect(speedSweep(p, p.edges.find((e) => e.kind === 'pipe')!.uid, [1])).toBeUndefined();
  });
});

describe('scenarios', () => {
  const p = defaultProject();

  it('a snapshot is independent of later edits and round-trips through save/load', () => {
    const s = snapshotScenario(p, 'Base');
    const edited = { ...p, nodes: p.nodes.map((n) => ({ ...n, elevationM: n.elevationM + 100 })), scenarios: [s] };
    expect(s.project.nodes[0].elevationM).toBe(p.nodes[0].elevationM);
    const back = parseProject(serializeProject(edited));
    expect(back.scenarios).toHaveLength(1);
    expect(back.scenarios![0]).toEqual(s);
    expect(back.scenarios![0].project).not.toHaveProperty('scenarios');
  });

  it('rejects a malformed saved scenario', () => {
    const bad = { ...p, scenarios: [{ id: 'x', name: 'Bad', project: { nodes: [] } }] };
    expect(() => parseProject(serializeProject(bad as never))).toThrow();
  });

  it('compares scenarios by element name with correct deltas', () => {
    const slow = { ...p, edges: p.edges.map((e) => (e.kind === 'pump' ? { ...e, speedRatio: 0.8 } : e)) };
    const items = [
      { name: 'Rated', computed: compute(p) },
      { name: '80 % speed', computed: compute(slow) },
    ];
    const cmp = compareScenarios(items);
    expect(cmp.columns).toEqual(['Rated', '80 % speed']);
    const sys = cmp.sections[0];
    const supplied = sys.rows.find((r) => r.label === 'Supplied by tanks')!.values as number[];
    expect(supplied[1]).toBeLessThan(supplied[0]);
    // independent recomputation: what the tanks give up (negative net inflow), summed, in L/s
    const tankSupply = items[0].computed.result!.nodes.filter((n) => n.kind === 'tank').reduce((s, n) => s + Math.max(0, -n.netOutflowM3s), 0) * 1000;
    expect(supplied[0]).toBeCloseTo(tankSupply, 12);
    // only the Supply tank gives flow here (pump flow in = what leaves the supply tank)
    expect(supplied[0]).toBeCloseTo(items[0].computed.result!.pumps[0].flowM3s * 1000, 9);
    const flow = cmp.sections.find((s) => s.title === 'Pumps')!.rows.find((r) => r.label === 'Pump 1: flow')!.values as number[];
    expect(flow[0]).toBeCloseTo(items[0].computed.result!.pumps[0].flowM3s * 1000, 12);
    expect(flow[1]).toBeCloseTo(items[1].computed.result!.pumps[0].flowM3s * 1000, 12);
    expect(cmp.sections.map((s) => s.title)).toEqual(['System', 'Pumps', 'Valves', 'Pipes', 'Junctions']);
  });

  it('matches elements missing from some scenarios and survives an unsolvable scenario', () => {
    const noValve = { ...p, edges: p.edges.filter((e) => e.kind !== 'valve') };
    const broken = { ...p, temperatureC: 500 };
    const cmp = compareScenarios([
      { name: 'A', computed: compute(p) },
      { name: 'B', computed: compute(noValve) },
      { name: 'C', computed: compute(broken) },
    ]);
    const valveStatus = cmp.sections.find((s) => s.title === 'Valves')!.rows.find((r) => r.label.endsWith('status'))!.values;
    expect(valveStatus[0]).toBe('open');
    expect(valveStatus[1]).toBeUndefined();
    expect(valveStatus[2]).toBeUndefined();
    expect(cmp.errors[2]).toMatch(/temperature/i);
    expect(cmp.sections[0].rows[0].values).toEqual(['yes', 'yes', 'error']);
  });
});
