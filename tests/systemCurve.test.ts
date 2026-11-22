import { describe, expect, it } from 'vitest';
import { systemCurve } from '../src/systemCurve';
import { compute, defaultProject } from '../src/model';
import { G } from '../src/solver/constants';

describe('system curve', () => {
  it('passes through the operating point and rises with flow', () => {
    const p = defaultProject();
    const c = compute(p);
    const pump = c.result!.pumps[0];
    const curve = systemCurve(c.model!, c.result, pump.id, pump.flowM3s * 1000 * 1.5, 12);
    expect(curve.length).toBeGreaterThan(10);
    for (let i = 1; i < curve.length; i++) expect(curve[i].h).toBeGreaterThan(curve[i - 1].h - 1e-6);
    // interpolate at the operating flow
    const q = pump.flowM3s * 1000;
    const j = curve.findIndex((x) => x.q >= q);
    const a = curve[j - 1];
    const b = curve[j];
    const h = a.h + ((b.h - a.h) * (q - a.q)) / (b.q - a.q);
    expect(Math.abs(h - pump.headM)).toBeLessThan(0.05 * pump.headM + 0.2);
  });

  it('for one pipe between two tanks it is the static lift plus the pipe loss', () => {
    const fluid = { name: 'w', temperatureC: 20, density: 998, dynamicViscosity: 0.001, vaporPressure: 2339 };
    const model = {
      fluid,
      nodes: [
        { kind: 'tank' as const, id: 'A', elevationM: 0, liquidLevelM: 1, surfacePressurePa: 101325 },
        { kind: 'junction' as const, id: 'J', elevationM: 0, demandM3s: 0 },
        { kind: 'tank' as const, id: 'B', elevationM: 20, liquidLevelM: 1, surfacePressurePa: 101325 },
      ],
      edges: [
        { kind: 'pump' as const, id: 'P', from: 'A', to: 'J', speedRatio: 1, model: { head: { a0: 40, a1: 0, a2: -1e4 }, headDataRange: { minFlowM3s: 0, maxFlowM3s: 0.05 }, fitRmse: { head: 0 } } },
        { kind: 'pipe' as const, id: 'L', from: 'J', to: 'B', spec: { lengthM: 100, innerDiameterM: 0.1, roughnessM: 0, elevationChangeM: 0, fittingsK: [10] } },
      ],
    };
    const curve = systemCurve(model, undefined, 'P', 20, 4);
    expect(curve[0].h).toBeCloseTo(20, 1);
    // at high flow the K = 10 term dominates the friction: check it is above static plus the K loss alone
    const last = curve[curve.length - 1];
    const v = last.q / 1000 / (Math.PI * 0.05 ** 2);
    expect(last.h).toBeGreaterThan(20 + (10 * v * v) / (2 * G));
  });
});
