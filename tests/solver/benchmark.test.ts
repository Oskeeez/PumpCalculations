import { describe, expect, it } from 'vitest';
import { P_ATM, fluidAt, solveSystem, type SysEdge, type SysNode, type SystemModel } from '../../src/solver';

/** An n x n grid of junctions with a pipe between neighbours, fed from one tank at the corner, with a small demand at every junction. */
export function gridNetwork(n: number): SystemModel {
  const id = (i: number, j: number) => `J${i}_${j}`;
  const nodes: SysNode[] = [{ kind: 'tank', id: 'T', elevationM: 0, liquidLevelM: 60, surfacePressurePa: P_ATM }];
  const edges: SysEdge[] = [];
  const pipe = (name: string, from: string, to: string, dMm: number): SysEdge => ({ kind: 'pipe', id: name, from, to, spec: { lengthM: 100, innerDiameterM: dMm / 1000, roughnessM: 0.0001, elevationChangeM: 0, fittingsK: [] } });
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) nodes.push({ kind: 'junction', id: id(i, j), elevationM: 0, demandM3s: 0.0002 });
  edges.push(pipe('feed', 'T', id(0, 0), 400));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) edges.push(pipe(`v${i}_${j}`, id(i, j), id(i + 1, j), 150));
      if (j + 1 < n) edges.push(pipe(`h${i}_${j}`, id(i, j), id(i, j + 1), 150));
    }
  }
  return { fluid: fluidAt('water', 20), nodes, edges };
}

describe('large networks', () => {
  for (const [n, limitMs] of [[7, 2000], [15, 5000], [32, 30000]] as const) {
    it(`a ${n} x ${n} grid solves, conserves mass, and takes well under ${limitMs / 1000} s`, () => {
      const model = gridNetwork(n);
      const t0 = performance.now();
      const r = solveSystem(model);
      const ms = performance.now() - t0;
      console.log(`grid ${n}x${n}: ${model.edges.length} pipes, ${model.nodes.length} nodes: ${ms.toFixed(0)} ms, ${r.iterations} iterations`);
      expect(r.converged).toBe(true);
      const demand = n * n * 0.2; // L/s
      expect(r.pipes.find((p) => p.id === 'feed')!.flowM3s * 1000).toBeCloseTo(demand, 3);
      expect(ms).toBeLessThan(limitMs);
    });
  }
});
