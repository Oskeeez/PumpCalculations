import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { NodeKind, NodeUI, ProjectUI } from '../model';
import type { SystemResult } from '../solver';
import { useUnits } from '../units';

export type Tool = 'select' | 'tank' | 'junction' | 'pipe' | 'pump' | 'valve';
export type Selection = { type: 'node' | 'edge'; uid: string } | null;

export const CANVAS_W = 1100;
export const CANVAS_H = 620;
const GRID = 10;

interface Props {
  project: ProjectUI;
  result?: SystemResult;
  selection: Selection;
  tool: Tool;
  pending?: string;
  onSelect: (s: Selection) => void;
  onAddNode: (kind: NodeKind, x: number, y: number) => void;
  onMoveNode: (uid: string, x: number, y: number) => void;
  onConnect: (kind: 'pipe' | 'pump' | 'valve', from: string, to: string) => void;
  onPending: (uid: string | undefined) => void;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;

/** Interactive network canvas: place tanks/junctions, connect with pipes/pumps, drag to rearrange. */
export function Canvas({ project, result, selection, tool, pending, onSelect, onAddNode, onMoveNode, onConnect, onPending }: Props) {
  const U = useUnits();
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ uid: string; dx: number; dy: number } | null>(null);
  const nodeById = new Map(project.nodes.map((n) => [n.uid, n]));

  const toSvg = (e: { clientX: number; clientY: number }) => {
    const r = (svgRef.current as SVGSVGElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) * CANVAS_W) / r.width, y: ((e.clientY - r.top) * CANVAS_H) / r.height };
  };

  const onBackgroundDown = (e: RPointerEvent) => {
    const p = toSvg(e);
    if (tool === 'tank' || tool === 'junction') onAddNode(tool, snap(p.x), snap(p.y));
    else if (tool === 'select') onSelect(null);
    else onPending(undefined);
  };

  const onNodeDown = (e: RPointerEvent, n: NodeUI) => {
    e.stopPropagation();
    if (tool === 'select') {
      onSelect({ type: 'node', uid: n.uid });
      const p = toSvg(e);
      setDrag({ uid: n.uid, dx: n.x - p.x, dy: n.y - p.y });
      svgRef.current?.setPointerCapture(e.pointerId);
    } else if (tool === 'pipe' || tool === 'pump' || tool === 'valve') {
      if (!pending) onPending(n.uid);
      else if (pending !== n.uid) {
        onConnect(tool, pending, n.uid);
        onPending(undefined);
      }
    }
  };

  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    const p = toSvg(e);
    onMoveNode(drag.uid, Math.max(30, Math.min(CANVAS_W - 30, snap(p.x + drag.dx))), Math.max(30, Math.min(CANVAS_H - 40, snap(p.y + drag.dy))));
  };

  // Parallel edges between the same two nodes are fanned out.
  const pairCount = new Map<string, number>();
  const pairIndex = new Map<string, number>();
  for (const e of project.edges) {
    const key = [e.from, e.to].sort().join('|');
    pairIndex.set(e.uid, pairCount.get(key) ?? 0);
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }

  const edgeEls = project.edges.map((e) => {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) return null;
    const key = [e.from, e.to].sort().join('|');
    const n = pairCount.get(key) ?? 1;
    const off = ((pairIndex.get(e.uid) ?? 0) - (n - 1) / 2) * 46;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // normal oriented consistently regardless of edge direction so fanned edges separate
    const sgn = e.from < e.to ? 1 : -1;
    const nx = (-dy / len) * sgn;
    const ny = (dx / len) * sgn;
    const cx = (a.x + b.x) / 2 + nx * off * 2;
    const cy = (a.y + b.y) / 2 + ny * off * 2;
    const mx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x;
    const my = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const pr = e.kind === 'pipe' ? result?.pipes.find((x) => x.id === e.name) : e.kind === 'valve' ? result?.valves.find((x) => x.id === e.name) : result?.pumps.find((x) => x.id === e.name);
    const q = pr?.flowM3s ?? 0;
    const flowing = Math.abs(q) > 1e-9;
    const ang = (Math.atan2(ty, tx) * 180) / Math.PI + (q < 0 ? 180 : 0);
    const sel = selection?.type === 'edge' && selection.uid === e.uid;
    const closed = e.kind === 'valve' && (!e.open || (pr !== undefined && 'status' in pr && (pr.status === 'check-closed' || pr.status === 'closed')));
    const label = closed ? (e.kind === 'valve' && !e.open ? 'closed' : pr && 'status' in pr && pr.status === 'closed' ? 'closed (reverse blocked)' : 'check closed') : pr && flowing ? `${U.fu('flow', Math.abs(q) * 1000, 2)}` : pr ? `0 ${U.u('flow')}` : '';
    const sub =
      closed
        ? ''
        : pr && e.kind === 'pipe' && 'flow' in pr
          ? U.fu('velocity', pr.flow.velocity, 2)
          : pr && e.kind === 'pump' && 'headM' in pr
            ? `H ${U.fu('head', pr.headM, 1)}`
            : pr && e.kind === 'valve' && 'pressureDropPa' in pr
              ? `Δp ${U.fu('pressure', pr.pressureDropPa / 1000, 1)}`
              : '';
    const path = `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`;
    return (
      <g key={e.uid} className={`edge ${e.kind} ${sel ? 'sel' : ''} ${closed ? 'closed' : ''}`} onPointerDown={(ev) => { ev.stopPropagation(); if (tool === 'select') onSelect({ type: 'edge', uid: e.uid }); }}>
        <path d={path} className="edge-hit" />
        <path d={path} className="edge-line" />
        {e.kind === 'pump' ? (
          <g transform={`translate(${mx} ${my})`}>
            <circle r={16} className="pump" />
            <path d="M-6,-8 L10,0 L-6,8 Z" className="pump-icon" transform={`rotate(${ang})`} />
          </g>
        ) : e.kind === 'valve' ? (
          <g transform={`translate(${mx} ${my}) rotate(${(Math.atan2(ty, tx) * 180) / Math.PI})`}>
            <path d="M-11,-9 L11,9 L11,-9 L-11,9 Z" className={`valve-icon ${closed ? 'closed' : ''}`} />
            {e.checkValve && <line x1={9} y1={-12} x2={9} y2={12} className="valve-check" />}
            {closed && <path d="M-8,-14 L8,14 M8,-14 L-8,14" className="valve-x" />}
          </g>
        ) : flowing ? (
          <path d="M-6,-5 L6,0 L-6,5 Z" className="flow-arrow" transform={`translate(${mx} ${my}) rotate(${ang})`} />
        ) : null}
        <text x={mx} y={my - (e.kind === 'pump' ? 24 : 16)} textAnchor="middle" className="t-name">{e.name}</text>
        {label && <text x={mx} y={my + (e.kind === 'pump' ? 32 : 26)} textAnchor="middle" className="t-res">{label}{sub ? ` · ${sub}` : ''}</text>}
      </g>
    );
  });

  const nodeEls = project.nodes.map((n) => {
    const sel = selection?.type === 'node' && selection.uid === n.uid;
    const isPending = pending === n.uid;
    const nr = result?.nodes.find((x) => x.id === n.name);
    const cls = `node ${n.kind} ${sel ? 'sel' : ''} ${isPending ? 'pending' : ''} ${nr && nr.warnings.length ? 'warn' : ''}`;
    const fill = Math.max(0.2, Math.min(0.9, n.levelM / (n.levelM + 3)));
    return (
      <g key={n.uid} className={cls} transform={`translate(${n.x} ${n.y})`} onPointerDown={(e) => onNodeDown(e, n)}>
        {n.kind === 'tank' ? (
          <>
            <rect x={-32} y={-24} width={64} height={48} rx={5} className="tank" />
            <rect x={-30} y={24 - 46 * fill} width={60} height={46 * fill} className="water" />
          </>
        ) : (
          <circle r={11} className="junction" />
        )}
        <text y={n.kind === 'tank' ? 40 : 28} textAnchor="middle" className="t-name">{n.name}</text>
        {nr && (
          <text y={n.kind === 'tank' ? 54 : 41} textAnchor="middle" className="t-res">
            {n.kind === 'tank' ? `h ${U.fu('head', nr.headM, 1)}` : `${U.fu('pressure', nr.gaugePressurePa / 1000, 0)} g`}
            {n.kind === 'junction' && Math.abs(nr.netOutflowM3s) > 1e-9 ? ` · −${U.fu('flow', nr.netOutflowM3s * 1000, 1)}` : ''}
          </text>
        )}
      </g>
    );
  });

  const hint =
    tool === 'tank' || tool === 'junction'
      ? `Click empty canvas to place a ${tool}.`
      : tool === 'pipe' || tool === 'pump' || tool === 'valve'
        ? pending
          ? `Click the node to connect the ${tool} to (Esc to cancel).`
          : `Click the node where the ${tool} starts.`
        : 'Drag nodes to rearrange. Click anything to edit it.';

  return (
    <div className="canvas-wrap">
      <div className="canvas-hint">{hint}</div>
      <svg
        ref={svgRef}
        className={`canvas tool-${tool}`}
        width={CANVAS_W}
        height={CANVAS_H}
        viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
        onPointerMove={onMove}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        role="application"
        aria-label="Pipe network canvas"
      >
        <defs>
          <pattern id="grid" width={GRID * 4} height={GRID * 4} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID * 4} 0 L 0 0 0 ${GRID * 4}`} className="grid-line" />
          </pattern>
        </defs>
        <rect width={CANVAS_W} height={CANVAS_H} fill="url(#grid)" onPointerDown={onBackgroundDown} />
        {edgeEls}
        {nodeEls}
        {project.nodes.length === 0 && <text x={CANVAS_W / 2} y={CANVAS_H / 2} textAnchor="middle" className="t-sub">Pick a tool above and click here to start building the network.</text>}
      </svg>
    </div>
  );
}
