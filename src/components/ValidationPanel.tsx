import { useState } from 'react';
import { printHtml } from '../report';
import { runValidation, type CaseResult } from '../validation/cases';

const esc = (s: string | number) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(5) : String(+v.toPrecision(7))) : '–');

function reportHtml(results: CaseResult[], buildId: string): string {
  const pass = results.filter((r) => r.pass).length;
  const rows = results.map((r) => `
    <h2>${esc(r.id)} ${esc(r.title)} <span class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'}</span></h2>
    <p>${esc(r.reference)}</p>
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : `<table><thead><tr><th>Quantity</th><th>Reference</th><th>This app</th><th>Unit</th><th>Allowed</th><th>Result</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${esc(x.quantity)}</td><td>${fmt(x.expected)}</td><td>${fmt(x.actual)}</td><td>${esc(x.unit)}</td><td>${x.tol.rel !== undefined ? `${x.tol.rel * 100} %` : ''}${x.tol.rel !== undefined && x.tol.abs !== undefined ? ' or ' : ''}${x.tol.abs !== undefined ? `${x.tol.abs} ${esc(x.unit)}` : ''}</td><td class="${x.pass ? 'pass' : 'fail'}">${x.pass ? 'pass' : 'FAIL'}</td></tr>`).join('')}</tbody></table>`}`).join('');
  return `<style>.rp{font:12px/1.45 system-ui,sans-serif;color:#1d2330}.rp h1{font-size:20px}.rp h2{font-size:14px;margin:16px 0 4px;border-bottom:1px solid #ccd}.rp table{border-collapse:collapse;width:100%}.rp th,.rp td{border-bottom:1px solid #dde;padding:3px 6px;text-align:right}.rp th:first-child,.rp td:first-child{text-align:left}.rp .pass{color:#17612f;font-weight:700}.rp .fail{color:#9b1c14;font-weight:700}.rp .err{background:#fde6e4;padding:6px}</style>
  <div class="rp"><h1>Validation report</h1><p>${esc(new Date().toISOString().slice(0, 10))} · software build ${esc(buildId)} · ${pass} of ${results.length} cases pass.</p>
  <p>Each case is built and solved by this software exactly as a user model would be, and compared with an independent reference: a closed-form result, a hand method coded separately from the solver, a published table (Crane TP-410, ISO 5167), or the EPANET 2.2 engine.</p>${rows}</div>`;
}

/** Runs the validation pack in the browser and shows or prints the result. */
export function ValidationPanel({ buildId }: { buildId: string }) {
  const [results, setResults] = useState<CaseResult[]>();
  const pass = results?.filter((r) => r.pass).length ?? 0;
  return (
    <div className="validation">
      <div className="toolbar">
        <button className="primary" onClick={() => setResults(runValidation())}>Run validation</button>
        {results && <button onClick={() => printHtml(reportHtml(results, buildId), 'Validation report')}>🖨 Print / save as PDF</button>}
      </div>
      {results && <div className={`banner ${pass === results.length ? 'ok' : 'error'}`}>{pass} of {results.length} cases pass.</div>}
      {results && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Case</th><th>Checks</th><th>Largest difference</th><th>Result</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id} title={r.reference}>
                  <td>{r.id} {r.title}</td>
                  <td>{r.rows.length}</td>
                  <td>{r.error ?? (r.rows.length ? `${fmt(Math.max(...r.rows.map((x) => Math.abs(x.actual - x.expected))))}` : '')}</td>
                  <td className={r.pass ? 'pass-text' : 'fail-text'}>{r.pass ? 'pass' : 'FAIL'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
