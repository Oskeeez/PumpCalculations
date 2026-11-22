/**
 * Fitting losses from Crane TP-410 style equivalent lengths (K = L/D x fT) and the usual
 * contraction / expansion relations. Typical values for screening; real fittings vary by maker and size.
 */

/** Crane fully turbulent friction factor for clean commercial steel, by inside diameter [mm]. */
export function craneFT(diameterMm: number): number {
  // upper limit of the inside diameter for each Crane size band: 1/2, 3/4, 1, 1-1/4, 1-1/2, 2, 2-1/2 to 3, 4, 5, 6, 8 to 10, 12 to 16
  const table: [number, number][] = [[18, 0.027], [23.5, 0.025], [30, 0.023], [38, 0.022], [46, 0.021], [57, 0.019], [90, 0.018], [115, 0.017], [141, 0.016], [178, 0.015], [280, 0.014], [420, 0.013]];
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

/** `long` is kept so projects saved with it still open: it reads as a flanged bend with r/D 1.5. */
export type ElbowStyle = 'standard' | 'flanged' | 'mitre' | 'long';

export const ELBOW_STYLES: { id: Exclude<ElbowStyle, 'long'>; label: string }[] = [
  { id: 'standard', label: 'Standard, threaded (r/D = 1)' },
  { id: 'flanged', label: 'Flanged or butt-welded (by r/D)' },
  { id: 'mitre', label: 'Mitre' },
];

/** Crane TP-410 p. A-29: K / fT for a flanged or butt-welded 90 degree bend, by bend radius over diameter. */
export const FLANGED_BEND_NFT: readonly [number, number][] = [[1, 20], [1.5, 14], [2, 12], [3, 12], [4, 14], [6, 17], [8, 24], [10, 30], [12, 34], [14, 38], [16, 42], [20, 50]];

/** Crane TP-410 standard elbows, K / fT by turn angle (45 and 90 degree elbows, 180 degree close-pattern return bend). */
const STANDARD_ELBOW_NFT: [number, number][] = [[0, 0], [45, 16], [90, 30], [180, 50]];
/** Crane TP-410 mitre bends, K / fT by turn angle. */
const MITRE_NFT: [number, number][] = [[0, 0], [15, 4], [30, 8], [45, 15], [60, 25], [75, 40], [90, 60], [180, 90]];

export function flangedBendNft(rOverD: number): number {
  return interpolate(FLANGED_BEND_NFT, Math.max(1, Math.min(20, rOverD)));
}

/** K of an elbow that turns the flow through `deflectionDeg` (90 = a right-angle elbow, 0 = no turn). */
export function elbowK(deflectionDeg: number, style: ElbowStyle, diameterMm: number, rOverD = 1.5): number {
  const d = Math.max(0, Math.min(180, deflectionDeg));
  const fT = craneFT(diameterMm);
  if (style === 'standard') return interpolate(STANDARD_ELBOW_NFT, d) * fT;
  if (style === 'mitre') return interpolate(MITRE_NFT, d) * fT;
  const r = style === 'long' ? 1.5 : rOverD;
  const k90 = flangedBendNft(r) * fT;
  if (d <= 90) return (k90 * d) / 90;
  // Crane: K = (n - 1)(0.25 pi fT r/D + 0.5 K90) + K90, with n the number of 90 degree bends
  const n = d / 90;
  return (n - 1) * (0.25 * Math.PI * fT * r + 0.5 * k90) + k90;
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
  /** Flanged or butt-welded elbow: bend radius over diameter. */
  rOverD?: number;
  /** Own loss values, from the maker or the company library. They replace the calculated ones. */
  override?: { k?: number; runK?: number; branchK?: number };
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
  return { type, style: 'standard', rOverD: 1.5, angleDeg: type === 'elbow' ? 90 : type === 'wye' ? 45 : 90, fromDrawing: type === 'elbow' || type === 'wye', coneDeg: 20 };
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
      const k = f.override?.k ?? elbowK(st.angleDeg ?? 90, f.style, dmin, f.rOverD ?? 1.5);
      st.legs.forEach((p) => add(p.uid, k / 2));
    } else if (f.type === 'tee' || f.type === 'wye') {
      const run = f.override?.runK ?? teeRunK(dmin);
      const branch = f.override?.branchK ?? teeBranchK(st.angleDeg ?? 90, dmin);
      for (const p of st.legs) add(p.uid, p.uid === st.branchUid ? branch - run / 2 : run / 2);
    } else if (f.type === 'cross') {
      st.legs.forEach((p) => add(p.uid, f.override?.k ?? crossLegK(dmin)));
    } else {
      const [a, b] = st.legs;
      if (f.override?.k === undefined && a.diameterMm === b.diameterMm) continue;
      const small = a.diameterMm <= b.diameterMm ? a : b;
      const big = small === a ? b : a;
      // flow runs from the pipe that ends at this node into the pipe that starts there
      const into = a.from === node.uid && b.to === node.uid ? a : b.from === node.uid && a.to === node.uid ? b : undefined;
      const flowIntoSmall = into ? into === small : true;
      add(small.uid, f.override?.k ?? reducerK(small.diameterMm, big.diameterMm, f.coneDeg, flowIntoSmall ? 'contraction' : 'expansion'));
    }
  }
  return out;
}

// ---- valve types

export interface ValveType {
  id: string;
  label: string;
  /** Equivalent length in pipe diameters, fully open. Some depend on the valve size. */
  ld: number | ((diameterMm: number) => number);
  check?: boolean;
  source: string;
}

/** Crane bands the butterfly and tilting-disc values by nominal size: 2-8 in, 10-14 in, 16 in and over. */
const bySize = (small: number, mid: number, large: number) => (d: number) => (d <= 210 ? small : d <= 365 ? mid : large);

const CRANE = 'Crane TP-410, p. A-27 to A-29';

export const VALVE_TYPES: readonly ValveType[] = [
  { id: 'gate', label: 'Gate valve', ld: 8, source: CRANE },
  { id: 'globe', label: 'Globe valve', ld: 340, source: CRANE },
  { id: 'angle', label: 'Angle valve', ld: 150, source: CRANE },
  { id: 'ball', label: 'Ball valve, full bore', ld: 3, source: CRANE },
  { id: 'butterfly', label: 'Butterfly valve', ld: bySize(45, 35, 25), source: CRANE },
  { id: 'plug', label: 'Plug valve, straight-way', ld: 18, source: CRANE },
  { id: 'swing-check', label: 'Swing check valve', ld: 100, check: true, source: CRANE },
  { id: 'lift-check', label: 'Lift check valve (globe type)', ld: 600, check: true, source: CRANE },
  { id: 'tilting-check', label: 'Tilting-disc check valve, 5°', ld: bySize(40, 30, 20), check: true, source: CRANE },
  { id: 'stop-check', label: 'Stop-check valve (globe type)', ld: 400, check: true, source: CRANE },
  { id: 'foot', label: 'Foot valve with strainer, poppet disc', ld: 420, check: true, source: CRANE },
  { id: 'foot-hinged', label: 'Foot valve with strainer, hinged disc', ld: 75, check: true, source: CRANE },
];

const ldOf = (t: { ld: number | ((d: number) => number) }, d: number) => (typeof t.ld === 'function' ? t.ld(d) : t.ld);

export function valveTypeK(id: string, diameterMm: number): number | undefined {
  const t = VALVE_TYPES.find((v) => v.id === id);
  return t ? ldOf(t, diameterMm) * craneFT(diameterMm) : undefined;
}

// ---- fittings library for the pipe editor

export interface LibraryFitting {
  category: string;
  name: string;
  /** Equivalent length in diameters, or a fixed K. */
  ld?: number | ((diameterMm: number) => number);
  k?: number;
  /** Where the value comes from. */
  source: string;
  /** A company entry, imported from a file. */
  custom?: boolean;
}

export const FITTING_LIBRARY: readonly LibraryFitting[] = [
  { category: 'Elbows', name: '90° elbow, standard', ld: 30, source: CRANE },
  ...FLANGED_BEND_NFT.map(([r, n]): LibraryFitting => ({ category: 'Elbows', name: `90° bend, flanged or welded, r/D = ${r}`, ld: n, source: 'Crane TP-410, p. A-29' })),
  { category: 'Elbows', name: '45° elbow, standard', ld: 16, source: CRANE },
  { category: 'Elbows', name: '180° return bend, close pattern', ld: 50, source: CRANE },
  ...MITRE_NFT.filter(([a]) => a > 0 && a < 180).map(([a, n]): LibraryFitting => ({ category: 'Elbows', name: `${a}° mitre bend`, ld: n, source: CRANE })),
  { category: 'Tees', name: 'Tee, flow through run', ld: 20, source: CRANE },
  { category: 'Tees', name: 'Tee, flow through branch', ld: 60, source: CRANE },
  { category: 'Entrances and exits', name: 'Entrance, flush, sharp-edged', k: 0.5, source: CRANE },
  { category: 'Entrances and exits', name: 'Entrance, inward projecting', k: 0.78, source: CRANE },
  { category: 'Entrances and exits', name: 'Entrance, rounded r/d = 0.02', k: 0.28, source: CRANE },
  { category: 'Entrances and exits', name: 'Entrance, rounded r/d = 0.04', k: 0.24, source: CRANE },
  { category: 'Entrances and exits', name: 'Entrance, rounded r/d = 0.06', k: 0.15, source: CRANE },
  { category: 'Entrances and exits', name: 'Entrance, rounded r/d = 0.10', k: 0.09, source: CRANE },
  { category: 'Entrances and exits', name: 'Entrance, rounded r/d 0.15 or more', k: 0.04, source: CRANE },
  { category: 'Entrances and exits', name: 'Exit into a tank or open air', k: 1, source: CRANE },
  ...VALVE_TYPES.map((v): LibraryFitting => ({ category: 'Valves, fully open', name: v.label, ld: v.ld, source: v.source })),
];

export function fittingK(f: LibraryFitting, diameterMm: number): number {
  return f.k ?? (f.ld === undefined ? 0 : ldOf({ ld: f.ld }, diameterMm)) * craneFT(diameterMm);
}
