/**
 * UI-side network model (UI units) and the conversion boundary to the SI solver.
 * UI units: flow L/s, diameter & roughness mm, pressure kPa (absolute), temperature degC, efficiency %,
 * viscosity mPa.s.
 */
import type { Assumption, Draft, Target } from './ai/types';
import { DEFAULT_CANVAS, DEFAULT_SCALE_M_PER_PX, lengthFromCanvas } from './geometry';
import {
  NetworkError,
  ORIFICE_CD_DEFAULT,
  orificeKPermanent,
  P_ATM,
  fitPump,
  fluidAt,
  solveWithSpeedControl,
  type SpeedControl,
  pumpHead,
  solveSystem,
  type FluidId,
  type PumpModel,
  type SysEdge,
  type SysNode,
  type SystemModel,
  type SystemResult,
  type ValveControl,
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
  /** Length [m]; used when lengthMode is 'manual'. */
  lengthM: number;
  /** 'canvas': straight-line 3D distance between the end nodes (canvas scale + elevations). */
  lengthMode: 'manual' | 'canvas';
  diameterMm: number;
  roughnessMm: number;
  fittings: FittingUI[];
  /** Optional pressure rating [kPa gauge]. An alert is raised when the solved pressure at either end exceeds it. */
  ratingKPaG?: number;
}

export interface PumpUI {
  kind: 'pump';
  uid: string;
  name: string;
  from: string;
  to: string;
  speedRatio: number;
  /** Rated speed [rpm], for display of speed ratios. */
  ratedRpm: number;
  head: { q: number; h: number }[];
  efficiency: { q: number; eta: number }[];
  npshr: { q: number; h: number }[];
  /** Impeller trim, D/D_full (1 = full diameter). Scales the curves by the affinity laws: Q ∝ D, H ∝ D². */
  impellerTrim?: number;
  /** Library curve this pump's data was taken from (its points are copied into head/efficiency/npshr). Cleared when edited by hand. */
  curveId?: string;
  /** false = switched off (standby). Default true. */
  running?: boolean;
  /** Variable-speed control: the solver sets the speed ratio to hold a flow or a node pressure (speedRatio is then the solved result). */
  control?: PumpControl;
}

/** Variable-speed pump control. Pressure is gauge [kPa], flow [L/s]. The speed stays between minRatio and maxRatio. */
export type PumpControl =
  | { mode: 'pressure'; nodeUid: string; kPaG: number; minRatio: number; maxRatio: number }
  | { mode: 'flow'; lps: number; minRatio: number; maxRatio: number };

export const defaultControl = (nodeUid: string): PumpControl => ({ mode: 'pressure', nodeUid, kPaG: 200, minRatio: 0.5, maxRatio: 1 });

/** A named, reusable pump curve (flow L/s, head m, efficiency %, NPSHr m). */
export interface PumpCurveEntry {
  id: string;
  name: string;
  ratedRpm: number;
  head: { q: number; h: number }[];
  efficiency: { q: number; eta: number }[];
  npshr: { q: number; h: number }[];
  note?: string;
}

/** 'orifice': lossValue is the bore diameter [mm]; K is derived from the bore/diameter ratio and orificeCd. */
export type ValveLossType = ValveLoss['type'] | 'orifice';
export type ValveControlType = 'none' | 'prv' | 'psv' | 'fcv';

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
  /** Discharge coefficient for lossType 'orifice' (default 0.61). */
  orificeCd?: number;
  checkValve: boolean;
  open: boolean;
  /** Regulation: none, pressure-reducing, pressure-sustaining or flow-control. */
  controlType: ValveControlType;
  /** Set pressure [kPa gauge] for PRV / PSV, or set flow [L/s] for FCV. */
  controlValue: number;
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
  /** Canvas scale [m per pixel]. */
  scaleMPerPx: number;
  /** Canvas size [px]. */
  canvasW: number;
  canvasH: number;
  /** Image layers drawn under the network. */
  images: ImageLayer[];
  /** Saved what-if snapshots of the network (see analysis.ts). */
  scenarios?: Scenario[];
  /** Design targets (see ai/targets.ts). */
  targets?: Target[];
  /** Assumptions recorded for AI-generated parts of the network. */
  assumptions?: Assumption[];
  /** AI drafts. Held outside the undo history by the app, but saved in the project file. */
  drafts?: Draft[];
  /** Library of reusable pump curves. */
  pumpCurves?: PumpCurveEntry[];
}

export interface ImageLayer {
  id: string;
  name: string;
  /** Data URL (downscaled on import). */
  dataUrl: string;
  /** Top-left corner and size on the canvas [px]. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1 */
  opacity: number;
  locked: boolean;
}

/** Everything the hydraulic calculation needs (no images, no saved scenarios). */
export type HydraulicProject = Omit<ProjectUI, 'scenarios' | 'images' | 'targets' | 'assumptions' | 'drafts' | 'pumpCurves'>;

/** A named snapshot of the hydraulic model (images are not part of a snapshot). */
export interface Scenario {
  id: string;
  name: string;
  project: HydraulicProject;
}

let counter = 100;
export const newUid = (): string => `u${++counter}`;

/** Make sure newly created uids cannot collide with those of a loaded project. */
export function syncUidCounter(p: ProjectUI): void {
  const ids: string[] = [...p.nodes.map((n) => n.uid), ...p.edges.map((e) => e.uid), ...(p.targets ?? []).map((t) => t.id), ...(p.assumptions ?? []).map((a) => a.id), ...(p.pumpCurves ?? []).map((c) => c.id)];
  for (const d of p.drafts ?? []) {
    ids.push(d.id, d.runId, ...d.project.nodes.map((n) => n.uid), ...d.project.edges.map((e) => e.uid), ...d.base.project.nodes.map((n) => n.uid), ...d.base.project.edges.map((e) => e.uid), ...d.targets.map((t) => t.id), ...d.assumptions.map((a) => a.id));
  }
  for (const id of ids) {
    const n = Number(/(\d+)$/.exec(id)?.[1]);
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
  return { kind: 'pipe', uid: newUid(), name: uniqueName('Pipe', taken), from, to, lengthM: 100, lengthMode: 'canvas', diameterMm: 102.26, roughnessMm: 0.046, fittings: [] };
}

export function newValve(from: string, to: string, taken: string[]): ValveUI {
  return { kind: 'valve', uid: newUid(), name: uniqueName('Valve', taken), from, to, diameterMm: 102.26, lossType: 'K', lossValue: 0.15, checkValve: false, open: true, controlType: 'none', controlValue: 200 };
}

export type InsertKind = 'junction' | 'tank' | 'valve' | 'orifice' | 'pump';

/**
 * Insert a junction, valve or pump into an existing pipe at the point on the pipe closest to (x, y).
 * The pipe is split in two (the original keeps its uid, name, fittings and upstream end; the new downstream
 * pipe copies its diameter, roughness and length mode). Manual lengths are shared in proportion to the split.
 * A valve or pump sits between two new junctions placed a short distance apart along the line.
 */
export function insertOnPipe(p: ProjectUI, pipeUid: string, kind: InsertKind, x: number, y: number): { project: ProjectUI; selectUid: string } {
  const pipe = p.edges.find((e) => e.uid === pipeUid);
  if (!pipe || pipe.kind !== 'pipe') throw new Error('Elements can only be inserted into a pipe.');
  const a = p.nodes.find((n) => n.uid === pipe.from);
  const b = p.nodes.find((n) => n.uid === pipe.to);
  if (!a || !b) throw new Error(`${pipe.name} is connected to a missing node.`);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (len * len)));
  const single = kind === 'junction' || kind === 'tank';
  const half = single ? 0 : Math.min(25 / len, 0.2);
  const t1 = Math.max(0.1, Math.min(0.9 - 2 * half, t - half));
  const t2 = single ? t1 : t1 + 2 * half;
  const names = p.nodes.map((n) => n.name);
  const mk = (tt: number, nodeKind: NodeKind = 'junction'): NodeUI => {
    const n = newNode(nodeKind, Math.round(a.x + dx * tt), Math.round(a.y + dy * tt), names);
    n.elevationM = a.elevationM + (b.elevationM - a.elevationM) * tt;
    names.push(n.name);
    return n;
  };
  const j1 = mk(t1, kind === 'tank' ? 'tank' : 'junction');
  const j2 = single ? j1 : mk(t2);
  const edgeNames = p.edges.map((e) => e.name);
  const tail: PipeUI = { ...pipe, uid: newUid(), name: uniqueName('Pipe', edgeNames), from: j2.uid, to: pipe.to, fittings: [], lengthM: pipe.lengthM * (1 - t2) };
  edgeNames.push(tail.name);
  const head: PipeUI = { ...pipe, to: j1.uid, lengthM: pipe.lengthM * t1 };
  const middle: EdgeUI[] = [];
  let selectUid = j1.uid;
  if (kind === 'valve' || kind === 'orifice') {
    const v = kind === 'orifice' ? newOrifice(j1.uid, j2.uid, edgeNames, pipe.diameterMm) : newValve(j1.uid, j2.uid, edgeNames);
    v.diameterMm = pipe.diameterMm;
    middle.push(v);
    selectUid = v.uid;
  } else if (kind === 'pump') {
    const pu = newPump(j1.uid, j2.uid, edgeNames);
    middle.push(pu);
    selectUid = pu.uid;
  }
  return {
    project: {
      ...p,
      nodes: single ? [...p.nodes, j1] : [...p.nodes, j1, j2],
      edges: p.edges.flatMap((e) => (e.uid === pipe.uid ? [head, ...middle, tail] : [e])),
    },
    selectUid,
  };
}

export function newOrifice(from: string, to: string, taken: string[], diameterMm = 102.26): ValveUI {
  return { kind: 'valve', uid: newUid(), name: uniqueName('Orifice', taken), from, to, diameterMm, lossType: 'orifice', lossValue: Math.round(diameterMm * 5) / 10, orificeCd: ORIFICE_CD_DEFAULT, checkValve: false, open: true, controlType: 'none', controlValue: 200 };
}

export type ConnectKindM = 'pipe' | 'pump' | 'valve' | 'orifice';

/** A new pipe, pump, valve or orifice between two nodes. Valves and orifices take the given diameter. */
export function makeEdge(kind: ConnectKindM, from: string, to: string, taken: string[], diameterMm = 102.26): EdgeUI {
  if (kind === 'pipe') return newPipe(from, to, taken);
  if (kind === 'pump') return newPump(from, to, taken);
  if (kind === 'orifice') return newOrifice(from, to, taken, diameterMm);
  return { ...newValve(from, to, taken), diameterMm };
}

/** Drag a connector from a node into empty space: the far end becomes a new junction at that point (same elevation as the start). */
export function connectToNewNode(p: ProjectUI, kind: ConnectKindM, fromUid: string, x: number, y: number, diameterMm?: number): { project: ProjectUI; selectUid: string } {
  const start = p.nodes.find((n) => n.uid === fromUid);
  if (!start) throw new Error('The start node no longer exists.');
  const end = newNode('junction', x, y, p.nodes.map((n) => n.name));
  end.elevationM = start.elevationM;
  const e = makeEdge(kind, fromUid, end.uid, p.edges.map((q) => q.name), diameterMm);
  return { project: { ...p, nodes: [...p.nodes, end], edges: [...p.edges, e] }, selectUid: e.uid };
}

/**
 * Drag across blank canvas with a pipe/pump/valve/orifice tool: a new junction at the start point, and either another new junction
 * at the end point or, when the drag ends on an existing node, that node. The element joins them, start to end.
 */
export function connectBlank(p: ProjectUI, kind: ConnectKindM, a: { x: number; y: number }, b: { x: number; y: number } | { uid: string }, diameterMm?: number): { project: ProjectUI; selectUid: string } {
  const names = p.nodes.map((n) => n.name);
  const endNode = 'uid' in b ? p.nodes.find((n) => n.uid === b.uid) : undefined;
  if ('uid' in b && !endNode) throw new Error('The end node no longer exists.');
  const start = newNode('junction', a.x, a.y, names);
  start.elevationM = endNode ? endNode.elevationM : 0;
  names.push(start.name);
  const end = endNode ?? newNode('junction', (b as { x: number }).x, (b as { y: number }).y, names);
  if (!endNode) end.elevationM = start.elevationM;
  const e = makeEdge(kind, start.uid, end.uid, p.edges.map((q) => q.name), diameterMm);
  return { project: { ...p, nodes: endNode ? [...p.nodes, start] : [...p.nodes, start, end], edges: [...p.edges, e] }, selectUid: e.uid };
}

/**
 * Place a pump, valve or orifice on its own, anywhere on the canvas: two new junctions 90 px apart (suction on the left,
 * discharge on the right) joined by the element. Connect those nodes to the rest of the network afterwards.
 */
export function placeStandalone(p: ProjectUI, kind: 'pump' | 'valve' | 'orifice', x: number, y: number, elevationM = 0): { project: ProjectUI; selectUid: string } {
  const names = p.nodes.map((n) => n.name);
  const mk = (px: number, label: string): NodeUI => {
    const n = newNode('junction', px, y, names);
    n.name = uniqueName(label, names);
    n.elevationM = elevationM;
    names.push(n.name);
    return n;
  };
  const a = mk(x - 45, kind === 'pump' ? 'Suction' : 'Inlet');
  const b = mk(x + 45, kind === 'pump' ? 'Discharge' : 'Outlet');
  const taken = p.edges.map((e) => e.name);
  const e: EdgeUI = kind === 'pump' ? newPump(a.uid, b.uid, taken) : kind === 'orifice' ? newOrifice(a.uid, b.uid, taken) : newValve(a.uid, b.uid, taken);
  return { project: { ...p, nodes: [...p.nodes, a, b], edges: [...p.edges, e] }, selectUid: e.uid };
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
  return { kind: 'pump', uid: newUid(), name: uniqueName('Pump', taken), from, to, speedRatio: 1, ratedRpm: 1450, ...defaultPumpCurve() };
}

export function blankProject(): ProjectUI {
  return { fluid: defaultFluid(), temperatureC: 20, npshMarginM: 0.5, maxVelocityMps: 3, nodes: [], edges: [], scaleMPerPx: DEFAULT_SCALE_M_PER_PX, canvasW: DEFAULT_CANVAS.w, canvasH: DEFAULT_CANVAS.h, images: [] };
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
    kind: 'pipe', uid: newUid(), name, from: a.uid, to: b.uid, lengthM, lengthMode: 'manual', diameterMm, roughnessMm: 0.05, fittings: k.map((v) => ({ name: 'Fitting', k: v })),
  });
  const pump: PumpUI = { kind: 'pump', uid: newUid(), name: 'Pump 1', from: suction.uid, to: j1.uid, speedRatio: 1, ratedRpm: 1450, ...defaultPumpCurve() };
  const valve: ValveUI = { kind: 'valve', uid: newUid(), name: 'Throttle valve', from: vb.uid, to: j3.uid, diameterMm: 100, lossType: 'Cv', lossValue: 250, checkValve: false, open: true, controlType: 'none', controlValue: 200 };
  return {
    fluid: defaultFluid(),
    temperatureC: 20,
    npshMarginM: 0.5,
    maxVelocityMps: 3,
    scaleMPerPx: DEFAULT_SCALE_M_PER_PX,
    canvasW: DEFAULT_CANVAS.w,
    canvasH: DEFAULT_CANVAS.h,
    images: [],
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

/** Pipe length [m]: the typed value, or the 3D distance between its end nodes on the canvas. */
export function pipeLengthM(p: Pick<ProjectUI, 'nodes' | 'scaleMPerPx'>, e: PipeUI): number {
  if (e.lengthMode !== 'canvas') return e.lengthM;
  const a = p.nodes.find((n) => n.uid === e.from);
  const b = p.nodes.find((n) => n.uid === e.to);
  return a && b ? lengthFromCanvas(a, b, p.scaleMPerPx) : e.lengthM;
}

/** Convert UI units to the SI solver model. Throws Error with a readable message if invalid. */
export function toSystemModel(p: HydraulicProject): SystemModel {
  if (!(p.scaleMPerPx > 0)) throw new Error('Canvas scale must be greater than 0.');
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
      const length = pipeLengthM(p, e);
      if (!(length >= 0)) throw new Error(`${e.name}: length must be ≥ 0.`);
      if (!(e.roughnessMm >= 0)) throw new Error(`${e.name}: roughness must be ≥ 0.`);
      if (e.fittings.some((f) => !(f.k >= 0))) throw new Error(`${e.name}: fitting K values must be ≥ 0.`);
      return {
        kind: 'pipe', id: e.name, from, to,
        spec: { lengthM: length, innerDiameterM: e.diameterMm / 1000, roughnessM: e.roughnessMm / 1000, elevationChangeM: 0, fittingsK: e.fittings.map((f) => f.k) },
      };
    }
    if (e.kind === 'valve') {
      if (!(e.diameterMm > 0)) throw new Error(`${e.name}: diameter must be > 0.`);
      let loss: ValveLoss;
      if (e.lossType === 'orifice') {
        if (!(e.lossValue > 0 && e.lossValue < e.diameterMm)) throw new Error(`${e.name}: orifice bore must be greater than 0 and smaller than the pipe diameter.`);
        try {
          loss = { type: 'K', k: orificeKPermanent(e.lossValue / e.diameterMm, e.orificeCd ?? ORIFICE_CD_DEFAULT) };
        } catch (err) {
          throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        if (e.lossType === 'K' ? !(e.lossValue >= 0) : !(e.lossValue > 0)) throw new Error(`${e.name}: ${e.lossType} must be ${e.lossType === 'K' ? '≥ 0' : '> 0'}.`);
        loss = e.lossType === 'K' ? { type: 'K', k: e.lossValue } : e.lossType === 'Cv' ? { type: 'Cv', cv: e.lossValue } : { type: 'Kv', kv: e.lossValue };
      }
      let control: ValveControl | undefined;
      if (e.controlType === 'prv' || e.controlType === 'psv') {
        if (!(e.controlValue >= 0)) throw new Error(`${e.name}: set pressure must be ≥ 0.`);
        control = { type: e.controlType, setpointPa: e.controlValue * 1000 };
      } else if (e.controlType === 'fcv') {
        if (!(e.controlValue > 0)) throw new Error(`${e.name}: set flow must be > 0.`);
        control = { type: 'fcv', flowM3s: e.controlValue / 1000 };
      }
      return { kind: 'valve', id: e.name, from, to, spec: { diameterM: e.diameterMm / 1000, loss, checkValve: e.checkValve, open: e.open, control } };
    }
    if (!(e.speedRatio > 0)) throw new Error(`${e.name}: speed ratio must be > 0.`);
    if (e.head.length < 2 || new Set(e.head.map((x) => x.q)).size < 2) throw new Error(`${e.name}: head curve needs at least 2 points with different flows.`);
    if (e.control) {
      const c = e.control;
      if (!(c.minRatio > 0) || !(c.maxRatio > c.minRatio)) throw new Error(`${e.name}: speed limits must satisfy 0 < minimum < maximum.`);
      if (c.mode === 'flow' && !(c.lps > 0)) throw new Error(`${e.name}: the flow to hold must be greater than 0.`);
      if (c.mode === 'pressure' && (!Number.isFinite(c.kPaG) || !nameOf.has(c.nodeUid))) throw new Error(`${e.name}: choose a node and a pressure to hold.`);
    }
    const trim = e.impellerTrim ?? 1;
    if (!(trim > 0 && trim <= 1.0001)) throw new Error(`${e.name}: impeller trim must be between 0 and 1.`);
    const model: PumpModel = fitPump({
      head: e.head.map((x) => ({ flowM3s: (x.q / 1000) * trim, headM: x.h * trim * trim })),
      efficiency: e.efficiency.length >= 2 ? e.efficiency.map((x) => ({ flowM3s: (x.q / 1000) * trim, eta: x.eta / 100 })) : undefined,
      npshr: e.npshr.length >= 2 ? e.npshr.map((x) => ({ flowM3s: (x.q / 1000) * trim, npshrM: x.h * trim * trim })) : undefined,
    });
    return { kind: 'pump', id: e.name, from, to, model, speedRatio: e.speedRatio, running: e.running !== false };
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

export function compute(p: HydraulicProject): Computed {
  try {
    let model = toSystemModel(p);
    const opts = { npshMarginM: p.npshMarginM };
    const controls: SpeedControl[] = [];
    for (const e of p.edges) {
      if (e.kind !== 'pump' || !e.control || e.running === false) continue;
      const c = e.control;
      controls.push({
        pumpId: e.name,
        minRatio: c.minRatio,
        maxRatio: c.maxRatio,
        target: c.mode === 'flow' ? { kind: 'flow', m3s: c.lps / 1000 } : { kind: 'pressure', nodeId: p.nodes.find((n) => n.uid === c.nodeUid)?.name ?? '', pa: c.kPaG * 1000 },
      });
    }
    let result: SystemResult;
    const controlNotes: string[] = [];
    if (controls.length) {
      const solved = solveWithSpeedControl(model, controls, opts);
      model = solved.model;
      result = solved.result;
      controlNotes.push(...solved.notes);
    } else {
      result = solveSystem(model, opts);
    }
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
    alerts.unshift(...controlNotes);
    // pipes with a pressure rating: the highest pressure is at one of the end nodes (or at the lowest end when the pipe falls)
    for (const e of p.edges) {
      if (e.kind !== 'pipe' || !(e.ratingKPaG !== undefined && e.ratingKPaG > 0)) continue;
      for (const uid of [e.from, e.to]) {
        const node = p.nodes.find((n) => n.uid === uid);
        const gauge = node ? result.nodes.find((x) => x.id === node.name)?.gaugePressurePa : undefined;
        if (node && gauge !== undefined && gauge / 1000 > e.ratingKPaG) alerts.push(`Pipe "${e.name}": pressure ${(gauge / 1000).toFixed(0)} kPa at "${node.name}" exceeds its rating of ${e.ratingKPaG} kPa.`);
      }
    }
    return { model, result, pumpCurves, alerts };
  } catch (err) {
    const msg = err instanceof NetworkError || err instanceof Error ? err.message : String(err);
    return { pumpCurves: [], alerts: [], error: msg };
  }
}

/**
 * Key that changes only when something hydraulic changes. Node positions count only while a pipe takes its
 * length from the canvas, so dragging nodes does not trigger a re-solve otherwise.
 */
export function hydraulicKey(p: HydraulicProject): string {
  const usesCanvas = p.edges.some((e) => e.kind === 'pipe' && e.lengthMode === 'canvas');
  return JSON.stringify([
    p.fluid,
    p.temperatureC,
    p.npshMarginM,
    p.maxVelocityMps,
    usesCanvas ? p.scaleMPerPx : 0,
    p.nodes.map(({ x, y, ...rest }) => (usesCanvas ? { x, y, ...rest } : rest)),
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

/** Validate one project (or scenario snapshot) and fill defaults for fields added in later versions. */
function normalizeProject(p: Partial<ProjectUI> | undefined, depth = 0): ProjectUI {
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
    edges: (p.edges as EdgeUI[]).map((e) =>
      e.kind === 'valve'
        ? { ...e, controlType: e.controlType ?? 'none', controlValue: isNum(e.controlValue) ? e.controlValue : 200, ...(e.lossType === 'orifice' && !isNum(e.orificeCd) ? { orificeCd: ORIFICE_CD_DEFAULT } : {}) }
        : e.kind === 'pump'
          ? { ...e, ratedRpm: isNum(e.ratedRpm) ? e.ratedRpm : 1450 }
          : { ...e, lengthMode: e.lengthMode === 'canvas' ? 'canvas' : 'manual' },
    ),
    scaleMPerPx: isNum(p.scaleMPerPx) && p.scaleMPerPx > 0 ? p.scaleMPerPx : DEFAULT_SCALE_M_PER_PX,
    canvasW: isNum(p.canvasW) && p.canvasW > 0 ? p.canvasW : DEFAULT_CANVAS.w,
    canvasH: isNum(p.canvasH) && p.canvasH > 0 ? p.canvasH : DEFAULT_CANVAS.h,
    images: [],
  };
  if (p.images !== undefined) {
    if (!Array.isArray(p.images)) throw new Error('The images in the project file are malformed.');
    project.images = p.images.map((im) => {
      if (!im || !isStr(im.id) || !isStr(im.name) || !isStr(im.dataUrl) || ![im.x, im.y, im.width, im.height, im.opacity].every(isNum)) throw new Error('An image in the project file is malformed.');
      return { ...im, locked: im.locked === true };
    });
  }
  if (p.targets !== undefined) {
    if (!Array.isArray(p.targets) || p.targets.some((t) => !t || !isStr(t.id) || !['flow', 'pressure', 'velocity', 'pumpRange', 'npsh'].includes(t.type))) throw new Error('A target in the project file is malformed.');
    project.targets = p.targets;
  }
  if (p.assumptions !== undefined) {
    if (!Array.isArray(p.assumptions) || p.assumptions.some((a) => !a || !isStr(a.id) || !isStr(a.text))) throw new Error('An assumption in the project file is malformed.');
    project.assumptions = p.assumptions;
  }
  if (p.pumpCurves !== undefined) {
    const ok = (a: unknown, k1: string, k2: string) => Array.isArray(a) && a.every((r) => r && isNum((r as Record<string, unknown>)[k1]) && isNum((r as Record<string, unknown>)[k2]));
    if (!Array.isArray(p.pumpCurves) || p.pumpCurves.some((c) => !c || !isStr(c.id) || !isStr(c.name) || !ok(c.head, 'q', 'h') || !ok(c.efficiency, 'q', 'eta') || !ok(c.npshr, 'q', 'h'))) throw new Error('A pump curve in the project file is malformed.');
    project.pumpCurves = p.pumpCurves.map((c) => ({ ...c, ratedRpm: isNum(c.ratedRpm) ? c.ratedRpm : 1450 }));
  }
  if (depth === 0 && p.drafts !== undefined) {
    if (!Array.isArray(p.drafts)) throw new Error('The drafts in the project file are malformed.');
    const hyd = (x: unknown): HydraulicProject => {
      const { scenarios: _s, images: _i, targets: _t, assumptions: _a, drafts: _d, pumpCurves: _c, ...rest } = normalizeProject(x as Partial<ProjectUI>, 1);
      return rest;
    };
    project.drafts = p.drafts.map((d) => {
      if (!d || !isStr(d.id) || !isStr(d.name) || !d.base || !Array.isArray(d.targets) || !Array.isArray(d.changes)) throw new Error('A draft in the project file is malformed.');
      return {
        ...d,
        rationale: isStr(d.rationale) ? d.rationale : '',
        project: hyd(d.project),
        base: { project: hyd(d.base.project), targets: Array.isArray(d.base.targets) ? d.base.targets : [] },
        assumptions: Array.isArray(d.assumptions) ? d.assumptions : [],
        status: d.status === 'merged' || d.status === 'discarded' || d.status === 'reference' ? d.status : 'open',
      };
    });
  }
  if (depth === 0 && Array.isArray(p.scenarios)) {
    project.scenarios = p.scenarios.map((s) => {
      if (!s || !isStr(s.id) || !isStr(s.name)) throw new Error('A saved scenario in the project file is malformed.');
      const { scenarios: _drop, images: _images, ...rest } = normalizeProject(s.project as Partial<ProjectUI>, 1);
      return { id: s.id, name: s.name, project: rest };
    });
  }
  return project;
}

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
  const project = normalizeProject(root.project as Partial<ProjectUI> | undefined);
  syncUidCounter(project);
  return project;
}
