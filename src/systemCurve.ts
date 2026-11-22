import { solveSystem, type SystemModel, type SystemResult } from './solver/system';

/** Stiffness of the stand-in for the pump [m per m3/s]: it holds the flow to within a few hundredths of a litre per second. */
const STIFF = 2e5;

/**
 * The system curve seen by one pump: the head the rest of the network needs across the pump for each flow through it,
 * with every other pump running at its solved speed. Each point is a full network solution with the pump replaced by a
 * very stiff element that holds the flow; the flow actually reached and the head across it are reported, so each point is exact.
 */
export function systemCurve(model: SystemModel, result: SystemResult | undefined, pumpId: string, qMaxLps: number, points = 12): { q: number; h: number }[] {
  const pump = model.edges.find((e) => e.kind === 'pump' && e.id === pumpId);
  if (!pump || pump.kind !== 'pump') return [];
  const speeds = new Map(result?.pumps.map((p) => [p.id, p.speedRatio]) ?? []);
  const out: { q: number; h: number }[] = [];
  for (let i = 0; i <= points; i++) {
    const target = (qMaxLps / 1000) * (i / points);
    const m: SystemModel = {
      ...model,
      edges: model.edges.map((e) => {
        if (e.kind !== 'pump') return e;
        if (e.id !== pumpId) return { ...e, speedRatio: speeds.get(e.id) ?? e.speedRatio };
        return {
          ...e,
          running: true,
          speedRatio: 1,
          model: { ...e.model, head: { a0: STIFF * target, a1: -STIFF, a2: 0 }, headDataRange: { minFlowM3s: 0, maxFlowM3s: Math.max(target, 1e-6) * 2 } },
        };
      }),
    };
    try {
      const r = solveSystem(m, { flowTolM3s: 1e-10 });
      const pr = r.pumps.find((p) => p.id === pumpId);
      if (!r.converged || !pr) continue;
      out.push({ q: pr.flowM3s * 1000, h: pr.headM });
    } catch {
      /* a point that cannot be solved is left out */
    }
  }
  return out;
}
