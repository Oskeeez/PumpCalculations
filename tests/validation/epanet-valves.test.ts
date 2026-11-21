import { LinkProperty, NodeProperty, Project, Workspace } from 'epanet-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { G, P_ATM, fitPump, fluidAt, solveSystem, type SysEdge, type SysNode, type SystemModel, type SystemResult } from '../../src/solver';

/**
 * Cross-check of regulating valves, a throttle valve, a check valve and parallel pumps against the EPANET engine
 * (OWA-EPANET 2.2 via epanet-js). Each network is written once as data and turned into both an EPANET input file and our own
 * system model. Both use Darcy-Weisbach friction (EPANET: Swamee-Jain, ours: Colebrook-White), so small differences are expected.
 * Metric units: L/s, m, mm; EPANET pressure units are metres of head, so a pressure setting converts to Pa with rho g.
 */

type Spec = {
  reservoirs: { id: string; head: number }[];
  junctions: { id: string; demand: number }[]; // elevation 0
  pipes: { id: string; from: string; to: string; lengthM: number; dMm: number }[];
  /** Check valves (EPANET: a 1 m pipe with status CV; ours: a valve that blocks reverse flow). */
  checks: { id: string; from: string; to: string; dMm: number }[];
  valves: { id: string; from: string; to: string; dMm: number; type: 'PRV' | 'PSV' | 'FCV' | 'TCV'; setting: number }[];
  pumps: { id: string; from: string; to: string; designLps: number; designM: number }[];
};

const ROUGH_MM = 0.1;
const water = fluidAt('water', 20);
const NU = water.dynamicViscosity / water.density; // m2/s

function inp(s: Spec): string {
  return `[TITLE]
valve validation

[JUNCTIONS]
${s.junctions.map((j) => ` ${j.id} 0 ${j.demand}`).join('\n')}

[RESERVOIRS]
${s.reservoirs.map((r) => ` ${r.id} ${r.head}`).join('\n')}

[PIPES]
${[...s.pipes.map((p) => ` ${p.id} ${p.from} ${p.to} ${p.lengthM} ${p.dMm} ${ROUGH_MM} 0 Open`), ...s.checks.map((c) => ` ${c.id} ${c.from} ${c.to} 1 ${c.dMm} ${ROUGH_MM} 0 CV`)].join('\n')}

[PUMPS]
${s.pumps.map((p, i) => ` ${p.id} ${p.from} ${p.to} HEAD ${i + 1}`).join('\n')}

[VALVES]
${s.valves.map((v) => ` ${v.id} ${v.from} ${v.to} ${v.dMm} ${v.type} ${v.setting} 0`).join('\n')}

[CURVES]
${s.pumps.map((p, i) => ` ${i + 1} ${p.designLps} ${p.designM}`).join('\n')}

[TIMES]
 Duration 0

[OPTIONS]
 Units LPS
 Headloss D-W
 Viscosity ${(NU / 1.0e-6).toFixed(5)}
 Accuracy 0.00001
 Trials 500

[END]
`;
}

function ours(s: Spec): SystemResult {
  const nodes: SysNode[] = [
    ...s.reservoirs.map((r): SysNode => ({ kind: 'tank', id: r.id, elevationM: 0, liquidLevelM: r.head, surfacePressurePa: P_ATM })),
    ...s.junctions.map((j): SysNode => ({ kind: 'junction', id: j.id, elevationM: 0, demandM3s: j.demand / 1000 })),
  ];
  const edges: SysEdge[] = [
    ...s.pipes.map((p): SysEdge => ({ kind: 'pipe', id: p.id, from: p.from, to: p.to, spec: { lengthM: p.lengthM, innerDiameterM: p.dMm / 1000, roughnessM: ROUGH_MM / 1000, elevationChangeM: 0, fittingsK: [] } })),
    ...s.valves.map((v): SysEdge => {
      const base = { diameterM: v.dMm / 1000, checkValve: false, open: true };
      if (v.type === 'TCV') return { kind: 'valve', id: v.id, from: v.from, to: v.to, spec: { ...base, loss: { type: 'K', k: v.setting } } };
      const control = v.type === 'FCV' ? ({ type: 'fcv', flowM3s: v.setting / 1000 } as const) : ({ type: v.type === 'PRV' ? 'prv' : 'psv', setpointPa: v.setting * water.density * G } as const);
      return { kind: 'valve', id: v.id, from: v.from, to: v.to, spec: { ...base, loss: { type: 'K', k: 0 }, control } };
    }),
    ...s.checks.map((c): SysEdge => ({ kind: 'valve', id: c.id, from: c.from, to: c.to, spec: { diameterM: c.dMm / 1000, loss: { type: 'K', k: 0 }, checkValve: true, open: true } })),
    ...s.pumps.map((p): SysEdge => ({
      kind: 'pump',
      id: p.id,
      from: p.from,
      to: p.to,
      speedRatio: 1,
      // EPANET's one-point curve: shutoff 1.33334 H, zero head at 2 Q (exactly quadratic)
      model: fitPump({ head: [{ flowM3s: 0, headM: 1.33334 * p.designM }, { flowM3s: p.designLps / 1000, headM: p.designM }, { flowM3s: (2 * p.designLps) / 1000, headM: 0 }] }),
    })),
  ];
  const model: SystemModel = { fluid: water, nodes, edges };
  return solveSystem(model);
}

interface Ref {
  head: Record<string, number>;
  flow: Record<string, number>;
}

async function epanet(s: Spec): Promise<Ref> {
  const ws = new Workspace();
  await ws.loadModule();
  const m = new Project(ws);
  ws.writeFile('n.inp', inp(s));
  m.open('n.inp', 'r.rpt', 'o.bin');
  m.solveH();
  const head: Record<string, number> = {};
  for (const id of [...s.reservoirs.map((r) => r.id), ...s.junctions.map((j) => j.id)]) head[id] = m.getNodeValue(m.getNodeIndex(id), NodeProperty.Head);
  const flow: Record<string, number> = {};
  for (const id of [...s.pipes.map((p) => p.id), ...s.checks.map((c) => c.id), ...s.valves.map((v) => v.id), ...s.pumps.map((p) => p.id)]) flow[id] = m.getLinkValue(m.getLinkIndex(id), LinkProperty.Flow);
  m.close();
  return { head, flow };
}

const flowOf = (r: SystemResult, id: string): number => {
  const x = r.pipes.find((p) => p.id === id) ?? r.valves.find((v) => v.id === id) ?? r.pumps.find((p) => p.id === id);
  return x ? x.flowM3s * 1000 : Number.NaN;
};
const headOf = (r: SystemResult, id: string): number => r.nodes.find((n) => n.id === id)?.headM ?? Number.NaN;

function compare(name: string, s: Spec, tolFlowFrac = 0.01, tolHeadM = 0.35) {
  it(name, async () => {
    const ref = await epanet(s);
    const mine = ours(s);
    expect(mine.converged).toBe(true);
    for (const [id, h] of Object.entries(ref.head)) expect(Math.abs(headOf(mine, id) - h), `head at ${id}: ours ${headOf(mine, id).toFixed(3)} vs EPANET ${h.toFixed(3)}`).toBeLessThan(tolHeadM);
    for (const [id, q] of Object.entries(ref.flow)) {
      const mineQ = flowOf(mine, id);
      expect(Math.abs(mineQ - q), `flow in ${id}: ours ${mineQ.toFixed(3)} vs EPANET ${q.toFixed(3)} L/s`).toBeLessThan(Math.max(0.05, Math.abs(q) * tolFlowFrac));
    }
  });
}

describe('EPANET cross-check: valves and pumps', () => {
  beforeAll(() => { void water; }, 60000);

  // R1 (head 70) -> J1 -> PRV (hold 25 m at J2) -> J2 -> J3, with demands: the PRV is active
  compare('pressure-reducing valve holds the downstream pressure', {
    reservoirs: [{ id: 'R1', head: 70 }],
    junctions: [{ id: 'J1', demand: 0 }, { id: 'J2', demand: 14 }, { id: 'J3', demand: 6 }],
    pipes: [{ id: 'P1', from: 'R1', to: 'J1', lengthM: 800, dMm: 250 }, { id: 'P2', from: 'J2', to: 'J3', lengthM: 400, dMm: 150 }],
    checks: [],
    valves: [{ id: 'V1', from: 'J1', to: 'J2', dMm: 200, type: 'PRV', setting: 25 }],
    pumps: [],
  });

  // R1 (60) -> J1 (demand 40) -> PSV (keep 40 m upstream) -> J2 -> tank R2 (head 10): the PSV throttles the flow to the tank
  compare('pressure-sustaining valve holds the upstream pressure', {
    reservoirs: [{ id: 'R1', head: 60 }, { id: 'R2', head: 10 }],
    junctions: [{ id: 'J1', demand: 40 }, { id: 'J2', demand: 0 }],
    pipes: [{ id: 'P1', from: 'R1', to: 'J1', lengthM: 600, dMm: 200 }, { id: 'P2', from: 'J2', to: 'R2', lengthM: 300, dMm: 200 }],
    checks: [],
    valves: [{ id: 'V1', from: 'J1', to: 'J2', dMm: 200, type: 'PSV', setting: 40 }],
    pumps: [],
  });

  // R1 (60) -> J1 -> FCV (12 L/s) -> J2 -> R2 (10): the FCV limits the flow
  compare('flow-control valve limits the flow', {
    reservoirs: [{ id: 'R1', head: 60 }, { id: 'R2', head: 10 }],
    junctions: [{ id: 'J1', demand: 0 }, { id: 'J2', demand: 0 }],
    pipes: [{ id: 'P1', from: 'R1', to: 'J1', lengthM: 500, dMm: 150 }, { id: 'P2', from: 'J2', to: 'R2', lengthM: 500, dMm: 150 }],
    checks: [],
    valves: [{ id: 'V1', from: 'J1', to: 'J2', dMm: 150, type: 'FCV', setting: 12 }],
    pumps: [],
  });

  // a throttle valve with loss coefficient K = 50 in series
  compare('throttle valve (loss coefficient)', {
    reservoirs: [{ id: 'R1', head: 60 }, { id: 'R2', head: 10 }],
    junctions: [{ id: 'J1', demand: 0 }, { id: 'J2', demand: 0 }],
    pipes: [{ id: 'P1', from: 'R1', to: 'J1', lengthM: 500, dMm: 150 }, { id: 'P2', from: 'J2', to: 'R2', lengthM: 500, dMm: 150 }],
    checks: [],
    valves: [{ id: 'V1', from: 'J1', to: 'J2', dMm: 100, type: 'TCV', setting: 50 }],
    pumps: [],
  });

  // one pump (design 30 L/s at 40 m) feeding a demand through a pipe to a tank
  compare('single pump on an exact quadratic curve', {
    reservoirs: [{ id: 'R1', head: 2 }, { id: 'R2', head: 25 }],
    junctions: [{ id: 'J1', demand: 0 }, { id: 'J2', demand: 12 }],
    pipes: [{ id: 'P1', from: 'R1', to: 'J1', lengthM: 20, dMm: 200 }, { id: 'P2', from: 'J2', to: 'R2', lengthM: 900, dMm: 200 }],
    checks: [],
    valves: [],
    pumps: [{ id: 'PU1', from: 'J1', to: 'J2', designLps: 30, designM: 40 }],
  });

  // two different pumps in parallel
  compare('two pumps in parallel', {
    reservoirs: [{ id: 'R1', head: 2 }, { id: 'R2', head: 30 }],
    junctions: [{ id: 'J1', demand: 0 }, { id: 'J2', demand: 0 }],
    pipes: [{ id: 'P1', from: 'R1', to: 'J1', lengthM: 20, dMm: 250 }, { id: 'P2', from: 'J2', to: 'R2', lengthM: 700, dMm: 250 }],
    checks: [],
    valves: [],
    pumps: [{ id: 'PU1', from: 'J1', to: 'J2', designLps: 25, designM: 45 }, { id: 'PU2', from: 'J1', to: 'J2', designLps: 40, designM: 38 }],
  });

  // R3 (head 70) is higher than the system, but a check valve between J1 and R3 blocks the reverse flow: it must carry nothing
  compare('check valve blocks reverse flow', {
    reservoirs: [{ id: 'R1', head: 50 }, { id: 'R2', head: 30 }, { id: 'R3', head: 70 }],
    junctions: [{ id: 'J1', demand: 0 }],
    pipes: [{ id: 'P1', from: 'R1', to: 'J1', lengthM: 400, dMm: 200 }, { id: 'P2', from: 'J1', to: 'R2', lengthM: 400, dMm: 200 }],
    checks: [{ id: 'CV1', from: 'J1', to: 'R3', dMm: 200 }],
    valves: [],
    pumps: [],
  });

  // the same check valve oriented the other way (R3 to J1) passes the flow
  compare('check valve passes forward flow', {
    reservoirs: [{ id: 'R1', head: 50 }, { id: 'R2', head: 30 }, { id: 'R3', head: 70 }],
    junctions: [{ id: 'J1', demand: 0 }],
    pipes: [{ id: 'P1', from: 'R1', to: 'J1', lengthM: 400, dMm: 200 }, { id: 'P2', from: 'J1', to: 'R2', lengthM: 400, dMm: 200 }],
    checks: [{ id: 'CV1', from: 'R3', to: 'J1', dMm: 200 }],
    valves: [],
    pumps: [],
  }, 0.015); // very fast flow (3.3 m/s): the friction formulas (Colebrook vs Swamee-Jain) differ by about 1 %
});
