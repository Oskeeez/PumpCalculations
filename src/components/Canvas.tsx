import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { planDistancePx } from '../geometry';
import type { EdgeUI, InsertKind, NodeKind, NodeUI, ProjectUI } from '../model';
import type { SystemResult } from '../solver';
import { useUnits } from '../units';

export type Tool = 'select' | 'tank' | 'junction' | 'pipe' | 'pump' | 'valve' | 'orifice' | 'scale';
export type Selection = { type: 'node' | 'edge'; uid: string } | null;
export type ConnectKind = 'pipe' | 'pump' | 'valve' | 'orifice';

const GRID = 10;

interface Props {
  project: ProjectUI;
  result?: SystemResult;
  selection: Selection;
  tool: Tool;
  pending?: string;
  /** Scale calibration points [px] (0 to 2). */
  calib: { x: number; y: number }[];
  onSelect: (s: Selection) => void;
  onTool: (t: Tool) => void;
  onAddNode: (kind: NodeKind, x: number, y: number) => void;
  onMoveNode: (uid: string, x: number, y: number) => void;
  onMoveImage: (id: string, x: number, y: number) => void;
  onConnect: (kind: ConnectKind, from: string, to: string) => void;
  /** Insert a junction, valve or pump into a pipe at the clicked point. */
  onInsert: (kind: InsertKind, pipeUid: string, x: number, y: number) => void;
  onPending: (uid: string | undefined) => void;
  onCalibPoint: (p: { x: number; y: number }) => void;
  /** Draft view: colour added / modified components. */
  highlight?: Map<string, 'added' | 'modified'>;
  /** Draft view: components that exist in the parent but not in this draft, drawn as ghosts. */
  removed?: { nodes: NodeUI[]; edges: EdgeUI[] };
  /** No editing: selecting only. */
  readOnly?: boolean;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;

const HINTS: Partial<Record<Tool, string>> = {
  tank: 'Click to place a tank',
  junction: 'Click empty space to place a junction, or click a pipe to split it',
  pipe: 'Drag from node to node',
  valve: 'Click a pipe to insert a valve, or drag from node to node',
  orifice: 'Click a pipe to insert an orifice plate, or drag from node to node',
  pump: 'Click a pipe to insert a pump, or drag from suction node to discharge node',
  scale: 'Click two points a known distance apart',
};

/** Network canvas. Select mode is the default; tools return to it after one use or a click on the background. */
export function Canvas({ project, result, selection, tool, pending, calib, onSelect, onTool, onAddNode, onMoveNode, onMoveImage, onConnect, onInsert, onPending, onCalibPoint, highlight, removed, readOnly }: Props) {
  const U = useUnits();
  const W = project.canvasW;
  const H = project.canvasH;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ kind: 'node' | 'image'; id: string; dx: number; dy: number } | null>(null);
  const [link, setLink] = useState<{ kind: ConnectKind; from: string; sx: number; sy: number; x: number; y: number; moved: boolean; target?: string } | null>(null);
  const nodeById = new Map(project.nodes.map((n) => [n.uid, n]));
  const isConnect = tool === 'pipe' || tool === 'pump' || tool === 'valve' || tool === 'orifice';

  const toSvg = (e: { clientX: number; clientY: number }) => {
    const r = (svgRef.current as SVGSVGElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  };
  const nodeAt = (e: { clientX: number; clientY: number }): string | undefined => {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const g = (el as Element).closest('[data-node]');
      if (g) return g.getAttribute('data-node') ?? undefined;
    }
    return undefined;
  };

  const onBackgroundDown = (e: RPointerEvent) => {
    if (readOnly) return onSelect(null);
    const p = toSvg(e);
    if (tool === 'tank' || tool === 'junction') {
      onAddNode(tool, snap(p.x), snap(p.y));
      onTool('select');
    } else if (tool === 'scale') {
      onCalibPoint(p);
    } else if (tool === 'select') {
      onSelect(null);
    } else {
      onPending(undefined);
      onTool('select');
    }
  };

  const onNodeDown = (e: RPointerEvent, n: NodeUI) => {
    e.stopPropagation();
    if (readOnly) return onSelect({ type: 'node', uid: n.uid });
    if (tool === 'select') {
      onSelect({ type: 'node', uid: n.uid });
      const p = toSvg(e);
      setDrag({ kind: 'node', id: n.uid, dx: n.x - p.x, dy: n.y - p.y });
      svgRef.current?.setPointerCapture(e.pointerId);
    } else if (isConnect) {
      if (pending && pending !== n.uid) {
        onConnect(tool as ConnectKind, pending, n.uid);
        onPending(undefined);
        onTool('select');
        return;
      }
      const p = toSvg(e);
      setLink({ kind: tool as ConnectKind, from: n.uid, sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false });
      svgRef.current?.setPointerCapture(e.pointerId);
    } else if (tool === 'scale') {
      onCalibPoint(toSvg(e));
    }
  };

  const onImageDown = (e: RPointerEvent, id: string, x: number, y: number) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    const p = toSvg(e);
    setDrag({ kind: 'image', id, dx: x - p.x, dy: y - p.y });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: RPointerEvent) => {
    if (drag) {
      const p = toSvg(e);
      if (drag.kind === 'node') onMoveNode(drag.id, Math.max(30, Math.min(W - 30, snap(p.x + drag.dx))), Math.max(30, Math.min(H - 40, snap(p.y + drag.dy))));
      else onMoveImage(drag.id, Math.round(p.x + drag.dx), Math.round(p.y + drag.dy));
    } else if (link) {
      const p = toSvg(e);
      const target = nodeAt(e);
      setLink({ ...link, x: p.x, y: p.y, moved: link.moved || Math.hypot(p.x - link.sx, p.y - link.sy) > 6, target: target && target !== link.from ? target : undefined });
    }
  };

  const onUp = (e: RPointerEvent) => {
    if (link) {
      const target = nodeAt(e);
      if (target && target !== link.from) {
        onConnect(link.kind, link.from, target);
        onPending(undefined);
        onTool('select');
      } else if (!link.moved || target === link.from) {
        onPending(link.from); // plain click: pick the second node with another click
      }
    }
    setLink(null);
    setDrag(null);
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
    const sgn = e.from < e.to ? 1 : -1;
    const nx = (-dy / len) * sgn;
    const ny = (dx / len) * sgn;
    const cx = (a.x + b.x) / 2 + nx * off * 2;
    const cy = (a.y + b.y) / 2 + ny * off * 2;
    const mx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x;
    const my = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
    const pr = e.kind === 'pipe' ? result?.pipes.find((x) => x.id === e.name) : e.kind === 'valve' ? result?.valves.find((x) => x.id === e.name) : result?.pumps.find((x) => x.id === e.name);
    const q = pr?.flowM3s ?? 0;
    const flowing = Math.abs(q) > 1e-9;
    const dirDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const ang = dirDeg + (q < 0 ? 180 : 0);
    const sel = selection?.type === 'edge' && selection.uid === e.uid;
    const closed = e.kind === 'valve' && (!e.open || (pr !== undefined && 'status' in pr && (pr.status === 'check-closed' || pr.status === 'closed')));
    const label = closed ? (e.kind === 'valve' && !e.open ? 'closed' : pr && 'status' in pr && pr.status === 'closed' ? 'closed (reverse blocked)' : 'check closed') : pr && flowing ? U.fu('flow', Math.abs(q) * 1000, 2) : pr ? `0 ${U.u('flow')}` : '';
    const sub = closed
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
      <g key={e.uid} className={`edge ${e.kind} ${sel ? 'sel' : ''} ${closed ? 'closed' : ''} ${highlight?.get(e.uid) ? `hl-${highlight.get(e.uid)}` : ''}`} onPointerDown={(ev) => {
        if (tool === 'select' || readOnly) { ev.stopPropagation(); onSelect({ type: 'edge', uid: e.uid }); }
        else if (e.kind === 'pipe' && (tool === 'junction' || tool === 'valve' || tool === 'orifice' || tool === 'pump')) {
          ev.stopPropagation();
          const p = toSvg(ev);
          onInsert(tool, e.uid, p.x, p.y);
          onTool('select');
        }
      }}>
        <path d={path} className="edge-hit" />
        <path d={path} className="edge-line" />
        {e.kind === 'pump' ? (
          <g transform={`translate(${mx} ${my})`}>
            <circle r={16} className="pump" />
            <path d="M-6,-8 L10,0 L-6,8 Z" className="pump-icon" transform={`rotate(${ang})`} />
          </g>
        ) : e.kind === 'valve' ? (
          <g transform={`translate(${mx} ${my}) rotate(${dirDeg})`}>
            {e.lossType === 'orifice' ? (
              <path d="M-2,-14 L-2,-4 M-2,4 L-2,14 M2,-14 L2,-4 M2,4 L2,14" className="valve-icon orifice-icon" />
            ) : (
              <path d="M-11,-9 L11,9 L11,-9 L-11,9 Z" className={`valve-icon ${closed ? 'closed' : ''}`} />
            )}
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
    const nr = result?.nodes.find((x) => x.id === n.name);
    const cls = `node ${n.kind} ${highlight?.get(n.uid) ? `hl-${highlight.get(n.uid)}` : ''} ${sel ? 'sel' : ''} ${pending === n.uid || link?.from === n.uid || link?.target === n.uid ? 'pending' : ''} ${nr && nr.warnings.length ? 'warn' : ''}`;
    const fill = Math.max(0.2, Math.min(0.9, n.levelM / (n.levelM + 3)));
    const top = n.kind === 'tank' ? 40 : 28;
    return (
      <g key={n.uid} data-node={n.uid} className={cls} transform={`translate(${n.x} ${n.y})`} onPointerDown={(e) => onNodeDown(e, n)}>
        {n.kind === 'tank' ? (
          <>
            <rect x={-32} y={-24} width={64} height={48} rx={5} className="tank" />
            <rect x={-30} y={24 - 46 * fill} width={60} height={46 * fill} className="water" />
          </>
        ) : (
          <circle r={11} className="junction" />
        )}
        <text y={top} textAnchor="middle" className="t-name">{n.name}</text>
        <text y={top + 13} textAnchor="middle" className="t-sub">
          {n.kind === 'tank' ? `z ${U.f('elevation', n.elevationM, 1)} · fluid ${U.fu('length', n.levelM, 1)}` : `z ${U.fu('elevation', n.elevationM, 1)}`}
        </text>
        {nr && (
          <text y={top + 26} textAnchor="middle" className="t-res">
            {n.kind === 'tank' ? `h ${U.fu('head', nr.headM, 1)}` : `${U.fu('pressure', nr.gaugePressurePa / 1000, 0)} g`}
            {n.kind === 'junction' && Math.abs(nr.netOutflowM3s) > 1e-9 ? ` · −${U.fu('flow', nr.netOutflowM3s * 1000, 1)}` : ''}
          </text>
        )}
      </g>
    );
  });

  const ghostNodes = new Map([...(removed?.nodes ?? []), ...project.nodes].map((n) => [n.uid, n]));
  const ghostEls = removed ? (
    <g className="ghosts">
      {removed.edges.map((e) => {
        const a = ghostNodes.get(e.from);
        const b = ghostNodes.get(e.to);
        return a && b ? <line key={e.uid} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="ghost-edge"><title>{`Removed: ${e.name}`}</title></line> : null;
      })}
      {removed.nodes.map((n) => (
        <g key={n.uid} transform={`translate(${n.x} ${n.y})`} className="ghost-node">
          <circle r={14} />
          <text y={30} textAnchor="middle" className="t-name">{n.name} (removed)</text>
        </g>
      ))}
    </g>
  ) : null;
  const hint = readOnly ? undefined : HINTS[tool];
  const from = link ? nodeById.get(link.from) : undefined;
  return (
    <div className="canvas-wrap">
      {hint && <div className="canvas-hint">{hint}</div>}
      <svg
        ref={svgRef}
        className={`canvas tool-${tool}`}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { setDrag(null); setLink(null); }}
        role="application"
        aria-label="Pipe network canvas"
      >
        <defs>
          <pattern id="grid" width={GRID * 4} height={GRID * 4} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID * 4} 0 L 0 0 0 ${GRID * 4}`} className="grid-line" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" onPointerDown={onBackgroundDown} />
        {project.images.map((im) => (
          <image
            key={im.id}
            href={im.dataUrl}
            x={im.x}
            y={im.y}
            width={im.width}
            height={im.height}
            opacity={im.opacity}
            preserveAspectRatio="none"
            className={im.locked ? 'img locked' : 'img'}
            style={{ pointerEvents: im.locked || tool !== 'select' ? 'none' : 'all' }}
            onPointerDown={(e) => onImageDown(e, im.id, im.x, im.y)}
          />
        ))}
        {tool === 'scale' && <rect width={W} height={H} fill="transparent" onPointerDown={onBackgroundDown} />}
        {ghostEls}
        {edgeEls}
        {link && from && (
          <g className="rubber">
            <line x1={from.x} y1={from.y} x2={link.x} y2={link.y} />
            {link.moved && (
              <text x={(from.x + link.x) / 2} y={(from.y + link.y) / 2 - 8} textAnchor="middle" className="t-res">
                {U.fu('length', planDistancePx(from, link) * project.scaleMPerPx, 1)}
              </text>
            )}
          </g>
        )}
        {calib.length > 0 && (
          <g className="calib">
            {calib.length === 2 && <line x1={calib[0].x} y1={calib[0].y} x2={calib[1].x} y2={calib[1].y} />}
            {calib.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={5} />)}
          </g>
        )}
        {nodeEls}
      </svg>
    </div>
  );
}
