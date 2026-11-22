import { NodeProperty, Project, Workspace } from 'epanet-js';
import { describe, expect, it } from 'vitest';
import { blankProject, compute, emitterKv, makeEdge, newNode, newPump, outletNames, type NodeUI, type ProjectUI, type ValveUI } from '../../src/model';

const G = 9.80665;

function line(nodes: NodeUI[], links: ReturnType<typeof makeEdge>[]): ProjectUI {
  return { ...blankProject(), nodes, edges: links };
}

describe('fixed-pressure node', () => {
  it('holds its gauge pressure and supplies or absorbs whatever flow the network needs', () => {
    const a = { ...newNode('junction', 0, 0, []), name: 'A', elevationM: 5, fixedPressureKPaG: 300 };
    const b = { ...newNode('junction', 100, 0, []), name: 'B', elevationM: 0, demandLps: 4 };
    const pipe = { ...makeEdge('pipe', a.uid, b.uid, []), lengthM: 50, lengthMode: 'manual' as const };
    const c = compute(line([a, b], [pipe]));
    expect(c.error).toBeUndefined();
    const ra = c.result!.nodes.find((n) => n.id === 'A')!;
    expect(ra.gaugePressurePa / 1000).toBeCloseTo(300, 6);
    expect(-ra.netOutflowM3s * 1000).toBeCloseTo(4, 6);
  });
});

describe('sprinkler / nozzle outlet', () => {
  it('discharges Q = K sqrt(p): K 80 L/min/bar^0.5 at 1 bar gives 80 L/min', () => {
    expect(emitterKv({ k: 80, unit: 'lpm-bar' })).toBeCloseTo(4.8, 12);
    // K 5.6 gpm/psi^0.5 is the standard K 80 metric sprinkler
    expect(emitterKv({ k: 5.6, unit: 'gpm-psi' }) / emitterKv({ k: 80.7, unit: 'lpm-bar' })).toBeCloseTo(1, 2);
    const src = { ...newNode('junction', 0, 0, []), name: 'S', elevationM: 0, fixedPressureKPaG: 100 };
    const head = { ...newNode('junction', 100, 0, []), name: 'H', elevationM: 0, emitter: { k: 80, unit: 'lpm-bar' as const } };
    // a very short, wide pipe, so the sprinkler sees almost the full 1 bar
    const pipe = { ...makeEdge('pipe', src.uid, head.uid, []), lengthM: 0.01, lengthMode: 'manual' as const, diameterMm: 300 };
    const c = compute(line([src, head], [pipe]));
    expect(c.error).toBeUndefined();
    const out = c.result!.valves.find((v) => v.id === outletNames('H').valve)!;
    const pBar = c.result!.nodes.find((n) => n.id === 'H')!.gaugePressurePa / 1e5;
    const qLpm = out.flowM3s * 60000;
    // Kv is defined for water (999 kg/m3); the fluid here is water at 20 degC (998.2), hence the small tolerance
    expect(qLpm / (80 * Math.sqrt(pBar))).toBeCloseTo(1, 3);
    expect(pBar).toBeGreaterThan(0.99);
  });

  it('matches an EPANET emitter', async () => {
    // reservoir at 40 m, 200 m of 100 mm pipe, a junction at 0 m with an emitter of 1.5 L/s per sqrt(m)
    const C = 1.5;
    const inp = `[JUNCTIONS]\n J 0 0\n[RESERVOIRS]\n R 40\n[PIPES]\n P R J 200 100 0.05 0 Open\n[EMITTERS]\n J ${C}\n[OPTIONS]\n Units LPS\n Headloss D-W\n Accuracy 0.000001\n Trials 200\n[TIMES]\n Duration 0\n[END]\n`;
    const ws = new Workspace();
    await ws.loadModule();
    const m = new Project(ws);
    ws.writeFile('e.inp', inp);
    m.open('e.inp', 'r.rpt', 'o.bin');
    m.solveH();
    const epaPressureM = m.getNodeValue(m.getNodeIndex('J'), NodeProperty.Pressure);
    const epaQ = m.getNodeValue(m.getNodeIndex('J'), NodeProperty.Demand);
    m.close();
    // same outlet in this app: Q[L/min] = K sqrt(p[bar]) with p = rho g h for EPANET's water (999 kg/m3 reference)
    const K = 60 * C * Math.sqrt(1e5 / (999 * G));
    const r = { ...newNode('tank', 0, 0, []), name: 'R', elevationM: 40, levelM: 0 };
    const j = { ...newNode('junction', 100, 0, []), name: 'J', elevationM: 0, emitter: { k: K, unit: 'lpm-bar' as const } };
    const pipe = { ...makeEdge('pipe', r.uid, j.uid, []), lengthM: 200, lengthMode: 'manual' as const, diameterMm: 100, roughnessMm: 0.05 };
    const c = compute(line([r, j], [pipe]));
    expect(c.error).toBeUndefined();
    const q = c.result!.valves.find((v) => v.id === 'J outlet')!.flowM3s * 1000;
    // EPANET uses Swamee-Jain, this app Colebrook-White: agree to about 1 %
    expect(Math.abs(q - epaQ) / epaQ).toBeLessThan(0.01);
    expect(Math.abs(c.result!.nodes.find((n) => n.id === 'J')!.headM - epaPressureM)).toBeLessThan(0.5);
  });
});

describe('relief valve', () => {
  const build = (setKPa: number, kv = 200) => {
    const t = { ...newNode('tank', 0, 0, []), name: 'Sump', elevationM: 0, levelM: 1 };
    const j = { ...newNode('junction', 100, 0, []), name: 'Discharge', elevationM: 0 };
    const back = { ...newNode('tank', 200, 0, []), name: 'Return', elevationM: 0, levelM: 1 };
    const pump = { ...newPump(t.uid, j.uid, []), head: [{ q: 0, h: 50 }, { q: 10, h: 45 }, { q: 20, h: 30 }], efficiency: [], npshr: [] };
    const rv: ValveUI = { ...(makeEdge('valve', j.uid, back.uid, [], 50) as ValveUI), name: 'RV', controlType: 'psv', relief: true, controlValue: setKPa, lossType: 'Kv', lossValue: kv };
    return compute(line([t, j, back], [pump, rv]));
  };

  it('relieves above its set pressure and holds the upstream pressure at the setting', () => {
    const c = build(300); // the pump can make about 480 kPa at shutoff
    expect(c.error).toBeUndefined();
    const rv = c.result!.valves.find((v) => v.id === 'RV')!;
    expect(rv.flowM3s).toBeGreaterThan(1e-4);
    expect(c.result!.nodes.find((n) => n.id === 'Discharge')!.gaugePressurePa / 1000).toBeCloseTo(300, 0);
  });

  it('says when it is too small: wide open and the pressure still above the setting', () => {
    const c = build(300, 40);
    expect(c.result!.nodes.find((n) => n.id === 'Discharge')!.gaugePressurePa / 1000).toBeGreaterThan(305);
    expect(c.alerts.join(' ')).toMatch(/too small/);
  });

  it('stays shut when the pressure cannot reach the setting', () => {
    const c = build(800);
    expect(c.error).toBeUndefined();
    const rv = c.result!.valves.find((v) => v.id === 'RV')!;
    expect(Math.abs(rv.flowM3s)).toBeLessThan(1e-6);
    expect(c.result!.warnings.join(' ')).not.toMatch(/did not settle/);
  });
});
