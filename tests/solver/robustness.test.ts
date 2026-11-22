import { describe, expect, it } from 'vitest';
import { P_ATM, fitPump, fluidAt, solveSystem, type SysEdge, type SysNode, type SysPump, type SystemModel } from '../../src/solver';

const water = fluidAt('water', 20);
const tank = (id: string, level: number, z = 0): SysNode => ({ kind: 'tank', id, elevationM: z, liquidLevelM: level, surfacePressurePa: P_ATM });
const junction = (id: string, demandLps = 0, z = 0): SysNode => ({ kind: 'junction', id, elevationM: z, demandM3s: demandLps / 1000 });
const pipe = (id: string, from: string, to: string, lengthM: number, dMm: number, fittingsK: number[] = []): SysEdge => ({
  kind: 'pipe', id, from, to, spec: { lengthM, innerDiameterM: dMm / 1000, roughnessM: 0.00005, elevationChangeM: 0, fittingsK },
});
const valve = (id: string, from: string, to: string, k: number, o: { open?: boolean; check?: boolean } = {}): SysEdge => ({
  kind: 'valve', id, from, to, spec: { diameterM: 0.1, loss: { type: 'K', k }, checkValve: o.check ?? false, open: o.open ?? true },
});
const pump = (id: string, from: string, to: string, shutoffM = 40, designLps = 20): SysEdge => ({
  kind: 'pump', id, from, to, speedRatio: 1,
  model: fitPump({ head: [{ flowM3s: 0, headM: shutoffM }, { flowM3s: designLps / 1000, headM: shutoffM * 0.75 }, { flowM3s: (designLps * 2) / 1000, headM: 0 }] }),
});
const solve = (nodes: SysNode[], edges: SysEdge[]) => solveSystem({ fluid: water, nodes, edges } as SystemModel);
const flow = (r: ReturnType<typeof solve>, id: string) => (r.pipes.find((p) => p.id === id) ?? r.valves.find((v) => v.id === id) ?? r.pumps.find((p) => p.id === id))!.flowM3s * 1000;

describe('degenerate but valid inputs', () => {
  it('a zero-length pipe with no fittings acts as a plain connection instead of crashing', () => {
    const r = solve([tank('A', 10), tank('B', 5), junction('J')], [pipe('p0', 'A', 'J', 0, 100), pipe('p1', 'J', 'B', 100, 100)]);
    expect(r.converged).toBe(true);
    expect(flow(r, 'p1')).toBeGreaterThan(0);
    expect(flow(r, 'p0')).toBeCloseTo(flow(r, 'p1'), 6);
  });

  it('a valve with K = 0 behaves as fully open', () => {
    const r = solve([tank('A', 10), tank('B', 5), junction('J')], [valve('v', 'A', 'J', 0), pipe('p1', 'J', 'B', 100, 100)]);
    expect(r.converged).toBe(true);
    expect(flow(r, 'v')).toBeCloseTo(flow(r, 'p1'), 6);
  });

  it('very large and very small loss coefficients both solve', () => {
    const big = solve([tank('A', 10), tank('B', 5)], [valve('v', 'A', 'B', 1e9)]);
    expect(big.converged).toBe(true);
    expect(Math.abs(flow(big, 'v'))).toBeLessThan(0.01); // K = 1e9 at a 5 m drop passes about 0.0025 L/s: a trickle, not zero
    const small = solve([tank('A', 10), tank('B', 5)], [valve('v', 'A', 'B', 1e-9)]);
    expect(small.converged).toBe(true);
    expect(flow(small, 'v')).toBeGreaterThan(10);
  });

  it('a 1 mm pipe and a 5 m pipe on the same network both solve', () => {
    const r = solve([tank('A', 10), tank('B', 0), junction('J')], [pipe('thin', 'A', 'J', 5, 1), pipe('fat', 'J', 'B', 5, 5000)]);
    expect(r.converged).toBe(true);
    expect(flow(r, 'thin')).toBeGreaterThan(0);
  });

  it('an empty tank (level 0) is a valid fixed-head node', () => {
    const r = solve([tank('A', 5), tank('B', 0)], [pipe('p', 'A', 'B', 100, 100)]);
    expect(r.converged).toBe(true);
    expect(flow(r, 'p')).toBeGreaterThan(0);
  });
});

describe('physical situations', () => {
  it('two tanks at the same level carry no flow', () => {
    const r = solve([tank('A', 5), tank('B', 5)], [pipe('p', 'A', 'B', 100, 100)]);
    expect(r.converged).toBe(true);
    expect(Math.abs(flow(r, 'p'))).toBeLessThan(1e-6);
  });

  it('identical parallel pipes split the flow equally, and flow runs from high to low', () => {
    const r = solve([tank('A', 20), tank('B', 0), junction('J1'), junction('J2')], [pipe('in', 'A', 'J1', 50, 150), pipe('a', 'J1', 'J2', 200, 100), pipe('b', 'J1', 'J2', 200, 100), pipe('out', 'J2', 'B', 50, 150)]);
    expect(r.converged).toBe(true);
    expect(flow(r, 'a')).toBeCloseTo(flow(r, 'b'), 6);
    expect(flow(r, 'in')).toBeGreaterThan(0);
    expect(flow(r, 'a') + flow(r, 'b')).toBeCloseTo(flow(r, 'in'), 6);
  });

  it('a negative demand (inflow) at a junction is accepted', () => {
    const r = solve([tank('A', 10), junction('J', -5)], [pipe('p', 'A', 'J', 100, 100)]);
    expect(r.converged).toBe(true);
    expect(flow(r, 'p')).toBeCloseTo(-5, 4);
  });

  it('a pump whose shutoff head is below the static lift gives no flow, and the network still solves', () => {
    const r = solve([tank('A', 0), tank('B', 0, 60), junction('S'), junction('D')], [pipe('s', 'A', 'S', 5, 100), pump('pu', 'S', 'D', 30), pipe('d', 'D', 'B', 100, 100)]);
    expect(r.converged).toBe(true);
    expect(flow(r, 'pu')).toBeLessThan(1e-6);
    expect(r.warnings.join(' ')).toMatch(/no flow|no forward flow/i);
  });

  it('a pump does not run backwards: reverse flow is blocked by a very stiff resistance, so any leakage is negligible', () => {
    const r = solve([tank('A', 0), tank('B', 80)], [pump('pu', 'A', 'B', 30)]);
    expect(r.converged).toBe(true);
    expect(flow(r, 'pu')).toBeGreaterThan(-0.02); // under 0.02 L/s against 50 m of reverse head
  });

  it('a pump with a closed dead end moves nothing', () => {
    const r = solve([tank('A', 5), junction('J')], [pump('pu', 'A', 'J', 30)]);
    expect(r.converged).toBe(true);
    expect(Math.abs(flow(r, 'pu'))).toBeLessThan(1e-6);
  });
});

describe('closed and isolated sections', () => {
  it('a closed valve cuts a branch off and flow reroutes through the loop', () => {
    const nodes = [tank('A', 20), tank('B', 0), junction('J1'), junction('J2')];
    const edges = (open: boolean) => [pipe('in', 'A', 'J1', 50, 150), pipe('a', 'J1', 'J2', 100, 100), valve('v', 'J1', 'J2', 1, { open }), pipe('out', 'J2', 'B', 50, 150)];
    const both = solve(nodes, edges(true));
    const one = solve(nodes, edges(false));
    expect(one.converged).toBe(true);
    expect(Math.abs(flow(one, 'v'))).toBeLessThan(1e-9);
    expect(flow(one, 'out')).toBeLessThan(flow(both, 'out'));
  });

  it('closing the only path to a demand is reported in words, not as a crash', () => {
    expect(() => solve([tank('A', 10), junction('J', 5)], [valve('v', 'A', 'J', 1, { open: false })])).toThrow(/not connected|isolated|path/i);
  });

  it('an island with no tank is rejected with a readable message', () => {
    expect(() => solve([tank('A', 10), junction('X'), junction('Y')], [pipe('p', 'X', 'Y', 10, 100)])).toThrow(/not connected/i);
  });

  it('a check valve closed by a higher downstream head is reported', () => {
    const r = solve([tank('A', 5), tank('B', 15)], [valve('cv', 'A', 'B', 2, { check: true })]);
    expect(r.converged).toBe(true);
    expect(Math.abs(flow(r, 'cv'))).toBeLessThan(0.02); // blocked by a very stiff resistance: leakage is negligible
    expect(r.warnings.join(' ')).toMatch(/check valve is closed/i);
  });
});

describe('input checks give readable errors', () => {
  it('rejects a zero diameter, negative length and no tank', () => {
    expect(() => solve([tank('A', 10), tank('B', 0)], [pipe('p', 'A', 'B', 100, 0)])).toThrow(/diameter/i);
    expect(() => solve([tank('A', 10), tank('B', 0)], [pipe('p', 'A', 'B', -5, 100)])).toThrow(/length/i);
    expect(() => solve([junction('A'), junction('B')], [pipe('p', 'A', 'B', 100, 100)])).toThrow(/tank/i);
  });
});

import { solveWithSpeedControl } from '../../src/solver';

describe('pump on / off', () => {
  const nodes = [tank('A', 0), tank('B', 20), junction('S'), junction('D')];
  const edges = (run1: boolean, run2: boolean): SysEdge[] => [
    pipe('suction', 'A', 'S', 5, 150),
    { ...(pump('p1', 'S', 'D', 40, 20) as SysPump), running: run1 },
    { ...(pump('p2', 'S', 'D', 40, 20) as SysPump), running: run2 },
    pipe('delivery', 'D', 'B', 300, 150),
  ];

  it('a switched-off pump carries nothing and the other pump takes over', () => {
    const both = solve(nodes, edges(true, true));
    const one = solve(nodes, edges(true, false));
    expect(one.converged).toBe(true);
    expect(flow(one, 'p2')).toBe(0);
    expect(one.pumps.find((p) => p.id === 'p2')!.warnings.join(' ')).toMatch(/switched off/);
    expect(flow(one, 'p1')).toBeGreaterThan(flow(both, 'p1')); // alone it runs further out on its curve
    expect(flow(both, 'p1')).toBeCloseTo(flow(both, 'p2'), 6);
  });

  it('switching every pump off leaves a standing network with no flow', () => {
    const none = solve(nodes, edges(false, false));
    expect(Math.abs(flow(none, 'delivery'))).toBeLessThan(1e-6);
  });
});

describe('variable-speed control', () => {
  const nodes = [tank('A', 0), tank('B', 15), junction('S'), junction('D', 0, 0)];
  const edges: SysEdge[] = [pipe('suction', 'A', 'S', 5, 150), pump('p1', 'S', 'D', 60, 30), pipe('delivery', 'D', 'B', 400, 150)];
  const model = { fluid: water, nodes, edges } as SystemModel;
  const pumpFlow = (r: ReturnType<typeof solveWithSpeedControl>) => r.result.pumps[0].flowM3s * 1000;

  it('finds the speed that holds a flow, and the result really has that flow', () => {
    const r = solveWithSpeedControl(model, [{ pumpId: 'p1', target: { kind: 'flow', m3s: 0.015 }, minRatio: 0.3, maxRatio: 1.2 }]);
    expect(pumpFlow(r)).toBeCloseTo(15, 3);
    const speed = r.speeds.get('p1')!;
    expect(speed).toBeGreaterThan(0.3);
    expect(speed).toBeLessThan(1.2);
    expect(r.notes).toEqual([]);
    expect(r.result.pumps[0].speedRatio).toBeCloseTo(speed, 9);
    // a lower flow needs a lower speed (affinity laws: the pump slows down)
    const lower = solveWithSpeedControl(model, [{ pumpId: 'p1', target: { kind: 'flow', m3s: 0.01 }, minRatio: 0.3, maxRatio: 1.2 }]);
    expect(lower.speeds.get('p1')!).toBeLessThan(speed);
  });

  it('finds the speed that holds a pressure at a node', () => {
    const r = solveWithSpeedControl(model, [{ pumpId: 'p1', target: { kind: 'pressure', nodeId: 'D', pa: 250_000 }, minRatio: 0.3, maxRatio: 1.2 }]);
    const d = r.result.nodes.find((n) => n.id === 'D')!;
    expect(d.gaugePressurePa).toBeCloseTo(250_000, -1);
    expect(r.notes).toEqual([]);
  });

  it('runs at the maximum speed and says so when the target cannot be reached', () => {
    const r = solveWithSpeedControl(model, [{ pumpId: 'p1', target: { kind: 'flow', m3s: 0.2 }, minRatio: 0.3, maxRatio: 1 }]);
    expect(r.speeds.get('p1')).toBe(1);
    expect(r.notes[0]).toMatch(/maximum speed.*cannot reach 200\.0 L\/s/);
  });

  it('runs at the minimum speed and says so when the pump cannot go slow enough', () => {
    const r = solveWithSpeedControl(model, [{ pumpId: 'p1', target: { kind: 'flow', m3s: 0.0001 }, minRatio: 0.9, maxRatio: 1.2 }]);
    expect(r.speeds.get('p1')).toBe(0.9);
    expect(r.notes[0]).toMatch(/minimum speed/);
  });

  it('rejects bad limits and unknown pumps with readable messages', () => {
    expect(() => solveWithSpeedControl(model, [{ pumpId: 'p1', target: { kind: 'flow', m3s: 0.01 }, minRatio: 1, maxRatio: 0.5 }])).toThrow(/speed limits/);
    expect(() => solveWithSpeedControl(model, [{ pumpId: 'nope', target: { kind: 'flow', m3s: 0.01 }, minRatio: 0.3, maxRatio: 1 }])).toThrow(/not in the model/);
    expect(() => solveWithSpeedControl(model, [{ pumpId: 'p1', target: { kind: 'pressure', nodeId: 'ghost', pa: 1 }, minRatio: 0.3, maxRatio: 1 }])).toThrow(/control node/);
  });

  it('two pumps in parallel under control each reach their own flow', () => {
    const two = { fluid: water, nodes, edges: [pipe('suction', 'A', 'S', 5, 200), pump('p1', 'S', 'D', 60, 30), pump('p2', 'S', 'D', 60, 30), pipe('delivery', 'D', 'B', 400, 200)] } as SystemModel;
    const r = solveWithSpeedControl(two, [
      { pumpId: 'p1', target: { kind: 'flow', m3s: 0.012 }, minRatio: 0.3, maxRatio: 1.2 },
      { pumpId: 'p2', target: { kind: 'flow', m3s: 0.018 }, minRatio: 0.3, maxRatio: 1.2 },
    ]);
    expect(r.result.pumps.find((p) => p.id === 'p1')!.flowM3s * 1000).toBeCloseTo(12, 2);
    expect(r.result.pumps.find((p) => p.id === 'p2')!.flowM3s * 1000).toBeCloseTo(18, 2);
  });
});
