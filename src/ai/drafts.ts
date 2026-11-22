/** Drafts: named copies of the network the AI edits. Creation, diff against the parent, and (partial) merge into main. */
import { newUid, pipeLengthM, uniqueName, type Computed, type EdgeUI, type HydraulicProject, type NodeUI, type ProjectUI } from '../model';
import type { DesignCriteria } from './criteria';
import type { Assumption, ChangeNote, DiffItem, Draft, DraftSource, DraftState, Target } from './types';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const newDraftId = (): string => `d${newUid()}`;
export const newRunId = (): string => `r${newUid()}`;

/** The hydraulic part of a project (no images, scenarios, drafts) plus its targets, deep-copied. */
export function stateOf(p: ProjectUI): DraftState {
  const { scenarios: _s, images: _i, targets, assumptions: _a, drafts: _d, ...rest } = p;
  return { project: clone(rest), targets: clone(targets ?? []) };
}

export interface NewDraftOptions {
  name: string;
  rationale: string;
  source: DraftSource;
  runId?: string;
  /** Start from the parent's content (default) or from an empty network that keeps the parent's fluid and settings. */
  start?: 'copy' | 'empty';
  parent?: Draft;
}

export function createDraft(main: ProjectUI, o: NewDraftOptions): Draft {
  const base = o.parent ? { project: clone(o.parent.project), targets: clone(o.parent.targets) } : stateOf(main);
  const work = clone(base);
  if (o.start === 'empty') {
    work.project.nodes = [];
    work.project.edges = [];
    work.targets = [];
  }
  return {
    id: newDraftId(),
    name: o.name,
    rationale: o.rationale,
    source: o.source,
    runId: o.runId ?? newRunId(),
    createdAt: new Date().toISOString(),
    parentId: o.parent ? o.parent.id : 'main',
    base,
    project: work.project,
    targets: work.targets,
    assumptions: [],
    changes: [],
    status: 'open',
  };
}

// ---------------------------------------------------------------------- diff
const stripPos = (n: NodeUI): Omit<NodeUI, 'x' | 'y'> => {
  const { x: _x, y: _y, ...rest } = n;
  return rest;
};

function fieldDiffs(a: object, b: object): string[] {
  const out: string[] = [];
  const A = a as Record<string, unknown>;
  const B = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (JSON.stringify(A[k]) === JSON.stringify(B[k])) continue;
    const show = (v: unknown) => (Array.isArray(v) ? `[${v.length} items]` : typeof v === 'number' ? String(+v.toPrecision(6)) : JSON.stringify(v));
    out.push(`${k}: ${show(A[k])} → ${show(B[k])}`);
  }
  return out;
}

const SETTINGS = (p: HydraulicProject) => ({ fluid: p.fluid, temperatureC: p.temperatureC, npshMarginM: p.npshMarginM, maxVelocityMps: p.maxVelocityMps, scaleMPerPx: p.scaleMPerPx });

export function edgeLabel(p: HydraulicProject, e: EdgeUI): string {
  const nm = (uid: string) => p.nodes.find((n) => n.uid === uid)?.name ?? '?';
  const what = e.kind === 'valve' && e.lossType === 'orifice' ? 'orifice' : e.kind;
  return `${e.name} (${what}, ${nm(e.from)} → ${nm(e.to)})`;
}

/** Added / removed / modified components, matched by uid. Node position changes alone do not count as modified. */
export function diffStates(base: DraftState, cur: DraftState, changes: ChangeNote[] = []): DiffItem[] {
  const reasons = (key: string) => changes.filter((c) => c.keys.includes(key)).map((c) => c.reason + (c.sideEffects ? ` (side effect: ${c.sideEffects})` : ''));
  const items: DiffItem[] = [];
  const add = (key: string, kind: DiffItem['kind'], type: DiffItem['type'], label: string, details: string[] = []) => items.push({ key, kind, type, label, details, reasons: reasons(key) });

  const bn = new Map(base.project.nodes.map((n) => [n.uid, n]));
  const cn = new Map(cur.project.nodes.map((n) => [n.uid, n]));
  for (const n of cur.project.nodes) {
    const o = bn.get(n.uid);
    if (!o) add(`node:${n.uid}`, 'added', 'node', `${n.kind} ${n.name}`);
    else {
      const d = fieldDiffs(stripPos(o), stripPos(n));
      if (d.length) add(`node:${n.uid}`, 'modified', 'node', `${n.kind} ${n.name}`, d);
    }
  }
  for (const n of base.project.nodes) if (!cn.has(n.uid)) add(`node:${n.uid}`, 'removed', 'node', `${n.kind} ${n.name}`);

  const be = new Map(base.project.edges.map((e) => [e.uid, e]));
  const ce = new Map(cur.project.edges.map((e) => [e.uid, e]));
  for (const e of cur.project.edges) {
    const o = be.get(e.uid);
    if (!o) add(`edge:${e.uid}`, 'added', 'edge', edgeLabel(cur.project, e));
    else {
      const d = fieldDiffs(o, e);
      if (d.length) add(`edge:${e.uid}`, 'modified', 'edge', edgeLabel(cur.project, e), d);
    }
  }
  for (const e of base.project.edges) if (!ce.has(e.uid)) add(`edge:${e.uid}`, 'removed', 'edge', edgeLabel(base.project, e));

  const bt = new Map(base.targets.map((t) => [t.id, t]));
  const ct = new Map(cur.targets.map((t) => [t.id, t]));
  for (const t of cur.targets) {
    const o = bt.get(t.id);
    if (!o) add(`target:${t.id}`, 'added', 'target', `target: ${t.label ?? t.type}`);
    else {
      const d = fieldDiffs(o, t);
      if (d.length) add(`target:${t.id}`, 'modified', 'target', `target: ${t.label ?? t.type}`, d);
    }
  }
  for (const t of base.targets) if (!ct.has(t.id)) add(`target:${t.id}`, 'removed', 'target', `target: ${t.label ?? t.type}`);

  const sd = fieldDiffs(SETTINGS(base.project), SETTINGS(cur.project));
  if (sd.length) add('settings', 'modified', 'settings', 'Fluid and project settings', sd);
  return items;
}

export const diffDraft = (d: Draft): DiffItem[] => diffStates(d.base, { project: d.project, targets: d.targets }, d.changes);

/** Canvas highlighting: uid → kind, plus the removed items (which no longer exist in the draft). */
export function highlightMap(items: DiffItem[]): { marks: Map<string, DiffKind2>; removed: string[] } {
  const marks = new Map<string, DiffKind2>();
  const removed: string[] = [];
  for (const i of items) {
    if (i.type !== 'node' && i.type !== 'edge') continue;
    const uid = i.key.split(':')[1];
    if (i.kind === 'removed') removed.push(uid);
    else marks.set(uid, i.kind);
  }
  return { marks, removed };
}
type DiffKind2 = 'added' | 'modified';

// -------------------------------------------------------------------- merge
export interface MergeResult {
  project: ProjectUI;
  notes: string[];
  applied: string[];
}

/**
 * Apply the draft's changes (base → draft) for the accepted diff keys onto `main`. Edges whose end nodes are missing pull those
 * nodes in from the draft; removing a node removes its edges. Where main changed since the draft was made, the draft's value wins.
 */
export function mergeDraft(main: ProjectUI, draft: Draft, accepted: Set<string> | 'all'): MergeResult {
  const items = diffDraft(draft);
  const take = new Set(accepted === 'all' ? items.map((i) => i.key) : [...accepted].filter((k) => items.some((i) => i.key === k)));
  const notes: string[] = [];
  let nodes = clone(main.nodes);
  let edges = clone(main.edges);
  let targets = clone(main.targets ?? []);
  let settingsPatch: Partial<ProjectUI> = {};
  const dn = new Map(draft.project.nodes.map((n) => [n.uid, n]));
  const de = new Map(draft.project.edges.map((e) => [e.uid, e]));
  const dt = new Map(draft.targets.map((t) => [t.id, t]));

  const putNode = (n: NodeUI, keepPos: boolean) => {
    const i = nodes.findIndex((x) => x.uid === n.uid);
    if (i >= 0) nodes[i] = keepPos ? { ...n, x: nodes[i].x, y: nodes[i].y } : { ...n };
    else {
      let name = n.name;
      if (nodes.some((x) => x.name === name)) {
        name = uniqueName(n.name, nodes.map((x) => x.name));
        notes.push(`Node "${n.name}" was renamed "${name}" because main already has that name.`);
      }
      nodes.push({ ...n, name });
    }
  };
  const putEdge = (e: EdgeUI) => {
    for (const end of [e.from, e.to]) {
      if (!nodes.some((n) => n.uid === end)) {
        const src = dn.get(end);
        if (src) {
          putNode(src, false);
          notes.push(`Node "${src.name}" was also added because "${e.name}" connects to it.`);
        }
      }
    }
    const i = edges.findIndex((x) => x.uid === e.uid);
    if (i >= 0) edges[i] = clone(e);
    else {
      let name = e.name;
      if (edges.some((x) => x.name === name)) {
        name = uniqueName(e.name.replace(/ \d+$/, ''), edges.map((x) => x.name));
        notes.push(`"${e.name}" was renamed "${name}" because main already has that name.`);
      }
      edges.push({ ...clone(e), name });
    }
  };

  for (const it of items) {
    if (!take.has(it.key)) continue;
    const id = it.key.split(':')[1];
    if (it.type === 'node') {
      if (it.kind === 'removed') {
        nodes = nodes.filter((n) => n.uid !== id);
        const gone = edges.filter((e) => e.from === id || e.to === id);
        edges = edges.filter((e) => e.from !== id && e.to !== id);
        if (gone.length) notes.push(`Removing "${it.label}" also removed ${gone.length} connected component(s).`);
      } else {
        const n = dn.get(id);
        if (n) putNode(n, it.kind === 'modified');
      }
    } else if (it.type === 'edge') {
      if (it.kind === 'removed') edges = edges.filter((e) => e.uid !== id);
      else {
        const e = de.get(id);
        if (e) putEdge(e);
      }
    } else if (it.type === 'target') {
      if (it.kind === 'removed') targets = targets.filter((t) => t.id !== id);
      else {
        const t = dt.get(id);
        if (t) targets = [...targets.filter((x) => x.id !== id), clone(t)];
      }
    } else if (it.type === 'settings') {
      const s = SETTINGS(draft.project);
      settingsPatch = { fluid: clone(s.fluid), temperatureC: s.temperatureC, npshMarginM: s.npshMarginM, maxVelocityMps: s.maxVelocityMps, scaleMPerPx: s.scaleMPerPx };
    }
  }
  // drop anything left dangling
  const have = new Set(nodes.map((n) => n.uid));
  const dangling = edges.filter((e) => !have.has(e.from) || !have.has(e.to));
  if (dangling.length) {
    notes.push(`Dropped ${dangling.length} component(s) whose end node was not accepted: ${dangling.map((e) => e.name).join(', ')}.`);
    edges = edges.filter((e) => have.has(e.from) && have.has(e.to));
  }
  const prior = main.assumptions ?? [];
  const extra: Assumption[] = take.size ? draft.assumptions.filter((a) => !prior.some((p) => p.id === a.id)) : [];
  return {
    project: { ...main, ...settingsPatch, nodes, edges, targets, assumptions: [...prior, ...clone(extra)] },
    notes,
    applied: [...take],
  };
}

// --------------------------------------------------------------------- cost
export interface CostBreakdown {
  total: number;
  pipes: number;
  valves: number;
  pumps: number;
  tanks: number;
}

/** Rough installed cost from the rates in the design criteria. For ranking drafts only. */
export function estimateCost(p: HydraulicProject, c: Computed, k: DesignCriteria): CostBreakdown {
  let pipes = 0;
  let valves = 0;
  let pumps = 0;
  for (const e of p.edges) {
    if (e.kind === 'pipe') pipes += pipeLengthM(p, e) * (k.cost.pipePerM.base + k.cost.pipePerM.perMmDiameter * e.diameterMm);
    else if (e.kind === 'valve') {
      const r = e.lossType === 'orifice' ? k.cost.orifice : k.cost.valve;
      valves += r.base + r.perMmDiameter * e.diameterMm;
    } else {
      const kw = c.result?.pumps.find((x) => x.id === e.name)?.shaftPowerW;
      pumps += k.cost.pump.base + k.cost.pump.perKwShaft * ((kw ?? 0) / 1000);
    }
  }
  const tanks = p.nodes.filter((n) => n.kind === 'tank').length * k.cost.tank;
  return { total: pipes + valves + pumps + tanks, pipes, valves, pumps, tanks };
}

export type { Target };
