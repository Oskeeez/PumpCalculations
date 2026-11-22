import { NodeProperty, Project, Workspace } from 'epanet-js';
import { describe, expect, it } from 'vitest';
import { CASES, NET1_EPANET_HEAD_FT, runValidation } from '../../src/validation/cases';
import { NET1_INP } from '../../src/validation/net1';

describe('validation pack', () => {
  const results = runValidation();
  for (const c of CASES) {
    it(`${c.id} ${c.title}`, () => {
      const r = results.find((x) => x.id === c.id)!;
      expect(r.error).toBeUndefined();
      for (const row of r.rows) expect(row.pass, `${row.quantity}: expected ${row.expected}, got ${row.actual} ${row.unit}`).toBe(true);
    });
  }

  it('the recorded Net1 heads are what the EPANET engine gives', async () => {
    const ws = new Workspace();
    await ws.loadModule();
    const m = new Project(ws);
    ws.writeFile('n.inp', NET1_INP);
    m.open('n.inp', 'r.rpt', 'o.bin');
    m.solveH();
    for (const [id, h] of Object.entries(NET1_EPANET_HEAD_FT)) expect(m.getNodeValue(m.getNodeIndex(id), NodeProperty.Head)).toBeCloseTo(h, 3);
    m.close();
  });
});
