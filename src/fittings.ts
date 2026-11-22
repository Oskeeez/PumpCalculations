/**
 * Fitting losses from Crane TP-410 style equivalent lengths (K = L/D x fT) and the usual
 * contraction / expansion relations. Typical values for screening; real fittings vary by maker and size.
 */

/** Crane fully turbulent friction factor for clean commercial steel, by inside diameter [mm]. */
export function craneFT(diameterMm: number): number {
  const table: [number, number][] = [[16, 0.027], [21, 0.025], [27, 0.023], [35, 0.022], [41, 0.021], [53, 0.019], [78, 0.018], [103, 0.017], [129, 0.016], [155, 0.015], [255, 0.014], [410, 0.013]];
  for (const [d, f] of table) if (diameterMm <= d) return f;
  return 0.012;
}

function interpolate(points: readonly [number, number][], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x0, y0] = points[i - 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

export type ElbowStyle = 'standard' | 'long' | 'mitre';

export const ELBOW_STYLES: { id: ElbowStyle; label: string }[] = [
  { id: 'standard', label: 'Standard (r/D = 1)' },
  { id: 'long', label: 'Long radius (r/D = 1.5)' },
  { id: 'mitre', label: 'Mitre' },
];

/** L/D of an elbow that turns the flow through `deflectionDeg` (90 = a right-angle elbow, 0 = no turn). */
const ELBOW_LD: Record<ElbowStyle, [number, number][]> = {
  standard: [[0, 0], [45, 16], [90, 30], [180, 50]],
  long: [[0, 0], [45, 11], [90, 20], [180, 34]],
  mitre: [[0, 0], [15, 4], [30, 8], [45, 15], [60, 25], [90, 60], [180, 90]],
};

export function elbowK(deflectionDeg: number, style: ElbowStyle, diameterMm: number): number {
  const d = Math.max(0, Math.min(180, deflectionDeg));
  return interpolate(ELBOW_LD[style], d) * craneFT(diameterMm);
}

/** Loss of a tee or wye leg pair: through the run, and into the branch that leaves at `branchAngleDeg` to the run. */
export function teeRunK(diameterMm: number): number {
  return 20 * craneFT(diameterMm);
}
export function teeBranchK(branchAngleDeg: number, diameterMm: number): number {
  const a = (Math.max(0, Math.min(90, branchAngleDeg)) * Math.PI) / 180;
  return 60 * craneFT(diameterMm) * (0.3 + 0.7 * Math.sin(a) ** 2);
}
export function crossLegK(diameterMm: number): number {
  return 30 * craneFT(diameterMm);
}

/** K of a change in diameter, referred to the velocity in the smaller pipe. `coneDeg` 180 = sudden. */
export function reducerK(smallMm: number, bigMm: number, coneDeg: number, flow: 'contraction' | 'expansion'): number {
  if (!(smallMm > 0 && bigMm > smallMm)) return 0;
  const b2 = (smallMm / bigMm) ** 2;
  const half = (Math.max(1, Math.min(180, coneDeg)) * Math.PI) / 360;
  if (flow === 'contraction') return (coneDeg <= 45 ? 0.8 * Math.sin(half) : 0.5 * Math.sqrt(Math.sin(half))) * (1 - b2);
  return (coneDeg <= 45 ? 2.6 * Math.sin(half) : 1) * (1 - b2) ** 2;
}

// ---- junction fittings on a network

export type JunctionFittingType = 'elbow' | 'tee' | 'wye' | 'cross' | 'reducer';

export interface JunctionFitting {
  type: JunctionFittingType;
  style: ElbowStyle;
  /** Elbow deflection or wye branch angle [deg], used when `fromDrawing` is false. */
  angleDeg: number;
  /** Take the angle from the way the pipes are drawn. */
  fromDrawing: boolean;
  /** Tee / wye: the pipe that is the branch. Found from the drawing when empty. */
  branchUid?: string;
  /** Reducer: included cone angle [deg]; 180 = sudden. */
  coneDeg: number;
}

export const JUNCTION_FITTING_LABELS: Record<JunctionFittingType | 'none', string> = {
  none: 'Plain junction',
  elbow: 'Elbow',
  tee: 'Tee',
  wye: 'Wye',
  cross: 'Cross',
  reducer: 'Reducer / expander',
};

export const LEG_COUNT: Record<JunctionFittingType, number> = { elbow: 2, tee: 3, wye: 3, cross: 4, reducer: 2 };

export function defaultFitting(type: JunctionFittingType): JunctionFitting {
  return { type, style: 'standard', angleDeg: type === 'elbow' ? 90 : type === 'wye' ? 45 : 90, fromDrawing: type === 'elbow' || type === 'wye', coneDeg: 20 };
}

interface NodeLike { uid: string; kind: string; x: number; y: number; fitting?: JunctionFitting }
interface PipeLike { uid: string; kind: string; from: string; to: string; diameterMm: number }

function angleBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la === 0 || lb === 0) return 180;
  const c = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

export interface FittingStatus {
  legs: PipeLike[];
  /** Why the fitting has no effect, if so. */
  problem?: string;
  /** Angle used [deg] (elbow deflection or branch angle). */
  angleDeg?: number;
  /** The branch of a tee or wye. */
  branchUid?: string;
}

/** The pipes at a node, and how the fitting reads them. */
export function fittingStatus(node: NodeLike, nodes: readonly NodeLike[], pipes: readonly PipeLike[]): FittingStatus {
  const f = node.fitting;
  const legs = pipes.filter((p) => p.kind === 'pipe' && (p.from === node.uid || p.to === node.uid));
  if (!f || node.kind !== 'junction') return { legs };
  const need = LEG_COUNT[f.type];
  if (legs.length !== need) return { legs, problem: `${JUNCTION_FITTING_LABELS[f.type]} needs ${need} pipes (has ${legs.length})` };
  const at = new Map(nodes.map((n) => [n.uid, n]));
  const vec = (p: PipeLike) => {
    const o = at.get(p.from === node.uid ? p.to : p.from);
    return o ? { x: o.x - node.x, y: o.y - node.y } : { x: 1, y: 0 };
  };
  const v = legs.map(vec);
  if (f.type === 'elbow') return { legs, angleDeg: f.fromDrawing ? 180 - angleBetween(v[0], v[1]) : f.angleDeg };
  if (f.type === 'tee' || f.type === 'wye') {
    let branch = legs.findIndex((p) => p.uid === f.branchUid);
    if (branch < 0) {
      // the two legs most nearly in line are the run
      let best = -1;
      let pair: [number, number] = [0, 1];
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) { const a = angleBetween(v[i], v[j]); if (a > best) { best = a; pair = [i, j]; } }
      branch = 3 - pair[0] - pair[1];
    }
    const run = [0, 1, 2].filter((i) => i !== branch);
    const alpha = f.type === 'tee' ? 90 : f.fromDrawing ? Math.min(angleBetween(v[branch], v[run[0]]), angleBetween(v[branch], v[run[1]])) : f.angleDeg;
    return { legs, angleDeg: alpha, branchUid: legs[branch].uid };
  }
  return { legs };
}

/** Extra loss coefficient to add to each pipe because of the fittings at its end nodes. */
export function junctionLegLosses(nodes: readonly NodeLike[], pipes: readonly PipeLike[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (uid: string, k: number) => out.set(uid, (out.get(uid) ?? 0) + Math.max(0, k));
  for (const node of nodes) {
    const f = node.fitting;
    if (!f || node.kind !== 'junction') continue;
    const st = fittingStatus(node, nodes, pipes);
    if (st.problem || st.legs.length === 0) continue;
    const dmin = Math.min(...st.legs.map((p) => p.diameterMm));
    if (f.type === 'elbow') {
      const k = elbowK(st.angleDeg ?? 90, f.style, dmin);
      st.legs.forEach((p) => add(p.uid, k / 2));
    } else if (f.type === 'tee' || f.type === 'wye') {
      const run = teeRunK(dmin);
      const branch = teeBranchK(st.angleDeg ?? 90, dmin);
      for (const p of st.legs) add(p.uid, p.uid === st.branchUid ? branch - run / 2 : run / 2);
    } else if (f.type === 'cross') {
      st.legs.forEach((p) => add(p.uid, crossLegK(dmin)));
    } else {
      const [a, b] = st.legs;
      if (a.diameterMm === b.diameterMm) continue;
      const small = a.diameterMm < b.diameterMm ? a : b;
      const big = small === a ? b : a;
      // flow runs from the pipe that ends at this node into the pipe that starts there
      const into = a.from === node.uid && b.to === node.uid ? a : b.from === node.uid && a.to === node.uid ? b : undefined;
      const flowIntoSmall = into ? into === small : true;
      add(small.uid, reducerK(small.diameterMm, big.diameterMm, f.coneDeg, flowIntoSmall ? 'contraction' : 'expansion'));
    }
  }
  return out;
}

// ---- valve types

export interface ValveType {
  id: string;
  label: string;
  /** Equivalent length in pipe diameters, fully open. */
  ld: number;
  check?: boolean;
}

export const VALVE_TYPES: readonly ValveType[] = [
  { id: 'gate', label: 'Gate valve', ld: 8 },
  { id: 'globe', label: 'Globe valve', ld: 340 },
  { id: 'angle', label: 'Angle valve', ld: 150 },
  { id: 'ball', label: 'Ball valve', ld: 3 },
  { id: 'butterfly', label: 'Butterfly valve', ld: 40 },
  { id: 'plug', label: 'Plug valve', ld: 18 },
  { id: 'swing-check', label: 'Swing check valve', ld: 100, check: true },
  { id: 'lift-check', label: 'Lift check valve', ld: 600, check: true },
  { id: 'tilting-check', label: 'Tilting-disc check valve', ld: 30, check: true },
  { id: 'stop-check', label: 'Stop-check valve', ld: 400, check: true },
  { id: 'foot', label: 'Foot valve with strainer', ld: 420, check: true },
];

export function valveTypeK(id: string, diameterMm: number): number | undefined {
  const t = VALVE_TYPES.find((v) => v.id === id);
  return t ? t.ld * craneFT(diameterMm) : undefined;
}

// ---- fittings library for the pipe editor

export interface LibraryFitting {
  category: string;
  name: string;
  /** Equivalent length in diameters, or a fixed K. */
  ld?: number;
  k?: number;
}

export const FITTING_LIBRARY: readonly LibraryFitting[] = [
  { category: 'Elbows', name: '90° elbow, standard', ld: 30 },
  { category: 'Elbows', name: '90° elbow, long radius', ld: 20 },
  { category: 'Elbows', name: '90° elbow, mitre', ld: 60 },
  { category: 'Elbows', name: '45° elbow, standard', ld: 16 },
  { category: 'Elbows', name: '45° elbow, mitre', ld: 15 },
  { category: 'Elbows', name: '180° return bend', ld: 50 },
  { category: 'Tees', name: 'Tee, flow through run', ld: 20 },
  { category: 'Tees', name: 'Tee, flow through branch', ld: 60 },
  { category: 'Tees', name: 'Tee, branch to run, flow combining', ld: 60 },
  { category: 'Entrances and exits', name: 'Entrance, sharp-edged', k: 0.5 },
  { category: 'Entrances and exits', name: 'Entrance, slightly rounded', k: 0.25 },
  { category: 'Entrances and exits', name: 'Entrance, well rounded', k: 0.04 },
  { category: 'Entrances and exits', name: 'Entrance, projecting inward', k: 0.78 },
  { category: 'Entrances and exits', name: 'Exit into a tank', k: 1 },
  ...VALVE_TYPES.map((v) => ({ category: 'Valves, fully open', name: v.label, ld: v.ld })),
  { category: 'Other', name: 'Strainer, Y-type', ld: 120 },
  { category: 'Other', name: 'Strainer, basket', k: 2 },
  { category: 'Other', name: 'Expansion joint', k: 0.2 },
  { category: 'Other', name: 'Flow meter, turbine', k: 6 },
  { category: 'Other', name: 'Union or coupling', k: 0.04 },
];

export function fittingK(f: LibraryFitting, diameterMm: number): number {
  return f.k ?? (f.ld ?? 0) * craneFT(diameterMm);
}
