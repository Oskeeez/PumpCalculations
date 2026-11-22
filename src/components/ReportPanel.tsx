import { useMemo } from 'react';
import type { TargetStatus } from '../ai/types';
import { EXPORT_THEME, pumpChartSvg } from '../curveChart';
import type { Computed, ProjectUI } from '../model';
import { buildReportHtml, printHtml } from '../report';
import { unitFactor, useUnits } from '../units';

interface Props {
  project: ProjectUI;
  computed: Computed;
  targets: TargetStatus[];
  buildId: string;
}

/** A printable summary of the current network. The Print button opens the browser's print dialog, where it can be saved as a PDF. */
export function ReportPanel({ project, computed, targets, buildId }: Props) {
  const U = useUnits();
  const html = useMemo(() => {
    const series = computed.pumpCurves.map((c) => ({ name: c.name, pts: c.pts, op: c.op }));
    const chartSvg = series.length ? pumpChartSvg(series, EXPORT_THEME, { flowLabel: U.u('flow'), headLabel: U.u('head'), flowFactor: unitFactor('flow', U.system), headFactor: unitFactor('head', U.system) }) : undefined;
    return buildReportHtml({ project, computed, targets, units: U, chartSvg, buildId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, computed, targets, U.system, buildId]);
  return (
    <div className="report-panel">
      <div className="toolbar">
        <button className="primary" onClick={() => printHtml(html)}>🖨 Print / save as PDF</button>
      </div>
      <div className="report-preview" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
