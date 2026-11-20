import { describe, expect, it } from 'vitest';
import {
  analyzeSeries,
  findOperatingPoint,
  fitPump,
  G,
  P_ATM,
  pipeArea,
  pumpHead,
  systemHead,
  tankHead,
  water,
  type Fluid,
  type PipeSpec,
  type SeriesSystem,
  type Tank,
} from '../../src/solver';

const atmTank = (elevationM: number, liquidLevelM: number): Tank => ({
  elevationM,
  liquidLevelM,
  surfacePressurePa: P_ATM,
});

describe('operating point: hand-calculated laminar case', () => {
  // Viscous oil keeps the pipe laminar, so H_sys(Q) is  H_static + R Q + C Q^2  in closed form.
  const oil: Fluid = { name: 'oil', temperatureC: 20, density: 900, dynamicViscosity: 0.2, vaporPressure: 1000 };
  const D = 0.05;
  const L = 50;
  const K = 5 + 3;
  const pipe: PipeSpec = { lengthM: L, innerDiameterM: D, roughnessM: 0, elevationChangeM: 10, fittingsK: [5, 3] };
  // Pump: H = 40 - 5000 Q - 1e6 Q^2   (exactly representable by the quadratic fit)
  const pumpFn = (q: number) => 40 - 5000 * q - 1e6 * q * q;
  const model = fitPump({ head: [0, 0.001, 0.002, 0.003].map((q) => ({ flowM3s: q, headM: pumpFn(q) })) });
  const sys: SeriesSystem = {
    fluid: oil,
    source: atmTank(0, 2), // surface head 2 m
    destination: atmTank(10, 2), // surface head 12 m  => H_static = 10 m
    elements: [
      { kind: 'pump', id: 'P1', model, speedRatio: 1 },
      { kind: 'pipe', id: 'L1', spec: pipe },
    ],
  };

  it('matches the closed-form quadratic solution', () => {
    const A = pipeArea(D);
    const R = (32 * oil.dynamicViscosity * L) / (oil.density * G * D * D * A); // laminar: h_f = R Q
    const C = K / (2 * G * A * A); // minor: h_m = C Q^2
    // 40 - 5000Q - 1e6Q^2 = 10 + R Q + C Q^2   ->  (1e6 + C) Q^2 + (5000 + R) Q - 30 = 0
    const a = 1e6 + C;
    const b = 5000 + R;
    const c = -30;
    const qExpected = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);

    const op = findOperatingPoint(sys);
    expect(op.status).toBe('ok');
    expect(op.flowM3s).toBeCloseTo(qExpected, 10);
    expect(op.headM).toBeCloseTo(pumpFn(qExpected), 8);
    expect(op.headM).toBeCloseTo(systemHead(sys, op.flowM3s), 8);
  });
});

describe('operating point: water system', () => {
  const w = water(20);
  const model = fitPump({
    head: [
      { flowM3s: 0, headM: 50 },
      { flowM3s: 0.01, headM: 46 },
      { flowM3s: 0.02, headM: 38 },
      { flowM3s: 0.03, headM: 26 },
    ],
    efficiency: [
      { flowM3s: 0.005, eta: 0.4 },
      { flowM3s: 0.015, eta: 0.7 },
      { flowM3s: 0.025, eta: 0.65 },
    ],
    npshr: [
      { flowM3s: 0, npshrM: 1.5 },
      { flowM3s: 0.02, npshrM: 2.5 },
      { flowM3s: 0.03, npshrM: 4 },
    ],
  });
  const suction: PipeSpec = { lengthM: 10, innerDiameterM: 0.15, roughnessM: 0.045e-3, elevationChangeM: 0, fittingsK: [0.5, 0.2] };
  const discharge: PipeSpec = { lengthM: 200, innerDiameterM: 0.1, roughnessM: 0.045e-3, elevationChangeM: 15, fittingsK: [1, 2, 0.3] };
  const base: SeriesSystem = {
    fluid: w,
    source: atmTank(0, 3),
    destination: atmTank(15, 2),
    elements: [
      { kind: 'pipe', id: 'suction', spec: suction },
      { kind: 'pump', id: 'P1', model, speedRatio: 1 },
      { kind: 'pipe', id: 'discharge', spec: discharge },
    ],
  };

  it('finds an intersection where H_pump = H_sys', () => {
    const op = findOperatingPoint(base);
    expect(op.status).toBe('ok');
    expect(op.flowM3s).toBeGreaterThan(0);
    const hp = pumpHead(model, op.flowM3s);
    const hs = systemHead(base, op.flowM3s);
    expect(Math.abs(hp - hs)).toBeLessThan(1e-9);
  });

  it('reports clearly when static head exceeds the pump shutoff head', () => {
    const op = findOperatingPoint({ ...base, destination: atmTank(80, 2) });
    expect(op.status).toBe('no-intersection');
    expect(op.flowM3s).toBe(0);
    expect(op.message).toMatch(/shutoff head/i);
  });

  it('raises flow when pump speed increases (affinity-scaled curve)', () => {
    const slow = findOperatingPoint({ ...base, elements: base.elements.map((e) => (e.kind === 'pump' ? { ...e, speedRatio: 0.85 } : e)) });
    const fast = findOperatingPoint({ ...base, elements: base.elements.map((e) => (e.kind === 'pump' ? { ...e, speedRatio: 1.1 } : e)) });
    const rated = findOperatingPoint(base);
    expect(slow.flowM3s).toBeLessThan(rated.flowM3s);
    expect(fast.flowM3s).toBeGreaterThan(rated.flowM3s);
  });

  it('computes NPSHa consistently with NPSHa = (ps - pv)/(rho g) + vs^2/2g + zs - hf,suction', () => {
    const op = findOperatingPoint(base);
    const res = analyzeSeries(base, op.flowM3s);
    const pump = res.pumps[0];
    const suctionLoss = res.pipes[0].flow.totalHeadLoss;
    const vs = op.flowM3s / pipeArea(suction.innerDiameterM);
    const zs = base.source.liquidLevelM + base.source.elevationM - (base.source.elevationM + suction.elevationChangeM); // surface above pump
    const expected = (P_ATM - w.vaporPressure) / (w.density * G) + (vs * vs) / (2 * G) + zs - suctionLoss;
    expect(pump.npshaM).toBeCloseTo(expected, 9);
    expect(pump.npshMarginM).toBeCloseTo(pump.npshaM - (pump.npshrM as number), 12);
    expect(pump.warnings).toHaveLength(0);
  });

  it('warns when NPSHa < NPSHr + margin (low suction pressure)', () => {
    const vacuum: SeriesSystem = { ...base, source: { ...base.source, liquidLevelM: 0.5, surfacePressurePa: 10000 } };
    const op = findOperatingPoint(vacuum);
    const res = analyzeSeries(vacuum, op.flowM3s);
    expect(res.pumps[0].npshaM).toBeLessThan((res.pumps[0].npshrM as number) + 0.5);
    expect(res.pumps[0].warnings.join(' ')).toMatch(/cavitation/i);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('reports shaft power = rho g Q H / eta', () => {
    const op = findOperatingPoint(base);
    const p = analyzeSeries(base, op.flowM3s).pumps[0];
    expect(p.shaftPowerW).toBeCloseTo((w.density * G * op.flowM3s * p.headM) / (p.efficiency as number), 6);
  });

  it('node heads close the energy balance from source to destination', () => {
    const op = findOperatingPoint(base);
    const res = analyzeSeries(base, op.flowM3s);
    const last = res.nodes[res.nodes.length - 1];
    expect(last.headM).toBeCloseTo(tankHead(base.destination, w), 8);
  });
});
