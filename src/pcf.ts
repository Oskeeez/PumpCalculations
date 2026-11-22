/**
 * Piping Component Files (.pcf, the Alias ISOGEN format written by most plant design tools: SmartPlant 3D, CADWorx,
 * AutoCAD Plant 3D, PDMS / E3D and others).
 *
 * Each component lists its end points in 3D. Points that coincide become nodes. Pipes and flanges become pipes, elbows and
 * bends become elbow junctions, tees and olets tee junctions, crosses cross junctions, reducers a reducer junction between two
 * pipes, and valves valves. Elevation is the Z (up) coordinate. The file has no boundary conditions, so the network still needs
 * tanks or demands added before it solves.
 */
import { defaultFitting, type ElbowStyle } from './fittings';
import { SCH40 } from './library';
import { blankProject, newUid, type EdgeUI, type NodeUI, type PipeUI, type ProjectUI, type ValveUI } from './model';
import { VALVE_TYPES, valveTypeK } from './fittings';

type P3 = [number, number, number];

interface Component {
  type: string;
  ends: { p: P3; bore: number }[];
  centre?: P3;
  branches: { p: P3; bore: number }[];
  attrs: Map<string, string>;
  line: number;
}

export interface PcfImport {
  project: ProjectUI;
  notes: string[];
}

/** Nominal bore [mm] -> Schedule 40 inside diameter [mm]. */
const DN_TO_NPS: Record<number, string> = { 15: '1/2"', 20: '3/4"', 25: '1"', 32: '1-1/4"', 40: '1-1/2"', 50: '2"', 65: '2-1/2"', 80: '3"', 100: '4"', 125: '5"', 150: '6"', 200: '8"', 250: '10"', 300: '12"' };

function insideDiameter(boreMm: number): number {
  const dn = Object.keys(DN_TO_NPS).map(Number).find((d) => Math.abs(d - boreMm) / d < 0.05);
  const nps = dn !== undefined ? DN_TO_NPS[dn] : undefined;
  return SCH40.find((s) => s.nps === nps)?.idMm ?? boreMm;
}

const dist = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function angleDeg(u: P3, v: P3): number {
  const lu = Math.hypot(...u);
  const lv = Math.hypot(...v);
  if (!lu || !lv) return 0;
  const c = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Read a PCF file. Throws with a readable message if nothing usable is found. */
export function parsePcf(text: string): PcfImport {
  const notes: string[] = [];
  let coordScale = 1; // to mm
  let boreScale = 1;
  const comps: Component[] = [];
  let cur: Component | undefined;
  const skipped = new Map<string, number>();
  const plain = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  const point = (parts: string[], li: number): P3 => {
    const v = parts.slice(1, 4).map(Number);
    if (v.length < 3 || v.some((x) => !Number.isFinite(x))) throw new Error(`Line ${li + 1}: "${parts.join(' ')}" does not have three coordinates.`);
    return [v[0] * coordScale, v[1] * coordScale, v[2] * coordScale];
  };
  const bore = (parts: string[]) => {
    const b = Number(parts[4]);
    return Number.isFinite(b) ? b * boreScale : NaN;
  };
  lines.forEach((raw, li) => {
    if (!raw.trim()) return;
    const indented = /^\s/.test(raw);
    const parts = raw.trim().split(/\s+/);
    const key = parts[0].toUpperCase();
    if (!indented) {
      if (key === 'UNITS-CO-ORDS') coordScale = /INCH/i.test(parts[1] ?? '') ? 25.4 : 1;
      else if (key === 'UNITS-BORE') boreScale = /INCH/i.test(parts[1] ?? '') ? 25.4 : 1;
      cur = { type: key, ends: [], branches: [], attrs: new Map(), line: li + 1 };
      comps.push(cur);
      return;
    }
    if (!cur) return;
    if (key === 'END-POINT') cur.ends.push({ p: point(parts, li), bore: bore(parts) });
    else if (key === 'CENTRE-POINT' || key === 'CENTER-POINT') cur.centre = point(parts, li);
    else if (/^BRANCH\d?-POINT$/.test(key)) cur.branches.push({ p: point(parts, li), bore: bore(parts) });
    else cur.attrs.set(key, parts.slice(1).join(' '));
  });

  // nodes at coincident points (within 1 mm)
  const nodes: { p: P3; node: NodeUI }[] = [];
  const nodeAt = (p: P3): NodeUI => {
    const hit = nodes.find((n) => dist(n.p, p) < 1);
    if (hit) return hit.node;
    const node: NodeUI = { uid: newUid(), kind: 'junction', name: `N${nodes.length + 1}`, x: 0, y: 0, elevationM: p[2] / 1000, levelM: 0, pressureKPa: 101.325, demandLps: 0 };
    nodes.push({ p, node });
    return node;
  };
  const edges: EdgeUI[] = [];
  const count = new Map<string, number>();
  const nextName = (base: string) => {
    const n = (count.get(base) ?? 0) + 1;
    count.set(base, n);
    return `${base} ${n}`;
  };
  const pipe = (a: { p: P3; bore: number }, b: { p: P3; bore: number }, boreMm: number): PipeUI => ({
    kind: 'pipe', uid: newUid(), name: nextName('Pipe'), from: nodeAt(a.p).uid, to: nodeAt(b.p).uid,
    lengthM: dist(a.p, b.p) / 1000, lengthMode: 'manual', diameterMm: insideDiameter(boreMm), roughnessMm: 0.046, fittings: [],
  });
  const fit = (node: NodeUI, f: NodeUI['fitting'], base: string) => {
    node.fitting = f;
    node.name = nextName(base);
  };
  let nominalUsed = false;

  for (const c of comps) {
    const b0 = c.ends[0]?.bore;
    const boreOf = (x: { bore: number }) => (Number.isFinite(x.bore) ? x.bore : Number.isFinite(b0) ? b0 : 100);
    switch (c.type) {
      case 'PIPE':
      case 'FLANGE':
      case 'FLANGE-BLIND':
      case 'COUPLING':
      case 'UNION':
      case 'INSTRUMENT':
      case 'FILTER':
      case 'MISC-COMPONENT': {
        if (c.ends.length < 2) break;
        if (dist(c.ends[0].p, c.ends[1].p) < 1) { nodeAt(c.ends[0].p); break; }
        edges.push(pipe(c.ends[0], c.ends[1], boreOf(c.ends[0])));
        nominalUsed = true;
        if (c.type === 'INSTRUMENT' || c.type === 'FILTER' || c.type === 'MISC-COMPONENT') plain.set(c.type, (plain.get(c.type) ?? 0) + 1);
        break;
      }
      case 'ELBOW':
      case 'BEND': {
        if (c.ends.length < 2 || !c.centre) break;
        const centre = nodeAt(c.centre);
        const turn = 180 - angleDeg(sub(c.ends[0].p, c.centre), sub(c.ends[1].p, c.centre));
        const skey = (c.attrs.get('SKEY') ?? '').toUpperCase();
        const style: ElbowStyle = /SC|SW|THD|SCRD/.test(skey) ? 'standard' : 'flanged';
        const f = { ...defaultFitting('elbow'), style, fromDrawing: false, angleDeg: Math.round(turn * 10) / 10 };
        // a bend's radius is the distance from the end to the centre point; elbows are taken as long radius
        if (c.type === 'BEND') f.rOverD = Math.max(1, Math.min(20, Math.round(dist(c.ends[0].p, c.centre) / Math.max(boreOf(c.ends[0]), 1))));
        fit(centre, f, c.type === 'BEND' ? 'Bend' : 'Elbow');
        edges.push(pipe(c.ends[0], { p: c.centre, bore: c.ends[0].bore }, boreOf(c.ends[0])), pipe({ p: c.centre, bore: c.ends[1].bore }, c.ends[1], boreOf(c.ends[1])));
        break;
      }
      case 'TEE':
      case 'TEE-STUB':
      case 'TEE-SET-ON':
      case 'OLET':
      case 'CROSS': {
        if (!c.centre) break;
        const centre = nodeAt(c.centre);
        const legs = [...c.ends, ...c.branches];
        const made = legs.filter((l) => dist(l.p, c.centre as P3) >= 1).map((l) => pipe(l, { p: c.centre as P3, bore: l.bore }, boreOf(l)));
        edges.push(...made);
        if (c.type === 'CROSS') fit(centre, defaultFitting('cross'), 'Cross');
        else {
          const branch = made[made.length - 1];
          const f = { ...defaultFitting('tee'), branchUid: c.branches.length ? branch?.uid : undefined };
          fit(centre, f, 'Tee');
        }
        break;
      }
      case 'REDUCER-CONCENTRIC':
      case 'REDUCER-ECCENTRIC': {
        if (c.ends.length < 2) break;
        const [a, b] = c.ends;
        const mid: P3 = [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (a.p[2] + b.p[2]) / 2];
        const m = nodeAt(mid);
        const L = dist(a.p, b.p);
        const cone = L > 0 ? Math.min(180, Math.max(1, (2 * Math.atan(Math.abs(boreOf(a) - boreOf(b)) / 2 / L) * 180) / Math.PI)) : 180;
        fit(m, { ...defaultFitting('reducer'), coneDeg: Math.round(cone) }, 'Reducer');
        edges.push(pipe(a, { p: mid, bore: a.bore }, boreOf(a)), pipe({ p: mid, bore: b.bore }, b, boreOf(b)));
        break;
      }
      case 'VALVE':
      case 'VALVE-ANGLE':
      case 'VALVE-3WAY': {
        if (c.ends.length < 2) break;
        const desc = `${c.attrs.get('ITEM-DESCRIPTION') ?? ''} ${c.attrs.get('SKEY') ?? ''} ${c.attrs.get('ITEM-CODE') ?? ''}`.toLowerCase();
        const kind = /check|non.?return|\bck/.test(desc) ? 'swing-check' : /globe/.test(desc) ? 'globe' : /butterfly|\bbf/.test(desc) ? 'butterfly' : /ball/.test(desc) ? 'ball' : /plug/.test(desc) ? 'plug' : c.type === 'VALVE-ANGLE' ? 'angle' : 'gate';
        const t = VALVE_TYPES.find((v) => v.id === kind)!;
        const d = insideDiameter(boreOf(c.ends[0]));
        const v: ValveUI = {
          kind: 'valve', uid: newUid(), name: nextName('Valve'), from: nodeAt(c.ends[0].p).uid, to: nodeAt(c.ends[1].p).uid, diameterMm: d,
          lossType: 'K', lossValue: valveTypeK(kind, d) ?? 0.15, valveType: kind, checkValve: !!t.check, open: true, controlType: 'none', controlValue: 200,
        };
        edges.push(v);
        if (c.type === 'VALVE-3WAY') notes.push(`Line ${c.line}: a three-way valve was read as a two-way ${t.label.toLowerCase()}.`);
        break;
      }
      case 'GASKET':
      case 'WELD':
      case 'BOLT':
      case 'SUPPORT':
      case 'CAP':
        for (const e of c.ends) nodeAt(e.p);
        break;
      default:
        if (c.ends.length || c.centre) skipped.set(c.type, (skipped.get(c.type) ?? 0) + 1);
    }
  }
  if (!edges.length) throw new Error('No pipes, fittings or valves were found in this file.');

  // remove zero-length pipes from gaskets, welds and flanges meeting at a point
  const kept = edges.filter((e) => e.from !== e.to);

  // canvas: plan view, east to the right and north up
  const all = nodes.filter((n) => kept.some((e) => e.from === n.node.uid || e.to === n.node.uid));
  const xs = all.map((n) => n.p[0]);
  const ys = all.map((n) => n.p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const W = 1400;
  const margin = 80;
  const s = (W - 2 * margin) / span;
  for (const n of all) {
    n.node.x = margin + (n.p[0] - Math.min(...xs)) * s;
    n.node.y = margin + (Math.max(...ys) - n.p[1]) * s;
  }
  const p = blankProject();
  p.nodes = all.map((n) => n.node);
  p.edges = kept;
  p.scaleMPerPx = span / 1000 / (W - 2 * margin);
  p.canvasW = W;
  p.canvasH = Math.max(p.canvasH, Math.max(...p.nodes.map((n) => n.y)) + margin);

  const openEnds = p.nodes.filter((n) => kept.filter((e) => e.from === n.uid || e.to === n.uid).length === 1);
  if (nominalUsed) notes.push('Bores in the file are nominal sizes; inside diameters were taken from Schedule 40 where the size matched. Check the pipe specification.');
  notes.push(`${openEnds.length} open end${openEnds.length === 1 ? '' : 's'}. Add tanks or demands at them before solving.`);
  for (const [k, n] of plain) notes.push(`${n} × ${k} read as plain pipe, with no loss. Add its loss as a fitting.`);
  for (const [k, n] of skipped) notes.push(`${n} × ${k} not used.`);
  return { project: p, notes };
}
