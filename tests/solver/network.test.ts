import { describe, expect, it } from 'vitest';
import {
  createPipeElement,
  createPumpElement,
  findOperatingPoint,
  fitPump,
  G,
  NetworkError,
  P_ATM,
  pipeArea,
  pumpHead,
  solveNetwork,
  toNetwork,
  water,
  type Fluid,
  type Network,
  type PipeSpec,
  type SeriesSystem,
} from '../../src/solver';

const oil: Fluid = { name: 'oil', temperatureC: 20, density: 900, dynamicViscosity: 0.2, vaporPressure: 1000 };
const mk = (lengthM: number, diameterM: number, k: number[] = []): PipeSpec => ({
  lengthM,
  innerDiameterM: diameterM,
  roughnessM: 0,
  elevationChangeM: 0,
  fittingsK: k,
});

describe('network solver: branched laminar network (closed-form check)', () => {
  // A(50 m) -> J, J -> B(20 m), J -> C(10 m). Laminar pipes are linear: Q = g * dh, so
  // continuity at J gives  h_J = sum(g_i h_i) / sum(g_i).
  const specs = { a: mk(40, 0.05), b: mk(60, 0.04), c: mk(80, 0.05) };
  const g = (s: PipeSpec) => (oil.density * G * s.innerDiameterM ** 2 * pipeArea(s.innerDiameterM)) / (32 * oil.dynamicViscosity * s.lengthM);
  const net: Network = {
    nodes: [
      { id: 'A', fixedHeadM: 50 },
      { id: 'J' },
      { id: 'B', fixedHeadM: 20 },
      { id: 'C', fixedHeadM: 10 },
    ],
    edges: [
      { id: 'a', from: 'A', to: 'J', element: createPipeElement(specs.a, oil) },
      { id: 'b', from: 'J', to: 'B', element: createPipeElement(specs.b, oil) },
      { id: 'c', from: 'J', to: 'C', element: createPipeElement(specs.c, oil) },
    ],
  };

  it('reproduces the analytic junction head and flows', () => {
    const ga = g(specs.a);
    const gb = g(specs.b);
    const gc = g(specs.c);
    const hJ = (ga * 50 + gb * 20 + gc * 10) / (ga + gb + gc);
    const sol = solveNetwork(net);
    expect(sol.converged).toBe(true);
    expect(sol.heads.J).toBeCloseTo(hJ, 9);
    expect(sol.flows.a).toBeCloseTo(ga * (50 - hJ), 12);
    expect(sol.flows.b).toBeCloseTo(gb * (hJ - 20), 12);
    expect(sol.flows.c).toBeCloseTo(gc * (hJ - 10), 12);
    expect(sol.flows.a).toBeCloseTo(sol.flows.b + sol.flows.c, 12);
  });
});

describe('network solver: turbulent water, branched', () => {
  const w = water(20);
  const rough = (L: number, D: number, K: number[] = []): PipeSpec => ({ lengthM: L, innerDiameterM: D, roughnessM: 0.1e-3, elevationChangeM: 0, fittingsK: K });
  const net: Network = {
    nodes: [
      { id: 'R', fixedHeadM: 60 },
      { id: 'J1' },
      { id: 'J2' },
      { id: 'T1', fixedHeadM: 25 },
      { id: 'T2', fixedHeadM: 15 },
    ],
    edges: [
      { id: 'p0', from: 'R', to: 'J1', element: createPipeElement(rough(500, 0.2, [2]), w) },
      { id: 'p1', from: 'J1', to: 'T1', element: createPipeElement(rough(800, 0.1), w) },
      { id: 'p2', from: 'J1', to: 'J2', element: createPipeElement(rough(300, 0.12, [1]), w) },
      { id: 'p3', from: 'J2', to: 'T2', element: createPipeElement(rough(400, 0.1), w) },
      { id: 'p4', from: 'R', to: 'J2', element: createPipeElement(rough(900, 0.15), w) }, // a loop
    ],
  };

  it('converges with mass balance at every junction and head drop = element curve on every edge', () => {
    const sol = solveNetwork(net, { flowTolM3s: 1e-12 });
    expect(sol.converged).toBe(true);
    expect(sol.residualM3s).toBeLessThan(1e-12);
    for (const j of ['J1', 'J2']) {
      let net = 0;
      for (const e of netEdges(j)) net += e.sign * sol.flows[e.id];
      expect(Math.abs(net)).toBeLessThan(1e-11);
    }
    for (const e of net.edges) {
      const dh = sol.heads[e.from] - sol.heads[e.to];
      expect(e.element.headDrop(sol.flows[e.id])).toBeCloseTo(dh, 9);
    }
  });

  function netEdges(node: string): { id: string; sign: number }[] {
    return net.edges.flatMap((e) => (e.to === node ? [{ id: e.id, sign: 1 }] : e.from === node ? [{ id: e.id, sign: -1 }] : []));
  }

  it('handles an external demand', () => {
    const withDemand: Network = { ...net, nodes: net.nodes.map((n) => (n.id === 'J1' ? { ...n, demandM3s: 0.004 } : n)) };
    const sol = solveNetwork(withDemand);
    expect(sol.converged).toBe(true);
    // at J1: p0 in = p1 out + p2 out + demand
    expect(sol.flows.p0).toBeCloseTo(sol.flows.p1 + sol.flows.p2 + 0.004, 9);
  });
});

describe('network solver: pump feeding a branch', () => {
  const w = water(20);
  const model = fitPump({
    head: [
      { flowM3s: 0, headM: 60 },
      { flowM3s: 0.01, headM: 55 },
      { flowM3s: 0.02, headM: 44 },
      { flowM3s: 0.03, headM: 28 },
    ],
  });
  const p = (L: number, D: number): PipeSpec => ({ lengthM: L, innerDiameterM: D, roughnessM: 0.05e-3, elevationChangeM: 0, fittingsK: [1] });
  const net: Network = {
    nodes: [{ id: 'S', fixedHeadM: 2 }, { id: 'N1' }, { id: 'J' }, { id: 'B', fixedHeadM: 30 }, { id: 'C', fixedHeadM: 20 }],
    edges: [
      { id: 'pump', from: 'S', to: 'N1', element: createPumpElement(model, 1) },
      { id: 'main', from: 'N1', to: 'J', element: createPipeElement(p(100, 0.15), w) },
      { id: 'b', from: 'J', to: 'B', element: createPipeElement(p(200, 0.1), w) },
      { id: 'c', from: 'J', to: 'C', element: createPipeElement(p(150, 0.1), w) },
    ],
  };
  it('satisfies the pump curve and continuity', () => {
    const sol = solveNetwork(net, { flowTolM3s: 1e-12 });
    expect(sol.converged).toBe(true);
    const q = sol.flows.pump;
    expect(sol.heads.N1 - sol.heads.S).toBeCloseTo(pumpHead(model, q), 8);
    expect(q).toBeCloseTo(sol.flows.b + sol.flows.c, 10);
    expect(sol.flows.b).toBeGreaterThan(0);
    expect(sol.flows.c).toBeGreaterThan(0);
  });
  it('blocks reverse flow through the pump (check valve) when the downstream head is too high', () => {
    const high: Network = { ...net, nodes: net.nodes.map((n) => (n.id === 'B' || n.id === 'C' ? { ...n, fixedHeadM: 90 } : n)) };
    const sol = solveNetwork(high);
    expect(sol.converged).toBe(true);
    expect(Math.abs(sol.flows.pump)).toBeLessThan(1e-5);
  });
});

describe('network solver vs single-line operating point', () => {
  const w = water(35);
  const model = fitPump({
    head: [
      { flowM3s: 0, headM: 45 },
      { flowM3s: 0.01, headM: 42 },
      { flowM3s: 0.02, headM: 34 },
      { flowM3s: 0.03, headM: 21 },
    ],
  });
  const sys: SeriesSystem = {
    fluid: w,
    source: { elevationM: 0, liquidLevelM: 2.5, surfacePressurePa: P_ATM },
    destination: { elevationM: 18, liquidLevelM: 1, surfacePressurePa: P_ATM + 20000 },
    elements: [
      { kind: 'pipe', id: 's', spec: { lengthM: 15, innerDiameterM: 0.125, roughnessM: 0.15e-3, elevationChangeM: 0, fittingsK: [0.5, 0.9] } },
      { kind: 'pump', id: 'p', model, speedRatio: 0.95 },
      { kind: 'pipe', id: 'd', spec: { lengthM: 350, innerDiameterM: 0.1, roughnessM: 0.15e-3, elevationChangeM: 18, fittingsK: [2, 1.5, 0.3] } },
    ],
  };

  it('agrees to within 1e-8 relative on flow, and matches the node heads', () => {
    const op = findOperatingPoint(sys);
    expect(op.status).toBe('ok');
    const sol = solveNetwork(toNetwork(sys), { flowTolM3s: 1e-13 });
    expect(sol.converged).toBe(true);
    expect(Math.abs(sol.flows.p - op.flowM3s) / op.flowM3s).toBeLessThan(1e-8);
    expect(Math.abs(sol.flows.s - sol.flows.d)).toBeLessThan(1e-11);
    // pump head from node heads equals the total head at the operating point
    expect(sol.heads.n2 - sol.heads.n1).toBeCloseTo(op.headM, 6);
  });
});

describe('network solver: input validation', () => {
  it('rejects a free node not connected to a fixed-head node', () => {
    const w = water(20);
    const net: Network = {
      nodes: [{ id: 'A', fixedHeadM: 10 }, { id: 'B', fixedHeadM: 5 }, { id: 'X' }, { id: 'Y' }],
      edges: [
        { id: 'ab', from: 'A', to: 'B', element: createPipeElement(mk(10, 0.1), w) },
        { id: 'xy', from: 'X', to: 'Y', element: createPipeElement(mk(10, 0.1), w) },
      ],
    };
    expect(() => solveNetwork(net)).toThrow(NetworkError);
  });
  it('requires a fixed-head node', () => {
    expect(() => solveNetwork({ nodes: [{ id: 'X' }], edges: [] })).toThrow(NetworkError);
  });
});
