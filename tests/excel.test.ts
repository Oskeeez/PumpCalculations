import ExcelJS from 'exceljs';
import { HyperFormula } from 'hyperformula';
import { describe, expect, it } from 'vitest';
import { buildNetworkWorkbook, workbookToBuffer } from '../src/excel/networkExport';
import { compareScenarios, snapshotScenario, speedSweep } from '../src/analysis';
import { compute, defaultProject } from '../src/model';

/** Re-open the written .xlsx, evaluate every formula independently with HyperFormula and compare to solver values. */
describe('Network Excel export', () => {
  const run = async () => {
    const project = defaultProject();
    const c = compute(project);
    if (!c.model || !c.result) throw new Error(c.error ?? 'compute failed');
    const pumpUid = project.edges.find((e) => e.kind === 'pump')!.uid;
    const sweep = speedSweep(project, pumpUid, [0.8, 0.9, 1]);
    const slow = { ...project, edges: project.edges.map((e) => (e.kind === 'pump' ? { ...e, speedRatio: 0.85 } : e)) };
    const snap = snapshotScenario(slow, 'Slow pump');
    const comparison = compareScenarios([
      { name: 'Current', computed: c },
      { name: snap.name, computed: compute(snap.project) },
    ]);
    const wb = await buildNetworkWorkbook({ model: c.model, result: c.result, npshMarginM: project.npshMarginM, pumpCurves: c.pumpCurves, speedSweep: sweep, comparison });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await workbookToBuffer(wb));
    return back;
  };

  it('has the expected sheets', async () => {
    const back = await run();
    expect(back.worksheets.map((w) => w.name)).toEqual(['Inputs', 'Node results', 'Pipe results', 'Valve results', 'Pump results', 'Pump curve', 'Speed analysis', 'Scenario comparison']);
  });

  it('formulas evaluate (independent engine) to the solver values, and the audit residuals are ~0', async () => {
    const back = await run();
    const data: Record<string, (string | number | null)[][]> = {};
    const expected: { sheet: string; row: number; col: number; value: number }[] = [];
    back.eachSheet((ws) => {
      const rows: (string | number | null)[][] = [];
      ws.eachRow({ includeEmpty: false }, (row, rn) => {
        const arr: (string | number | null)[] = [];
        row.eachCell({ includeEmpty: false }, (cell, cn) => {
          const val = cell.value as unknown;
          if (val && typeof val === 'object' && 'formula' in val) {
            const f = val as { formula: string; result?: unknown };
            arr[cn - 1] = `=${f.formula}`;
            if (typeof f.result === 'number') expected.push({ sheet: ws.name, row: rn - 1, col: cn - 1, value: f.result });
          } else if (typeof val === 'string' || typeof val === 'number') arr[cn - 1] = val;
        });
        rows[rn - 1] = Array.from(arr, (x) => x ?? null);
      });
      data[ws.name] = Array.from(rows, (r) => r ?? []);
    });
    const hf = HyperFormula.buildFromSheets(data, { licenseKey: 'gpl-v3' });
    expect(expected.length).toBeGreaterThan(150);
    const get = (sheet: string, row: number, col: number) => hf.getCellValue({ sheet: hf.getSheetId(sheet)!, row, col });
    for (const e of expected) {
      const got = get(e.sheet, e.row, e.col);
      expect(typeof got, `${e.sheet} r${e.row + 1} c${e.col + 1}`).toBe('number');
      expect(Math.abs((got as number) - e.value), `${e.sheet} r${e.row + 1} c${e.col + 1}: ${got} vs ${e.value}`).toBeLessThan(1e-7 * Math.max(1, Math.abs(e.value)));
    }
    // audit columns, as evaluated by the independent engine
    const nPipes = 6;
    for (let i = 0; i < nPipes; i++) expect(Math.abs(get('Pipe results', 3 + i, 14) as number)).toBeLessThan(1e-6); // loss - head difference
    for (let i = 0; i < 8; i++) {
      const v = get('Node results', 3 + i, 7);
      if (typeof v === 'number') expect(Math.abs(v)).toBeLessThan(1e-9); // junction continuity
    }
    expect(Math.abs(get('Pump results', 3, 7) as number)).toBeLessThan(1e-6); // pump curve - head across
    expect(Math.abs(get('Valve results', 3, 10) as number)).toBeLessThan(1e-6); // valve K-drop - head difference
    for (let i = 0; i < 3; i++) expect(Math.abs(get('Speed analysis', 4 + i, 8) as number)).toBeLessThan(1e-6); // curve check at each speed
    // scenario deltas are live formulas: current vs slow pump supplies less
    const sc = hf.getSheetId('Scenario comparison')!;
    const supplyRow = 5; // first item row of the System section
    expect(hf.getCellValue({ sheet: sc, row: supplyRow, col: 0 })).toBe('Supplied by tanks');
    expect(hf.getCellValue({ sheet: sc, row: supplyRow, col: 4 }) as number).toBeLessThan(0);
  });
});

describe('Excel export: targets and pump curve library sheets', () => {
  it('adds the sheets only when there is something to put in them, with the solver pass/fail', async () => {
    const project = defaultProject();
    const c = compute(project);
    const j3 = project.nodes.find((n) => n.name === 'J3')!;
    const gauge = c.result!.nodes.find((n) => n.id === 'J3')!.gaugePressurePa / 1000;
    const { evaluateTargets } = await import('../src/ai/targets');
    const targets = evaluateTargets(project, [{ id: 't1', type: 'pressure', nodeUid: j3.uid, minKPaG: gauge - 10 }, { id: 't2', type: 'pressure', nodeUid: j3.uid, minKPaG: gauge + 60 }], c);
    const { newCurve } = await import('../src/pumpCurves');
    const curve = newCurve('Datasheet A', { head: [{ q: 0, h: 50 }, { q: 10, h: 40 }], efficiency: [{ q: 10, eta: 62 }] });
    const plain = await buildNetworkWorkbook({ model: c.model!, result: c.result!, npshMarginM: 0.5, pumpCurves: c.pumpCurves });
    expect(plain.worksheets.map((w) => w.name)).not.toContain('Targets');
    const wb = await buildNetworkWorkbook({ model: c.model!, result: c.result!, npshMarginM: 0.5, pumpCurves: c.pumpCurves, targets, curveLibrary: [curve] });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await workbookToBuffer(wb));
    const ts = back.getWorksheet('Targets')!;
    expect(ts.getCell('B4').value).toBe('PASS');
    expect(ts.getCell('B5').value).toBe('FAIL');
    expect(Number(ts.getCell('D5').value)).toBeCloseTo(60, 1);
    const cl = back.getWorksheet('Pump curve library')!;
    const cells = cl.getSheetValues().flat().filter((v) => v !== undefined && v !== null);
    expect(cells).toContain('Datasheet A');
    expect(cells).toContain(62);
  });
});
