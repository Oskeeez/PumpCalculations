/**
 * Validation pack. Each case builds a network through the same project model the app uses, solves it with compute(), and
 * compares the answer with a reference worked out independently: a closed-form result, a hand method coded separately here
 * (its own Colebrook and bisection, not the solver's), a published table, or the EPANET 2.2 engine (results recorded below and
 * re-checked against EPANET by the test suite). Runs in the browser, so anyone can re-run it and print the result.
 */
import { parseInp } from '../epanet';
import { elbowK, reducerK, teeBranchK } from '../fittings';
import { blankProject, compute, makeEdge, newNode, newPump, type EdgeUI, type NodeUI, type PipeUI, type ProjectUI } from '../model';
import { orificeKPermanent } from '../solver/orifice';
import { water } from '../solver/fluid';
import { NET1_INP } from './net1';

const G = 9.80665;
const FT = 0.3048;

export interface CheckRow {
  quantity: string;
  expected: number;
  actual: number;
  unit: string;
  /** Allowed difference, relative (fraction) or absolute. */
  tol: { rel?: number; abs?: number };
  pass: boolean;
}

export interface CaseResult {
  id: string;
  title: string;
  reference: string;
  rows: CheckRow[];
  pass: boolean;
  error?: string;
}

interface Case {
  id: string;
  title: string;
  reference: string;
  run: () => Omit<CheckRow, 'pass'>[];
}

const check = (r: Omit<CheckRow, 'pass'>): CheckRow => {
  const d = Math.abs(r.actual - r.expected);
  const ok = Number.isFinite(r.actual) && ((r.tol.abs !== undefined && d <= r.tol.abs) || (r.tol.rel !== undefined && d <= r.tol.rel * Math.abs(r.expected)));
  return { ...r, pass: ok };
};

// ---- independent reference methods (deliberately separate from the solver code)

/** Colebrook-White solved by bisection on f. */
function colebrook(re: number, relRough: number): number {
  if (re < 2300) return 64 / re;
  let lo = 0.005;
  let hi = 0.1;
  const g = (f: number) => 1 / Math.sqrt(f) + 2 * Math.log10(relRough / 3.7 + 2.51 / (re * Math.sqrt(f)));
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (g(lo) * g(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

const W20 = water(20);
const nu = W20.dynamicViscosity / W20.density;

/** Darcy-Weisbach head loss [m] for flow q [m3/s] in a pipe. */
function pipeLoss(q: number, L: number, D: number, eps: number, sumK = 0): number {
  const A = (Math.PI / 4) * D * D;
  const v = Math.abs(q) / A;
  if (v === 0) return 0;
  const re = (v * D) / nu;
  const f = re < 2300 ? 64 / re : colebrook(re, eps / D);
  return (f * (L / D) + sumK) * ((v * v) / (2 * G));
}

/** Flow [m3/s] through a pipe for a head difference dh, by bisection. */
function pipeFlow(dh: number, L: number, D: number, eps: number): number {
  let lo = 0;
  let hi = 10;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pipeLoss(mid, L, D, eps) < Math.abs(dh)) lo = mid;
    else hi = mid;
  }
  return Math.sign(dh) * (lo + hi) / 2;
}

function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 200; i++) {
    const m = (a + b) / 2;
    if (f(a) * f(m) <= 0) b = m;
    else a = m;
  }
  return (a + b) / 2;
}

// ---- helpers to build networks

function tank(name: string, x: number, elevationM: number, levelM = 0): NodeUI {
  return { ...newNode('tank', x, 0, []), name, elevationM, levelM };
}
function junction(name: string, x: number, elevationM = 0, demandLps = 0): NodeUI {
  return { ...newNode('junction', x, 0, []), name, elevationM, demandLps };
}
function pipe(name: string, a: NodeUI, b: NodeUI, lengthM: number, diameterMm: number, roughnessMm: number, fittings: number[] = []): PipeUI {
  return { ...(makeEdge('pipe', a.uid, b.uid, []) as PipeUI), name, lengthM, lengthMode: 'manual', diameterMm, roughnessMm, fittings: fittings.map((k) => ({ name: 'K', k })) };
}
function solve(nodes: NodeUI[], edges: EdgeUI[], extra: Partial<ProjectUI> = {}) {
  const c = compute({ ...blankProject(), nodes, edges, ...extra });
  if (c.error || !c.result) throw new Error(c.error ?? 'no result');
  if (!c.result.converged) throw new Error(c.result.message);
  return c.result;
}

// ---- the cases

export const CASES: Case[] = [
  {
    id: 'V1',
    title: 'Single pipe between two tanks, turbulent flow',
    reference: 'Darcy-Weisbach with Colebrook-White, solved independently by bisection. 500 m of 150 mm pipe, roughness 0.05 mm, K = 2.5, 15 m difference in level.',
    run: () => {
      const a = tank('A', 0, 20);
      const b = tank('B', 100, 5);
      const r = solve([a, b], [pipe('P', a, b, 500, 150, 0.05, [2.5])]);
      let qRef = 0;
      qRef = bisect((q) => pipeLoss(q, 500, 0.15, 0.05e-3, 2.5) - 15, 1e-6, 1);
      return [{ quantity: 'Flow', expected: qRef * 1000, actual: r.pipes[0].flowM3s * 1000, unit: 'L/s', tol: { rel: 1e-4 } }];
    },
  },
  {
    id: 'V2',
    title: 'Laminar flow in a long small pipe',
    reference: 'Hagen-Poiseuille, exact: h = 32 mu L v / (rho g D^2). 100 m of 10 mm pipe with 0.05 m of head.',
    run: () => {
      const a = tank('A', 0, 0.05);
      const b = tank('B', 100, 0);
      const r = solve([a, b], [pipe('P', a, b, 100, 10, 0)]);
      const D = 0.01;
      const v = (0.05 * W20.density * G * D * D) / (32 * W20.dynamicViscosity * 100);
      const q = v * (Math.PI / 4) * D * D;
      return [
        { quantity: 'Flow', expected: q * 1e6, actual: r.pipes[0].flowM3s * 1e6, unit: 'mL/s', tol: { rel: 1e-4 } },
        { quantity: 'Reynolds number (must be laminar)', expected: (v * D) / nu, actual: r.pipes[0].flow.reynolds, unit: '–', tol: { rel: 1e-4 } },
      ];
    },
  },
  {
    id: 'V3',
    title: 'Three-reservoir problem',
    reference: 'Classic three-reservoir problem: reservoirs at 100 m, 80 m and 50 m joined at one junction. Junction head found independently by bisection on continuity.',
    run: () => {
      const r1 = tank('R1', 0, 100);
      const r2 = tank('R2', 100, 80);
      const r3 = tank('R3', 200, 50);
      const j = junction('J', 100, 40);
      const spec: [NodeUI, number, number][] = [[r1, 1000, 300], [r2, 800, 250], [r3, 1200, 200]];
      const r = solve([r1, r2, r3, j], spec.map(([t, L, d], i) => pipe(`P${i + 1}`, t, j, L, d, 0.1)));
      const hj = bisect((h) => spec.reduce((s, [t, L, d]) => s + pipeFlow(t.elevationM - h, L, d / 1000, 0.1e-3), 0), 50, 100);
      return [
        { quantity: 'Junction head', expected: hj, actual: r.nodes.find((n) => n.id === 'J')!.headM, unit: 'm', tol: { abs: 0.001 } },
        ...spec.map(([t, L, d], i) => ({ quantity: `Flow from ${t.name}`, expected: pipeFlow(t.elevationM - hj, L, d / 1000, 0.1e-3) * 1000, actual: r.pipes[i].flowM3s * 1000, unit: 'L/s', tol: { rel: 1e-3, abs: 0.01 } })),
      ];
    },
  },
  {
    id: 'V4',
    title: 'Two pipes in parallel',
    reference: 'Each pipe carries the flow that its own loss allows for the common head difference (solved independently); the total is their sum.',
    run: () => {
      const a = tank('A', 0, 30);
      const b = tank('B', 200, 10);
      const r = solve([a, b], [pipe('P1', a, b, 600, 150, 0.05), pipe('P2', a, b, 400, 100, 0.05)]);
      return [
        { quantity: 'Flow in the 150 mm pipe', expected: pipeFlow(20, 600, 0.15, 0.05e-3) * 1000, actual: r.pipes.find((p) => p.id === 'P1')!.flowM3s * 1000, unit: 'L/s', tol: { rel: 2e-3 } },
        { quantity: 'Flow in the 100 mm pipe', expected: pipeFlow(20, 400, 0.1, 0.05e-3) * 1000, actual: r.pipes.find((p) => p.id === 'P2')!.flowM3s * 1000, unit: 'L/s', tol: { rel: 2e-3 } },
      ];
    },
  },
  {
    id: 'V5',
    title: 'Pump operating point',
    reference: 'Intersection of the pump curve H = 40 - 5000 Q^2 with the system curve (20 m static lift plus pipe loss), found independently by bisection.',
    run: () => {
      const a = tank('Sump', 0, 0, 2);
      const j = junction('Discharge', 50, 0);
      const b = tank('Top', 100, 20, 2);
      const pump = { ...newPump(a.uid, j.uid, []), name: 'P1', head: [{ q: 0, h: 40 }, { q: 20, h: 38 }, { q: 50, h: 27.5 }], efficiency: [], npshr: [] };
      const r = solve([a, j, b], [pump, pipe('Rising main', j, b, 300, 150, 0.05, [5])]);
      const H = (q: number) => 40 - 5000 * q * q;
      const qRef = bisect((q) => H(q) - 20 - pipeLoss(q, 300, 0.15, 0.05e-3, 5), 0, 0.08);
      return [
        { quantity: 'Pump flow', expected: qRef * 1000, actual: r.pumps[0].flowM3s * 1000, unit: 'L/s', tol: { rel: 1e-3 } },
        { quantity: 'Pump head', expected: H(qRef), actual: r.pumps[0].headM, unit: 'm', tol: { abs: 0.01 } },
      ];
    },
  },
  {
    id: 'V6',
    title: 'EPANET Net1 (looped network, Hazen-Williams, pump, tank)',
    reference: 'EPANET 2.2 engine on the EPANET example network Net1 at time zero. Heads recorded from EPANET (and re-checked against it by the test suite).',
    run: () => {
      const p = parseInp(NET1_INP).project;
      const r = solve(p.nodes, p.edges, { frictionMethod: p.frictionMethod });
      return Object.entries(NET1_EPANET_HEAD_FT).map(([id, h]) => ({ quantity: `Head at junction ${id}`, expected: h, actual: r.nodes.find((n) => n.id === id)!.headM / FT, unit: 'ft', tol: { abs: 0.05 } }));
    },
  },
  {
    id: 'V7',
    title: 'Sprinkler outlet (emitter)',
    reference: 'Q = K sqrt(p) at the outlet, from the solved pressure; and the EPANET 2.2 emitter result for the same network (9.1514 L/s).',
    run: () => {
      const r0 = tank('R', 0, 40);
      const j = { ...junction('J', 100, 0), emitter: { k: 60 * 1.5 * Math.sqrt(1e5 / (999 * G)), unit: 'lpm-bar' as const } };
      const r = solve([r0, j], [pipe('P', r0, j, 200, 100, 0.05)]);
      const q = r.valves.find((v) => v.id === 'J outlet')!.flowM3s * 1000;
      const pBar = (r.nodes.find((n) => n.id === 'J')!.headM * 999 * G) / 1e5;
      return [
        { quantity: 'Outlet flow against K sqrt(p)', expected: (j.emitter.k * Math.sqrt(pBar)) / 60, actual: q, unit: 'L/s', tol: { rel: 1e-3 } },
        { quantity: 'Outlet flow against EPANET', expected: 9.1514, actual: q, unit: 'L/s', tol: { rel: 0.01 } },
      ];
    },
  },
  {
    id: 'V8',
    title: 'Fitting losses (Crane TP-410)',
    reference: 'Crane TP-410 Appendix A: K = n fT. 4 in pipe (fT 0.017): standard 90° elbow 30 fT, tee branch 60 fT; sudden contraction 0.5 (1 - beta^2) with beta 0.5.',
    run: () => [
      { quantity: '90° standard elbow, 4 in', expected: 0.51, actual: elbowK(90, 'standard', 102.26), unit: 'K', tol: { abs: 1e-9 } },
      { quantity: 'Tee, flow through branch, 4 in', expected: 1.02, actual: teeBranchK(90, 102.26), unit: 'K', tol: { abs: 1e-9 } },
      { quantity: 'Sudden contraction, beta 0.5', expected: 0.375, actual: reducerK(50, 100, 180, 'contraction'), unit: 'K', tol: { abs: 1e-12 } },
    ],
  },
  {
    id: 'V9',
    title: 'Orifice plate permanent loss',
    reference: 'ISO 5167-2 pressure-loss relation for beta 0.5 and Cd 0.61, written out independently.',
    run: () => {
      const b = 0.5;
      const cd = 0.61;
      const km = (1 - b ** 4) / (cd * cd * b ** 4);
      const s = Math.sqrt(1 - b ** 4 * (1 - cd * cd));
      return [{ quantity: 'Permanent K (pipe velocity)', expected: (km * (s - cd * b * b)) / (s + cd * b * b), actual: orificeKPermanent(b, cd), unit: 'K', tol: { rel: 1e-9 } }];
    },
  },
  {
    id: 'V10',
    title: 'Fixed-pressure boundary and NPSH available',
    reference: 'Hand calculation: a node held at 250 kPa gauge has head z + p / (rho g); NPSHa = (p_atm - p_v) / (rho g) + suction head - z - losses.',
    run: () => {
      const s = tank('Sump', 0, 0, 3);
      const j = junction('Suction', 20, 0);
      const d = { ...junction('Out', 40, 2), fixedPressureKPaG: 250 };
      const pump = { ...newPump(j.uid, d.uid, []), name: 'P1', head: [{ q: 0, h: 50 }, { q: 10, h: 45 }, { q: 20, h: 30 }], efficiency: [], npshr: [{ q: 0, h: 1 }, { q: 20, h: 3 }] };
      const r = solve([s, j, d], [pipe('Suction pipe', s, j, 10, 150, 0.05, [0.5]), pump]);
      const out = r.nodes.find((n) => n.id === 'Out')!;
      const q = r.pumps[0].flowM3s;
      const v = q / ((Math.PI / 4) * 0.15 * 0.15);
      const hs = 3 - pipeLoss(q, 10, 0.15, 0.05e-3, 0.5);
      const npsha = hs + (101325 - W20.vaporPressure) / (W20.density * G) + (v * v) / (2 * G);
      return [
        { quantity: 'Head at the fixed-pressure node', expected: 2 + 250000 / (W20.density * G), actual: out.headM, unit: 'm', tol: { abs: 1e-6 } },
        { quantity: 'NPSH available', expected: npsha, actual: r.pumps[0].npshaM, unit: 'm', tol: { abs: 0.01 } },
      ];
    },
  },
];

/** EPANET 2.2 heads [ft] for Net1 at time zero (Hazen-Williams). Re-checked against the EPANET engine by tests/validation/pack.test.ts. */
export const NET1_EPANET_HEAD_FT: Record<string, number> = {
  '10': 1004.3474, '11': 985.2304, '12': 970.0698, '13': 968.8727, '21': 971.5466, '22': 969.0784, '23': 968.6452, '31': 967.3916, '32': 965.6893,
};

export function runValidation(): CaseResult[] {
  return CASES.map((c) => {
    try {
      const rows = c.run().map(check);
      return { id: c.id, title: c.title, reference: c.reference, rows, pass: rows.every((r) => r.pass) };
    } catch (err) {
      return { id: c.id, title: c.title, reference: c.reference, rows: [], pass: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
