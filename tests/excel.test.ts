import ExcelJS from 'exceljs';
import { HyperFormula } from 'hyperformula';
import { describe, expect, it } from 'vitest';
import { buildNetworkWorkbook, workbookToBuffer } from '../src/excel/networkExport';
import { compute, defaultProject } from '../src/model';

/** Re-open the written .xlsx, evaluate every formula independently with HyperFormula and compare to solver values. */
describe('Network Excel export', () => {
  const run = async () => {
    const project = defaultProject();
    const c = compute(project);
    if (!c.model || !c.result) throw new Error(c.error ?? 'compute failed');
    const wb = await buildNetworkWorkbook({ model: c.model, result: c.result, npshMarginM: project.npshMarginM, pumpCurves: c.pumpCurves });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(await workbookToBuffer(wb));
    return back;
  };

  it('has the expected sheets', async () => {
    const back = await run();
    expect(back.worksheets.map((w) => w.name)).toEqual(['Inputs', 'Node results', 'Pipe results', 'Pump results', 'Pump curve']);
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
    const nPipes = 5;
    for (let i = 0; i < nPipes; i++) expect(Math.abs(get('Pipe results', 3 + i, 14) as number)).toBeLessThan(1e-6); // loss - head difference
    for (let i = 0; i < 7; i++) {
      const v = get('Node results', 3 + i, 7);
      if (typeof v === 'number') expect(Math.abs(v)).toBeLessThan(1e-9); // junction continuity
    }
    expect(Math.abs(get('Pump results', 3, 7) as number)).toBeLessThan(1e-6); // pump curve - head across
  });
});
