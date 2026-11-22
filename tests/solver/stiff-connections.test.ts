import { describe, expect, it } from 'vitest';
import { blankProject, compute, makeEdge, newNode, type NodeUI, type PipeUI } from '../../src/model';

const tank = (name: string, x: number, z: number): NodeUI => ({ ...newNode('tank', x, 0, []), name, elevationM: z, levelM: 0 });
const junction = (name: string, x: number, z: number): NodeUI => ({ ...newNode('junction', x, 0, []), name, elevationM: z });
const pipe = (name: string, a: NodeUI, b: NodeUI, L: number, d: number, e: number): PipeUI => ({ ...(makeEdge('pipe', a.uid, b.uid, []) as PipeUI), name, lengthM: L, lengthMode: 'manual', diameterMm: d, roughnessMm: e, fittings: [] });

describe('stiff connections', () => {
  it('zero-length pipes feeding parallel pipes converge, to the rounding limit', () => {
    for (const L of [0, 0.001]) {
      const a = tank('A', 0, 30);
      const b = tank('B', 200, 10);
      const ja = junction('JA', 50, 30);
      const jb = junction('JB', 150, 10);
      const c = compute({ ...blankProject(), nodes: [a, b, ja, jb], edges: [pipe('In', a, ja, L, 400, 0), pipe('P1', ja, jb, 600, 150, 0.05), pipe('P2', ja, jb, 400, 100, 0.05), pipe('Out', jb, b, L, 400, 0)] });
      expect(c.result?.converged, c.result?.message).toBe(true);
      expect(c.result!.residualM3s).toBeLessThan(1e-8);
      const q = (id: string) => c.result!.pipes.find((p) => p.id === id)!.flowM3s;
      expect(Math.abs(q('In') - q('P1') - q('P2'))).toBeLessThan(1e-7);
    }
  });
});
