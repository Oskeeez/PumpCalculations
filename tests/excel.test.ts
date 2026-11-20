import ExcelJS from 'exceljs';
import { HyperFormula } from 'hyperformula';
import { describe, expect, it } from 'vitest';
import { buildWorkbook, workbookToBuffer } from '../src/excel/export';
import { compute, defaultProject } from '../src/model';

/** Re-open the written .xlsx, evaluate every formula independently with HyperFormula and compare to solver values. */
describe('Excel export', () => {
  const run = async (project = defaultProject()) => {
    const c = compute(project);
    if (!c.system || !c.op || !c.analysis || !c.curves) throw new Error(c.error ?? 'compute failed');
    const wb = await buildWorkbook({ system: c.system, op: c.op, analysis: c.analysis, curves: c.curves, npshMarginM: project.npshMarginM });
    const buf = await workbookToBuffer(wb);
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buf);
    return { back, c };
  };

  it('has the expected sheets and live formulas', async () => {
    const { back } = await run();
    expect(back.worksheets.map((w) => w.name)).toEqual(['Inputs', 'Pipe results', 'Pump results', 'Pump curve']);
    const v = back.getWorksheet('Pipe results')!.getCell('I4').value as { formula: string };
    expect(v.formula).toContain('/(2*Inputs!');
  });

  it('formulas evaluate (independent engine) to the solver values', async () => {
    const { back } = await run();
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
          } else if (typeof val === 'string' || typeof val === 'number') {
            arr[cn - 1] = val;
          }
        });
        rows[rn - 1] = Array.from(arr, (x) => x ?? null);
      });
      data[ws.name] = Array.from(rows, (r) => r ?? []);
    });
    const hf = HyperFormula.buildFromSheets(data, { licenseKey: 'gpl-v3' });
    expect(expected.length).toBeGreaterThan(50);
    for (const e of expected) {
      const got = hf.getCellValue({ sheet: hf.getSheetId(e.sheet)!, row: e.row, col: e.col });
      expect(typeof got, `${e.sheet} r${e.row + 1} c${e.col + 1}`).toBe('number');
      const tol = 1e-7 * Math.max(1, Math.abs(e.value));
      expect(Math.abs((got as number) - e.value), `${e.sheet} r${e.row + 1} c${e.col + 1}: ${got} vs ${e.value}`).toBeLessThan(tol);
    }
  });
});
