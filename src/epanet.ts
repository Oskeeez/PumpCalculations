/**
 * EPANET .inp files: read one into a project, and write a project out as one.
 *
 * Read: junctions (with [DEMANDS]), reservoirs, tanks, pipes (open, closed and check-valve pipes), pumps with head curves,
 * valves (PRV, PSV, FCV, TCV; PBV and GPV are read as throttle valves with a note), [STATUS], [CURVES], [COORDINATES], [OPTIONS]
 * units and head-loss formula. Time patterns, controls, rules, water quality and energy are ignored, and listed in the notes.
 * The network is a snapshot at time zero: tanks at their initial level, demand multipliers of 1.
 */
import { DEFAULT_HAZEN_C, blankProject, emitterKv, newUid, outletNames, toSystemModel, type EdgeUI, type NodeUI, type PipeUI, type ProjectUI, type PumpUI, type ValveUI } from './model';
import { valveEquivalentK } from './solver/valve';

const G = 9.80665;
/** EPANET's pressure unit in SI is metres of water; the app stores kPa. Converted with water at 20 degC. */
const RHO_W = 998.2;
const M_TO_KPA = (RHO_W * G) / 1000;
const PSI_TO_KPA = 6.894757;
const FT = 0.3048;
const IN_MM = 25.4;

/** Flow unit -> L/s. */
const FLOW_LPS: Record<string, number> = {
  CFS: 28.316846592, GPM: 0.0630901964, MGD: 43.812636, IMGD: 52.616782, AFD: 14.276410,
  LPS: 1, LPM: 1 / 60, MLD: 11.574074, CMH: 1 / 3.6, CMD: 1 / 86.4,
};
const US_UNITS = new Set(['CFS', 'GPM', 'MGD', 'IMGD', 'AFD']);

export interface InpImport {
  project: ProjectUI;
  notes: string[];
}

interface Section { name: string; rows: string[][] }

function sections(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const m = /^\[([^\]]+)\]/.exec(line);
    if (m) {
      cur = { name: m[1].trim().toUpperCase(), rows: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.rows.push(line.split(/\s+/));
  }
  return out;
}

const num = (s: string | undefined, what: string): number => {
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`${what}: "${s ?? ''}" is not a number.`);
  return v;
};

/** Read an EPANET .inp file. Throws with a readable message if the file cannot be used. */
export function parseInp(text: string): InpImport {
  const secs = sections(text);
  const get = (name: string) => secs.filter((s) => s.name === name).flatMap((s) => s.rows);
  const notes: string[] = [];

  // options
  let flowUnit = 'GPM';
  let headloss = 'H-W';
  for (const r of get('OPTIONS')) {
    const key = r[0].toUpperCase();
    if (key === 'UNITS') flowUnit = (r[1] ?? 'GPM').toUpperCase();
    if (key === 'HEADLOSS') headloss = (r[1] ?? 'H-W').toUpperCase();
    if (key === 'SPECIFIC' && Number(r[2]) !== 1) notes.push(`Specific gravity ${r[2]} is not used: the fluid is water at 20 °C. Change it in the fluid bar if needed.`);
    if (key === 'VISCOSITY' && Number(r[1]) !== 1) notes.push(`Relative viscosity ${r[1]} is not used: the fluid is water at 20 °C.`);
  }
  if (!(flowUnit in FLOW_LPS)) throw new Error(`Unknown flow units "${flowUnit}".`);
  const us = US_UNITS.has(flowUnit);
  const q = FLOW_LPS[flowUnit];
  const len = us ? FT : 1; // length and elevation -> m
  const dia = us ? IN_MM : 1; // diameter -> mm
  const pressKPa = (v: number) => (us ? v * PSI_TO_KPA : v * M_TO_KPA);
  if (headloss === 'C-M') notes.push('Chezy-Manning roughness is not supported: pipes were given Darcy-Weisbach roughness 0.046 mm. Check them.');
  const hw = headloss === 'H-W';

  const p = blankProject();
  if (hw) p.frictionMethod = 'hw';
  const nodes = new Map<string, NodeUI>();
  const addNode = (n: Omit<NodeUI, 'uid' | 'x' | 'y'>) => {
    if (nodes.has(n.name)) throw new Error(`Node "${n.name}" is defined twice.`);
    nodes.set(n.name, { ...n, uid: newUid(), x: NaN, y: NaN });
  };
  for (const r of get('JUNCTIONS')) addNode({ kind: 'junction', name: r[0], elevationM: num(r[1], `Junction ${r[0]} elevation`) * len, levelM: 0, pressureKPa: 101.325, demandLps: (r[2] !== undefined ? num(r[2], `Junction ${r[0]} demand`) : 0) * q });
  for (const r of get('RESERVOIRS')) addNode({ kind: 'tank', name: r[0], elevationM: num(r[1], `Reservoir ${r[0]} head`) * len, levelM: 0, pressureKPa: 101.325, demandLps: 0 });
  for (const r of get('TANKS')) addNode({ kind: 'tank', name: r[0], elevationM: num(r[1], `Tank ${r[0]} elevation`) * len, levelM: num(r[2], `Tank ${r[0]} level`) * len, pressureKPa: 101.325, demandLps: 0 });
  if (get('TANKS').length) notes.push('Tanks are held at their initial level (a single steady-state snapshot).');

  // [DEMANDS] replaces the junction's own demand
  const demands = new Map<string, number>();
  for (const r of get('DEMANDS')) demands.set(r[0], (demands.get(r[0]) ?? 0) + num(r[1], `Demand at ${r[0]}`) * q);
  for (const [id, d] of demands) {
    const n = nodes.get(id);
    if (n) n.demandLps = d;
  }
  if (get('PATTERNS').length) notes.push('Demand and head patterns are ignored: multipliers of 1 are used.');

  // curves
  const curves = new Map<string, { x: number; y: number }[]>();
  for (const r of get('CURVES')) {
    const list = curves.get(r[0]) ?? [];
    list.push({ x: num(r[1], `Curve ${r[0]}`), y: num(r[2], `Curve ${r[0]}`) });
    curves.set(r[0], list);
  }

  const node = (id: string, link: string) => {
    const n = nodes.get(id);
    if (!n) throw new Error(`Link ${link} refers to node "${id}", which is not defined.`);
    return n;
  };
  const edges: EdgeUI[] = [];
  const extraNodes: NodeUI[] = [];
  const valve = (name: string, from: string, to: string, diameterMm: number, patch: Partial<ValveUI>): ValveUI => ({
    kind: 'valve', uid: newUid(), name, from, to, diameterMm, lossType: 'K', lossValue: 0, checkValve: false, open: true, controlType: 'none', controlValue: 200, ...patch,
  });

  for (const r of get('PIPES')) {
    const [id, a, b] = r;
    const from = node(a, id);
    const to = node(b, id);
    const lengthM = num(r[3], `Pipe ${id} length`) * len;
    const diameterMm = num(r[4], `Pipe ${id} diameter`) * dia;
    const rough = num(r[5], `Pipe ${id} roughness`);
    const minor = r[6] !== undefined && !/^(open|closed|cv)$/i.test(r[6]) ? num(r[6], `Pipe ${id} minor loss`) : 0;
    const status = (r.find((x) => /^(open|closed|cv)$/i.test(x)) ?? 'OPEN').toUpperCase();
    const pipe: PipeUI = {
      kind: 'pipe', uid: newUid(), name: id, from: from.uid, to: to.uid, lengthM, lengthMode: 'manual', diameterMm,
      roughnessMm: hw ? 0.046 : headloss === 'D-W' ? (us ? rough * 1e-3 * FT * 1000 : rough) : 0.046,
      fittings: minor > 0 ? [{ name: 'Minor loss', k: minor }] : [],
      ...(hw ? { hazenC: rough > 0 ? rough : DEFAULT_HAZEN_C } : {}),
    };
    if (status === 'CLOSED') {
      edges.push(valve(id, from.uid, to.uid, diameterMm, { open: false }));
    } else if (status === 'CV') {
      // a check-valve pipe: the pipe, then a check valve into the end node
      const mid: NodeUI = { ...to, uid: newUid(), name: `${id}-cv`, kind: 'junction', demandLps: 0, levelM: 0 };
      extraNodes.push(mid);
      edges.push({ ...pipe, to: mid.uid }, valve(`${id} check`, mid.uid, to.uid, diameterMm, { checkValve: true }));
    } else {
      edges.push(pipe);
    }
  }

  for (const r of get('PUMPS')) {
    const [id, a, b, ...rest] = r;
    const from = node(a, id);
    const to = node(b, id);
    const kv = new Map<string, string>();
    for (let i = 0; i + 1 < rest.length; i += 2) kv.set(rest[i].toUpperCase(), rest[i + 1]);
    const curveId = kv.get('HEAD');
    if (!curveId) {
      notes.push(`Pump ${id} is a constant-power pump, which is not supported. It was left out.`);
      continue;
    }
    const pts = curves.get(curveId);
    if (!pts || !pts.length) throw new Error(`Pump ${id} uses curve "${curveId}", which is not defined.`);
    const head = pumpPoints(pts).map((pt) => ({ q: pt.x * q, h: pt.y * len }));
    const pump: PumpUI = { kind: 'pump', uid: newUid(), name: id, from: from.uid, to: to.uid, speedRatio: kv.has('SPEED') ? num(kv.get('SPEED'), `Pump ${id} speed`) : 1, ratedRpm: 1450, head, efficiency: [], npshr: [] };
    if (kv.has('PATTERN')) notes.push(`Pump ${id}: its speed pattern is ignored.`);
    edges.push(pump);
  }

  for (const r of get('VALVES')) {
    const [id, a, b] = r;
    const from = node(a, id);
    const to = node(b, id);
    const diameterMm = num(r[3], `Valve ${id} diameter`) * dia;
    const type = (r[4] ?? '').toUpperCase();
    const setting = r[5];
    const minor = r[6] !== undefined ? num(r[6], `Valve ${id} minor loss`) : 0;
    if (type === 'PRV' || type === 'PSV') edges.push(valve(id, from.uid, to.uid, diameterMm, { lossValue: minor, controlType: type === 'PRV' ? 'prv' : 'psv', controlValue: pressKPa(num(setting, `Valve ${id} setting`)) }));
    else if (type === 'FCV') edges.push(valve(id, from.uid, to.uid, diameterMm, { lossValue: minor, controlType: 'fcv', controlValue: num(setting, `Valve ${id} setting`) * q }));
    else if (type === 'TCV') edges.push(valve(id, from.uid, to.uid, diameterMm, { lossValue: num(setting, `Valve ${id} setting`) }));
    else {
      notes.push(`Valve ${id} is a ${type || 'valve of unknown type'}, which is not supported. It was read as an open throttle valve with K = ${minor}. Check it.`);
      edges.push(valve(id, from.uid, to.uid, diameterMm, { lossValue: minor }));
    }
  }

  // [STATUS] overrides
  for (const r of get('STATUS')) {
    const e = edges.find((x) => x.name === r[0]);
    if (!e) continue;
    const s = (r[1] ?? '').toUpperCase();
    if (s === 'CLOSED') {
      if (e.kind === 'pump') e.running = false;
      else if (e.kind === 'valve') e.open = false;
      else {
        const i = edges.indexOf(e);
        edges[i] = valve(e.name, e.from, e.to, e.diameterMm, { open: false });
      }
    } else if (s === 'OPEN') {
      if (e.kind === 'valve' && e.controlType !== 'none') { e.controlType = 'none'; notes.push(`Valve ${e.name} is fixed open in [STATUS], so it does not regulate.`); }
    } else if (e.kind === 'pump' && Number.isFinite(Number(s))) e.speedRatio = Number(s);
  }

  // emitters: q = C p^0.5 in the file's flow and pressure units
  for (const r of get('EMITTERS')) {
    const n = nodes.get(r[0]);
    const c = num(r[1], `Emitter at ${r[0]}`);
    if (!n || !(c > 0)) continue;
    // to L/min per sqrt(bar): US files are gpm per sqrt(psi) times the flow unit's size in gpm; SI files use metres of water
    n.emitter = us
      ? { k: (c * q) / FLOW_LPS.GPM, unit: 'gpm-psi' }
      : { k: c * q * 60 * Math.sqrt(1e5 / (999 * G)), unit: 'lpm-bar' };
  }
  for (const r of get('OPTIONS')) if (r[0].toUpperCase() === 'EMITTER' && Number(r[2]) !== 0.5) notes.push(`Emitter exponent ${r[2]} is not supported: outlets use 0.5.`);

  for (const name of ['CONTROLS', 'RULES', 'QUALITY', 'REACTIONS', 'SOURCES', 'MIXING', 'ENERGY', 'LABELS', 'BACKDROP', 'TAGS']) {
    if (get(name).length) notes.push(`[${name}] is ignored.`);
  }

  // coordinates: canvas pixels, y downwards, the network fitted into the canvas
  const all = [...nodes.values(), ...extraNodes];
  const coords = new Map<string, { x: number; y: number }>();
  for (const r of get('COORDINATES')) coords.set(r[0], { x: num(r[1], `Coordinates of ${r[0]}`), y: num(r[2], `Coordinates of ${r[0]}`) });
  const known = [...coords.values()];
  const minX = Math.min(...known.map((c) => c.x));
  const maxX = Math.max(...known.map((c) => c.x));
  const minY = Math.min(...known.map((c) => c.y));
  const maxY = Math.max(...known.map((c) => c.y));
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const W = 1400;
  const margin = 80;
  const s = known.length ? (W - 2 * margin) / span : 1;
  let gridI = 0;
  for (const n of all) {
    const c = coords.get(n.name);
    if (c) {
      n.x = margin + (c.x - minX) * s;
      n.y = margin + (maxY - c.y) * s;
    } else if (!extraNodes.includes(n)) {
      n.x = margin + (gridI % 10) * 120;
      n.y = margin + Math.floor(gridI / 10) * 120;
      gridI++;
    }
  }
  // check-valve helper nodes sit just short of their end node
  for (const n of extraNodes) {
    const e = edges.find((x) => x.kind === 'valve' && x.from === n.uid);
    const end = e && all.find((x) => x.uid === e.to);
    const pipe = edges.find((x) => x.to === n.uid);
    const start = pipe && all.find((x) => x.uid === pipe.from);
    if (end && start) {
      n.x = end.x + (start.x - end.x) * 0.15;
      n.y = end.y + (start.y - end.y) * 0.15;
    }
  }
  if (!known.length && all.length) notes.push('The file has no coordinates: nodes were laid out on a grid.');

  p.nodes = all;
  p.edges = edges;
  p.canvasW = Math.max(p.canvasW, W);
  p.canvasH = Math.max(p.canvasH, Math.max(...all.map((n) => n.y)) + margin);
  if (!all.length) throw new Error('The file has no junctions, reservoirs or tanks.');
  return { project: p, notes };
}

/**
 * EPANET's pump curves: one point means shutoff 4/3 H at zero flow and zero head at 2 Q; three points are fitted with
 * h = A - B q^C. Both are returned as points along that curve so the app's quadratic fit follows the same shape.
 */
function pumpPoints(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  if (pts.length === 1) {
    const [{ x: q0, y: h0 }] = pts;
    return [{ x: 0, y: 1.33334 * h0 }, { x: q0, y: h0 }, { x: 2 * q0, y: 0 }]; // EPANET's own shutoff factor
  }
  if (pts.length === 3 && pts[0].x === 0) {
    const [a, b, c] = pts;
    const C = Math.log((a.y - c.y) / (a.y - b.y)) / Math.log(c.x / b.x);
    const B = (a.y - b.y) / b.x ** C;
    if (Number.isFinite(C) && Number.isFinite(B) && C > 0) {
      const qmax = (a.y / B) ** (1 / C);
      const out: { x: number; y: number }[] = [];
      for (let i = 0; i <= 8; i++) {
        const x = (qmax * i) / 8;
        out.push({ x, y: Math.max(0, a.y - B * x ** C) });
      }
      return out;
    }
  }
  return pts;
}

/** Write the project as an EPANET .inp file (SI units: L/s, m, mm). Fitting losses, including junction fittings, become minor losses. */
export function toInp(project: ProjectUI, title = 'Exported from the pipe network calculator'): { text: string; notes: string[] } {
  const model = toSystemModel(project);
  const notes: string[] = [];
  const hw = project.frictionMethod === 'hw';
  const rho = model.fluid.density;
  const byName = new Map(project.edges.map((e) => [e.name, e]));
  const id = (s: string) => s.replace(/\s+/g, '_').replace(/;/g, ',');
  const f = (v: number, d = 4) => String(+v.toFixed(d));
  const L: string[] = [`[TITLE]`, title, ''];
  const outlets = new Set(project.nodes.filter((n) => n.kind === 'junction' && n.emitter).flatMap((n) => [outletNames(n.name).valve, outletNames(n.name).sink]));

  L.push('[JUNCTIONS]', ';ID  Elev(m)  Demand(L/s)');
  for (const n of model.nodes) if (n.kind === 'junction') L.push(` ${id(n.id)} ${f(n.elevationM)} ${f(n.demandM3s * 1000, 6)}`);
  L.push('', '[RESERVOIRS]', ';ID  Head(m)');
  for (const n of model.nodes) {
    if (n.kind !== 'tank' || outlets.has(n.id)) continue;
    const head = n.elevationM + n.liquidLevelM + (n.surfacePressurePa - 101325) / (rho * G);
    L.push(` ${id(n.id)} ${f(head)}`);
  }
  if (model.nodes.some((n) => n.kind === 'tank')) notes.push('Tanks are written as reservoirs (fixed head), which is how this app treats them.');

  const pipes: string[] = [];
  const pumps: string[] = [];
  const valves: string[] = [];
  const status: string[] = [];
  const curves: string[] = [];
  for (const e of model.edges) {
    if (outlets.has(e.id)) continue;
    const ui = byName.get(e.id);
    if (e.kind === 'pipe') {
      const k = e.spec.fittingsK.reduce((s, x) => s + x, 0);
      const rough = hw ? (e.spec.hazenC ?? DEFAULT_HAZEN_C) : e.spec.roughnessM * 1000;
      pipes.push(` ${id(e.id)} ${id(e.from)} ${id(e.to)} ${f(e.spec.lengthM, 3)} ${f(e.spec.innerDiameterM * 1000, 3)} ${f(rough, 5)} ${f(k, 4)} Open`);
    } else if (e.kind === 'pump') {
      const h = e.model.head;
      // points along the fitted curve, from zero flow to where the head reaches zero
      const qMax = h.a2 < 0 ? (-h.a1 - Math.sqrt(h.a1 * h.a1 - 4 * h.a2 * h.a0)) / (2 * h.a2) : e.model.headDataRange.maxFlowM3s * 1.2;
      const cid = `C_${id(e.id)}`;
      for (let i = 0; i <= 8; i++) {
        const qq = (Math.max(qMax, 1e-6) * i) / 8;
        curves.push(` ${cid} ${f(qq * 1000, 5)} ${f(Math.max(0, h.a0 + h.a1 * qq + h.a2 * qq * qq), 4)}`);
      }
      pumps.push(` ${id(e.id)} ${id(e.from)} ${id(e.to)} HEAD ${cid} SPEED ${f(e.speedRatio, 4)}`);
      if (e.running === false) status.push(` ${id(e.id)} Closed`);
      if (ui?.kind === 'pump' && ui.control) notes.push(`Pump ${e.id}: speed control is not written; it runs at the speed last solved here.`);
    } else {
      const s = e.spec;
      const d = s.diameterM * 1000;
      const k = valveEquivalentK(s);
      if (s.checkValve && !s.control) {
        pipes.push(` ${id(e.id)} ${id(e.from)} ${id(e.to)} 0.01 ${f(d, 3)} ${hw ? 150 : 0.0015} ${f(k, 4)} CV`);
      } else if (s.control?.type === 'prv' || s.control?.type === 'psv') {
        valves.push(` ${id(e.id)} ${id(e.from)} ${id(e.to)} ${f(d, 3)} ${s.control.type.toUpperCase()} ${f(s.control.setpointPa / (rho * G), 4)} ${f(k, 4)}`);
      } else if (s.control?.type === 'fcv') {
        valves.push(` ${id(e.id)} ${id(e.from)} ${id(e.to)} ${f(d, 3)} FCV ${f(s.control.flowM3s * 1000, 5)} ${f(k, 4)}`);
      } else {
        valves.push(` ${id(e.id)} ${id(e.from)} ${id(e.to)} ${f(d, 3)} TCV ${f(k, 5)} 0`);
      }
      if (!s.open) status.push(` ${id(e.id)} Closed`);
    }
  }
  L.push('', '[PIPES]', ';ID  Node1  Node2  Length(m)  Diameter(mm)  Roughness  MinorLoss  Status', ...pipes);
  L.push('', '[PUMPS]', ';ID  Node1  Node2  Parameters', ...pumps);
  L.push('', '[VALVES]', ';ID  Node1  Node2  Diameter(mm)  Type  Setting  MinorLoss', ...valves);
  L.push('', '[STATUS]', ...status);
  L.push('', '[CURVES]', ';ID  Flow(L/s)  Head(m)', ...curves);
  // outlets: EPANET emitter coefficient in L/s per sqrt(m of water)
  L.push('', '[EMITTERS]', ';Node  Coefficient(L/s per m^0.5)');
  for (const n of project.nodes) if (n.kind === 'junction' && n.emitter) L.push(` ${id(n.name)} ${f((emitterKv(n.emitter) / 3.6) / Math.sqrt(1e5 / (999 * G)), 6)}`);
  if (project.nodes.some((n) => n.fixedPressureKPaG !== undefined)) notes.push('Fixed-pressure nodes are written as reservoirs.');
  L.push('', '[OPTIONS]', ' Units LPS', ` Headloss ${hw ? 'H-W' : 'D-W'}`, ` Specific Gravity ${f(rho / RHO_W, 4)}`, ` Viscosity ${f(model.fluid.dynamicViscosity / rho / 1.022e-6, 4)}`, ' Trials 200', ' Accuracy 0.00001');
  L.push('', '[TIMES]', ' Duration 0');
  const scale = project.scaleMPerPx;
  L.push('', '[COORDINATES]', ';Node  X(m)  Y(m)');
  for (const n of project.nodes) L.push(` ${id(n.name)} ${f(n.x * scale, 3)} ${f(-n.y * scale, 3)}`);
  L.push('', '[END]', '');
  return { text: L.join('\n'), notes };
}
