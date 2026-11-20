import { describe, expect, it } from 'vitest';
import {
  createPipeElement,
  createPumpElement,
  fitPump,
  G,
  hydraulicPower,
  pipeFlowState,
  pumpEfficiency,
  pumpHead,
  pumpNpshr,
  shaftPower,
  water,
  type PipeSpec,
} from '../../src/solver';

const pipe: PipeSpec = {
  lengthM: 100,
  innerDiameterM: 0.1,
  roughnessM: 0.045e-3,
  elevationChangeM: 0,
  fittingsK: [0.5, 1.0],
};

describe('pipe losses', () => {
  it('matches a hand calculation (water 20 degC, Q = 10 L/s)', () => {
    const w = { ...water(20), density: 998.2, dynamicViscosity: 1.002e-3 };
    const st = pipeFlowState(pipe, w, 0.01);
    // v = Q/A = 0.01 / (pi/4 * 0.01) = 1.27324 m/s ; v^2/2g = 0.082644 m
    expect(st.velocity).toBeCloseTo(1.27324, 5);
    // Re = rho v D / mu = 998.2*1.27324*0.1/1.002e-3 = 126,840
    expect(st.reynolds).toBeCloseTo(126840, -2);
    // e/D = 4.5e-4, Re ~1.27e5: Haaland by hand gives 1/sqrt(f) = 7.205 -> f = 0.01926; Colebrook ~0.0195
    expect(st.frictionFactor).toBeGreaterThan(0.019);
    expect(st.frictionFactor).toBeLessThan(0.02);
    // h_f = f L/D v^2/2g ~ 0.0195*1000*0.082644 ~ 1.61 m ; h_m = 1.5 * 0.082644 = 0.12397 m
    expect(st.minorHeadLoss).toBeCloseTo(1.5 * 0.082644, 4);
    expect(st.frictionHeadLoss).toBeCloseTo(st.frictionFactor * 1000 * 0.082644, 3);
    expect(st.totalHeadLoss).toBeCloseTo(st.frictionHeadLoss + st.minorHeadLoss, 12);
  });

  it('is exactly zero and finite at Q = 0, with a finite positive slope', () => {
    const el = createPipeElement(pipe, water(20));
    expect(el.headDrop(0)).toBe(0);
    const slope = el.dHeadDrop(0);
    expect(Number.isFinite(slope)).toBe(true);
    expect(slope).toBeGreaterThan(0);
  });

  it('is an odd function of Q', () => {
    const el = createPipeElement(pipe, water(20));
    expect(el.headDrop(-0.02)).toBeCloseTo(-el.headDrop(0.02), 12);
  });

  it('uses Hagen-Poiseuille in laminar flow', () => {
    const oil = { name: 'oil', temperatureC: 20, density: 900, dynamicViscosity: 0.2, vaporPressure: 1000 };
    const Q = 1e-3;
    const A = Math.PI / 4 * pipe.innerDiameterM ** 2;
    const dp = (128 * oil.dynamicViscosity * pipe.lengthM * Q) / (Math.PI * pipe.innerDiameterM ** 4);
    const st = pipeFlowState({ ...pipe, fittingsK: [] }, oil, Q);
    expect(st.regime).toBe('laminar');
    expect(st.frictionHeadLoss).toBeCloseTo(dp / (oil.density * G), 10);
    expect(A).toBeGreaterThan(0);
  });

  it('analytic-style derivative agrees with a wide finite difference', () => {
    const el = createPipeElement(pipe, water(20));
    const q = 0.015;
    const wide = (el.headDrop(q * 1.001) - el.headDrop(q * 0.999)) / (q * 0.002);
    expect(el.dHeadDrop(q)).toBeCloseTo(wide, 2);
  });
});

describe('pump curve fit and affinity laws', () => {
  const data = {
    head: [
      { flowM3s: 0, headM: 50 },
      { flowM3s: 0.01, headM: 46 },
      { flowM3s: 0.02, headM: 38 },
      { flowM3s: 0.03, headM: 26 },
    ],
    efficiency: [
      { flowM3s: 0, eta: 0.05 },
      { flowM3s: 0.01, eta: 0.55 },
      { flowM3s: 0.02, eta: 0.7 },
      { flowM3s: 0.03, eta: 0.55 },
    ],
    npshr: [
      { flowM3s: 0, npshrM: 1.5 },
      { flowM3s: 0.02, npshrM: 2.5 },
      { flowM3s: 0.03, npshrM: 4 },
    ],
  };
  const model = fitPump(data);

  it('reproduces the data closely', () => {
    expect(model.fitRmse.head).toBeLessThan(0.5);
    expect(pumpHead(model, 0)).toBeCloseTo(model.head.a0, 12);
  });

  it.each([0.7, 0.85, 1.2])('obeys Q2/Q1 = r, H2/H1 = r^2, P2/P1 = r^3 at speed ratio %f', (r) => {
    const rho = 998.2;
    for (const q1 of [0.005, 0.012, 0.02]) {
      const h1 = pumpHead(model, q1, 1);
      const eta1 = pumpEfficiency(model, q1, 1) as number;
      const p1 = shaftPower(rho, q1, h1, eta1);

      const q2 = r * q1; // homologous flow
      const h2 = pumpHead(model, q2, r);
      const eta2 = pumpEfficiency(model, q2, r) as number;
      const p2 = shaftPower(rho, q2, h2, eta2);

      expect(h2 / h1).toBeCloseTo(r * r, 10);
      expect(eta2).toBeCloseTo(eta1, 12);
      expect(p2 / p1).toBeCloseTo(r ** 3, 10);
      expect((pumpNpshr(model, q2, r) as number) / (pumpNpshr(model, q1, 1) as number)).toBeCloseTo(r * r, 10);
    }
  });

  it('computes P = rho g Q H / eta', () => {
    expect(hydraulicPower(1000, 0.01, 30)).toBeCloseTo(1000 * G * 0.01 * 30, 9);
    expect(shaftPower(1000, 0.01, 30, 0.6)).toBeCloseTo((1000 * G * 0.01 * 30) / 0.6, 9);
  });

  it('acts as a check valve for reverse flow', () => {
    const el = createPumpElement(model, 1);
    expect(el.headDrop(0)).toBeCloseTo(-model.head.a0, 12);
    // head the downstream side must exceed (h_to - h_from) rises steeply with reverse flow
    expect(-el.headDrop(-1e-5)).toBeGreaterThan(-el.headDrop(0) + 5);
    expect(el.dHeadDrop(-1e-5)).toBeGreaterThan(1e5);
    // C1 at zero flow: slope is continuous across Q = 0
    expect(el.dHeadDrop(-1e-12)).toBeCloseTo(el.dHeadDrop(1e-12), -1);
  });

  it('omits efficiency / NPSHr when no data were given', () => {
    const bare = fitPump({ head: data.head });
    expect(pumpEfficiency(bare, 0.01)).toBeUndefined();
    expect(pumpNpshr(bare, 0.01)).toBeUndefined();
  });
});
