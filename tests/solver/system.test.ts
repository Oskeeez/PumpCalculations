import { describe, expect, it } from 'vitest';
import {
  analyzeSeries,
  findOperatingPoint,
  fitPump,
  G,
  NetworkError,
  P_ATM,
  pipeFlowState,
  pumpHead,
  solveSystem,
  water,
  type SeriesSystem,
  type SystemModel,
  type PipeSpec,
} from '../../src/solver';

const w = water(20);
const model = fitPump({
  head: [
    { flowM3s: 0, headM: 50 },
    { flowM3s: 0.01, headM: 46 },
    { flowM3s: 0.02, headM: 38 },
    { flowM3s: 0.03, headM: 26 },
  ],
  efficiency: [
    { flowM3s: 0.005, eta: 0.4 },
    { flowM3s: 0.015, eta: 0.7 },
    { flowM3s: 0.025, eta: 0.65 },
  ],
  npshr: [
    { flowM3s: 0, npshrM: 1.5 },
    { flowM3s: 0.02, npshrM: 2.5 },
    { flowM3s: 0.03, npshrM: 4 },
  ],
});
const pipe = (L: number, D: number, K: number[] = []): PipeSpec => ({ lengthM: L, innerDiameterM: D, roughnessM: 0.05e-3, elevationChangeM: 0, fittingsK: K });
const atm = P_ATM;

/** Looped, branched network: tank -> pump -> J1 -> {J2, J3} -> cross link -> two tanks, with demands. */
const loopNet: SystemModel = {
  fluid: w,
  nodes: [
    { kind: 'tank', id: 'Supply', elevationM: 0, liquidLevelM: 4, surfacePressurePa: atm },
    { kind: 'junction', id: 'S1', elevationM: 0, demandM3s: 0 },
    { kind: 'junction', id: 'J1', elevationM: 2, demandM3s: 0 },
    { kind: 'junction', id: 'J2', elevationM: 5, demandM3s: 0.004 },
    { kind: 'junction', id: 'J3', elevationM: 4, demandM3s: 0.006 },
    { kind: 'tank', id: 'B', elevationM: 20, liquidLevelM: 3, surfacePressurePa: atm },
    { kind: 'tank', id: 'C', elevationM: 12, liquidLevelM: 2, surfacePressurePa: atm },
  ],
  edges: [
    { kind: 'pipe', id: 'suction', from: 'Supply', to: 'S1', spec: pipe(8, 0.15, [0.5]) },
    { kind: 'pump', id: 'P1', from: 'S1', to: 'J1', model, speedRatio: 1 },
    { kind: 'pipe', id: 'a', from: 'J1', to: 'J2', spec: pipe(150, 0.1, [1]) },
    { kind: 'pipe', id: 'b', from: 'J1', to: 'J3', spec: pipe(200, 0.1) },
    { kind: 'pipe', id: 'cross', from: 'J2', to: 'J3', spec: pipe(120, 0.08) },
    { kind: 'pipe', id: 'toB', from: 'J2', to: 'B', spec: pipe(180, 0.1, [2]) },
    { kind: 'pipe', id: 'toC', from: 'J3', to: 'C', spec: pipe(90, 0.1) },
  ],
};

describe('solveSystem: looped network', () => {
  const res = solveSystem(loopNet, { flowTolM3s: 1e-12 });
  const q = (id: string) => res.pipes.find((p) => p.id === id)?.flowM3s ?? res.pumps.find((p) => p.id === id)!.flowM3s;

  it('converges', () => {
    expect(res.converged).toBe(true);
    expect(res.residualM3s).toBeLessThan(1e-12);
  });

  it('satisfies continuity at every junction', () => {
    const bal = (_id: string, demand: number, ins: string[], outs: string[]) =>
      ins.reduce((s, e) => s + q(e), 0) - outs.reduce((s, e) => s + q(e), 0) - demand;
    expect(Math.abs(bal('S1', 0, ['suction'], ['P1']))).toBeLessThan(1e-10);
    expect(Math.abs(bal('J1', 0, ['P1'], ['a', 'b']))).toBeLessThan(1e-10);
    expect(Math.abs(bal('J2', 0.004, ['a'], ['cross', 'toB']))).toBeLessThan(1e-10);
    expect(Math.abs(bal('J3', 0.006, ['b', 'cross'], ['toC']))).toBeLessThan(1e-10);
  });

  it('satisfies the energy equation on every pipe and the pump curve', () => {
    for (const p of res.pipes) {
      const spec = loopNet.edges.find((e) => e.id === p.id && e.kind === 'pipe');
      const loss = Math.sign(p.flowM3s) * pipeFlowState((spec as { spec: PipeSpec }).spec, w, p.flowM3s).totalHeadLoss;
      expect(p.headDropM).toBeCloseTo(loss, 8);
    }
    const pump = res.pumps[0];
    expect(pump.headM).toBeCloseTo(pumpHead(model, pump.flowM3s), 12);
    const h = (id: string) => res.nodes.find((n) => n.id === id)!.headM;
    expect(h('J1') - h('S1')).toBeCloseTo(pump.headM, 8);
  });

  it('reports a tank supply equal to total demand plus tank inflow', () => {
    const net = res.nodes.map((n) => n.netOutflowM3s).reduce((s, x) => s + x, 0);
    // tanks supply (positive) or absorb (negative); junction demands are withdrawals: all sum to zero
    expect(net).toBeCloseTo(0, 9);
  });

  it('computes gauge pressure from head and elevation', () => {
    const j2 = res.nodes.find((n) => n.id === 'J2')!;
    expect(j2.gaugePressurePa).toBeCloseTo((j2.headM - 5) * w.density * G, 6);
    expect(j2.absolutePressurePa).toBeCloseTo(j2.gaugePressurePa + P_ATM, 6);
  });
});

describe('solveSystem vs the single-line solver', () => {
  const chain: SeriesSystem = {
    fluid: w,
    source: { elevationM: 0, liquidLevelM: 3, surfacePressurePa: atm },
    destination: { elevationM: 15, liquidLevelM: 2, surfacePressurePa: atm },
    elements: [
      { kind: 'pipe', id: 'suction', spec: pipe(10, 0.15, [0.5, 0.2]) },
      { kind: 'pump', id: 'P1', model, speedRatio: 1 },
      { kind: 'pipe', id: 'discharge', spec: { ...pipe(200, 0.1, [1, 2, 0.3]), elevationChangeM: 15 } },
    ],
  };
  const asNetwork: SystemModel = {
    fluid: w,
    nodes: [
      { kind: 'tank', id: 'src', elevationM: 0, liquidLevelM: 3, surfacePressurePa: atm },
      { kind: 'junction', id: 'suc', elevationM: 0, demandM3s: 0 },
      { kind: 'junction', id: 'dis', elevationM: 0, demandM3s: 0 },
      { kind: 'tank', id: 'dst', elevationM: 15, liquidLevelM: 2, surfacePressurePa: atm },
    ],
    edges: [
      { kind: 'pipe', id: 'suction', from: 'src', to: 'suc', spec: pipe(10, 0.15, [0.5, 0.2]) },
      { kind: 'pump', id: 'P1', from: 'suc', to: 'dis', model, speedRatio: 1 },
      { kind: 'pipe', id: 'discharge', from: 'dis', to: 'dst', spec: pipe(200, 0.1, [1, 2, 0.3]) },
    ],
  };
  it('gives the same flow, pump head and NPSHa', () => {
    const op = findOperatingPoint(chain);
    const ser = analyzeSeries(chain, op.flowM3s).pumps[0];
    const net = solveSystem(asNetwork, { flowTolM3s: 1e-13 });
    expect(net.converged).toBe(true);
    expect(Math.abs(net.pumps[0].flowM3s - op.flowM3s) / op.flowM3s).toBeLessThan(1e-8);
    expect(net.pumps[0].headM).toBeCloseTo(ser.headM, 6);
    expect(net.pumps[0].npshaM).toBeCloseTo(ser.npshaM, 6);
    expect(net.pumps[0].shaftPowerW).toBeCloseTo(ser.shaftPowerW as number, 3);
  });
});

describe('solveSystem: edge cases and validation', () => {
  it('closes the check valve and warns when the downstream head exceeds shutoff', () => {
    const high: SystemModel = {
      ...loopNet,
      nodes: loopNet.nodes.map((n) => (n.id === 'B' ? { ...n, elevationM: 120 } : n.id === 'C' ? { ...n, elevationM: 120 } : n)),
    };
    const res = solveSystem(high);
    expect(res.converged, `${res.message} residual=${res.residualM3s}`).toBe(true);
    expect(Math.abs(res.pumps[0].flowM3s)).toBeLessThan(3e-5);
    expect(res.warnings.join(' ')).toMatch(/check valve|no (forward )?flow/i);
  });

  it('rejects networks without a tank, with self-loops, or duplicate names', () => {
    expect(() => solveSystem({ ...loopNet, nodes: loopNet.nodes.filter((n) => n.kind !== 'tank'), edges: [] })).toThrow(NetworkError);
    expect(() => solveSystem({ ...loopNet, edges: [{ kind: 'pipe', id: 'x', from: 'J1', to: 'J1', spec: pipe(1, 0.1) }] })).toThrow(/itself/);
    expect(() => solveSystem({ ...loopNet, nodes: [...loopNet.nodes, { kind: 'junction', id: 'J1', elevationM: 0, demandM3s: 0 }] })).toThrow(/Duplicate/);
  });

  it('reports an island of nodes with no path to a tank', () => {
    const island: SystemModel = {
      ...loopNet,
      nodes: [...loopNet.nodes, { kind: 'junction', id: 'X', elevationM: 0, demandM3s: 0 }, { kind: 'junction', id: 'Y', elevationM: 0, demandM3s: 0 }],
      edges: [...loopNet.edges, { kind: 'pipe', id: 'xy', from: 'X', to: 'Y', spec: pipe(10, 0.1) }],
    };
    expect(() => solveSystem(island)).toThrow(/not connected/);
  });

  it('flags a sub-atmospheric junction', () => {
    const lift: SystemModel = {
      fluid: w,
      nodes: [
        { kind: 'tank', id: 'T', elevationM: 0, liquidLevelM: 1, surfacePressurePa: atm },
        { kind: 'junction', id: 'High', elevationM: 8, demandM3s: 0.002 },
      ],
      edges: [{ kind: 'pipe', id: 'p', from: 'T', to: 'High', spec: pipe(20, 0.05) }],
    };
    const res = solveSystem(lift);
    expect(res.nodes.find((n) => n.id === 'High')!.gaugePressurePa).toBeLessThan(0);
    expect(res.warnings.join(' ')).toMatch(/sub-atmospheric|vapour/);
  });
});
