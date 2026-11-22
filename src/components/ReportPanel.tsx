import { useMemo, useState } from 'react';
import type { TargetStatus } from '../ai/types';
import { EXPORT_THEME, pumpChartSvg } from '../curveChart';
import type { CalcRecord, Computed, ProjectUI } from '../model';
import { buildReportHtml, emptyCalcRecord, issueState, modelFingerprint, printHtml } from '../report';
import { unitFactor, useUnits } from '../units';

interface Props {
  project: ProjectUI;
  computed: Computed;
  targets: TargetStatus[];
  buildId: string;
  onRecord: (r: CalcRecord) => void;
}

const nextRev = (revs: { rev: string }[]): string => {
  const last = revs[revs.length - 1]?.rev;
  if (!last) return 'A';
  if (/^[A-Y]$/i.test(last)) return String.fromCharCode(last.toUpperCase().charCodeAt(0) + 1);
  if (/^\d+$/.test(last)) return String(Number(last) + 1);
  return `${last}+`;
};

/** The calculation record: title block, revisions and sign-off, and the printable report with every input. */
export function ReportPanel({ project, computed, targets, buildId, onRecord }: Props) {
  const U = useUnits();
  const rec = project.calcRecord ?? emptyCalcRecord();
  const set = (patch: Partial<CalcRecord>) => onRecord({ ...rec, ...patch });
  const st = issueState(project);
  const [draft, setDraft] = useState({ description: '', preparedBy: '', checkedBy: '', approvedBy: '' });
  const html = useMemo(() => {
    const series = computed.pumpCurves.map((c) => ({ name: c.name, pts: c.pts, op: c.op }));
    const chartSvg = series.length ? pumpChartSvg(series, EXPORT_THEME, { flowLabel: U.u('flow'), headLabel: U.u('head'), flowFactor: unitFactor('flow', U.system), headFactor: unitFactor('head', U.system) }) : undefined;
    return buildReportHtml({ project, computed, targets, units: U, chartSvg, buildId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, computed, targets, U.system, buildId]);
  const field = (label: string, k: 'title' | 'calcNo' | 'project' | 'client') => (
    <label className="field"><span>{label}</span><input aria-label={label} value={rec[k]} onChange={(e) => set({ [k]: e.target.value })} /></label>
  );
  const issue = () => {
    const rev = { rev: nextRev(rec.revisions), date: new Date().toISOString().slice(0, 10), ...draft, fingerprint: modelFingerprint(project) };
    set({ revisions: [...rec.revisions, rev] });
    setDraft({ description: '', preparedBy: draft.preparedBy, checkedBy: draft.checkedBy, approvedBy: draft.approvedBy });
  };
  const solved = !!computed.result?.converged;
  return (
    <div className="report-panel">
      <details className="panel" open>
        <summary>Calculation record</summary>
        <div className="grid">
          {field('Title', 'title')}
          {field('Calculation no.', 'calcNo')}
          {field('Project', 'project')}
          {field('Client', 'client')}
        </div>
        <label className="field"><span>Notes</span><textarea rows={2} aria-label="Notes" value={rec.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
        <div className={`banner ${st.kind === 'changed' ? 'warn' : st.kind === 'issued' ? 'ok' : ''}`}>
          {st.kind === 'draft' ? 'Draft: no revision issued yet.' : st.kind === 'issued' ? `Matches revision ${st.rev} as issued.` : `Changed since revision ${st.rev} was issued.`}
        </div>
        <div className="grid">
          <label className="field"><span>Revision description</span><input aria-label="Revision description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={rec.revisions.length ? 'What changed' : 'First issue'} /></label>
          <label className="field"><span>Prepared by</span><input aria-label="Prepared by" value={draft.preparedBy} onChange={(e) => setDraft({ ...draft, preparedBy: e.target.value })} /></label>
          <label className="field"><span>Checked by</span><input aria-label="Checked by" value={draft.checkedBy} onChange={(e) => setDraft({ ...draft, checkedBy: e.target.value })} /></label>
          <label className="field"><span>Approved by</span><input aria-label="Approved by" value={draft.approvedBy} onChange={(e) => setDraft({ ...draft, approvedBy: e.target.value })} /></label>
        </div>
        <div className="toolbar">
          <button disabled={!solved || !draft.preparedBy.trim()} onClick={issue} title={!solved ? 'The network must solve first' : !draft.preparedBy.trim() ? 'Enter who prepared it' : ''}>Issue revision {nextRev(rec.revisions)}</button>
          {rec.revisions.length > 0 && <button onClick={() => set({ revisions: rec.revisions.slice(0, -1) })}>Withdraw revision {rec.revisions[rec.revisions.length - 1].rev}</button>}
        </div>
      </details>
      <div className="toolbar">
        <button className="primary" onClick={() => printHtml(html)}>🖨 Print / save as PDF</button>
      </div>
      <div className="report-preview" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
