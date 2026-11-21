import { useEffect, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  ALL_PANELS,
  PANEL_TITLES,
  PRESETS,
  addTab,
  closePanel,
  findGroup,
  loadNamedLayouts,
  saveNamedLayouts,
  withNamedLayout,
  type NamedLayout,
  movePanel,
  openPanel,
  openPanels,
  presetLayout,
  setActive,
  setSizes,
  type DropZone,
  type Group,
  type LayoutNode,
  type PanelId,
  type Split,
} from './layout';

interface Props {
  layout: LayoutNode;
  onLayout: (l: LayoutNode) => void;
  render: (id: PanelId) => ReactNode;
  /** Optional text after a tab title, e.g. a count. */
  badge?: (id: PanelId) => string | undefined;
}

/** Panels that fill their tile and manage their own scrolling. */
const FILL: PanelId[] = ['network', 'view3d'];
const MIN = 0.07;

export function Workspace({ layout, onLayout, render, badge }: Props) {
  const [dragging, setDragging] = useState<PanelId | null>(null);
  /** The tile shown full-screen, if any. The rest of the layout is kept and comes back when it is restored. */
  const [maxId, setMaxId] = useState<string | null>(null);
  const ref = useRef(layout);
  ref.current = layout;
  const apply = (l: LayoutNode) => onLayout(l);
  const maximised = maxId ? findGroup(layout, maxId) : undefined;
  useEffect(() => {
    if (maxId && !maximised) setMaxId(null); // its tile was closed or merged away
  }, [maxId, maximised]);
  useEffect(() => {
    if (!maximised) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === 'Escape' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') setMaxId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximised]);
  const ctx: Ctx = { layoutRef: ref, apply, render, badge, dragging, setDragging, maxId: maximised ? maxId : null, toggleMax: (id) => setMaxId((cur) => (cur === id ? null : id)) };
  return (
    <div className="ws-root">
      <NodeView node={maximised ?? layout} ctx={ctx} />
    </div>
  );
}

interface Ctx {
  layoutRef: { current: LayoutNode };
  apply: (l: LayoutNode) => void;
  render: Props['render'];
  badge: Props['badge'];
  dragging: PanelId | null;
  setDragging: (p: PanelId | null) => void;
  maxId: string | null;
  toggleMax: (groupId: string) => void;
}

function NodeView({ node, ctx }: { node: LayoutNode; ctx: Ctx }) {
  return node.kind === 'group' ? <GroupView group={node} ctx={ctx} /> : <SplitView split={node} ctx={ctx} />;
}

// -------------------------------------------------------------------- split
function SplitView({ split, ctx }: { split: Split; ctx: Ctx }) {
  const box = useRef<HTMLDivElement>(null);
  const row = split.dir === 'row';

  const startResize = (i: number, ev: RPointerEvent) => {
    ev.preventDefault();
    const el = box.current;
    if (!el) return;
    const total = row ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
    const start = row ? ev.clientX : ev.clientY;
    const s0 = [...split.sizes];
    document.body.classList.add(row ? 'ws-resizing-col' : 'ws-resizing-row');
    const move = (e: PointerEvent) => {
      const d = ((row ? e.clientX : e.clientY) - start) / Math.max(total, 1);
      const pair = s0[i] + s0[i + 1];
      const a = Math.min(pair - MIN, Math.max(MIN, s0[i] + d));
      const next = [...s0];
      next[i] = a;
      next[i + 1] = pair - a;
      ctx.apply(setSizes(ctx.layoutRef.current, split.id, next));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ws-resizing-col', 'ws-resizing-row');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={box} className={`ws-split ${split.dir}`}>
      {split.children.map((c, i) => (
        <FragmentWith key={c.id}>
          {i > 0 && (
            <div
              className={`ws-div ${split.dir}`}
              role="separator"
              aria-orientation={row ? 'vertical' : 'horizontal'}
              title="Drag to resize"
              onPointerDown={(e) => startResize(i - 1, e)}
              onDoubleClick={() => ctx.apply(setSizes(ctx.layoutRef.current, split.id, split.sizes.map(() => 1 / split.sizes.length)))}
            />
          )}
          <div className="ws-child" style={{ flex: `${split.sizes[i]} 1 0` }}>
            <NodeView node={c} ctx={ctx} />
          </div>
        </FragmentWith>
      ))}
    </div>
  );
}

const FragmentWith = ({ children }: { children: ReactNode }) => <>{children}</>;

// -------------------------------------------------------------------- group
function zoneOf(e: DragEvent<HTMLElement>): DropZone {
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / Math.max(r.width, 1);
  const y = (e.clientY - r.top) / Math.max(r.height, 1);
  const d: [number, DropZone][] = [[x, 'left'], [1 - x, 'right'], [y, 'top'], [1 - y, 'bottom']];
  const [dist, z] = d.reduce((a, b) => (b[0] < a[0] ? b : a));
  return dist > 0.28 ? 'center' : z;
}

function GroupView({ group, ctx }: { group: Group; ctx: Ctx }) {
  const [zone, setZone] = useState<DropZone | null>(null);
  const [menu, setMenu] = useState(false);
  const closed = ALL_PANELS.filter((p) => !openPanels(ctx.layoutRef.current).includes(p));
  const fill = FILL.includes(group.active);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const onDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    const p = e.dataTransfer.getData('text/plain') as PanelId;
    const z = zoneOf(e);
    setZone(null);
    ctx.setDragging(null);
    if (ALL_PANELS.includes(p)) ctx.apply(movePanel(ctx.layoutRef.current, p, group.id, z));
  };

  return (
    <div className="ws-group">
      <div className="ws-tabs" role="tablist">
        {group.panels.map((p) => (
          <div
            key={p}
            role="tab"
            aria-selected={p === group.active}
            className={`ws-tab ${p === group.active ? 'active' : ''}`}
            draggable
            title="Drag to move this panel; drop on a tile's edge to dock it beside, or in the middle to add it as a tab"
            onClick={() => ctx.apply(setActive(ctx.layoutRef.current, group.id, p))}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', p);
              e.dataTransfer.effectAllowed = 'move';
              ctx.setDragging(p);
            }}
            onDragEnd={() => { ctx.setDragging(null); setZone(null); }}
          >
            <span>{PANEL_TITLES[p]}{ctx.badge?.(p) ? ` ${ctx.badge(p)}` : ''}</span>
            <button className="ws-x" aria-label={`Close ${PANEL_TITLES[p]}`} title="Close this panel (re-open it from the Panels menu or the + button)" onClick={(e) => { e.stopPropagation(); ctx.apply(closePanel(ctx.layoutRef.current, p)); }}>×</button>
          </div>
        ))}
        <button className="ws-max" aria-label={ctx.maxId === group.id ? 'Restore the tile size' : 'Maximise this tile'} title={ctx.maxId === group.id ? 'Restore the tile (Esc)' : 'Fill the whole workspace with this tile'} onClick={() => ctx.toggleMax(group.id)}>{ctx.maxId === group.id ? '❐' : '⤢'}</button>
        <div className="ws-add" onPointerDown={(e) => e.stopPropagation()}>
          <button className="ws-plus" aria-label="Add a panel to this tile" title="Add a panel to this tile" onClick={() => setMenu((m) => !m)} disabled={closed.length === 0}>+</button>
          {menu && (
            <div className="ws-menu" role="menu">
              {closed.map((p) => (
                <button key={p} role="menuitem" onClick={() => { setMenu(false); ctx.apply(addTab(ctx.layoutRef.current, group.id, p)); }}>{PANEL_TITLES[p]}</button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className={`ws-body ${fill ? 'fill' : ''}`}>
        <ErrorBoundary title={`${PANEL_TITLES[group.active]} failed`}>{ctx.render(group.active)}</ErrorBoundary>
      </div>
      {ctx.dragging && (
        <div
          className="ws-drop"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; const z = zoneOf(e); if (z !== zone) setZone(z); }}
          onDragLeave={() => setZone(null)}
          onDrop={onDrop}
        >
          {zone && <div className={`ws-zone ${zone}`} />}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- menus
function Menu({ label, title, children }: { label: string; title?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);
  return (
    <div className="menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button aria-haspopup="menu" aria-expanded={open} title={title} onClick={() => setOpen((o) => !o)}>{label} ▾</button>
      {open && <div className="ws-menu top" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/** Choose a ready-made arrangement or one of your own saved ones, or save the current arrangement under a name. */
export function LayoutMenu({ layout, onLayout }: { layout: LayoutNode; onLayout: (l: LayoutNode) => void }) {
  const [saved, setSaved] = useState<NamedLayout[]>(loadNamedLayouts);
  const update = (next: NamedLayout[]) => {
    setSaved(next);
    saveNamedLayouts(next);
  };
  return (
    <Menu label="Layout" title="Arrange the workspace">
      {(close) => (
        <>
          {PRESETS.map((p) => (
            <button key={p.id} role="menuitem" onClick={() => { onLayout(presetLayout(p.id)); close(); }}>{p.label}</button>
          ))}
          <hr />
          {saved.length > 0 && <div className="ws-menu-note">Your layouts</div>}
          {saved.map((n) => (
            <div key={n.name} className="ws-saved">
              <button role="menuitem" onClick={() => { onLayout(n.layout); close(); }}>{n.name}</button>
              <button className="ws-del" aria-label={`Delete the layout ${n.name}`} title="Delete this saved layout" onClick={() => update(saved.filter((x) => x.name !== n.name))}>×</button>
            </div>
          ))}
          <button role="menuitem" onClick={() => {
            const name = window.prompt('Name for this layout:', `My layout ${saved.length + 1}`);
            if (name && name.trim()) { update(withNamedLayout(saved, name, layout)); close(); }
          }}>Save this layout as…</button>
          <hr />
          <div className="ws-menu-note">Drag a tab to move it. Drop it on a tile's edge to dock it beside, or in the middle to add it as a tab. Drag the bars between tiles to resize (double-click to even out).</div>
        </>
      )}
    </Menu>
  );
}

/** Show or hide each panel. */
export function PanelsMenu({ layout, onLayout }: { layout: LayoutNode; onLayout: (l: LayoutNode) => void }) {
  const open = openPanels(layout);
  return (
    <Menu label="Panels" title="Choose which panels are on screen">
      {() => ALL_PANELS.map((p) => (
        <label key={p} className="ws-check">
          <input
            type="checkbox"
            checked={open.includes(p)}
            onChange={(e) => onLayout(e.target.checked ? openPanel(layout, p) : closePanel(layout, p))}
          />
          {PANEL_TITLES[p]}
        </label>
      ))}
    </Menu>
  );
}
