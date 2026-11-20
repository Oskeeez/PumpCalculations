import { describe, expect, it } from 'vitest';
import {
  FLUID_LIBRARY,
  G,
  P_ATM,
  createValveElement,
  fluidAt,
  pipeArea,
  solveSystem,
  valveEquivalentK,
  valveResistance,
  water,
  type SystemModel,
  type ValveSpec,
} from '../../src/solver';

const GPM = 6.30901964e-5;
const valve = (loss: ValveSpec['loss'], extra: Partial<ValveSpec> = {}): ValveSpec => ({ diameterM: 0.1, loss, checkValve: false, open: true, ...extra });

describe('valve resistance', () => {
  it('K valve: h = K v^2 / 2g (hand calculation)', () => {
    const v = valve({ type: 'K', k: 2 });
    const Q = 0.01;
    const vel = Q / pipeArea(0.1); // 1.27324 m/s
    expect(createValveElement(v).headDrop(Q)).toBeCloseTo((2 * vel * vel) / (2 * G), 12);
    expect(createValveElement(v).headDrop(Q)).toBeCloseTo(0.1653, 3);
    expect(valveEquivalentK(v)).toBeCloseTo(2, 12);
  });

  it('Cv = 1 passes 1 gpm of water at 1 psi: head = 6894.757 / (999 g) = 0.7038 m', () => {
    const h = createValveElement(valve({ type: 'Cv', cv: 1 })).headDrop(GPM);
    expect(h).toBeCloseTo(6894.757 / (999 * G), 9);
    expect(h).toBeCloseTo(0.7038, 3);
  });

  it('Kv = 1 passes 1 m3/h of water at 1 bar: head = 1e5 / (999 g) = 10.21 m', () => {
    const h = createValveElement(valve({ type: 'Kv', kv: 1 })).headDrop(1 / 3600);
    expect(h).toBeCloseTo(1e5 / (999 * G), 9);
    expect(h).toBeCloseTo(10.2, 1);
  });

  it('Cv and Kv agree through Cv = 1.1561 Kv (within the rounding of that constant)', () => {
    const kv = 50;
    const a = valveResistance(valve({ type: 'Kv', kv }));
    const b = valveResistance(valve({ type: 'Cv', cv: 1.1561 * kv }));
    expect(Math.abs(a - b) / a).toBeLessThan(2e-4);
  });

  it('is quadratic in flow, odd, and zero at zero flow', () => {
    const el = createValveElement(valve({ type: 'Cv', cv: 100 }));
    expect(el.headDrop(0)).toBe(0);
    expect(el.headDrop(0.02) / el.headDrop(0.01)).toBeCloseTo(4, 10);
    expect(el.headDrop(-0.01)).toBeCloseTo(-el.headDrop(0.01), 12);
  });

  it('check valve blocks reverse flow with a C1 stiff term', () => {
    const el = createValveElement(valve({ type: 'K', k: 1 }, { checkValve: true }));
    expect(-el.headDrop(-1e-5)).toBeGreaterThan(50); // >50 m needed for 10 mL/s reverse
    expect(el.dHeadDrop(-1e-15)).toBeCloseTo(el.dHeadDrop(1e-15), 2);
    const free = createValveElement(valve({ type: 'K', k: 1 }));
    expect(free.headDrop(-1e-3)).toBeCloseTo(-free.headDrop(1e-3), 12);
  });

  it('rejects invalid specs', () => {
    expect(() => createValveElement(valve({ type: 'Cv', cv: 0 }))).toThrow(RangeError);
    expect(() => createValveElement(valve({ type: 'K', k: -1 }))).toThrow(RangeError);
    expect(() => createValveElement({ ...valve({ type: 'K', k: 1 }), diameterM: 0 })).toThrow(RangeError);
  });
});

const w = water(20);
const tank = (id: string, z: number, level: number) => ({ kind: 'tank' as const, id, elevationM: z, liquidLevelM: level, surfacePressurePa: P_ATM });
const pipe = (id: string, from: string, to: string, L: number, D: number) => ({
  kind: 'pipe' as const, id, from, to, spec: { lengthM: L, innerDiameterM: D, roughnessM: 0.05e-3, elevationChangeM: 0, fittingsK: [] as number[] },
});
const chain = (v: ValveSpec, fluid = w): SystemModel => ({
  fluid,
  nodes: [tank('A', 20, 2), { kind: 'junction', id: 'J1', elevationM: 0, demandM3s: 0 }, { kind: 'junction', id: 'J2', elevationM: 0, demandM3s: 0 }, tank('B', 0, 1)],
  edges: [pipe('p1', 'A', 'J1', 50, 0.1), { kind: 'valve', id: 'V', from: 'J1', to: 'J2', spec: v }, pipe('p2', 'J2', 'B', 50, 0.1)],
});

describe('valves in a network', () => {
  it('energy balance: tank head difference = pipe losses + valve drop', () => {
    const res = solveSystem(chain(valve({ type: 'Cv', cv: 150 })), { flowTolM3s: 1e-13 });
    expect(res.converged).toBe(true);
    const dH = res.nodes.find((n) => n.id === 'A')!.headM - res.nodes.find((n) => n.id === 'B')!.headM;
    const losses = res.pipes.reduce((s, p) => s + p.headDropM, 0) + res.valves[0].headDropM;
    expect(losses).toBeCloseTo(dH, 8);
    // valve drop follows its Cv relation: dP[psi] = (Q[gpm]/Cv)^2
    const qGpm = res.valves[0].flowM3s / GPM;
    expect(res.valves[0].pressureDropPa / 6894.757).toBeCloseTo((qGpm / 150) ** 2 * (w.density / 999), 3);
  });

  it('throttling (smaller Cv) lowers the flow monotonically', () => {
    const q = (cv: number) => solveSystem(chain(valve({ type: 'Cv', cv }))).valves[0].flowM3s;
    expect(q(20)).toBeLessThan(q(50));
    expect(q(50)).toBeLessThan(q(200));
    expect(q(200)).toBeLessThan(q(1e5)); // ~ wide open
  });

  it('a closed valve carries no flow and is reported closed', () => {
    const m = chain(valve({ type: 'K', k: 1 }, { open: false }));
    // closing the only path isolates J2 from a tank on one side: J2 still connects to B via p2
    // but J1 connects to A via p1, so both halves stay tank-connected
    const res = solveSystem(m);
    expect(res.valves[0].status).toBe('closed');
    expect(res.valves[0].flowM3s).toBe(0);
    expect(Math.abs(res.pipes[0].flowM3s)).toBeLessThan(1e-12);
  });

  it('closing a valve that isolates a node from every tank reports a clear error naming the valve', () => {
    const m: SystemModel = {
      fluid: w,
      nodes: [tank('A', 10, 1), { kind: 'junction', id: 'J1', elevationM: 0, demandM3s: 0 }, { kind: 'junction', id: 'J2', elevationM: 0, demandM3s: 0.001 }],
      edges: [pipe('p1', 'A', 'J1', 20, 0.1), { kind: 'valve', id: 'V', from: 'J1', to: 'J2', spec: valve({ type: 'K', k: 1 }, { open: false }) }],
    };
    expect(() => solveSystem(m)).toThrow(/not connected.*closed valves: V/);
  });

  it('a check valve closes and warns when the downstream head is higher', () => {
    const m = chain(valve({ type: 'K', k: 1 }, { checkValve: true }));
    const high: SystemModel = { ...m, nodes: m.nodes.map((n) => (n.id === 'B' ? { ...n, elevationM: 60 } : n)) };
    const res = solveSystem(high);
    expect(res.converged, res.message).toBe(true);
    expect(res.valves[0].status).toBe('check-closed');
    expect(Math.abs(res.valves[0].flowM3s)).toBeLessThan(3e-5);
    expect(res.warnings.join(' ')).toMatch(/check valve is closed/);
  });

  it('flows reverse through an open valve without a check valve', () => {
    const m = chain(valve({ type: 'K', k: 1 }));
    const high: SystemModel = { ...m, nodes: m.nodes.map((n) => (n.id === 'B' ? { ...n, elevationM: 60 } : n)) };
    expect(solveSystem(high).valves[0].flowM3s).toBeLessThan(-1e-3);
  });
});

describe('fluid library', () => {
  const rel = (a: number, b: number) => Math.abs(a - b) / b;

  it('reproduces tabulated nodes exactly (ethylene glycol 30 %, 20 °C)', () => {
    const f = fluidAt('eg30', 20);
    expect(f.density).toBeCloseTo(1038.046, 6);
    expect(f.dynamicViscosity).toBeCloseTo(2.1664e-3, 9);
  });

  it('interpolates between table points to within 1 % of published intermediate values', () => {
    const a = fluidAt('eg30', 5); // published 1043.470 kg/m3, 3.5592 mPa.s
    expect(rel(a.density, 1043.47)).toBeLessThan(0.001);
    expect(rel(a.dynamicViscosity * 1000, 3.5592)).toBeLessThan(0.01);
    const b = fluidAt('eg50', 45); // 1050.327, 1.8715
    expect(rel(b.density, 1050.327)).toBeLessThan(0.001);
    expect(rel(b.dynamicViscosity * 1000, 1.8715)).toBeLessThan(0.015);
    const c = fluidAt('seawater', 25); // MIT: 1023.6, 0.959
    expect(rel(c.density, 1023.6)).toBeLessThan(0.001);
    expect(rel(c.dynamicViscosity * 1000, 0.959)).toBeLessThan(0.01);
  });

  it('propylene glycol matches the ASHRAE table in °F (30 % at 80 °F = 26.67 °C: 2.43 cP, 64.08 lb/ft3)', () => {
    const f = fluidAt('pg30', (80 - 32) / 1.8);
    expect(f.dynamicViscosity * 1000).toBeCloseTo(2.43, 6);
    expect(f.density).toBeCloseTo(64.08 * 16.01846, 3);
  });

  it('vapour pressure is a fraction of water, and water is unchanged', () => {
    expect(fluidAt('eg50', 20).vaporPressure).toBeCloseTo(water(20).vaporPressure * 0.775, 6);
    expect(fluidAt('water', 20)).toEqual(water(20));
  });

  it('rejects temperatures outside the data range and invalid custom fluids', () => {
    expect(() => fluidAt('seawater', 60)).toThrow(RangeError);
    expect(() => fluidAt('pg50', 70)).toThrow(RangeError);
    expect(() => fluidAt('custom', 20)).toThrow(RangeError);
    const c = fluidAt('custom', 20, { name: 'Oil', density: 850, dynamicViscosity: 0.03, vaporPressure: 500 });
    expect(c.density).toBe(850);
  });

  it('lists every fluid with a valid range, and a thicker fluid gives less flow in the same network', () => {
    expect(FLUID_LIBRARY.length).toBeGreaterThanOrEqual(7);
    const v = valve({ type: 'K', k: 1 });
    const qW = solveSystem(chain(v, water(20))).pipes[0].flowM3s;
    const qG = solveSystem(chain(v, fluidAt('eg50', 20))).pipes[0].flowM3s;
    expect(qG).toBeLessThan(qW);
  });
});
