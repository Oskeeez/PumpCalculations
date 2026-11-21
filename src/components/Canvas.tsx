import { useState, type PointerEvent as RPointerEvent } from 'react';
import { planDistancePx } from '../geometry';
import type { EdgeUI, InsertKind, NodeKind, NodeUI, ProjectUI } from '../model';
import type { SystemResult } from '../solver';
import { useUnits } from '../units';
import { contentBounds } from '../viewport';
import { edgeGeometry, pairKey } from './canvasGeometry';
import { useViewport } from './useViewport';
import { SYM_MAX, SYM_MIN, ZoomControls } from './ZoomControls';

export type Tool = 'select' | 'tank' | 'junction' | 'pipe' | 'pump' | 'valve' | 'orifice' | 'scale';
export type Selection = { type: 'node' | 'edge'; uid: string } | null;
export type ConnectKind = 'pipe' | 'pump' | 'valve' | 'orifice';

/** What a "pick on the network" request accepts. */
export type PickAccept = 'node' | 'pump' | 'line';
export interface PickSpec {
  accept: PickAccept;
  /** What is being chosen, shown in the banner. */
  label: string;
}

const GRID = 10;
const SYM_KEY = 'pipe-network-symbol-scale';

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
  /** Drag (or click) from a node into empty space: the end of the new pipe/pump/valve becomes a new node there. */
  onConnectNew: (kind: ConnectKind, from: string, x: number, y: number) => void;
  /** Drag across blank canvas: new start node, and a new end node (or the existing node the drag ended on). */
  onConnectBlank: (kind: ConnectKind, a: { x: number; y: number }, b: { x: number; y: number } | { uid: string }) => void;
  /** Place a pump, valve or orifice on its own at a point of empty canvas. */
  onPlace: (kind: 'pump' | 'valve' | 'orifice', x: number, y: number) => void;
  /** Swap the flow direction of an element. */
  onReverse: (uid: string) => void;
  /** The image being adjusted (move by dragging, zoom with the wheel); all other images ignore the pointer. */
  adjustImageId?: string;
  onZoomImage: (id: string, factor: number, cx: number, cy: number) => void;
  /** Leave image adjust mode. */
  onAdjustDone?: () => void;
  /** Insert a junction, valve or pump into a pipe at the clicked point. */
  onInsert: (kind: InsertKind, pipeUid: string, x: number, y: number) => void;
  onPending: (uid: string | undefined) => void;
  onCalibPoint: (p: { x: number; y: number }) => void;
  /** Changes when a different project is loaded: the view is re-fitted to the new content. */
  fitKey?: number;
  /** A panel is asking the user to click a node, pump or line on the network. */
  pick?: PickSpec;
  onPick?: (uid: string) => void;
  onPickCancel?: () => void;
  /** Draft view: colour added / modified components. */
  highlight?: Map<string, 'added' | 'modified'>;
  /** Draft view: components that exist in the parent but not in this draft, drawn as ghosts. */
  removed?: { nodes: NodeUI[]; edges: EdgeUI[] };
  /** No editing: selecting only. */
  readOnly?: boolean;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;
const clampSym = (v: number) => Math.min(SYM_MAX, Math.max(SYM_MIN, v));

function loadSym(): number {
  try {
    const n = Number(localStorage.getItem(SYM_KEY));
    if (Number.isFinite(n) && n >= SYM_MIN && n <= SYM_MAX) return n;
  } catch {
    /* ignore */
  }
  return 1;
}

const HINTS: Partial<Record<Tool, string>> = {
  tank: 'Click empty space to place a tank, or click a pipe to split it with a tank',
  junction: 'Click empty space to place a junction, or click a pipe to split it',
  pipe: 'Drag from node to node, or drag across blank space to create both ends',
  valve: 'Click a pipe to insert a valve, click empty space to place one, or drag to draw one between two nodes',
  orifice: 'Click a pipe to insert an orifice plate, click empty space to place one, or drag to draw one between two nodes',
  pump: 'Click a pipe to insert a pump, click empty space to place one, or drag from suction to discharge',
  scale: 'Click two points a known distance apart',
};

const PICK_NAME: Record<PickAccept, string> = { node: 'node', pump: 'pump', line: 'pipe or valve' };

/**
 * Network canvas with a pan / zoom viewport that fills its tile. Scroll zooms about the pointer, dragging empty space pans, the +/−
 * buttons zoom, Fit shows the whole network. Symbol size (nodes, valves, pumps, labels) is separate from the zoom.
 */
export function Canvas({ project, result, selection, tool, pending, calib, onSelect, onTool, onAddNode, onMoveNode, onMoveImage, onConnect, onInsert, onConnectNew, onConnectBlank, onPlace, onReverse, adjustImageId, onZoomImage, onAdjustDone, onPending, onCalibPoint, fitKey, pick, onPick, onPickCancel, highlight, removed, readOnly }: Props) {
  const U = useUnits();
  const W = project.canvasW;
  const H = project.canvasH;
  const [drag, setDrag] = useState<{ kind: 'node' | 'image'; id: string; dx: number; dy: number } | null>(null);
  const [link, setLink] = useState<{ kind: ConnectKind; from: string; sx: number; sy: number; x: number; y: number; moved: boolean; target?: string } | null>(null);
  const [sym, setSym] = useState(loadSym);
  const nodeById = new Map(project.nodes.map((n) => [n.uid, n]));
  const isConnect = tool === 'pipe' || tool === 'pump' || tool === 'valve' || tool === 'orifice';
  const vp = useViewport({
    canvas: { w: W, h: H },
    bounds: (symbolScale) => contentBounds(project.nodes, project.images, { w: W, h: H }, symbolScale),
    symbolScale: sym,
    fitKey,
    // while an image is being adjusted, the wheel zooms the image, not the view
    wheelOverride: (p, zoomIn) => {
      if (!adjustImageId) return false;
      onZoomImage(adjustImageId, zoomIn ? 1.08 : 1 / 1.08, p.x, p.y);
      return true;
    },
  });
  const { svgRef, toSvg, zoomBy, fit } = vp;

  const changeSym = (f: number) => {
    const next = clampSym(Math.round(sym * f * 100) / 100);
    setSym(next);
    try {
      localStorage.setItem(SYM_KEY, String(next));
    } catch {
      /* ignore */
    }
  };


  const nodeAt = (e: { clientX: number; clientY: number }): string | undefined => {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const g = (el as Element).closest('[data-node]');
      if (g) return g.getAttribute('data-node') ?? undefined;
    }
    return undefined;
  };

  const startPan = vp.beginPan;

  /** Tools stay active after each placement. Escape, right-click, the tool button again, or another tool ends it. */
  const onBackgroundDown = (e: RPointerEvent) => {
    if (e.button === 1) return; // middle button pans (handled on the svg)
    if (pick) return onPickCancel?.();
    if (readOnly) return startPan(e);
    if (e.button === 2) return;
    const p = toSvg(e);
    if (tool === 'tank' || tool === 'junction') {
      onAddNode(tool, snap(p.x), snap(p.y));
    } else if (tool === 'scale') {
      onCalibPoint(p);
    } else if (tool === 'select') {
      startPan(e); // a drag pans; a plain click deselects (see onUp)
    } else if (pending) {
      // first node picked, then a click in empty space: the end becomes a new node there
      onConnectNew(tool as ConnectKind, pending, snap(p.x), snap(p.y));
      onPending(undefined);
    } else if (isConnect) {
      // press on blank canvas and drag: both ends become new nodes. A plain click places a pump / valve / orifice on its own.
      setLink({ kind: tool as ConnectKind, from: '', sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false });
      svgRef.current?.setPointerCapture(e.pointerId);
    }
  };

  const onNodeDown = (e: RPointerEvent, n: NodeUI) => {
    e.stopPropagation();
    if (pick) {
      if (pick.accept === 'node') onPick?.(n.uid);
      return;
    }
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
    if (tool !== 'select' || adjustImageId !== id) return;
    e.stopPropagation();
    const p = toSvg(e);
    setDrag({ kind: 'image', id, dx: x - p.x, dy: y - p.y });
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: RPointerEvent) => {
    if (vp.movePan(e)) return;
    if (drag) {
      const p = toSvg(e);
      if (drag.kind === 'node') onMoveNode(drag.id, snap(p.x + drag.dx), snap(p.y + drag.dy));
      else onMoveImage(drag.id, Math.round(p.x + drag.dx), Math.round(p.y + drag.dy));
    } else if (link) {
      const p = toSvg(e);
      const target = nodeAt(e);
      setLink({ ...link, x: p.x, y: p.y, moved: link.moved || Math.hypot(p.x - link.sx, p.y - link.sy) * vp.view.scale > 6, target: target && target !== link.from ? target : undefined });
    }
  };

  const onUp = (e: RPointerEvent) => {
    const panned = vp.endPan();
    if (panned) {
      if (panned === 'click') onSelect(null); // a plain click on empty space deselects; a drag only pans
      return;
    }
    if (link && link.from === '') {
      // started on blank canvas
      const target = nodeAt(e);
      const p = toSvg(e);
      const a = { x: snap(link.sx), y: snap(link.sy) };
      if (link.moved) {
        onConnectBlank(link.kind, a, target ? { uid: target } : { x: snap(p.x), y: snap(p.y) });
      } else if (link.kind !== 'pipe') {
        onPlace(link.kind, a.x, a.y);
      }
    } else if (link) {
      const target = nodeAt(e);
      if (target && target !== link.from) {
        onConnect(link.kind, link.from, target);
        onPending(undefined);
      } else if (!link.moved || target === link.from) {
        onPending(link.from); // plain click: pick the second node (or empty space) with another click
      } else {
        const p = toSvg(e); // dragged into empty space: the end becomes a new node
        onConnectNew(link.kind, link.from, snap(p.x), snap(p.y));
        onPending(undefined);
      }
    }
    setLink(null);
    setDrag(null);
  };

  // Parallel edges between the same two nodes are fanned out.
  const pairCount = new Map<string, number>();
  const pairIndex = new Map<string, number>();
  for (const e of project.edges) {
    const key = pairKey(e.from, e.to);
    pairIndex.set(e.uid, pairCount.get(key) ?? 0);
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }

  const edgePickable = (e: EdgeUI) => !!pick && ((pick.accept === 'pump' && e.kind === 'pump') || (pick.accept === 'line' && (e.kind === 'pipe' || e.kind === 'valve')));

  const edgeEls = project.edges.map((e) => {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) return null;
    const { path, mx, my, dirDeg } = edgeGeometry(e.from, e.to, a, b, pairIndex.get(e.uid) ?? 0, pairCount.get(pairKey(e.from, e.to)) ?? 1);
    const pr = e.kind === 'pipe' ? result?.pipes.find((x) => x.id === e.name) : e.kind === 'valve' ? result?.valves.find((x) => x.id === e.name) : result?.pumps.find((x) => x.id === e.name);
    const q = pr?.flowM3s ?? 0;
    const flowing = Math.abs(q) > 1e-9;
    const ang = dirDeg + (q < 0 ? 180 : 0);
    const sel = selection?.type === 'edge' && selection.uid === e.uid;
    const closed = e.kind === 'valve' && (!e.open || (pr !== undefined && 'status' in pr && (pr.status === 'check-closed' || pr.status === 'closed')));
    const off = e.kind === 'pump' && e.running === false;
    const label = off ? 'OFF' : closed ? (e.kind === 'valve' && !e.open ? 'closed' : pr && 'status' in pr && pr.status === 'closed' ? 'closed (reverse blocked)' : 'check closed') : pr && flowing ? U.fu('flow', Math.abs(q) * 1000, 2) : pr ? `0 ${U.u('flow')}` : '';
    const sub = closed || off
      ? ''
      : pr && e.kind === 'pipe' && 'flow' in pr
        ? U.fu('velocity', pr.flow.velocity, 2)
        : pr && e.kind === 'pump' && 'headM' in pr
          ? `H ${U.fu('head', pr.headM, 1)}`
          : pr && e.kind === 'valve' && 'pressureDropPa' in pr
            ? `Δp ${U.fu('pressure', pr.pressureDropPa / 1000, 1)}`
            : '';
    return (
      <g
        key={e.uid}
        className={`edge ${e.kind} ${sel ? 'sel' : ''} ${closed || off ? 'closed' : ''} ${off ? 'off' : ''} ${edgePickable(e) ? 'pickable' : ''} ${highlight?.get(e.uid) ? `hl-${highlight.get(e.uid)}` : ''}`}
        onPointerDown={(ev) => {
          if (pick) {
            ev.stopPropagation();
            if (edgePickable(e)) onPick?.(e.uid);
          } else if (tool === 'select' || readOnly) {
            ev.stopPropagation();
            onSelect({ type: 'edge', uid: e.uid });
          } else if (e.kind === 'pipe' && (tool === 'junction' || tool === 'tank' || tool === 'valve' || tool === 'orifice' || tool === 'pump')) {
            ev.stopPropagation();
            const p = toSvg(ev);
            onInsert(tool, e.uid, p.x, p.y);
          }
        }}
      >
        <path d={path} className="edge-hit" />
        <path d={path} className="edge-line" />
        {e.kind === 'pump' ? (
          <g transform={`translate(${mx} ${my}) scale(${sym})`}>
            <circle r={16} className="pump" />
            <path d="M-6,-8 L10,0 L-6,8 Z" className="pump-icon" transform={`rotate(${ang})`} />
          </g>
        ) : e.kind === 'valve' ? (
          <g transform={`translate(${mx} ${my}) rotate(${dirDeg}) scale(${sym})`}>
            {e.lossType === 'orifice' ? (
              <path d="M-2,-14 L-2,-4 M-2,4 L-2,14 M2,-14 L2,-4 M2,4 L2,14" className="valve-icon orifice-icon" />
            ) : (
              <path d="M-11,-9 L11,9 L11,-9 L-11,9 Z" className={`valve-icon ${closed ? 'closed' : ''}`} />
            )}
            {e.checkValve && <line x1={9} y1={-12} x2={9} y2={12} className="valve-check" />}
            {closed && <path d="M-8,-14 L8,14 M8,-14 L-8,14" className="valve-x" />}
          </g>
        ) : flowing ? (
          <path d="M-6,-5 L6,0 L-6,5 Z" className="flow-arrow" transform={`translate(${mx} ${my}) rotate(${ang}) scale(${sym})`} />
        ) : null}
        <g transform={`translate(${mx} ${my}) scale(${sym})`}>
          <text x={0} y={e.kind === 'pump' ? -24 : -16} textAnchor="middle" className="t-name">{e.name}</text>
          {label && <text x={0} y={e.kind === 'pump' ? 32 : 26} textAnchor="middle" className="t-res">{label}{sub ? ` · ${sub}` : ''}</text>}
        </g>
        {sel && !readOnly && (e.kind === 'pump' || e.kind === 'valve') && (
          <>
            {([['from', a, b], ['to', b, a]] as const).map(([which, nn, other]) => {
              const d = Math.hypot(other.x - nn.x, other.y - nn.y) || 1;
              const tx = nn.x + ((other.x - nn.x) / d) * 38 * sym;
              const ty = nn.y + ((other.y - nn.y) / d) * 38 * sym - 8 * sym;
              const txt = e.kind === 'pump' ? (which === 'from' ? 'SUCTION' : 'DISCHARGE') : which === 'from' ? 'IN' : 'OUT';
              return <text key={which} transform={`translate(${tx} ${ty}) scale(${sym})`} textAnchor="middle" className="t-end">{txt}</text>;
            })}
            <g className="reverse-btn" transform={`translate(${mx + 30 * sym} ${my - 30 * sym}) scale(${sym})`} onPointerDown={(ev) => { ev.stopPropagation(); onReverse(e.uid); }}>
              <title>Reverse flow direction</title>
              <circle r={12} />
              <text textAnchor="middle" y={5}>⇄</text>
            </g>
          </>
        )}
      </g>
    );
  });

  const nodeEls = project.nodes.map((n) => {
    const sel = selection?.type === 'node' && selection.uid === n.uid;
    const nr = result?.nodes.find((x) => x.id === n.name);
    const pickable = pick?.accept === 'node';
    const cls = `node ${n.kind} ${pickable ? 'pickable' : ''} ${highlight?.get(n.uid) ? `hl-${highlight.get(n.uid)}` : ''} ${sel ? 'sel' : ''} ${pending === n.uid || link?.from === n.uid || link?.target === n.uid ? 'pending' : ''} ${nr && nr.warnings.length ? 'warn' : ''}`;
    const fill = Math.max(0.2, Math.min(0.9, n.levelM / (n.levelM + 3)));
    const top = n.kind === 'tank' ? 40 : 28;
    return (
      <g key={n.uid} data-node={n.uid} className={cls} transform={`translate(${n.x} ${n.y}) scale(${sym})`} onPointerDown={(e) => onNodeDown(e, n)}>
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
        <g key={n.uid} transform={`translate(${n.x} ${n.y}) scale(${sym})`} className="ghost-node">
          <circle r={14} />
          <text y={30} textAnchor="middle" className="t-name">{n.name} (removed)</text>
        </g>
      ))}
    </g>
  ) : null;
  const hint = readOnly || pick ? undefined : HINTS[tool];
  const from = link ? (link.from ? nodeById.get(link.from) : { x: link.sx, y: link.sy }) : undefined;
  return (
    <div className={`canvas-wrap ${pick ? 'picking' : ''}`}>
      {pick && (
        <div className="pick-bar" role="status">
          <span>Click a {PICK_NAME[pick.accept]} on the network to choose it for “{pick.label}”.</span>
          <button onClick={onPickCancel}>Cancel (Esc)</button>
        </div>
      )}
      {adjustImageId && !readOnly && (() => {
        const im = project.images.find((q) => q.id === adjustImageId);
        return im ? (
          <div className="adjust-bar" role="toolbar" aria-label="Adjust image">
            <span>Adjusting “{im.name}”: drag to move, scroll to zoom</span>
            <button onClick={() => onZoomImage(im.id, 1 / 1.1, im.x + im.width / 2, im.y + im.height / 2)}>Zoom −</button>
            <button onClick={() => onZoomImage(im.id, 1.1, im.x + im.width / 2, im.y + im.height / 2)}>Zoom +</button>
            <button className="primary" onClick={onAdjustDone}>Done</button>
          </div>
        ) : null;
      })()}
      {hint && <div className="canvas-hint">{hint}. Esc or right-click to stop.</div>}
      <svg
        ref={svgRef}
        className={`canvas tool-${tool} ${adjustImageId ? 'adjusting' : ''} ${pick ? 'picking' : ''}`}
        style={{ ['--sym' as string]: sym }}
        viewBox={vp.viewBoxString}
        onPointerDown={(e) => { if (e.button === 1) { e.preventDefault(); startPan(e); } }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => { setDrag(null); setLink(null); vp.cancelPan(); }}
        onContextMenu={(e) => { if (tool !== 'select' && !readOnly) { e.preventDefault(); onPending(undefined); onTool('select'); } }}
        role="application"
        aria-label="Pipe network canvas"
      >
        <defs>
          <pattern id="grid" width={GRID * 4} height={GRID * 4} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID * 4} 0 L 0 0 0 ${GRID * 4}`} className="grid-line" />
          </pattern>
        </defs>
        <rect x={-100000} y={-100000} width={200000} height={200000} fill="url(#grid)" onPointerDown={onBackgroundDown} />
        {project.images.map((im) => (
          <g key={im.id}>
            <image
              href={im.dataUrl}
              x={im.x}
              y={im.y}
              width={im.width}
              height={im.height}
              opacity={im.opacity}
              preserveAspectRatio="none"
              className={adjustImageId === im.id ? 'img adjusting' : 'img'}
              style={{ pointerEvents: adjustImageId === im.id && tool === 'select' ? 'all' : 'none' }}
              onPointerDown={(e) => onImageDown(e, im.id, im.x, im.y)}
            />
            {adjustImageId === im.id && <rect x={im.x} y={im.y} width={im.width} height={im.height} className="img-frame" />}
          </g>
        ))}
        {tool === 'scale' && <rect x={-100000} y={-100000} width={200000} height={200000} fill="transparent" onPointerDown={onBackgroundDown} />}
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
      <ZoomControls onZoom={zoomBy} onFit={() => fit()} symbolScale={sym} onSymbolScale={changeSym} />
    </div>
  );
}
