import { describe, expect, it } from 'vitest';
import { G, P_ATM, solveSystem, water, type SysEdge, type SysNode, type SystemModel, type ValveSpec } from '../../src/solver';

const w = water(20);
const RHO_G = w.density * G;
const tank = (id: string, z: number, level: number): SysNode => ({ kind: 'tank', id, elevationM: z, liquidLevelM: level, surfacePressurePa: P_ATM });
const jn = (id: string, z = 0, demandLps = 0): SysNode => ({ kind: 'junction', id, elevationM: z, demandM3s: demandLps / 1000 });
const pipe = (id: string, from: string, to: string, L = 100, D = 0.1): SysEdge => ({
  kind: 'pipe', id, from, to, spec: { lengthM: L, innerDiameterM: D, roughnessM: 0.05e-3, elevationChangeM: 0, fittingsK: [] },
});
const valve = (id: string, from: string, to: string, extra: Partial<ValveSpec>): SysEdge => ({
  kind: 'valve', id, from, to, spec: { diameterM: 0.1, loss: { type: 'K', k: 0.5 }, checkValve: false, open: true, ...extra },
});
const model = (nodes: SysNode[], edges: SysEdge[]): SystemModel => ({ fluid: w, nodes, edges });
const head = (r: ReturnType<typeof solveSystem>, id: string) => r.nodes.find((n) => n.id === id)!.headM;
const q = (r: ReturnType<typeof solveSystem>, id: string) => (r.pipes.find((p) => p.id === id) ?? r.valves.find((v) => v.id === id))!.flowM3s;
const tol = { flowTolM3s: 1e-13 };

/** A (head 60 m) -> p1 -> J1 -> [valve] -> J2 -> p2 -> J3 (demand 10 L/s) */
const prvNet = (setKPa: number, extra: Partial<ValveSpec> = {}) =>
  model(
    [tank('A', 0, 60), jn('J1'), jn('J2'), jn('J3', 0, 10)],
    [pipe('p1', 'A', 'J1'), valve('V', 'J1', 'J2', { control: { type: 'prv', setpointPa: setKPa * 1000 }, ...extra }), pipe('p2', 'J2', 'J3')],
  );

describe('pressure-reducing valve', () => {
  it('holds the downstream node at the set pressure and passes the downstream demand', () => {
    const r = solveSystem(prvNet(200), tol);
    expect(r.converged, r.message).toBe(true);
    const v = r.valves[0];
    expect(v.status).toBe('active');
    expect(v.mode).toBe('prv');
    const set = 200000 / RHO_G; // head at z = 0
    expect(head(r, 'J2')).toBeCloseTo(set, 9);
    expect(v.flowM3s).toBeCloseTo(0.01, 9); // = the 10 L/s demand
    expect(q(r, 'p1')).toBeCloseTo(0.01, 9);
    expect(q(r, 'p2')).toBeCloseTo(0.01, 9);
    // upstream node sits above the set head by the dissipation across the valve
    expect(v.headDropM).toBeCloseTo(head(r, 'J1') - set, 9);
    expect(v.headDropM).toBeGreaterThan(0);
    expect(v.pressureDropPa).toBeCloseTo(v.headDropM * RHO_G, 6);
  });

  it('matches the same downstream network fed by a tank at the set head', () => {
    const r = solveSystem(prvNet(200), tol);
    const set = 200000 / RHO_G;
    const ref = solveSystem(model([{ kind: 'tank', id: 'S', elevationM: 0, liquidLevelM: set, surfacePressurePa: P_ATM }, jn('J3', 0, 10)], [pipe('p2', 'S', 'J3')]), tol);
    expect(head(r, 'J3')).toBeCloseTo(head(ref, 'J3'), 9);
    expect(q(r, 'p2')).toBeCloseTo(q(ref, 'p2'), 10);
  });

  it('stays open (an ordinary resistance) when the upstream pressure is below the set pressure', () => {
    const r = solveSystem(prvNet(900), tol);
    expect(r.valves[0].status).toBe('open');
    const plain = solveSystem(prvNet(900, { control: undefined }), tol);
    expect(q(r, 'p2')).toBeCloseTo(q(plain, 'p2'), 10);
    expect(head(r, 'J2')).toBeCloseTo(head(plain, 'J2'), 9);
    expect(head(r, 'J2')).toBeLessThan(900000 / RHO_G);
  });

  it('closes on reverse flow and says so', () => {
    const m = model(
      [tank('A', 0, 20), jn('J'), tank('B', 0, 40)],
      [valve('V', 'A', 'J', { control: { type: 'prv', setpointPa: 100000 } }), pipe('p', 'J', 'B')],
    );
    const r = solveSystem(m, tol);
    expect(r.converged, r.message).toBe(true);
    expect(r.valves[0].status).toBe('closed');
    expect(r.valves[0].flowM3s).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/closed/);
  });

  const loop = (bypassD: number) =>
    model(
      [tank('A', 0, 60), jn('J1'), jn('J2', 0, 8), jn('J3', 0, 1)],
      [
        pipe('p1', 'A', 'J1'),
        valve('V', 'J1', 'J2', { control: { type: 'prv', setpointPa: 250000 } }),
        pipe('p3', 'J1', 'J3', 300, bypassD),
        pipe('p4', 'J3', 'J2', 300, bypassD),
      ],
    );

  it('works inside a loop: continuity holds everywhere and the set head is exact', () => {
    const r = solveSystem(loop(0.05), tol); // a thin bypass cannot overfeed J2
    expect(r.converged, r.message).toBe(true);
    expect(r.valves[0].status).toBe('active');
    expect(head(r, 'J2')).toBeCloseTo(250000 / RHO_G, 9);
    const Qv = r.valves[0].flowM3s;
    expect(Qv).toBeGreaterThan(0);
    expect(q(r, 'p1')).toBeCloseTo(Qv + q(r, 'p3'), 9); // J1
    expect(q(r, 'p3')).toBeCloseTo(q(r, 'p4') + 0.001, 9); // J3 (demand 1 L/s)
    expect(Qv + q(r, 'p4')).toBeCloseTo(0.008, 9); // J2 (demand 8 L/s)
  });

  it('closes when an unregulated bypass overfeeds the downstream side, and does not flip-flop', () => {
    const r = solveSystem(loop(0.15), tol); // a fat bypass delivers more than the downstream demand
    expect(r.converged, r.message).toBe(true);
    expect(r.valves[0].status).toBe('closed');
    expect(r.valves[0].flowM3s).toBe(0);
    expect(head(r, 'J2')).toBeGreaterThan(250000 / RHO_G);
    expect(r.warnings.join(' ')).not.toMatch(/did not settle/);
  });

  it('cannot regulate the head of a tank: it stays open and warns', () => {
    const m = model([tank('A', 0, 60), tank('B', 0, 30)], [valve('V', 'A', 'B', { control: { type: 'prv', setpointPa: 100000 } })]);
    const r = solveSystem(m, tol);
    expect(r.valves[0].status).toBe('open');
    expect(r.warnings.join(' ')).toMatch(/cannot regulate the head of a tank/);
  });
});

describe('pressure-sustaining valve', () => {
  // A (head 60) -> p1 -> J1 -> PSV -> J2 -> p2 -> B (head 10)
  const net = (setKPa: number) =>
    model(
      [tank('A', 0, 60), jn('J1'), jn('J2'), tank('B', 0, 10)],
      [pipe('p1', 'A', 'J1', 300, 0.1), valve('V', 'J1', 'J2', { control: { type: 'psv', setpointPa: setKPa * 1000 } }), pipe('p2', 'J2', 'B', 100, 0.1)],
    );

  it('throttles to hold the upstream pressure at the set pressure', () => {
    const open = solveSystem(net(1e6 / 1000 * 0.001)); // tiny setpoint: never active
    const set = 400000 / RHO_G; // 40.8 m: above the free-flow upstream head
    expect(head(open, 'J1')).toBeLessThan(set);
    const r = solveSystem(net(400), tol);
    expect(r.converged, r.message).toBe(true);
    expect(r.valves[0].status).toBe('active');
    expect(head(r, 'J1')).toBeCloseTo(set, 9);
    // flow limited by p1 alone: (60 - set) head over pipe p1
    expect(q(r, 'p1')).toBeLessThan(q(open, 'p1'));
    expect(r.valves[0].flowM3s).toBeCloseTo(q(r, 'p1'), 9);
    expect(q(r, 'p2')).toBeCloseTo(q(r, 'p1'), 9);
    expect(r.valves[0].headDropM).toBeGreaterThan(0);
  });

  it('stays open when the upstream pressure is already above the set pressure', () => {
    const r = solveSystem(net(10), tol); // set head 1 m, far below the free-flow head
    expect(r.valves[0].status).toBe('open');
  });
});

describe('flow-control valve', () => {
  // A (head 50) -> p1 -> J1 -> FCV -> J2 -> p2 -> B (head 10)
  const net = (setLps: number) =>
    model(
      [tank('A', 0, 50), jn('J1'), jn('J2'), tank('B', 0, 10)],
      [pipe('p1', 'A', 'J1', 100, 0.1), valve('V', 'J1', 'J2', { control: { type: 'fcv', flowM3s: setLps / 1000 } }), pipe('p2', 'J2', 'B', 100, 0.1)],
    );

  it('limits the flow to exactly the set value when the network would pass more', () => {
    const free = solveSystem(net(1000), tol);
    expect(free.valves[0].status).toBe('open');
    const freeQ = free.valves[0].flowM3s * 1000;
    expect(freeQ).toBeGreaterThan(5);
    const r = solveSystem(net(5), tol);
    expect(r.converged, r.message).toBe(true);
    expect(r.valves[0].status).toBe('active');
    expect(r.valves[0].flowM3s).toBeCloseTo(0.005, 12);
    expect(q(r, 'p1')).toBeCloseTo(0.005, 9);
    expect(q(r, 'p2')).toBeCloseTo(0.005, 9);
    // the valve takes up the surplus head
    expect(r.valves[0].headDropM).toBeGreaterThan(free.valves[0].headDropM);
    expect(r.valves[0].effectiveK).toBeGreaterThan(r.valves[0].equivalentK);
  });

  it('passes the natural flow when the set value is larger than the network can deliver', () => {
    const r = solveSystem(net(500), tol);
    expect(r.valves[0].status).toBe('open');
    expect(r.valves[0].flowM3s * 1000).toBeLessThan(500);
  });
});
