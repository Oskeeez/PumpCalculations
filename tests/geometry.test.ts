import { describe, expect, it } from 'vitest';
import { calibrate, lengthFromCanvas, nodeWorld, planDistancePx } from '../src/geometry';
import { compute, defaultProject, hydraulicKey, newNode, newPipe, parseProject, pipeLengthM, serializeProject } from '../src/model';

describe('geometry', () => {
  it('maps canvas pixels to world metres with Y up from the bottom-left corner', () => {
    const w = nodeWorld({ x: 200, y: 120, elevationM: 7 }, 0.1, 620);
    expect(w).toEqual({ x: 20, y: 50, z: 7 });
  });

  it('pipe length is the 3D distance: plan distance from the scale plus the elevation difference', () => {
    // 300 px x 400 px = 500 px; at 0.1 m/px = 50 m plan; 120 m rise... use 30 m rise -> sqrt(50^2 + 30^2)
    const a = { x: 100, y: 100, elevationM: 0 };
    const b = { x: 400, y: 500, elevationM: 30 };
    expect(planDistancePx(a, b)).toBe(500);
    expect(lengthFromCanvas(a, b, 0.1)).toBeCloseTo(Math.hypot(50, 30), 12);
    expect(lengthFromCanvas(a, { ...b, elevationM: 0 }, 0.1)).toBeCloseTo(50, 12);
  });

  it('calibrates the scale from two points and a real distance', () => {
    expect(calibrate({ x: 0, y: 0 }, { x: 300, y: 400 }, 25)).toBeCloseTo(0.05, 12);
    expect(calibrate({ x: 5, y: 5 }, { x: 5, y: 5 }, 25)).toBeUndefined();
    expect(calibrate({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toBeUndefined();
    expect(calibrate({ x: 0, y: 0 }, { x: 10, y: 0 }, Number.NaN)).toBeUndefined();
  });
});

describe('canvas-sized pipes in the model', () => {
  const base = defaultProject();
  const withCanvasPipe = () => {
    const a = newNode('junction', 100, 600, base.nodes.map((n) => n.name));
    const b = newNode('junction', 400, 600, [...base.nodes.map((n) => n.name), a.name]);
    const pipe = newPipe(a.uid, b.uid, base.edges.map((e) => e.name));
    return { a, b, pipe };
  };

  it('a pipe drawn on the canvas takes its length from the node distance and scale', () => {
    const { a, b, pipe } = withCanvasPipe();
    expect(pipe.lengthMode).toBe('canvas');
    const p = { ...base, nodes: [...base.nodes, a, b], edges: [...base.edges, pipe] };
    expect(pipeLengthM(p, pipe)).toBeCloseTo(30, 9); // 300 px * 0.1 m/px, same elevation
    expect(pipeLengthM({ ...p, scaleMPerPx: 0.2 }, pipe)).toBeCloseTo(60, 9);
    expect(pipeLengthM(p, { ...pipe, lengthMode: 'manual', lengthM: 12 })).toBe(12);
  });

  it('moving a node changes the hydraulic key only when a pipe uses canvas length', () => {
    const moved = { ...base, nodes: base.nodes.map((n, i) => (i === 0 ? { ...n, x: n.x + 50 } : n)) };
    expect(hydraulicKey(moved)).toBe(hydraulicKey(base)); // example pipes are manual
    const { a, b, pipe } = withCanvasPipe();
    const p = { ...base, nodes: [...base.nodes, a, b], edges: [...base.edges, pipe] };
    const p2 = { ...p, nodes: p.nodes.map((n) => (n.uid === b.uid ? { ...n, x: n.x + 50 } : n)) };
    expect(hydraulicKey(p2)).not.toBe(hydraulicKey(p));
  });

  it('a longer canvas distance gives a smaller flow between the same two tanks', () => {
    const { pipe } = withCanvasPipe();
    const mk = (bx: number) => {
      const ta = { ...newNode('tank', 100, 500, ['x']), name: 'TA', elevationM: 10, levelM: 2 };
      const tb = { ...newNode('tank', bx, 500, ['x', 'TA']), name: 'TB', elevationM: 0, levelM: 1 };
      return compute({ ...base, nodes: [ta, tb], edges: [{ ...pipe, from: ta.uid, to: tb.uid }] }).result!.pipes[0];
    };
    const near = mk(300);
    const far = mk(900);
    expect(near.flowM3s).toBeGreaterThan(0);
    expect(far.flowM3s).toBeGreaterThan(0);
    expect(far.flowM3s).toBeLessThan(near.flowM3s);
  });

  it('scale, canvas size, images and pipe length mode survive save and load; old files get defaults', () => {
    const { a, b, pipe } = withCanvasPipe();
    const img = { id: 'i1', name: 'plan.png', dataUrl: 'data:image/png;base64,AAAA', x: 10, y: 20, width: 300, height: 200, opacity: 0.5, locked: true };
    const p = { ...base, nodes: [...base.nodes, a, b], edges: [...base.edges, pipe], scaleMPerPx: 0.25, canvasW: 1600, canvasH: 900, images: [img] };
    const back = parseProject(serializeProject(p));
    expect(back.scaleMPerPx).toBe(0.25);
    expect([back.canvasW, back.canvasH]).toEqual([1600, 900]);
    expect(back.images).toEqual([img]);
    expect(back.edges.find((e) => e.uid === pipe.uid)).toMatchObject({ lengthMode: 'canvas' });

    const legacy = JSON.parse(serializeProject(base));
    delete legacy.project.scaleMPerPx;
    delete legacy.project.images;
    legacy.project.edges.forEach((e: { lengthMode?: string }) => delete e.lengthMode);
    const old = parseProject(JSON.stringify(legacy));
    expect(old.scaleMPerPx).toBe(0.1);
    expect(old.images).toEqual([]);
    expect(old.edges.filter((e) => e.kind === 'pipe').every((e) => e.kind === 'pipe' && e.lengthMode === 'manual')).toBe(true);
  });

  it('rejects a malformed image and a non-positive scale', () => {
    const bad = JSON.parse(serializeProject(base));
    bad.project.images = [{ id: 'x', name: 'n', dataUrl: 5 }];
    expect(() => parseProject(JSON.stringify(bad))).toThrow(/image/i);
    expect(compute({ ...base, scaleMPerPx: 0 }).error).toMatch(/scale/i);
  });
});
