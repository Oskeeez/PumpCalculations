import { describe, expect, it } from 'vitest';
import { craneFT, defaultFitting, elbowK, fittingK, FITTING_LIBRARY, junctionLegLosses, reducerK, teeBranchK, teeRunK, valveTypeK, type JunctionFitting } from '../src/fittings';

const node = (uid: string, x: number, y: number, fitting?: JunctionFitting) => ({ uid, kind: 'junction', x, y, fitting });
const pipe = (uid: string, from: string, to: string, d = 100) => ({ uid, kind: 'pipe', from, to, diameterMm: d });
const sum = (m: Map<string, number>, ...ids: string[]) => ids.reduce((s, i) => s + (m.get(i) ?? 0), 0);

describe('fitting losses', () => {
  it('uses Crane values for a 90 degree standard elbow', () => {
    expect(elbowK(90, 'standard', 102)).toBeCloseTo(30 * 0.017, 6);
    expect(elbowK(45, 'standard', 102)).toBeCloseTo(16 * 0.017, 6);
    expect(elbowK(0, 'standard', 102)).toBe(0);
    expect(elbowK(90, 'long', 102)).toBeLessThan(elbowK(90, 'standard', 102));
    expect(elbowK(90, 'mitre', 102)).toBeGreaterThan(elbowK(90, 'standard', 102));
    expect(elbowK(60, 'standard', 102)).toBeGreaterThan(elbowK(45, 'standard', 102));
  });

  it('gives a wye branch less loss than a tee branch', () => {
    expect(teeBranchK(90, 100)).toBeCloseTo(60 * craneFT(100), 9);
    expect(teeBranchK(45, 100)).toBeLessThan(teeBranchK(90, 100));
    expect(teeRunK(100)).toBeCloseTo(20 * craneFT(100), 9);
  });

  it('reducers: sudden contraction and expansion, none for equal sizes', () => {
    expect(reducerK(50, 100, 180, 'contraction')).toBeCloseTo(0.5 * (1 - 0.25), 9);
    expect(reducerK(50, 100, 180, 'expansion')).toBeCloseTo((1 - 0.25) ** 2, 9);
    expect(reducerK(50, 100, 20, 'contraction')).toBeLessThan(reducerK(50, 100, 180, 'contraction'));
    expect(reducerK(100, 100, 180, 'expansion')).toBe(0);
  });

  it('valve and library K scale with fT', () => {
    expect(valveTypeK('gate', 100)).toBeCloseTo(8 * craneFT(100), 9);
    expect(valveTypeK('nothing', 100)).toBeUndefined();
    expect(fittingK({ category: 'x', name: 'y', k: 0.5, source: 'test' }, 100)).toBe(0.5);
    expect(FITTING_LIBRARY.length).toBeGreaterThanOrEqual(30);
  });
});

describe('fittings on a network', () => {
  it('elbow: angle from the drawing, loss split between the two pipes', () => {
    const nodes = [node('a', 0, 0), node('j', 100, 0, defaultFitting('elbow')), node('b', 100, 100)];
    const pipes = [pipe('p1', 'a', 'j'), pipe('p2', 'j', 'b')];
    const m = junctionLegLosses(nodes, pipes);
    expect(sum(m, 'p1', 'p2')).toBeCloseTo(elbowK(90, 'standard', 100), 9);
    // a gentle bend loses less
    const gentle = junctionLegLosses([node('a', 0, 0), node('j', 100, 0, defaultFitting('elbow')), node('b', 200, 40)], pipes);
    expect(sum(gentle, 'p1', 'p2')).toBeLessThan(sum(m, 'p1', 'p2'));
  });

  it('elbow: typed angle when not taken from the drawing', () => {
    const f = { ...defaultFitting('elbow'), fromDrawing: false, angleDeg: 45 };
    const m = junctionLegLosses([node('a', 0, 0), node('j', 100, 0, f), node('b', 200, 0)], [pipe('p1', 'a', 'j'), pipe('p2', 'j', 'b')]);
    expect(sum(m, 'p1', 'p2')).toBeCloseTo(elbowK(45, 'standard', 100), 9);
  });

  it('tee: run to run and run to branch match the Crane values', () => {
    const nodes = [node('a', 0, 0), node('j', 100, 0, defaultFitting('tee')), node('b', 200, 0), node('c', 100, 100)];
    const pipes = [pipe('run1', 'a', 'j'), pipe('run2', 'j', 'b'), pipe('br', 'j', 'c')];
    const m = junctionLegLosses(nodes, pipes);
    expect(sum(m, 'run1', 'run2')).toBeCloseTo(teeRunK(100), 9);
    expect(sum(m, 'run1', 'br')).toBeCloseTo(teeBranchK(90, 100), 9);
  });

  it('wye: branch angle from the drawing lowers the branch loss', () => {
    const nodes = [node('a', 0, 0), node('j', 100, 0, defaultFitting('wye')), node('b', 200, 0), node('c', 170, 70)];
    const pipes = [pipe('run1', 'a', 'j'), pipe('run2', 'j', 'b'), pipe('br', 'j', 'c')];
    const m = junctionLegLosses(nodes, pipes);
    expect(sum(m, 'run1', 'br')).toBeLessThan(teeBranchK(90, 100));
    expect(sum(m, 'run1', 'br')).toBeGreaterThan(teeRunK(100) / 2);
  });

  it('a chosen branch overrides the drawing', () => {
    const f = { ...defaultFitting('tee'), branchUid: 'run1' };
    const nodes = [node('a', 0, 0), node('j', 100, 0, f), node('b', 200, 0), node('c', 100, 100)];
    const m = junctionLegLosses(nodes, [pipe('run1', 'a', 'j'), pipe('run2', 'j', 'b'), pipe('br', 'j', 'c')]);
    expect(m.get('run1')!).toBeGreaterThan(m.get('br')!);
  });

  it('cross, reducer, and a fitting with the wrong number of pipes', () => {
    const cross = junctionLegLosses(
      [node('a', 0, 0), node('j', 100, 0, defaultFitting('cross')), node('b', 200, 0), node('c', 100, 100), node('d', 100, -100)],
      [pipe('p1', 'a', 'j'), pipe('p2', 'j', 'b'), pipe('p3', 'j', 'c'), pipe('p4', 'd', 'j')],
    );
    expect(cross.size).toBe(4);
    const red = junctionLegLosses([node('a', 0, 0), node('j', 100, 0, { ...defaultFitting('reducer'), coneDeg: 180 }), node('b', 200, 0)], [pipe('big', 'a', 'j', 100), pipe('small', 'j', 'b', 50)]);
    expect(red.get('small')).toBeCloseTo(reducerK(50, 100, 180, 'contraction'), 9);
    expect(red.has('big')).toBe(false);
    const wrong = junctionLegLosses([node('a', 0, 0), node('j', 100, 0, defaultFitting('tee')), node('b', 200, 0)], [pipe('p1', 'a', 'j'), pipe('p2', 'j', 'b')]);
    expect(wrong.size).toBe(0);
  });
});

import { blankProject, makeEdge, newNode, setJunctionFitting, toSystemModel, compute } from '../src/model';

describe('fittings in the solver', () => {
  it('an elbow adds loss to the two pipes at the junction and changes the result', () => {
    const a = newNode('tank', 0, 0, []);
    const j = newNode('junction', 100, 0, []);
    const b = newNode('junction', 100, 100, ['Junction 1']);
    const base = blankProject();
    const p = { ...base, nodes: [a, j, b], edges: [makeEdge('pipe', a.uid, j.uid, [], 100), makeEdge('pipe', j.uid, b.uid, ['Pipe 1'], 100)] };
    const withElbow = setJunctionFitting(p, j.uid, 'elbow');
    expect(withElbow.nodes.find((n) => n.uid === j.uid)!.name).toMatch(/^Elbow/);
    const kSum = (proj: typeof p) => toSystemModel(proj).edges.reduce((s, e) => s + (e.kind === 'pipe' ? (e.spec.fittingsK ?? []).reduce((a, b) => a + b, 0) : 0), 0);
    expect(kSum(withElbow)).toBeGreaterThan(kSum(p));
    expect(compute(withElbow).error).toBeUndefined();
    expect(setJunctionFitting(withElbow, j.uid, 'none').nodes.find((n) => n.uid === j.uid)!.name).toMatch(/^Junction/);
  });
});

describe('own loss values', () => {
  it('replace the calculated losses', () => {
    const nodes = (f: JunctionFitting) => [node('a', 0, 0), node('j', 100, 0, f), node('b', 100, 100)];
    const pipes = [pipe('p1', 'a', 'j'), pipe('p2', 'j', 'b')];
    const elbow = { ...defaultFitting('elbow'), override: { k: 0.9 } };
    expect(sum(junctionLegLosses(nodes(elbow), pipes), 'p1', 'p2')).toBeCloseTo(0.9, 10);
    const tn = [node('a', 0, 0), node('j', 100, 0, { ...defaultFitting('tee'), override: { runK: 0.2, branchK: 1.1 } }), node('b', 200, 0), node('c', 100, 100)];
    const m = junctionLegLosses(tn, [pipe('run1', 'a', 'j'), pipe('run2', 'j', 'b'), pipe('br', 'j', 'c')]);
    expect(sum(m, 'run1', 'run2')).toBeCloseTo(0.2, 10);
    expect(sum(m, 'run1', 'br')).toBeCloseTo(1.1, 10);
  });
});
