import { LinkProperty, NodeProperty, Project, Workspace } from 'epanet-js';
import { describe, expect, it } from 'vitest';
import { parseInp, toInp } from '../../src/epanet';
import { compute, defaultProject, type ProjectUI } from '../../src/model';

const FT = 0.3048;

/** Net1 from the EPANET examples (US units, Hazen-Williams), with the extra sections a real file has. */
const NET1 = `[TITLE]
 EPANET Example Network 1

[JUNCTIONS]
;ID  Elev  Demand  Pattern
 10  710   0   ;
 11  710   150  1 ;
 12  700   150  1 ;
 13  695   100  1 ;
 21  700   150  1 ;
 22  695   200  1 ;
 23  690   150  1 ;
 31  700   100  1 ;
 32  710   100  1 ;

[RESERVOIRS]
 9  800

[TANKS]
 2  850  120  100  150  50.5  0

[PIPES]
 10   10  11  10530  18  100  0  Open
 11   11  12  5280   14  100  0  Open
 12   12  13  5280   10  100  0  Open
 21   21  22  5280   10  100  0  Open
 22   22  23  5280   12  100  0  Open
 31   31  32  5280   6   100  0  Open
 110  2   12  200    18  100  0  Open
 111  11  21  5280   10  100  0  Open
 112  12  22  5280   12  100  0  Open
 113  13  23  5280   8   100  0  Open
 121  21  31  5280   8   100  0  Open
 122  22  32  5280   6   100  0  Open

[PUMPS]
 9  9  10  HEAD 1

[PATTERNS]
 1  1.0  1.2  1.4  1.6  1.4  1.2

[CURVES]
 1  1500  250

[CONTROLS]
 LINK 9 OPEN IF NODE 2 BELOW 110

[QUALITY]
 10 0.5

[TIMES]
 Duration 24:00

[OPTIONS]
 Units GPM
 Headloss H-W
 Specific Gravity 1.0
 Viscosity 1.0
 Trials 40
 Accuracy 0.001

[COORDINATES]
 10  20  70
 11  30  70
 12  50  70
 13  70  70
 21  30  40
 22  50  40
 23  70  40
 31  30  10
 32  50  10
 9   10  70
 2   50  90

[END]
`;

async function epanet(text: string, nodes: string[], links: string[]) {
  const ws = new Workspace();
  await ws.loadModule();
  const model = new Project(ws);
  ws.writeFile('net.inp', text);
  model.open('net.inp', 'r.rpt', 'o.bin');
  model.solveH();
  const head: Record<string, number> = {};
  for (const id of nodes) head[id] = model.getNodeValue(model.getNodeIndex(id), NodeProperty.Head);
  const flow: Record<string, number> = {};
  for (const id of links) flow[id] = model.getLinkValue(model.getLinkIndex(id), LinkProperty.Flow);
  model.close();
  return { head, flow };
}

const solve = (p: ProjectUI) => {
  const c = compute(p);
  expect(c.error).toBeUndefined();
  return c.result!;
};

describe('EPANET .inp import', () => {
  it('reads Net1 and gives the same heads and flows as the EPANET engine', async () => {
    const r = parseInp(NET1);
    expect(r.project.nodes.length).toBe(11);
    expect(r.project.edges.length).toBe(13);
    expect(r.project.frictionMethod).toBe('hw');
    expect(r.notes.join(' ')).toMatch(/patterns are ignored/);
    expect(r.notes.join(' ')).toMatch(/\[CONTROLS\] is ignored/);
    const ours = solve(r.project);
    const ids = ['10', '11', '12', '13', '21', '22', '23', '31', '32'];
    const ref = await epanet(NET1.replace('Duration 24:00', 'Duration 0').replace('Accuracy 0.001', 'Accuracy 0.00001').replace('Trials 40', 'Trials 200'), ids, ['10', '110', '9']);
    for (const id of ids) {
      const h = ours.nodes.find((n) => n.id === id)!.headM / FT;
      expect(Math.abs(h - ref.head[id])).toBeLessThan(0.05); // ft
    }
    const gpm = 0.0630901964 / 1000;
    expect(Math.abs(ours.pipes.find((p) => p.id === '110')!.flowM3s / gpm - ref.flow['110'])).toBeLessThan(0.5);
    expect(Math.abs(ours.pumps[0].flowM3s / gpm - ref.flow['9'])).toBeLessThan(0.5);
  });

  it('places nodes from the coordinates, with y up in EPANET and down on the canvas', () => {
    const p = parseInp(NET1).project;
    const at = (n: string) => p.nodes.find((x) => x.name === n)!;
    expect(at('2').y).toBeLessThan(at('31').y);
    expect(at('9').x).toBeLessThan(at('13').x);
  });

  it('reads SI units, closed and check-valve pipes, valves, [DEMANDS] and [STATUS]', () => {
    const p = parseInp(`[JUNCTIONS]
 A 10 0
 B 5 1
 C 5 0
[RESERVOIRS]
 R 50
[PIPES]
 P1 R A 100 150 0.05 2 Open
 P2 A B 100 100 0.05 0 CV
 P3 A C 100 100 0.05 0 Closed
[VALVES]
 V1 B C 100 PRV 20 0
 V2 C B 80 TCV 5 0
 V3 B C 80 FCV 3 0
[DEMANDS]
 B 2
 B 1.5
[STATUS]
 V2 Closed
[OPTIONS]
 Units LPS
 Headloss D-W
[END]`).project;
    expect(p.frictionMethod).toBeUndefined();
    const e = (n: string) => p.edges.find((x) => x.name === n)!;
    expect(e('P1')).toMatchObject({ kind: 'pipe', lengthM: 100, diameterMm: 150, roughnessMm: 0.05, fittings: [{ k: 2 }] });
    expect(e('P2 check')).toMatchObject({ kind: 'valve', checkValve: true });
    expect(e('P3')).toMatchObject({ kind: 'valve', open: false });
    expect(e('V1')).toMatchObject({ controlType: 'prv' });
    expect((e('V1') as { controlValue: number }).controlValue).toBeCloseTo(20 * 9.789, 1);
    expect(e('V2')).toMatchObject({ lossType: 'K', lossValue: 5, open: false });
    expect(e('V3')).toMatchObject({ controlType: 'fcv', controlValue: 3 });
    expect(p.nodes.find((n) => n.name === 'B')!.demandLps).toBeCloseTo(3.5, 10);
  });

  it('says clearly what is wrong with a bad file', () => {
    expect(() => parseInp('[PIPES]\n P1 A B 100 100 100 0 Open\n[OPTIONS]\n Units LPS')).toThrow(/no junctions|not defined/);
    expect(() => parseInp('[JUNCTIONS]\n A x 0')).toThrow(/not a number/);
    expect(() => parseInp('[JUNCTIONS]\n A 1 0\n[OPTIONS]\n Units FOO')).toThrow(/Unknown flow units/);
  });
});

describe('EPANET .inp export', () => {
  it('the example project solved by EPANET agrees with this app', async () => {
    const p = defaultProject();
    const ours = solve(p);
    const { text } = toInp(p);
    const junctions = ours.nodes.filter((n) => p.nodes.find((x) => x.name === n.id)?.kind === 'junction').map((n) => n.id.replace(/\s+/g, '_'));
    const ref = await epanet(text, junctions, []);
    for (const id of junctions) {
      const h = ours.nodes.find((n) => n.id.replace(/\s+/g, '_') === id)!.headM;
      // EPANET uses Swamee-Jain for Darcy-Weisbach; the app uses Colebrook-White
      expect(Math.abs(h - ref.head[id])).toBeLessThan(0.3);
    }
  });

  it('round trip: export then import gives the same answer', () => {
    const p = defaultProject();
    const before = solve(p);
    const back = parseInp(toInp(p).text).project;
    const after = solve(back);
    for (const n of before.nodes) {
      const m = after.nodes.find((x) => x.id === n.id.replace(/\s+/g, '_'))!;
      expect(Math.abs(m.headM - n.headM)).toBeLessThan(0.02);
    }
  });

  it('Hazen-Williams projects export C values', () => {
    const p = { ...defaultProject(), frictionMethod: 'hw' as const };
    const t = toInp(p).text;
    expect(t).toMatch(/Headloss H-W/);
    expect(t).toMatch(/ 130 /);
  });
});

describe('EPANET emitters', () => {
  it('reads [EMITTERS] as outlets and writes them back', () => {
    const p = parseInp('[JUNCTIONS]\n J 0 0\n[RESERVOIRS]\n R 40\n[PIPES]\n P R J 200 100 0.05 0 Open\n[EMITTERS]\n J 1.5\n[OPTIONS]\n Units LPS\n Headloss D-W\n[END]\n').project;
    const j = p.nodes.find((n) => n.name === 'J')!;
    expect(j.emitter?.unit).toBe('lpm-bar');
    const c = compute(p);
    // EPANET gives 9.151 L/s for this network (Swamee-Jain); this app should be within 1 %
    const q = c.result!.valves.find((v) => v.id === 'J outlet')!.flowM3s * 1000;
    expect(Math.abs(q - 9.1514) / 9.1514).toBeLessThan(0.01);
    const text = toInp(p).text;
    expect(text).toMatch(/\[EMITTERS\][\s\S]* J 1\.5\b/);
    expect(text).not.toMatch(/J_outlet/);
    const us = parseInp('[JUNCTIONS]\n J 0 0\n[RESERVOIRS]\n R 100\n[PIPES]\n P R J 100 4 120 0 Open\n[EMITTERS]\n J 5.6\n[OPTIONS]\n Units GPM\n[END]\n').project;
    expect(us.nodes.find((n) => n.name === 'J')!.emitter).toEqual({ k: 5.6, unit: 'gpm-psi' });
  });
});
