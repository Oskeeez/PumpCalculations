import { LinkProperty, NodeProperty, Project, Workspace } from 'epanet-js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  fitPump,
  createPumpElement,
  solveNetwork,
  solveSystem,
  type Fluid,
  type HydraulicElement,
  type Network,
  type SystemModel,
} from '../../src/solver';

/**
 * Validation against the EPANET engine (OWA-EPANET 2.2 compiled to WASM, via epanet-js) on EPANET's
 * "Net1" example network. Net1 data is the published Net1.inp (EPANET example-networks), snapshot at
 * t = 0: demand pattern multiplier 1.0, tank at its initial level (treated as a fixed head), pump open.
 *
 *  A) Same physics: Hazen-Williams, using EPANET's own coefficients, solved by OUR network solver
 *     and compared with the EPANET engine. This isolates the solver (topology, loops, pump, continuity).
 *  B) Darcy-Weisbach: EPANET (Swamee-Jain based) vs OUR pipe model (Colebrook-White): quantifies the
 *     difference in friction model on the same network.
 */

const FT = 0.3048;
const IN = 0.0254;
const GPM = 6.30901964e-5; // m3/s per gpm

const JUNCTIONS = [
  ['10', 710, 0], ['11', 710, 150], ['12', 700, 150], ['13', 695, 100], ['21', 700, 150],
  ['22', 695, 200], ['23', 690, 150], ['31', 700, 100], ['32', 710, 100],
] as const;
const RESERVOIR = { id: '9', head: 800 };
const TANK = { id: '2', elevation: 850, level: 120 };
// id, node1, node2, length ft, diameter in
const PIPES = [
  ['10', '10', '11', 10530, 18], ['11', '11', '12', 5280, 14], ['12', '12', '13', 5280, 10],
  ['21', '21', '22', 5280, 10], ['22', '22', '23', 5280, 12], ['31', '31', '32', 5280, 6],
  ['110', '2', '12', 200, 18], ['111', '11', '21', 5280, 10], ['112', '12', '22', 5280, 12],
  ['113', '13', '23', 5280, 8], ['121', '21', '31', 5280, 8], ['122', '22', '32', 5280, 6],
] as const;
const PUMP = { id: '9', from: '9', to: '10', designQ: 1500, designH: 250 };

function inp(headloss: 'H-W' | 'D-W', roughness: number): string {
  return `[TITLE]
Net1 snapshot

[JUNCTIONS]
${JUNCTIONS.map(([id, z, d]) => ` ${id} ${z} ${d}`).join('\n')}

[RESERVOIRS]
 ${RESERVOIR.id} ${RESERVOIR.head}

[TANKS]
 ${TANK.id} ${TANK.elevation} ${TANK.level} 100 150 50.5 0

[PIPES]
${PIPES.map(([id, a, b, L, D]) => ` ${id} ${a} ${b} ${L} ${D} ${roughness} 0 Open`).join('\n')}

[PUMPS]
 ${PUMP.id} ${PUMP.from} ${PUMP.to} HEAD 1

[CURVES]
 1 ${PUMP.designQ} ${PUMP.designH}

[TIMES]
 Duration 0

[OPTIONS]
 Units GPM
 Headloss ${headloss}
 Accuracy 0.00001
 Trials 200

[END]
`;
}

interface EpanetResult {
  headFt: Record<string, number>;
  flowGpm: Record<string, number>;
}

async function runEpanet(headloss: 'H-W' | 'D-W', roughness: number): Promise<EpanetResult> {
  const ws = new Workspace();
  await ws.loadModule();
  const model = new Project(ws);
  ws.writeFile('net.inp', inp(headloss, roughness));
  model.open('net.inp', 'r.rpt', 'o.bin');
  model.solveH();
  const nodeIds = [...JUNCTIONS.map((j) => j[0]), RESERVOIR.id, TANK.id];
  const headFt: Record<string, number> = {};
  for (const id of nodeIds) headFt[id] = model.getNodeValue(model.getNodeIndex(id), NodeProperty.Head);
  const flowGpm: Record<string, number> = {};
  for (const id of [...PIPES.map((p) => p[0]), `pump ${PUMP.id}`]) {
    const lid = id.startsWith('pump') ? PUMP.id : id;
    flowGpm[id] = model.getLinkValue(model.getLinkIndex(lid), LinkProperty.Flow);
  }
  model.close();
  return { headFt, flowGpm };
}

// EPANET pump curve from a single design point: shutoff 1.33334 H, zero head at 2 Q. Exactly quadratic.
const pumpModel = fitPump({
  head: [
    { flowM3s: 0, headM: 1.33334 * PUMP.designH * FT },
    { flowM3s: PUMP.designQ * GPM, headM: PUMP.designH * FT },
    { flowM3s: 2 * PUMP.designQ * GPM, headM: 0 },
  ],
});

const demandM3s = (id: string) => (JUNCTIONS.find((j) => j[0] === id)?.[2] ?? 0) * GPM;

/** EPANET Hazen-Williams: h = 4.727 C^-1.852 d^-4.871 L Q^1.852 (ft, cfs), converted to SI. */
function hazenWilliams(L: number, D: number, C: number): HydraulicElement {
  const toSi = 4.727 * (1 / 0.028316846592) ** 1.852 * FT ** 4.871; // ft,cfs -> m,m3/s coefficient
  const K = (toSi * L) / (C ** 1.852 * D ** 4.871);
  return {
    kind: 'pipe',
    headDrop: (q) => Math.sign(q) * K * Math.abs(q) ** 1.852,
    dHeadDrop: (q) => 1.852 * K * Math.abs(q) ** 0.852,
  };
}

const maxRel = (a: number[], b: number[]) => Math.max(...a.map((x, i) => Math.abs(x - b[i]) / Math.max(Math.abs(b[i]), 1e-12)));

describe('EPANET Net1 validation', () => {
  let hw: EpanetResult;
  let dw: EpanetResult;
  const ROUGH_DW_MM = 0.2; // Darcy-Weisbach roughness; EPANET US units take it in 1e-3 ft
  beforeAll(async () => {
    hw = await runEpanet('H-W', 100);
    dw = await runEpanet('D-W', (ROUGH_DW_MM / 1000 / FT) * 1000);
  });

  it('EPANET engine reproduces the published Net1 character (sanity check of the reference run)', () => {
    // Net1: 9 demand junctions totalling 1,100 gpm, supplied by the pump plus the tank (pipe 110 runs tank -> node 12).
    const totalDemand = JUNCTIONS.reduce((s, j) => s + j[2], 0);
    expect(totalDemand).toBe(1100);
    expect(hw.flowGpm[`pump ${PUMP.id}`] + hw.flowGpm['110']).toBeCloseTo(totalDemand, 0);
  });

  it('A) our network solver matches EPANET (Hazen-Williams, same physics) on all 11 heads and 13 flows', () => {
    const net: Network = {
      nodes: [
        ...JUNCTIONS.map(([id]) => ({ id, demandM3s: demandM3s(id) })),
        { id: RESERVOIR.id, fixedHeadM: RESERVOIR.head * FT },
        { id: TANK.id, fixedHeadM: (TANK.elevation + TANK.level) * FT },
      ],
      edges: [
        ...PIPES.map(([id, a, b, L, D]) => ({ id, from: a, to: b, element: hazenWilliams(L * FT, D * IN, 100) })),
        { id: 'pump', from: PUMP.from, to: PUMP.to, element: createPumpElement(pumpModel, 1) },
      ],
    };
    const ours = solveNetwork(net, { flowTolM3s: 1e-12 });
    expect(ours.converged, ours.message).toBe(true);

    const nodeIds = Object.keys(hw.headFt);
    const headDiffFt = nodeIds.map((id) => Math.abs(ours.heads[id] / FT - hw.headFt[id]));
    const flowIds = PIPES.map((p) => p[0]);
    const oursQ = [...flowIds.map((id) => ours.flows[id] / GPM), ours.flows.pump / GPM];
    const epaQ = [...flowIds.map((id) => hw.flowGpm[id]), hw.flowGpm[`pump ${PUMP.id}`]];
    const flowDiff = oursQ.map((q, i) => Math.abs(q - epaQ[i]));
    console.info(`[Net1 H-W] max |dh| = ${Math.max(...headDiffFt).toExponential(2)} ft, max |dQ| = ${Math.max(...flowDiff).toExponential(2)} gpm, pump Q ours ${oursQ[12].toFixed(2)} vs EPANET ${epaQ[12].toFixed(2)} gpm`);
    expect(Math.max(...headDiffFt)).toBeLessThan(0.05); // ft
    expect(Math.max(...flowDiff)).toBeLessThan(0.5); // gpm (EPANET stops at its own convergence criterion)
  });

  it('A2) the app pipe model with Hazen-Williams C matches EPANET through the full system solver', () => {
    const nu = 1.1e-5 * FT * FT;
    const fluid: Fluid = { name: 'EPANET water', temperatureC: 20, density: 1000, dynamicViscosity: nu * 1000, vaporPressure: 2339 };
    const z = (id: string) => (JUNCTIONS.find((j) => j[0] === id)?.[1] ?? 0) * FT;
    const sys: SystemModel = {
      fluid,
      nodes: [
        ...JUNCTIONS.map(([id]) => ({ kind: 'junction' as const, id, elevationM: z(id), demandM3s: demandM3s(id) })),
        { kind: 'tank', id: RESERVOIR.id, elevationM: RESERVOIR.head * FT, liquidLevelM: 0, surfacePressurePa: 101325 },
        { kind: 'tank', id: TANK.id, elevationM: TANK.elevation * FT, liquidLevelM: TANK.level * FT, surfacePressurePa: 101325 },
      ],
      edges: [
        ...PIPES.map(([id, a, b, L, D]) => ({
          kind: 'pipe' as const, id, from: a, to: b,
          spec: { lengthM: L * FT, innerDiameterM: D * IN, roughnessM: 0, elevationChangeM: 0, fittingsK: [], hazenC: 100 },
        })),
        { kind: 'pump', id: 'pump', from: PUMP.from, to: PUMP.to, model: pumpModel, speedRatio: 1 },
      ],
    };
    const ours = solveSystem(sys, { flowTolM3s: 1e-12 });
    expect(ours.converged, ours.message).toBe(true);
    const headDiffFt = Object.keys(hw.headFt).map((id) => Math.abs(ours.nodes.find((n) => n.id === id)!.headM / FT - hw.headFt[id]));
    expect(Math.max(...headDiffFt)).toBeLessThan(0.05);
    for (const [id] of PIPES) expect(Math.abs(ours.pipes.find((p) => p.id === id)!.flowM3s / GPM - hw.flowGpm[id])).toBeLessThan(0.5);
  });

  it('B) with Darcy-Weisbach, our Colebrook model stays within a small, quantified band of EPANET', () => {
    // EPANET internal viscosity 1.1e-5 ft2/s; density only scales gauge pressure, not heads.
    const nu = 1.1e-5 * FT * FT;
    const fluid: Fluid = { name: 'EPANET water', temperatureC: 20, density: 1000, dynamicViscosity: nu * 1000, vaporPressure: 2339 };
    const z = (id: string) => (JUNCTIONS.find((j) => j[0] === id)?.[1] ?? 0) * FT;
    const sys: SystemModel = {
      fluid,
      nodes: [
        ...JUNCTIONS.map(([id]) => ({ kind: 'junction' as const, id, elevationM: z(id), demandM3s: demandM3s(id) })),
        { kind: 'tank', id: RESERVOIR.id, elevationM: RESERVOIR.head * FT, liquidLevelM: 0, surfacePressurePa: 101325 },
        { kind: 'tank', id: TANK.id, elevationM: TANK.elevation * FT, liquidLevelM: TANK.level * FT, surfacePressurePa: 101325 },
      ],
      edges: [
        ...PIPES.map(([id, a, b, L, D]) => ({
          kind: 'pipe' as const, id, from: a, to: b,
          spec: { lengthM: L * FT, innerDiameterM: D * IN, roughnessM: ROUGH_DW_MM / 1000, elevationChangeM: 0, fittingsK: [] },
        })),
        { kind: 'pump', id: 'pump', from: PUMP.from, to: PUMP.to, model: pumpModel, speedRatio: 1 },
      ],
    };
    const ours = solveSystem(sys, { flowTolM3s: 1e-12 });
    expect(ours.converged, ours.message).toBe(true);
    const flowIds = PIPES.map((p) => p[0]);
    const q = (id: string) => (id === 'pump' ? ours.pumps[0].flowM3s : ours.pipes.find((p) => p.id === id)!.flowM3s) / GPM;
    const oursQ = [...flowIds.map(q), q('pump')];
    const epaQ = [...flowIds.map((id) => dw.flowGpm[id]), dw.flowGpm[`pump ${PUMP.id}`]];
    const bigFlows = epaQ.map((v, i) => [v, oursQ[i]] as const).filter(([e]) => Math.abs(e) > 50);
    const relFlow = Math.max(...bigFlows.map(([e, o]) => Math.abs(o - e) / Math.abs(e)));
    const headDiffFt = Object.keys(dw.headFt).map((id) => {
      const h = ours.nodes.find((n) => n.id === id)!.headM / FT;
      return Math.abs(h - dw.headFt[id]);
    });
    console.info(`[Net1 D-W] max rel flow diff (|Q|>50 gpm) = ${(relFlow * 100).toFixed(2)} %, max |dh| = ${Math.max(...headDiffFt).toFixed(3)} ft, pump Q ours ${oursQ[12].toFixed(1)} vs EPANET ${epaQ[12].toFixed(1)} gpm`);
    expect(relFlow).toBeLessThan(0.02);
    expect(Math.max(...headDiffFt)).toBeLessThan(0.5);
    expect(maxRel([oursQ[12]], [epaQ[12]])).toBeLessThan(0.01); // pump flow within 1 %
  });
});
