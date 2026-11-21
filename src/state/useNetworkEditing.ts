import type { ConnectKind, Selection } from '../components/Canvas';
import {
  connectBlank,
  connectToNewNode,
  insertOnPipe,
  makeEdge,
  newNode,
  placeStandalone,
  type EdgeUI,
  type FluidUI,
  type InsertKind,
  type NodeKind,
  type NodeUI,
  type PipeUI,
  type ProjectUI,
} from '../model';
import type { Message, SetProject } from './types';

type Point = { x: number; y: number };

/** The ways the user changes the network on the canvas or in the editors. Each one updates the project and the selection. */
export function useNetworkEditing(project: ProjectUI, setProject: SetProject, selection: Selection, setSelection: (s: Selection) => void, setMessage: (m: Message | undefined) => void) {
  const fail = (err: unknown) => setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
  const selectEdge = (uid: string) => setSelection({ type: 'edge', uid });
  /** Diameter of the pipe at a node, for new valves and orifices that start there. */
  const diameterAt = (nodeUid: string) => (project.edges.find((e) => e.kind === 'pipe' && (e.from === nodeUid || e.to === nodeUid)) as PipeUI | undefined)?.diameterMm ?? 102.26;

  const addNode = (kind: NodeKind, x: number, y: number) => {
    const n = newNode(kind, x, y, project.nodes.map((q) => q.name));
    setProject((p) => ({ ...p, nodes: [...p.nodes, n] }));
    setSelection({ type: 'node', uid: n.uid });
  };
  const connect = (kind: ConnectKind, from: string, to: string) => {
    const e = makeEdge(kind, from, to, project.edges.map((q) => q.name), diameterAt(from));
    setProject((p) => ({ ...p, edges: [...p.edges, e] }));
    selectEdge(e.uid);
  };
  const insertInto = (kind: InsertKind, pipeUid: string, x: number, y: number) => {
    try {
      const r = insertOnPipe(project, pipeUid, kind, x, y);
      setProject(r.project);
      setSelection({ type: kind === 'junction' || kind === 'tank' ? 'node' : 'edge', uid: r.selectUid });
      setMessage(undefined);
    } catch (err) {
      fail(err);
    }
  };
  const connectNew = (kind: ConnectKind, from: string, x: number, y: number) => {
    try {
      const r = connectToNewNode(project, kind, from, x, y, diameterAt(from));
      setProject(r.project);
      selectEdge(r.selectUid);
    } catch (err) {
      fail(err);
    }
  };
  const connectBlankDrag = (kind: ConnectKind, a: Point, b: Point | { uid: string }) => {
    try {
      const r = connectBlank(project, kind, a, b);
      setProject(r.project);
      selectEdge(r.selectUid);
    } catch (err) {
      fail(err);
    }
  };
  const placeAlone = (kind: 'pump' | 'valve' | 'orifice', x: number, y: number) => {
    const r = placeStandalone(project, kind, x, y);
    setProject(r.project);
    selectEdge(r.selectUid);
    setMessage(undefined);
  };

  const reverseEdge = (uid: string) => setProject((p) => ({ ...p, edges: p.edges.map((e) => (e.uid === uid ? { ...e, from: e.to, to: e.from } : e)) }), `edge:${uid}`);
  const moveNode = (uid: string, x: number, y: number) => setProject((p) => ({ ...p, nodes: p.nodes.map((n) => (n.uid === uid ? { ...n, x, y } : n)) }), `drag:${uid}`);
  const updateNode = (n: NodeUI) => setProject((p) => ({ ...p, nodes: p.nodes.map((q) => (q.uid === n.uid ? n : q)) }), `node:${n.uid}`);
  const updateEdge = (e: EdgeUI) => setProject((p) => ({ ...p, edges: p.edges.map((q) => (q.uid === e.uid ? e : q)) }), `edge:${e.uid}`);
  const updateFluid = (patch: Partial<FluidUI>) => setProject((p) => ({ ...p, fluid: { ...p.fluid, ...patch } }), 'fluid');

  const deleteSelected = () => {
    if (!selection) return;
    setProject((p) =>
      selection.type === 'node'
        ? { ...p, nodes: p.nodes.filter((n) => n.uid !== selection.uid), edges: p.edges.filter((e) => e.from !== selection.uid && e.to !== selection.uid) }
        : { ...p, edges: p.edges.filter((e) => e.uid !== selection.uid) },
    );
    setSelection(null);
  };

  return { addNode, connect, insertInto, connectNew, connectBlankDrag, placeAlone, reverseEdge, moveNode, updateNode, updateEdge, updateFluid, deleteSelected };
}
