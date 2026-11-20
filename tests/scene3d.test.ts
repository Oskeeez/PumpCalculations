import { describe, expect, it } from 'vitest';
import { blankProject, compute, defaultProject, newNode, newPipe } from '../src/model';
import { buildScene } from '../src/scene3d';

describe('3D scene description', () => {
  const p = defaultProject();
  const scene = buildScene(p, compute(p).result);

  it('places each node at (x, y) from the canvas scale and z from its height', () => {
    const supply = scene.nodes.find((n) => n.name === 'Supply tank')!;
    expect(supply.pos.x).toBeCloseTo(90 * 0.1, 9);
    expect(supply.pos.y).toBeCloseTo((620 - 260) * 0.1, 9);
    expect(supply.pos.z).toBe(0);
    const tb = scene.nodes.find((n) => n.name === 'Tank B')!;
    expect(tb.pos.z).toBe(20);
    expect(tb.fluidHeightM).toBe(3);
    expect(tb.surfaceZ).toBe(23);
  });

  it('follows the scale: doubling it doubles plan coordinates and leaves heights alone', () => {
    const s2 = buildScene({ ...p, scaleMPerPx: 0.2 });
    const a = scene.nodes.find((n) => n.name === 'J2')!;
    const b = s2.nodes.find((n) => n.name === 'J2')!;
    expect(b.pos.x).toBeCloseTo(a.pos.x * 2, 9);
    expect(b.pos.z).toBe(a.pos.z);
  });

  it('lists every element with its end points, velocities from the solution and bounds that contain everything', () => {
    expect(scene.edges).toHaveLength(p.edges.length);
    const pipe = scene.edges.find((e) => e.name === 'Pipe A')!;
    expect(pipe.fromName).toBe('J1');
    expect(pipe.toName).toBe('J2');
    expect(pipe.velocity).toBeGreaterThan(0);
    expect(pipe.diameterM).toBeCloseTo(0.1, 9);
    expect(pipe.lengthM).toBe(150); // manual length in the example
    for (const n of scene.nodes) {
      expect(n.pos.x).toBeGreaterThanOrEqual(scene.min.x);
      expect(n.pos.x).toBeLessThanOrEqual(scene.max.x);
      expect(n.surfaceZ).toBeLessThanOrEqual(scene.max.z);
    }
    expect(scene.max.z).toBe(23); // top of Tank B's fluid
  });

  it('a canvas-sized pipe reports the same length as the straight-line distance between its nodes', () => {
    const base = blankProject();
    const a = { ...newNode('tank', 100, 300, []), elevationM: 5 };
    const b = { ...newNode('junction', 400, 100, ['x']), elevationM: 9, name: 'B' };
    const pipe = newPipe(a.uid, b.uid, []);
    const sc = buildScene({ ...base, nodes: [a, b], edges: [pipe] });
    expect(sc.edges[0].lengthM).toBeCloseTo(sc.edges[0].straightM, 9);
    expect(sc.edges[0].straightM).toBeCloseTo(Math.hypot(Math.hypot(300, 200) * 0.1, 4), 9);
  });

  it('copes with an empty project', () => {
    const empty = buildScene(blankProject());
    expect(empty.nodes).toEqual([]);
    expect(empty.max.x).toBeGreaterThan(empty.min.x);
  });
});
