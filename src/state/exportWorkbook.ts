import type { TargetStatus } from '../ai/types';
import type { Comparison, SpeedSweep } from '../analysis';
import { EXPORT_THEME, SI_AXES, pumpChartSvg, svgToPngBase64 } from '../curveChart';
import type { Computed, ProjectUI } from '../model';
import { download } from './persistence';

export interface ExportInput {
  project: ProjectUI;
  computed: Computed;
  /** SVG of the pump curves for the sheet (SI units). */
  chartSvg?: string;
  sweep?: SpeedSweep;
  /** Scenario comparison, included only when there are saved scenarios. */
  comparison?: Comparison;
  targets?: TargetStatus[];
}

/** Build the Excel workbook and offer it as a download. Throws with a readable message on failure. */
export async function exportWorkbook({ project, computed, chartSvg, sweep, comparison, targets }: ExportInput): Promise<void> {
  if (!computed.model || !computed.result || !computed.result.converged) throw new Error('The network has no converged result to export.');
  const png = chartSvg ? await svgToPngBase64(chartSvg) : undefined;
  const speedPng = sweep && sweep.series.length ? await svgToPngBase64(pumpChartSvg(sweep.series, EXPORT_THEME, SI_AXES)) : undefined;
  const { buildNetworkWorkbook, workbookToBuffer } = await import('../excel/networkExport'); // lazy: keeps ExcelJS out of the first load
  const wb = await buildNetworkWorkbook({
    model: computed.model,
    result: computed.result,
    npshMarginM: project.npshMarginM,
    pumpCurves: computed.pumpCurves,
    chartPngBase64: png,
    speedChartPngBase64: speedPng,
    speedSweep: sweep && sweep.rows.some((r) => !r.error) ? sweep : undefined,
    comparison,
    targets,
    curveLibrary: project.pumpCurves,
    controlNotes: computed.alerts.filter((a) => /speed \(/.test(a)),
  });
  const buf = await workbookToBuffer(wb);
  download('pipe-network.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}
