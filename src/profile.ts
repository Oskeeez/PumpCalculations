import { pipeLengthM, type EdgeUI, type HydraulicProject, type NodeUI } from './model';
import type { SystemResult } from './solver/system';

const G = 9.80665;

export interface ProfilePoint {
  node: NodeUI;
  /** Distance along the path [m]. */
  s: number;
  elevationM: number;
  /** Hydraulic grade [m]. */
  hglM: number;
  /** Energy grade: HGL plus the velocity head of the line leaving (or, at the end, entering) the node [m]. */
  eglM: number;
  /** The element from the previous point to this one. */
  via?: EdgeUI;
}

const lengthOf = (p: HydraulicProject, e: EdgeUI) => (e.kind === 'pipe' ? pipeLengthM(p, e) : 0);

/** The shortest path by pipe length between two nodes (any direction), or undefined when they are not connected. */
export function findPath(p: HydraulicProject, fromUid: string, toUid: string): { nodes: NodeUI[]; edges: EdgeUI[] } | undefined {
  const dist = new Map<string, number>([[fromUid, 0]]);
  const prev = new Map<string, { node: string; edge: EdgeUI }>();
  const done = new Set<string>();
  const adj = new Map<string, { to: string; edge: EdgeUI }[]>();
  for (const e of p.edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), { to: e.to, edge: e }]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), { to: e.from, edge: e }]);
  }
  while (true) {
    let u: string | undefined;
    let best = Infinity;
    for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; u = k; }
    if (u === undefined) return undefined;
    if (u === toUid) break;
    done.add(u);
    for (const { to, edge } of adj.get(u) ?? []) {
      const d = best + lengthOf(p, edge) + 1e-6; // the small step prefers fewer elements among equal lengths
      if (d < (dist.get(to) ?? Infinity)) { dist.set(to, d); prev.set(to, { node: u, edge }); }
    }
  }
  const nodes: NodeUI[] = [];
  const edges: EdgeUI[] = [];
  let cur = toUid;
  const at = new Map(p.nodes.map((n) => [n.uid, n]));
  while (cur !== fromUid) {
    const step = prev.get(cur)!;
    nodes.unshift(at.get(cur)!);
    edges.unshift(step.edge);
    cur = step.node;
  }
  nodes.unshift(at.get(fromUid)!);
  return { nodes, edges };
}

/** Elevation, hydraulic grade and energy grade at each node along a path. */
export function profile(p: HydraulicProject, result: SystemResult, path: { nodes: NodeUI[]; edges: EdgeUI[] }): ProfilePoint[] {
  const head = new Map(result.nodes.map((n) => [n.id, n.headM]));
  const velocity = (e: EdgeUI | undefined) => {
    if (!e) return 0;
    if (e.kind === 'pipe') return result.pipes.find((x) => x.id === e.name)?.flow.velocity ?? 0;
    if (e.kind === 'valve') return result.valves.find((x) => x.id === e.name)?.velocity ?? 0;
    return 0;
  };
  let s = 0;
  return path.nodes.map((n, i) => {
    if (i > 0) s += lengthOf(p, path.edges[i - 1]);
    const v = velocity(path.edges[i] ?? path.edges[i - 1]);
    const h = head.get(n.name) ?? NaN;
    return { node: n, s, elevationM: n.elevationM, hglM: h, eglM: h + (v * v) / (2 * G), via: path.edges[i - 1] };
  });
}
