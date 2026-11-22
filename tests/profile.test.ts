import { describe, expect, it } from 'vitest';
import { findPath, profile } from '../src/profile';
import { compute, defaultProject, pipeLengthM } from '../src/model';

describe('HGL profile', () => {
  const p = defaultProject();
  const c = compute(p);
  const tanks = p.nodes.filter((n) => n.kind === 'tank');

  it('finds a connected path and measures it along the pipes', () => {
    const path = findPath(p, tanks[0].uid, tanks[1].uid)!;
    expect(path.nodes[0].uid).toBe(tanks[0].uid);
    expect(path.nodes[path.nodes.length - 1].uid).toBe(tanks[1].uid);
    expect(path.edges.length).toBe(path.nodes.length - 1);
    const pts = profile(p, c.result!, path);
    const total = path.edges.reduce((s, e) => s + (e.kind === 'pipe' ? pipeLengthM(p, e) : 0), 0);
    expect(pts[pts.length - 1].s).toBeCloseTo(total, 9);
    for (const pt of pts) {
      expect(pt.eglM).toBeGreaterThanOrEqual(pt.hglM);
      expect(Number.isFinite(pt.hglM)).toBe(true);
    }
    // a tank's grade is its surface level
    const t = tanks[0];
    expect(pts[0].hglM).toBeCloseTo(t.elevationM + t.levelM + (t.pressureKPa - 101.325) / (998.2 * 9.80665 / 1000), 1);
  });

  it('returns nothing for nodes that are not connected', () => {
    const lone = { ...p, nodes: [...p.nodes, { ...p.nodes[0], uid: 'lone', name: 'Lone' }] };
    expect(findPath(lone, tanks[0].uid, 'lone')).toBeUndefined();
  });
});
