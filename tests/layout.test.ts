import { describe, expect, it } from 'vitest';
import {
  ALL_PANELS,
  activatePanel,
  closePanel,
  findGroup,
  groupOfPanel,
  groupsOf,
  movePanel,
  normalize,
  openPanel,
  openPanels,
  parseLayout,
  presetLayout,
  serializeLayout,
  setActive,
  setSizes,
  PRESETS,
  type LayoutNode,
} from '../src/layout/layout';

/** The invariants every operation must keep. */
function check(l: LayoutNode): void {
  const panels = openPanels(l);
  expect(new Set(panels).size).toBe(panels.length); // each panel at most once
  const walk = (n: LayoutNode, parentDir?: string) => {
    if (n.kind === 'group') {
      expect(n.panels.length).toBeGreaterThan(0);
      expect(n.panels).toContain(n.active);
    } else {
      expect(n.children.length).toBeGreaterThanOrEqual(2);
      expect(n.dir).not.toBe(parentDir);
      expect(n.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(n.sizes.every((s) => s > 0)).toBe(true);
      n.children.forEach((c) => walk(c, n.dir));
    }
  };
  walk(l);
}

describe('layout presets and invariants', () => {
  it('every preset is valid and shows the network; the default shows every panel', () => {
    for (const p of PRESETS) {
      const l = presetLayout(p.id);
      check(l);
      expect(openPanels(l)).toContain('network');
    }
    expect(openPanels(presetLayout('default')).sort()).toEqual([...ALL_PANELS].sort());
  });
});

describe('layout operations', () => {
  const base = () => presetLayout('default');

  it('docks a panel at the left edge of a group, taking half its space', () => {
    const l = base();
    const g = groupOfPanel(l, 'network')!;
    const next = movePanel(l, 'results', g.id, 'left');
    check(next);
    const ng = groupOfPanel(next, 'results')!;
    expect(ng.panels).toEqual(['results']);
    expect(ng.id).not.toBe(groupOfPanel(next, 'network')!.id);
    expect(groupOfPanel(next, 'pumpchart')!.panels).not.toContain('results');
  });

  it('docks to the right and bottom with the right side-by-side order', () => {
    const l = base();
    const g = groupOfPanel(l, 'network')!;
    const right = movePanel(l, 'properties', g.id, 'right');
    check(right);
    const order = groupsOf(right).map((x) => x.panels[0]);
    expect(order.indexOf('network')).toBeLessThan(order.indexOf('properties'));
    const bottom = movePanel(l, 'ai', g.id, 'bottom');
    check(bottom);
    expect(groupOfPanel(bottom, 'ai')!.panels).toEqual(['ai']);
  });

  it('dropping in the middle adds a tab and makes it visible, and an emptied group disappears', () => {
    const start = base();
    let l = movePanel(start, 'ai', groupOfPanel(start, 'network')!.id, 'left'); // ai alone in a new group
    check(l);
    const aiGroup = groupOfPanel(l, 'ai')!.id;
    l = movePanel(l, 'ai', groupOfPanel(l, 'network')!.id, 'center');
    check(l);
    expect(groupOfPanel(l, 'network')!.panels).toContain('ai');
    expect(groupOfPanel(l, 'network')!.active).toBe('ai');
    expect(findGroup(l, aiGroup)).toBeUndefined();
  });

  it('dragging a lone panel onto its own edge changes nothing', () => {
    const l = base();
    const g = groupOfPanel(l, 'network')!;
    expect(g.panels).toEqual(['network']);
    expect(movePanel(l, 'network', g.id, 'left')).toBe(l);
  });

  it('closing panels removes empty groups and never leaves an empty layout', () => {
    let l = base();
    for (const p of ALL_PANELS) {
      l = closePanel(l, p);
      check(l);
    }
    expect(openPanels(l)).toEqual(['network']); // falls back to a single network panel
  });

  it('opens a closed panel as a tab, and activates an open one', () => {
    let l = closePanel(base(), 'view3d');
    expect(openPanels(l)).not.toContain('view3d');
    l = openPanel(l, 'view3d');
    check(l);
    expect(openPanels(l)).toContain('view3d');
    expect(groupOfPanel(l, 'view3d')!.active).toBe('view3d');
    const g = groupOfPanel(l, 'results')!;
    const act = activatePanel(l, 'results');
    expect(groupOfPanel(act, 'results')!.active).toBe('results');
    expect(activatePanel(act, 'results')).toBe(act); // unchanged: same object, so no re-render loop
    expect(setActive(l, g.id, 'results')).not.toBe(undefined);
  });

  it('opens into a preferred group', () => {
    const l = closePanel(base(), 'ai');
    const target = groupOfPanel(l, 'network')!.id;
    const next = openPanel(l, 'ai', target);
    expect(groupOfPanel(next, 'network')!.panels).toContain('ai');
  });

  it('resizes a split and ignores a wrong-length size list', () => {
    const l = base();
    expect(l.kind).toBe('split');
    if (l.kind !== 'split') return;
    const next = setSizes(l, l.id, [0.3, 0.7]);
    expect(next.kind === 'split' && next.sizes).toEqual([0.3, 0.7]);
    expect(setSizes(l, l.id, [1])).toBe(l);
  });

  it('flattens nested splits of the same direction and merges sizes', () => {
    const l = base();
    const g = groupOfPanel(l, 'properties')!;
    // dock two panels to the right of the same group: stays a flat row
    let n = movePanel(l, 'ai', g.id, 'right');
    n = movePanel(n, 'drafts', groupOfPanel(n, 'ai')!.id, 'right');
    check(n);
  });

  it('round-trips through JSON and rejects junk', () => {
    const l = presetLayout('ai');
    expect(parseLayout(serializeLayout(l))).toEqual(l);
    expect(parseLayout('nope')).toBeUndefined();
    expect(parseLayout(JSON.stringify({ kind: 'group', id: 'g1', panels: ['bogus'], active: 'bogus' }))).toBeUndefined();
    expect(parseLayout(JSON.stringify({ kind: 'split', id: 's', dir: 'row', sizes: [1], children: [] }))).toBeUndefined();
  });

  it('normalize repairs duplicates and empty groups', () => {
    const g = (id: string, panels: string[]) => ({ kind: 'group', id, panels, active: panels[0] ?? 'network' });
    const bad = { kind: 'split', id: 's1', dir: 'row', sizes: [0.5, 0.3, 0.2], children: [g('a', ['network', 'results']), g('b', []), g('c', ['results', 'ai'])] } as unknown as LayoutNode;
    const fixed = normalize(bad);
    check(fixed);
    expect(openPanels(fixed).sort()).toEqual(['ai', 'network', 'results']);
  });
});
