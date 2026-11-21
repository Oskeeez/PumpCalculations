import { describe, expect, it } from 'vitest';
import { copyNodes, moveNodes, nodesInRect, pasteClip, removeNodes } from '../src/clipboard';
import { compute, defaultProject } from '../src/model';

const uidsOf = (p: ReturnType<typeof defaultProject>, ...names: string[]) => new Set(p.nodes.filter((n) => names.includes(n.name)).map((n) => n.uid));

describe('copy and paste', () => {
  it('copies the chosen nodes with only the elements between them', () => {
    const p = defaultProject();
    const clip = copyNodes(p, uidsOf(p, 'J1', 'J2', 'Valve inlet'))!;
    expect(clip.nodes.map((n) => n.name).sort()).toEqual(['J1', 'J2', 'Valve inlet']);
    expect(clip.edges.map((e) => e.name).sort()).toEqual(['Pipe A', 'Pipe B']); // J1-J2 and J1-Valve inlet
    expect(copyNodes(p, new Set())).toBeUndefined();
  });

  it('pastes a shifted copy with new ids and unique names, leaving the original alone', () => {
    const p = defaultProject();
    const clip = copyNodes(p, uidsOf(p, 'J1', 'J2'))!;
    const { project, newNodeUids } = pasteClip(p, clip, { x: 50, y: 70 });
    expect(project.nodes).toHaveLength(p.nodes.length + 2);
    expect(project.edges).toHaveLength(p.edges.length + 1);
    expect(newNodeUids).toHaveLength(2);
    const names = [...project.nodes.map((n) => n.name), ...project.edges.map((e) => e.name)];
    expect(new Set(names).size).toBe(names.length);
    const uids = [...project.nodes.map((n) => n.uid), ...project.edges.map((e) => e.uid)];
    expect(new Set(uids).size).toBe(uids.length);
    const j1 = p.nodes.find((n) => n.name === 'J1')!;
    const copy = project.nodes.find((n) => newNodeUids.includes(n.uid) && n.x === j1.x + 50)!;
    expect(copy.y).toBe(j1.y + 70);
    // the pasted pipe joins the pasted nodes, not the originals
    const pipe = project.edges.find((e) => !p.edges.some((o) => o.uid === e.uid))!;
    expect(newNodeUids).toContain(pipe.from);
    expect(newNodeUids).toContain(pipe.to);
    expect(copy.name).toBe('J4'); // J1, J2 and J3 exist, so the copy of J1 follows on
    expect(project.nodes.find((n) => newNodeUids.includes(n.uid) && n.name !== 'J4')!.name).toBe('J5');
    expect(project.edges.find((e) => !p.edges.some((o) => o.uid === e.uid))!.name).toBe('Pipe A 2');
  });

  it('pasting twice never reuses a name, and pasted nodes are independent copies', () => {
    const p = defaultProject();
    const clip = copyNodes(p, uidsOf(p, 'J2', 'J3'))!;
    const once = pasteClip(p, clip).project;
    const twice = pasteClip(once, clip).project;
    const names = twice.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    clip.nodes[0].demandLps = 999; // changing the clip afterwards does not touch what was pasted
    expect(twice.nodes.some((n) => n.demandLps === 999)).toBe(false);
  });

  it('a pasted group that is connected to a supply still solves', () => {
    const p = defaultProject();
    const clip = copyNodes(p, uidsOf(p, 'J2', 'Tank B'))!;
    const { project } = pasteClip(p, clip);
    // the copy is an island (no path to a tank other than its own pasted tank), which is fine: a tank is a source
    expect(compute(project).error).toBeUndefined();
  });
});

describe('delete, move and box select', () => {
  it('deleting nodes takes the elements attached to them', () => {
    const p = defaultProject();
    const after = removeNodes(p, uidsOf(p, 'J2', 'J3'));
    expect(after.nodes.map((n) => n.name)).not.toContain('J2');
    expect(after.edges.some((e) => e.name === 'Cross link' || e.name === 'Pipe A')).toBe(false);
    expect(after.edges.every((e) => after.nodes.some((n) => n.uid === e.from) && after.nodes.some((n) => n.uid === e.to))).toBe(true);
  });

  it('moves only the listed nodes', () => {
    const p = defaultProject();
    const j2 = p.nodes.find((n) => n.name === 'J2')!;
    const moved = moveNodes(p, new Map([[j2.uid, { x: 1, y: 2 }]]));
    expect(moved.nodes.find((n) => n.uid === j2.uid)).toMatchObject({ x: 1, y: 2 });
    expect(moved.nodes.filter((n) => n.uid !== j2.uid)).toEqual(p.nodes.filter((n) => n.uid !== j2.uid));
  });

  it('box select picks the nodes inside, whichever corner you start from', () => {
    const p = defaultProject();
    const inside = nodesInRect(p.nodes, { x: 600, y: 100 }, { x: 900, y: 420 }); // right-hand side: J2, J3, Tank B, Tank C
    expect(p.nodes.filter((n) => inside.includes(n.uid)).map((n) => n.name).sort()).toEqual(['J2', 'J3', 'Tank B', 'Tank C']);
    expect(nodesInRect(p.nodes, { x: 900, y: 420 }, { x: 600, y: 100 })).toEqual(inside);
    expect(nodesInRect(p.nodes, { x: 0, y: 0 }, { x: 5, y: 5 })).toEqual([]);
  });
});
