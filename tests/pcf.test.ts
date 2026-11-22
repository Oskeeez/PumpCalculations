import { describe, expect, it } from 'vitest';
import { parsePcf } from '../src/pcf';
import { compute, newNode, type ProjectUI } from '../src/model';
import { fittingStatus } from '../src/fittings';

/** A short line: pipe east, 90 degree elbow turning up, pipe up, tee with a branch north, gate valve, reducer, pipe. */
const PCF = `ISOGEN-FILES ISOGEN.FLS
UNITS-BORE MM
UNITS-CO-ORDS MM
PIPELINE-REFERENCE LINE-1
PIPE
    END-POINT 0 0 0 100
    END-POINT 5000 0 0 100
ELBOW
    END-POINT 5000 0 0 100 BW
    END-POINT 5152 0 152 100 BW
    CENTRE-POINT 5152 0 0
    SKEY ELBW
PIPE
    END-POINT 5152 0 152 100
    END-POINT 5152 0 3152 100
TEE
    END-POINT 5152 0 3152 100
    END-POINT 5152 0 3456 100
    CENTRE-POINT 5152 0 3304
    BRANCH1-POINT 5152 152 3304 50
    SKEY TEBW
PIPE
    END-POINT 5152 152 3304 50
    END-POINT 5152 4152 3304 50
GASKET
    END-POINT 5152 0 3456 100
    END-POINT 5152 0 3456 100
VALVE
    END-POINT 5152 0 3456 100
    END-POINT 5152 0 3756 100
    ITEM-DESCRIPTION GATE VALVE, FLANGED
REDUCER-CONCENTRIC
    END-POINT 5152 0 3756 100
    END-POINT 5152 0 3908 50
PIPE
    END-POINT 5152 0 3908 50
    END-POINT 5152 0 6908 50
SUPPORT
    CO-ORDS 2500 0 0
`;

describe('PCF import', () => {
  const r = parsePcf(PCF);
  const p = r.project;
  const byName = (re: RegExp) => p.nodes.filter((n) => re.test(n.name));

  it('makes pipes, an elbow, a tee, a valve and a reducer, joined at shared points', () => {
    expect(p.edges.filter((e) => e.kind === 'pipe').length).toBe(4 + 2 + 3 + 2);
    expect(p.edges.filter((e) => e.kind === 'valve').length).toBe(1);
    expect(byName(/^Elbow/).length).toBe(1);
    expect(byName(/^Tee/).length).toBe(1);
    expect(byName(/^Reducer/).length).toBe(1);
  });

  it('takes the elbow turn from the 3D geometry, not the plan view', () => {
    const elbow = byName(/^Elbow/)[0];
    expect(elbow.fitting).toMatchObject({ type: 'elbow', fromDrawing: false, angleDeg: 90, style: 'flanged' });
    const st = fittingStatus(elbow, p.nodes, p.edges.filter((e) => e.kind === 'pipe') as never);
    expect(st.problem).toBeUndefined();
  });

  it('uses Z for elevation and true 3D lengths', () => {
    const top = p.nodes.reduce((a, b) => (b.elevationM > a.elevationM ? b : a));
    expect(top.elevationM).toBeCloseTo(6.908, 6);
    const riser = p.edges.find((e) => e.kind === 'pipe' && Math.abs(e.lengthM - 3) < 1e-9);
    expect(riser).toBeDefined();
  });

  it('marks the tee branch, reads the valve type, and takes inside diameters from Schedule 40', () => {
    const tee = byName(/^Tee/)[0];
    const branch = p.edges.find((e) => e.uid === tee.fitting?.branchUid);
    expect(branch && branch.kind === 'pipe' && branch.diameterMm).toBeCloseTo(52.5, 6);
    const v = p.edges.find((e) => e.kind === 'valve')!;
    expect(v).toMatchObject({ valveType: 'gate', diameterMm: 102.26 });
  });

  it('works out the reducer cone angle', () => {
    const red = byName(/^Reducer/)[0];
    expect(red.fitting?.coneDeg).toBeGreaterThan(15);
    expect(red.fitting?.coneDeg).toBeLessThan(25);
  });

  it('reports open ends, and the network solves once tanks are added', () => {
    expect(r.notes.join(' ')).toMatch(/3 open ends/);
    const ends = p.nodes.filter((n) => p.edges.filter((e) => e.from === n.uid || e.to === n.uid).length === 1);
    const tanks = ends.map((n, i) => ({ ...newNode('tank', n.x, n.y, []), uid: n.uid, name: `T${i}`, elevationM: n.elevationM, levelM: i === 0 ? 30 : 0 }));
    const solved: ProjectUI = { ...p, nodes: p.nodes.map((n) => tanks.find((t) => t.uid === n.uid) ?? n) };
    const c = compute(solved);
    expect(c.error).toBeUndefined();
    expect(c.result?.converged).toBe(true);
  });

  it('reads inch units', () => {
    const q = parsePcf('UNITS-BORE INCH\nUNITS-CO-ORDS INCH\nPIPE\n    END-POINT 0 0 0 4\n    END-POINT 100 0 0 4\n').project;
    expect(q.edges[0]).toMatchObject({ diameterMm: 102.26 });
    expect((q.edges[0] as { lengthM: number }).lengthM).toBeCloseTo(2.54, 9);
  });

  it('says so when the file has nothing usable', () => {
    expect(() => parsePcf('ISOGEN-FILES X\n')).toThrow(/No pipes/);
    expect(() => parsePcf('PIPE\n    END-POINT 0 0\n')).toThrow(/three coordinates/);
  });
});
