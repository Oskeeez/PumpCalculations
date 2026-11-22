/**
 * Tiling workspace layout. A layout is a tree: a split (row or column) holds children with proportional sizes, a group holds one or
 * more panels as tabs. All operations are pure (they return a new, normalised tree) so they can be tested without a browser.
 * Invariants kept by `normalize`: a panel appears at most once, groups are never empty, splits have at least two children,
 * a split never directly contains a split of the same direction, and sizes sum to 1.
 */
export type PanelId = 'network' | 'properties' | 'solve' | 'pumpcurves' | 'pipelib' | 'fittinglib' | 'results' | 'pumpchart' | 'profile' | 'targets' | 'scale' | 'speed' | 'scenarios' | 'report' | 'validation' | 'view3d' | 'coords3d' | 'ai' | 'drafts';

export const PANEL_TITLES: Record<PanelId, string> = {
  network: 'Network',
  properties: 'Properties',
  solve: 'Solve for me',
  pumpcurves: 'Pump curves',
  pipelib: 'Pipe sizes',
  fittinglib: 'Fittings',
  results: 'Results',
  pumpchart: 'Pump curve',
  profile: 'HGL profile',
  targets: 'Targets',
  scale: 'Scale & images',
  speed: 'Speed analysis',
  scenarios: 'Scenarios',
  validation: 'Validation',
  report: 'Report',
  view3d: '3D view',
  coords3d: '3D coordinates',
  ai: 'AI assistant',
  drafts: 'Drafts',
};

export const ALL_PANELS = Object.keys(PANEL_TITLES) as PanelId[];

export interface Group {
  kind: 'group';
  id: string;
  panels: PanelId[];
  active: PanelId;
}

export interface Split {
  kind: 'split';
  id: string;
  dir: 'row' | 'col';
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = Group | Split;
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

let counter = 0;
const newId = (p: string) => `${p}${++counter}`;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const group = (panels: PanelId[], active?: PanelId): Group => ({ kind: 'group', id: newId('g'), panels, active: active ?? panels[0] });
const split = (dir: 'row' | 'col', parts: [number, LayoutNode][]): Split => {
  const total = parts.reduce((s, p) => s + p[0], 0);
  return { kind: 'split', id: newId('s'), dir, sizes: parts.map((p) => p[0] / total), children: parts.map((p) => p[1]) };
};

// ------------------------------------------------------------------ queries
export function groupsOf(n: LayoutNode): Group[] {
  return n.kind === 'group' ? [n] : n.children.flatMap(groupsOf);
}
export function openPanels(n: LayoutNode): PanelId[] {
  return groupsOf(n).flatMap((g) => g.panels);
}
export const findGroup = (n: LayoutNode, id: string): Group | undefined => groupsOf(n).find((g) => g.id === id);
export const groupOfPanel = (n: LayoutNode, p: PanelId): Group | undefined => groupsOf(n).find((g) => g.panels.includes(p));

// ---------------------------------------------------------------- normalise
function norm(n: LayoutNode): LayoutNode | null {
  if (n.kind === 'group') {
    const seen = new Set<PanelId>();
    n.panels = n.panels.filter((p) => ALL_PANELS.includes(p) && !seen.has(p) && (seen.add(p), true));
    if (!n.panels.length) return null;
    if (!n.panels.includes(n.active)) n.active = n.panels[0];
    return n;
  }
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const r = norm(c);
    if (!r) return;
    const s = Number.isFinite(n.sizes[i]) && n.sizes[i] > 0 ? n.sizes[i] : 1 / n.children.length;
    if (r.kind === 'split' && r.dir === n.dir) {
      // flatten a same-direction split into its parent
      r.children.forEach((cc, j) => {
        kids.push(cc);
        sizes.push(s * r.sizes[j]);
      });
    } else {
      kids.push(r);
      sizes.push(s);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  n.children = kids;
  n.sizes = sizes.map((s) => s / total);
  return n;
}

/** Drop duplicate panels (first occurrence wins), empty groups and redundant splits. Never returns an empty layout. */
export function normalize(root: LayoutNode): LayoutNode {
  const seen = new Set<PanelId>();
  const dedupe = (n: LayoutNode): void => {
    if (n.kind === 'group') n.panels = n.panels.filter((p) => !seen.has(p) && (seen.add(p), true));
    else n.children.forEach(dedupe);
  };
  const copy = clone(root);
  dedupe(copy);
  return norm(copy) ?? group(['network']);
}

// --------------------------------------------------------------- operations
function removeFrom(root: LayoutNode, panel: PanelId): void {
  const g = groupOfPanel(root, panel);
  if (!g) return;
  const i = g.panels.indexOf(panel);
  g.panels.splice(i, 1);
  if (g.active === panel) g.active = g.panels[Math.min(i, g.panels.length - 1)] ?? g.active;
}

export function closePanel(root: LayoutNode, panel: PanelId): LayoutNode {
  const c = clone(root);
  removeFrom(c, panel);
  return normalize(c);
}

export function setActive(root: LayoutNode, groupId: string, panel: PanelId): LayoutNode {
  const g = findGroup(root, groupId);
  if (!g || g.active === panel || !g.panels.includes(panel)) return root;
  const c = clone(root);
  findGroup(c, groupId)!.active = panel;
  return c;
}

/** Make an open panel the visible tab of its group. Returns the same object when nothing changes. */
export function activatePanel(root: LayoutNode, panel: PanelId): LayoutNode {
  const g = groupOfPanel(root, panel);
  return g ? setActive(root, g.id, panel) : root;
}

export function addTab(root: LayoutNode, groupId: string, panel: PanelId): LayoutNode {
  const c = clone(root);
  const target = findGroup(c, groupId);
  if (!target) return root;
  if (!target.panels.includes(panel)) {
    removeFrom(c, panel);
    target.panels.push(panel);
  }
  target.active = panel;
  return normalize(c);
}

/** Show a panel: activate it if open, otherwise add it as a tab of `preferGroupId` (default: the last group). */
export function openPanel(root: LayoutNode, panel: PanelId, preferGroupId?: string): LayoutNode {
  if (groupOfPanel(root, panel)) return activatePanel(root, panel);
  const gs = groupsOf(root);
  const g = (preferGroupId && gs.find((x) => x.id === preferGroupId)) || gs[gs.length - 1];
  return addTab(root, g.id, panel);
}

/** Dock `panel` beside `targetGroupId`, taking half of its space. */
export function splitAt(root: LayoutNode, targetGroupId: string, panel: PanelId, zone: Exclude<DropZone, 'center'>): LayoutNode {
  const src = groupOfPanel(root, panel);
  const tgt = findGroup(root, targetGroupId);
  if (!tgt) return root;
  if (src && src.id === tgt.id && tgt.panels.length === 1) return root; // already alone there
  const c = clone(root);
  removeFrom(c, panel);
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
  const first = zone === 'left' || zone === 'top';
  const fresh = group([panel]);
  const ins = (n: LayoutNode): LayoutNode => {
    if (n.kind === 'group') return n.id !== targetGroupId ? n : split(dir, first ? [[0.5, fresh], [0.5, n]] : [[0.5, n], [0.5, fresh]]);
    const kids: LayoutNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((ch, i) => {
      if (ch.kind === 'group' && ch.id === targetGroupId && n.dir === dir) {
        // same direction as the parent: slot in beside it, sharing its size
        kids.push(...(first ? [fresh, ch] : [ch, fresh]));
        sizes.push(n.sizes[i] / 2, n.sizes[i] / 2);
      } else {
        kids.push(ins(ch));
        sizes.push(n.sizes[i]);
      }
    });
    n.children = kids;
    n.sizes = sizes;
    return n;
  };
  return normalize(ins(c));
}

/** Drop a panel on a group: in the middle it joins as a tab, at an edge it docks beside the group. */
export function movePanel(root: LayoutNode, panel: PanelId, targetGroupId: string, zone: DropZone): LayoutNode {
  if (zone === 'center') return addTab(root, targetGroupId, panel);
  return splitAt(root, targetGroupId, panel, zone);
}

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const c = clone(root);
  const find = (n: LayoutNode): Split | undefined => (n.kind === 'split' ? (n.id === splitId ? n : n.children.map(find).find(Boolean)) : undefined);
  const s = find(c);
  if (!s || sizes.length !== s.sizes.length) return root;
  s.sizes = sizes;
  return c;
}

// ------------------------------------------------------------------ presets
export type PresetId = 'default' | 'network3d' | 'analysis' | 'ai';

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'default', label: 'Default: network, results, properties' },
  { id: 'network3d', label: 'Network + 3D view' },
  { id: 'analysis', label: 'Network + results + pump curve' },
  { id: 'ai', label: 'AI workspace: network, assistant, drafts' },
];

export function presetLayout(id: PresetId): LayoutNode {
  switch (id) {
    case 'network3d':
      return split('row', [[0.4, group(['network'])], [0.4, group(['view3d', 'coords3d'])], [0.2, group(['properties', 'solve', 'pumpcurves', 'pipelib', 'fittinglib', 'targets', 'scale', 'ai', 'drafts'], 'properties')]]);
    case 'analysis':
      return split('row', [
        [0.55, split('col', [[0.6, group(['network'])], [0.4, group(['results', 'speed', 'scenarios', 'report'])]])],
        [0.45, split('col', [[0.5, group(['pumpchart', 'profile', 'view3d', 'coords3d'])], [0.5, group(['properties', 'solve', 'pumpcurves', 'pipelib', 'fittinglib', 'targets', 'scale', 'ai', 'drafts'], 'properties')]])],
      ]);
    case 'ai':
      return split('row', [[0.4, group(['network', 'view3d', 'coords3d'], 'network')], [0.3, group(['ai', 'properties', 'solve', 'pumpcurves', 'pipelib', 'fittinglib', 'targets', 'scale'], 'ai')], [0.3, group(['drafts', 'results', 'pumpchart', 'profile', 'speed', 'scenarios', 'report'], 'drafts')]]);
    default:
      return split('row', [
        [0.68, split('col', [[0.68, group(['network'])], [0.32, group(['results', 'pumpchart', 'profile', 'speed', 'scenarios', 'report', 'validation', 'view3d', 'coords3d'], 'results')]])],
        [0.32, group(['properties', 'solve', 'pumpcurves', 'pipelib', 'fittinglib', 'targets', 'scale', 'ai', 'drafts'], 'properties')],
      ]);
  }
}

// ------------------------------------------------------------- persistence
const KEY = 'pipe-network-layout-v1';

export function serializeLayout(l: LayoutNode): string {
  return JSON.stringify(l);
}

function valid(n: unknown): n is LayoutNode {
  const x = n as { kind?: unknown; id?: unknown; panels?: unknown; active?: unknown; dir?: unknown; sizes?: unknown; children?: unknown } | null;
  if (!x || typeof x !== 'object' || typeof x.id !== 'string') return false;
  if (x.kind === 'group') return Array.isArray(x.panels) && x.panels.every((p) => ALL_PANELS.includes(p as PanelId)) && typeof x.active === 'string';
  if (x.kind === 'split') return (x.dir === 'row' || x.dir === 'col') && Array.isArray(x.children) && Array.isArray(x.sizes) && x.sizes.length === x.children.length && x.children.every(valid);
  return false;
}

/** Parse a saved layout; undefined if it is not a usable layout. */
export function parseLayout(text: string): LayoutNode | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    if (!valid(v)) return undefined;
    syncIds(v);
    return normalize(v);
  } catch {
    return undefined;
  }
}

function syncIds(n: LayoutNode): void {
  const k = Number(/(\d+)$/.exec(n.id)?.[1]);
  if (Number.isFinite(k) && k > counter) counter = k;
  if (n.kind === 'split') n.children.forEach(syncIds);
}

export function loadLayout(): LayoutNode {
  try {
    const t = localStorage.getItem(KEY);
    if (t) {
      const l = parseLayout(t);
      if (l) return l;
    }
  } catch {
    /* ignore */
  }
  return presetLayout('default');
}

export function saveLayout(l: LayoutNode): void {
  try {
    localStorage.setItem(KEY, serializeLayout(l));
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------- named layouts
const NAMED_KEY = 'pipe-network-named-layouts-v1';

export interface NamedLayout {
  name: string;
  layout: LayoutNode;
}

export function loadNamedLayouts(): NamedLayout[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NAMED_KEY) ?? '[]') as { name?: unknown; layout?: unknown }[];
    return raw.flatMap((r) => {
      const l = typeof r.name === 'string' && r.layout ? parseLayout(JSON.stringify(r.layout)) : undefined;
      return l ? [{ name: r.name as string, layout: l }] : [];
    });
  } catch {
    return [];
  }
}

/** Add (or replace, by name) a saved layout and return the new list. */
export function withNamedLayout(list: NamedLayout[], name: string, layout: LayoutNode): NamedLayout[] {
  const n = name.trim();
  if (!n) return list;
  return [...list.filter((x) => x.name !== n), { name: n, layout: normalize(layout) }];
}

export function saveNamedLayouts(list: NamedLayout[]): void {
  try {
    localStorage.setItem(NAMED_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
