/** Copy, paste and delete for a group of nodes. Pure functions on the project; the canvas and keyboard handlers call them. */
import { newUid, type EdgeUI, type NodeUI, type ProjectUI } from './model';

export interface Clip {
  nodes: NodeUI[];
  /** Only elements with both ends inside the copied group are kept. */
  edges: EdgeUI[];
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Copy the given nodes and the pipes, valves and pumps between them. Returns undefined for an empty selection. */
export function copyNodes(p: Pick<ProjectUI, 'nodes' | 'edges'>, uids: ReadonlySet<string>): Clip | undefined {
  const nodes = p.nodes.filter((n) => uids.has(n.uid));
  if (!nodes.length) return undefined;
  return { nodes: clone(nodes), edges: clone(p.edges.filter((e) => uids.has(e.from) && uids.has(e.to))) };
}

/** The next free name in the same style: "J1" becomes "J4" if J2 and J3 exist, "Pump suction" becomes "Pump suction 2". */
function nextName(name: string, taken: readonly string[]): string {
  const m = /^(.*?)(\d+)$/.exec(name);
  const base = m ? m[1] : `${name} `;
  let n = m ? Number(m[2]) + 1 : 2;
  while (taken.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/**
 * Paste a copy shifted by `offset` canvas pixels. Everything gets a new uid and a name that is unique in the project.
 * Returns the new project and the uids of the pasted nodes.
 */
export function pasteClip(p: ProjectUI, clip: Clip, offset = { x: 40, y: 40 }): { project: ProjectUI; newNodeUids: string[] } {
  const nodeNames = p.nodes.map((n) => n.name);
  const edgeNames = p.edges.map((e) => e.name);
  const map = new Map<string, string>();
  const nodes = clip.nodes.map((n): NodeUI => {
    const uid = newUid();
    map.set(n.uid, uid);
    const name = nextName(n.name, nodeNames);
    nodeNames.push(name);
    const copy = clone(n);
    if (copy.fitting) copy.fitting = { ...copy.fitting, branchUid: undefined };
    return { ...copy, uid, name, x: n.x + offset.x, y: n.y + offset.y };
  });
  const edges = clip.edges.map((e): EdgeUI => {
    const name = nextName(e.name, edgeNames);
    edgeNames.push(name);
    return { ...clone(e), uid: newUid(), name, from: map.get(e.from) as string, to: map.get(e.to) as string };
  });
  return { project: { ...p, nodes: [...p.nodes, ...nodes], edges: [...p.edges, ...edges] }, newNodeUids: nodes.map((n) => n.uid) };
}

/** Delete nodes and every pipe, valve and pump attached to them. */
export function removeNodes(p: ProjectUI, uids: ReadonlySet<string>): ProjectUI {
  const edges = p.edges.filter((e) => !uids.has(e.from) && !uids.has(e.to));
  const keep = new Set([...p.nodes.filter((n) => !uids.has(n.uid)).map((n) => n.uid), ...edges.map((e) => e.uid)]);
  return { ...p, nodes: p.nodes.filter((n) => !uids.has(n.uid)), edges, locked: p.locked?.filter((u) => keep.has(u)) };
}

/** Move nodes by a canvas offset. */
export function moveNodes(p: ProjectUI, positions: ReadonlyMap<string, { x: number; y: number }>): ProjectUI {
  return { ...p, nodes: p.nodes.map((n) => (positions.has(n.uid) ? { ...n, ...(positions.get(n.uid) as { x: number; y: number }) } : n)) };
}

/** Nodes whose centre lies inside the rectangle spanned by two canvas points. */
export function nodesInRect(nodes: readonly NodeUI[], a: { x: number; y: number }, b: { x: number; y: number }): string[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  return nodes.filter((n) => n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1).map((n) => n.uid);
}
