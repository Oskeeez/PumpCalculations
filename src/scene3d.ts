/** Scene description for the 3D view: world (X east, Y north, Z up) coordinates of every node and element. */
import { nodeWorld, type World } from './geometry';
import { pipeLengthM, type ProjectUI } from './model';
import type { SystemResult } from './solver';

export interface SceneNode {
  uid: string;
  name: string;
  kind: 'tank' | 'junction';
  pos: World;
  /** Tanks: fluid height above the base [m]. */
  fluidHeightM: number;
  /** Tanks: z of the fluid surface [m]. */
  surfaceZ: number;
}

export interface SceneEdge {
  uid: string;
  name: string;
  kind: 'pipe' | 'valve' | 'pump';
  fromName: string;
  toName: string;
  a: World;
  b: World;
  /** Straight-line distance between the end points [m]. */
  straightM: number;
  /** Hydraulic length [m] (pipes only). */
  lengthM?: number;
  diameterM: number;
  velocity?: number;
  flowM3s?: number;
  /** Valves: false when closed. */
  open?: boolean;
}

export interface Scene3D {
  nodes: SceneNode[];
  edges: SceneEdge[];
  min: World;
  max: World;
}

const dist = (a: World, b: World) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

export function buildScene(p: ProjectUI, result?: SystemResult): Scene3D {
  const s = p.scaleMPerPx;
  const nodes: SceneNode[] = p.nodes.map((n) => {
    const pos = nodeWorld(n, s, p.canvasH);
    const fluid = n.kind === 'tank' ? n.levelM : 0;
    return { uid: n.uid, name: n.name, kind: n.kind, pos, fluidHeightM: fluid, surfaceZ: pos.z + fluid };
  });
  const byUid = new Map(nodes.map((n) => [n.uid, n]));
  const edges: SceneEdge[] = [];
  for (const e of p.edges) {
    const a = byUid.get(e.from);
    const b = byUid.get(e.to);
    if (!a || !b) continue;
    const res = e.kind === 'pipe' ? result?.pipes.find((x) => x.id === e.name) : e.kind === 'valve' ? result?.valves.find((x) => x.id === e.name) : result?.pumps.find((x) => x.id === e.name);
    edges.push({
      uid: e.uid,
      name: e.name,
      kind: e.kind,
      fromName: a.name,
      toName: b.name,
      a: a.pos,
      b: b.pos,
      straightM: dist(a.pos, b.pos),
      lengthM: e.kind === 'pipe' ? pipeLengthM(p, e) : undefined,
      diameterM: (e.kind === 'pump' ? 0 : e.diameterMm) / 1000,
      velocity: res && 'flow' in res ? res.flow.velocity : res && 'velocity' in res ? res.velocity : undefined,
      flowM3s: res?.flowM3s,
      open: e.kind === 'valve' ? e.open : undefined,
    });
  }
  const pts = [...nodes.map((n) => n.pos), ...nodes.filter((n) => n.kind === 'tank').map((n) => ({ ...n.pos, z: n.surfaceZ }))];
  const min = { x: Math.min(...pts.map((q) => q.x)), y: Math.min(...pts.map((q) => q.y)), z: Math.min(...pts.map((q) => q.z)) };
  const max = { x: Math.max(...pts.map((q) => q.x)), y: Math.max(...pts.map((q) => q.y)), z: Math.max(...pts.map((q) => q.z)) };
  return nodes.length ? { nodes, edges, min, max } : { nodes, edges, min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
}
