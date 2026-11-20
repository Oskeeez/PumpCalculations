/**
 * UI-side network model (UI units) and the conversion boundary to the SI solver.
 * UI units: flow L/s, diameter & roughness mm, pressure kPa (absolute), temperature degC, efficiency %,
 * viscosity mPa.s.
 */
import {
  NetworkError,
  P_ATM,
  fitPump,
  fluidAt,
  pumpHead,
  solveSystem,
  type FluidId,
  type PumpModel,
  type SysEdge,
  type SysNode,
  type SystemModel,
  type SystemResult,
  type ValveLoss,
} from './solver';

export type NodeKind = 'tank' | 'junction';

export interface NodeUI {
  uid: string;
  kind: NodeKind;
  name: string;
  /** Canvas position (px). */
  x: number;
  y: number;
  /** Tank bottom elevation / junction elevation [m]. */
  elevationM: number;
  /** Tank liquid depth [m] (tanks only). */
  levelM: number;
  /** Absolute pressure above the liquid [kPa] (tanks only). */
  pressureKPa: number;
  /** External withdrawal [L/s]; negative = inflow (junctions only). */
  demandLps: number;
}

export interface FittingUI {
  name: string;
  k: number;
}

export interface PipeUI {
  kind: 'pipe';
  uid: string;
  name: string;
  from: string;
  to: string;
  lengthM: number;
  diameterMm: number;
  roughnessMm: number;
  fittings: FittingUI[];
}

export interface PumpUI {
  kind: 'pump';
  uid: string;
  name: string;
  from: string;
  to: string;
  speedRatio: number;
  head: { q: number; h: number }[];
  efficiency: { q: number; eta: number }[];
  npshr: { q: number; h: number }[];
}

export type ValveLossType = ValveLoss['type'];

export interface ValveUI {
  kind: 'valve';
  uid: string;
  name: string;
  from: string;
  to: string;
  diameterMm: number;
  lossType: ValveLossType;
  /** K, Cv or Kv according to lossType. */
  lossValue: number;
  checkValve: boolean;
  open: boolean;
}

export type EdgeUI = PipeUI | PumpUI | ValveUI;

export interface FluidUI {
  id: FluidId;
  /** Used when id === 'custom'. */
  customName: string;
  customDensity: number;
  customViscosityMPas: number;
  customVaporKPa: number;
}

export interface ProjectUI {
  fluid: FluidUI;
  temperatureC: number;
  npshMarginM: number;
  /** Design alert: warn above this velocity [m/s]; 0 disables. */
  maxVelocityMps: number;
  nodes: NodeUI[];
  edges: EdgeUI[];
}

let counter = 100;
export const newUid = (): string => `u${++counter}`;

/** Make sure newly created uids cannot collide with those of a loaded project. */
export function syncUidCounter(p: ProjectUI): void {
  for (const id of [...p.nodes.map((n) => n.uid), ...p.edges.map((e) => e.uid)]) {
    const n = Number(id.replace(/^u/, ''));
    if (Number.isFinite(n) && n > counter) counter = n;
  }
}

export function uniqueName(base: string, taken: string[]): string {
  let n = 1;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export const defaultFluid = (): FluidUI => ({ id: 'water', customName: 'Custom fluid', customDensity: 850, customViscosityMPas: 5, customVaporKPa: 1 });

export function newNode(kind: NodeKind, x: number, y: number, taken: string[]): NodeUI {
  return {
    uid: newUid(),
    kind,
    name: uniqueName(kind === 'tank' ? 'Tank' : 'Junction', taken),
    x,
    y,
    elevationM: 0,
    levelM: kind === 'tank' ? 3 : 0,
    pressureKPa: P_ATM / 1000,
    demandLps: 0,
  };
}

export function newPipe(from: string, to: string, taken: string[]): PipeUI {
  return { kind: 'pipe', uid: newUid(), name: uniqueName('Pipe', taken), from, to, lengthM: 100, diameterMm: 102.26, roughnessMm: 0.046, fittings: [] };
}

export function newValve(from: string, to: string, taken: string[]): ValveUI {
  return { kind: 'valve', uid: newUid(), name: uniqueName('Valve', taken), from, to, diameterMm: 102.26, lossType: 'K', lossValue: 0.15, checkValve: false, open: true };
}

export function defaultPumpCurve() {
  return {
    head: [
      { q: 0, h: 50 },
      { q: 10, h: 46 },
      { q: 20, h: 38 },
      { q: 30, h: 26 },
      { q: 40, h: 10 },
    ],
    efficiency: [
      { q: 5, eta: 40 },
      { q: 15, eta: 70 },
      { q: 25, eta: 65 },
    ],
    npshr: [
      { q: 0, h: 1.5 },
      { q: 20, h: 2.5 },
      { q: 30, h: 4 },
    ],
  };
}

export function newPump(from: string, to: string, taken: string[]): PumpUI {
  return { kind: 'pump', uid: newUid(), name: uniqueName('Pump', taken), from, to, speedRatio: 1, ...defaultPumpCurve() };
}

export function blankProject(): ProjectUI {
  return { fluid: defaultFluid(), temperatureC: 20, npshMarginM: 0.5, maxVelocityMps: 3, nodes: [], edges: [] };
}

/** Example: tank -> pump -> looped distribution with a throttling valve and demands -> two elevated tanks. */
export function defaultProject(): ProjectUI {
  const node = (kind: NodeKind, name: string, x: number, y: number, elevationM: number, extra: Partial<NodeUI> = {}): NodeUI => ({
    uid: newUid(), kind, name, x, y, elevationM, levelM: kind === 'tank' ? 3 : 0, pressureKPa: P_ATM / 1000, demandLps: 0, ...extra,
  });
  const supply = node('tank', 'Supply tank', 90, 260, 0, { levelM: 4 });
  const suction = node('junction', 'Pump suction', 230, 260, 0);
  const j1 = node('junction', 'J1', 450, 260, 2);
  const vb = node('junction', 'Valve inlet', 490, 340, 3);
  const j2 = node('junction', 'J2', 640, 130, 5, { demandLps: 4 });
  const j3 = node('junction', 'J3', 640, 390, 4, { demandLps: 6 });
  const tb = node('tank', 'Tank B', 860, 130, 20);
  const tc = node('tank', 'Tank C', 860, 390, 12, { levelM: 2 });
  const pipe = (name: string, a: NodeUI, b: NodeUI, lengthM: number, diameterMm: number, k: number[] = []): PipeUI => ({
    kind: 'pipe', uid: newUid(), name, from: a.uid, to: b.uid, lengthM, diameterMm, roughnessMm: 0.05, fittings: k.map((v) => ({ name: 'Fitting', k: v })),
  });
  const pump: PumpUI = { kind: 'pump', uid: newUid(), name: 'Pump 1', from: suction.uid, to: j1.uid, speedRatio: 1, ...defaultPumpCurve() };
  const valve: ValveUI = { kind: 'valve', uid: newUid(), name: 'Throttle valve', from: vb.uid, to: j3.uid, diameterMm: 100, lossType: 'Cv', lossValue: 250, checkValve: false, open: true };
  return {
    fluid: defaultFluid(),
    temperatureC: 20,
    npshMarginM: 0.5,
    maxVelocityMps: 3,
    nodes: [supply, suction, j1, vb, j2, j3, tb, tc],
    edges: [
      pipe('Suction pipe', supply, suction, 8, 150, [0.5]),
      pump,
      pipe('Pipe A', j1, j2, 150, 100, [1]),
      pipe('Pipe B', j1, vb, 100, 100),
      valve,
      pipe('Cross link', j2, j3, 120, 80),
      pipe('To Tank B', j2, tb, 180, 100, [2]),
      pipe('To Tank C', j3, tc, 90, 100),
    ],
  };
}

/** Convert UI units to the SI solver model. Throws Error with a readable message if invalid. */
export function toSystemModel(p: ProjectUI): SystemModel {
  let fluid;
  try {
    fluid = fluidAt(p.fluid.id, p.temperatureC, {
      name: p.fluid.customName,
      density: p.fluid.customDensity,
      dynamicViscosity: p.fluid.customViscosityMPas / 1000,
      vaporPressure: p.fluid.customVaporKPa * 1000,
    });
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Invalid fluid.');
  }
  const nameOf = new Map(p.nodes.map((n) => [n.uid, n.name]));
  const nodes: SysNode[] = p.nodes.map((n) =>
    n.kind === 'tank'
      ? { kind: 'tank', id: n.name, elevationM: n.elevationM, liquidLevelM: n.levelM, surfacePressurePa: n.pressureKPa * 1000 }
      : { kind: 'junction', id: n.name, elevationM: n.elevationM, demandM3s: n.demandLps / 1000 },
  );
  for (const n of p.nodes) if (n.kind === 'tank' && !(n.levelM >= 0)) throw new Error(`${n.name}: liquid level must be ≥ 0.`);
  const edges: SysEdge[] = p.edges.map((e): SysEdge => {
    const from = nameOf.get(e.from);
    const to = nameOf.get(e.to);
    if (from === undefined || to === undefined) throw new Error(`${e.name} is connected to a missing node.`);
    if (e.kind === 'pipe') {
      if (!(e.diameterMm > 0)) throw new Error(`${e.name}: diameter must be > 0.`);
      if (!(e.lengthM >= 0)) throw new Error(`${e.name}: length must be ≥ 0.`);
      if (!(e.roughnessMm >= 0)) throw new Error(`${e.name}: roughness must be ≥ 0.`);
      if (e.fittings.some((f) => !(f.k >= 0))) throw new Error(`${e.name}: fitting K values must be ≥ 0.`);
      return {
        kind: 'pipe', id: e.name, from, to,
        spec: { lengthM: e.lengthM, innerDiameterM: e.diameterMm / 1000, roughnessM: e.roughnessMm / 1000, elevationChangeM: 0, fittingsK: e.fittings.map((f) => f.k) },
      };
    }
    if (e.kind === 'valve') {
      if (!(e.diameterMm > 0)) throw new Error(`${e.name}: diameter must be > 0.`);
      if (e.lossType === 'K' ? !(e.lossValue >= 0) : !(e.lossValue > 0)) throw new Error(`${e.name}: ${e.lossType} must be ${e.lossType === 'K' ? '≥ 0' : '> 0'}.`);
      const loss: ValveLoss = e.lossType === 'K' ? { type: 'K', k: e.lossValue } : e.lossType === 'Cv' ? { type: 'Cv', cv: e.lossValue } : { type: 'Kv', kv: e.lossValue };
      return { kind: 'valve', id: e.name, from, to, spec: { diameterM: e.diameterMm / 1000, loss, checkValve: e.checkValve, open: e.open } };
    }
    if (!(e.speedRatio > 0)) throw new Error(`${e.name}: speed ratio must be > 0.`);
    if (e.head.length < 2 || new Set(e.head.map((x) => x.q)).size < 2) throw new Error(`${e.name}: head curve needs at least 2 points with different flows.`);
    const model: PumpModel = fitPump({
      head: e.head.map((x) => ({ flowM3s: x.q / 1000, headM: x.h })),
      efficiency: e.efficiency.length >= 2 ? e.efficiency.map((x) => ({ flowM3s: x.q / 1000, eta: x.eta / 100 })) : undefined,
      npshr: e.npshr.length >= 2 ? e.npshr.map((x) => ({ flowM3s: x.q / 1000, npshrM: x.h })) : undefined,
    });
    return { kind: 'pump', id: e.name, from, to, model, speedRatio: e.speedRatio };
  });
  return { fluid, nodes, edges };
}

export interface PumpCurveData {
  name: string;
  /** Sampled curve, flow L/s vs head m. */
  pts: { q: number; h: number }[];
  /** Operating point (L/s, m), if the pump has forward flow. */
  op?: { q: number; h: number };
  headFitRmse: number;
}

export interface Computed {
  model?: SystemModel;
  result?: SystemResult;
  pumpCurves: PumpCurveData[];
  /** Design alerts (velocity limits). */
  alerts: string[];
  error?: string;
}

export function compute(p: ProjectUI): Computed {
  try {
    const model = toSystemModel(p);
    const result = solveSystem(model, { npshMarginM: p.npshMarginM });
    const pumpCurves: PumpCurveData[] = [];
    for (const e of model.edges) {
      if (e.kind !== 'pump') continue;
      const res = result.pumps.find((x) => x.id === e.id);
      const qOp = res && res.flowM3s > 1e-9 ? res.flowM3s : 0;
      const qMax = Math.max(e.model.headDataRange.maxFlowM3s * e.speedRatio * 1.05, qOp * 1.3, 1e-3);
      const pts = Array.from({ length: 61 }, (_, i) => {
        const q = (qMax * i) / 60;
        return { q: q * 1000, h: pumpHead(e.model, q, e.speedRatio) };
      });
      pumpCurves.push({ name: e.id, pts, op: qOp > 0 && res ? { q: qOp * 1000, h: res.headM } : undefined, headFitRmse: e.model.fitRmse.head });
    }
    const alerts: string[] = [];
    if (p.maxVelocityMps > 0) {
      for (const x of result.pipes) if (x.flow.velocity > p.maxVelocityMps) alerts.push(`Pipe "${x.id}": velocity ${x.flow.velocity.toFixed(2)} m/s exceeds the ${p.maxVelocityMps} m/s limit.`);
      for (const x of result.valves) if (x.velocity > p.maxVelocityMps) alerts.push(`Valve "${x.id}": velocity ${x.velocity.toFixed(2)} m/s exceeds the ${p.maxVelocityMps} m/s limit.`);
    }
    return { model, result, pumpCurves, alerts };
  } catch (err) {
    const msg = err instanceof NetworkError || err instanceof Error ? err.message : String(err);
    return { pumpCurves: [], alerts: [], error: msg };
  }
}

/** Key that changes only when something hydraulic changes (not when a node is dragged). */
export function hydraulicKey(p: ProjectUI): string {
  return JSON.stringify([
    p.fluid,
    p.temperatureC,
    p.npshMarginM,
    p.maxVelocityMps,
    p.nodes.map(({ x: _x, y: _y, ...rest }) => rest),
    p.edges,
  ]);
}

// ---------------------------------------------------------------- save / load
const FORMAT = 'pipe-network-project';
const VERSION = 1;

export function serializeProject(p: ProjectUI): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, project: p }, null, 2);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** Parse and validate a saved project. Throws Error with a readable message. */
export function parseProject(text: string): ProjectUI {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  const root = data as { format?: unknown; version?: unknown; project?: unknown };
  if (!root || root.format !== FORMAT) throw new Error('This is not a pipe network project file.');
  if (root.version !== VERSION) throw new Error(`Unsupported project version ${String(root.version)}.`);
  const p = root.project as Partial<ProjectUI> | undefined;
  if (!p || !Array.isArray(p.nodes) || !Array.isArray(p.edges) || !p.fluid) throw new Error('The project file is missing nodes, edges or fluid.');
  for (const n of p.nodes) {
    if (!n || !isStr(n.uid) || !isStr(n.name) || (n.kind !== 'tank' && n.kind !== 'junction') || ![n.x, n.y, n.elevationM, n.levelM, n.pressureKPa, n.demandLps].every(isNum)) {
      throw new Error('A node in the project file is malformed.');
    }
  }
  const uids = new Set(p.nodes.map((n) => n.uid));
  for (const e of p.edges) {
    if (!e || !isStr(e.uid) || !isStr(e.name) || !isStr(e.from) || !isStr(e.to) || !['pipe', 'pump', 'valve'].includes(e.kind)) throw new Error('A pipe, pump or valve in the project file is malformed.');
    if (!uids.has(e.from) || !uids.has(e.to)) throw new Error(`"${e.name}" refers to a node that is not in the file.`);
  }
  if (!isNum(p.temperatureC) || !isNum(p.npshMarginM)) throw new Error('The project file is missing fluid temperature or NPSH margin.');
  const project: ProjectUI = {
    fluid: { ...defaultFluid(), ...p.fluid },
    temperatureC: p.temperatureC,
    npshMarginM: p.npshMarginM,
    maxVelocityMps: isNum(p.maxVelocityMps) ? p.maxVelocityMps : 3,
    nodes: p.nodes as NodeUI[],
    edges: p.edges as EdgeUI[],
  };
  syncUidCounter(project);
  return project;
}
