/**
 * Printable project report. `buildReportHtml` returns a self-contained HTML document body (escaped, with its own styles) that is
 * shown in the Report panel and printed through a hidden frame, so it can be saved as a PDF from the browser's print dialog.
 */
import { pumpDuty } from './ai/duty';
import type { TargetStatus } from './ai/types';
import { pipeLengthM, type Computed, type ProjectUI } from './model';
import type { Units } from './units';

const esc = (s: string | number | undefined): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE = `
.rp { font: 12px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1d2330; }
.rp h1 { font-size: 20px; margin: 0 0 2px; } .rp h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 1px solid #ccd; padding-bottom: 2px; }
.rp .sub { color: #556; margin-bottom: 10px; }
.rp table { border-collapse: collapse; width: 100%; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
.rp th, .rp td { border-bottom: 1px solid #dde; padding: 3px 6px; text-align: right; } .rp th:first-child, .rp td:first-child { text-align: left; }
.rp th { background: #f1f3f8; font-weight: 600; }
.rp .pass { color: #17612f; font-weight: 700; } .rp .fail { color: #9b1c14; font-weight: 700; }
.rp .warn { background: #fff4d6; color: #7a5200; padding: 4px 8px; border-radius: 4px; margin: 3px 0; }
.rp .err { background: #fde6e4; color: #9b1c14; padding: 6px 8px; border-radius: 4px; }
.rp .kpis { display: flex; gap: 16px; margin: 6px 0; } .rp .kpis div { border: 1px solid #ccd; border-radius: 6px; padding: 6px 10px; }
.rp .kpis b { font-size: 16px; } .rp svg { max-width: 560px; height: auto; } .rp .note { color: #667; font-size: 11px; margin-top: 14px; }
`;

export interface ReportInput {
  project: ProjectUI;
  computed: Computed;
  targets: TargetStatus[];
  units: Units;
  /** SVG of the pump curves (print theme). */
  chartSvg?: string;
  buildId?: string;
  date?: Date;
}

const table = (heads: string[], rows: (string | number)[][]): string =>
  `<table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

export function buildReportHtml({ project, computed, targets, units: U, chartSvg, buildId, date = new Date() }: ReportInput): string {
  const out: string[] = [];
  out.push(`<style>${STYLE}</style><div class="rp">`);
  out.push(`<h1>Pipe network report</h1><div class="sub">${esc(date.toISOString().slice(0, 10))}${buildId ? ` · build ${esc(buildId)}` : ''} · ${esc(U.system === 'si' ? 'SI units' : 'US units')}</div>`);
  const r = computed.result;
  if (computed.error || !r) {
    out.push(`<div class="err">The network could not be solved: ${esc(computed.error ?? 'no result')}</div></div>`);
    return out.join('');
  }
  if (!r.converged) out.push(`<div class="err">The solver did not converge: ${esc(r.message)}. The numbers below are not reliable.</div>`);

  const f = computed.model?.fluid;
  const supply = r.nodes.filter((n) => n.kind === 'tank').reduce((s, n) => s + Math.max(0, -n.netOutflowM3s), 0) * 1000;
  const demand = r.nodes.filter((n) => n.kind === 'junction').reduce((s, n) => s + n.netOutflowM3s, 0) * 1000;
  out.push('<h2>Summary</h2>');
  out.push(`<div class="kpis"><div>Supplied by tanks<br><b>${esc(U.fu('flow', supply, 2))}</b></div><div>Junction demand<br><b>${esc(U.fu('flow', demand, 2))}</b></div><div>Pipes / valves / pumps<br><b>${r.pipes.length} / ${r.valves.length} / ${r.pumps.length}</b></div></div>`);
  if (f) out.push(`<p>Fluid: <b>${esc(f.name)}</b> at ${esc(U.fu('temperature', f.temperatureC, 1))}. Density ${esc(U.fu('density', f.density, 1))}, viscosity ${esc(U.fu('viscosity', f.dynamicViscosity * 1000, 3))}, vapour pressure ${esc(U.fu('pressure', f.vaporPressure / 1000, 2))} absolute.</p>`);

  const messages = [...computed.alerts, ...r.warnings];
  if (messages.length) {
    out.push('<h2>Alerts and warnings</h2>');
    for (const m of messages) out.push(`<div class="warn">${esc(m)}</div>`);
  }

  if (targets.length) {
    out.push('<h2>Design targets</h2>');
    out.push(`<table><thead><tr><th>Target</th><th>Result</th><th>Actual vs required</th></tr></thead><tbody>${targets.map((t) => `<tr><td>${esc(t.label)}</td><td class="${t.pass ? 'pass' : 'fail'}">${t.pass ? 'PASS' : 'FAIL'}</td><td style="text-align:left">${esc(t.text)}</td></tr>`).join('')}</tbody></table>`);
  }

  if (r.pumps.length) {
    out.push('<h2>Pumps</h2>');
    out.push(table(['Pump', `Q [${U.u('flow')}]`, `H [${U.u('head')}]`, '% of BEP', 'Efficiency', `Shaft [${U.u('power')}]`, `NPSH margin [${U.u('head')}]`, 'Speed', 'Status'], r.pumps.map((p) => {
      const edge = computed.model?.edges.find((e) => e.kind === 'pump' && e.id === p.id);
      const d = edge && edge.kind === 'pump' ? pumpDuty(edge.model, p) : undefined;
      const ui = project.edges.find((e) => e.kind === 'pump' && e.name === p.id);
      const off = ui?.kind === 'pump' && ui.running === false;
      return [p.id, U.f('flow', p.flowM3s * 1000, 2), U.f('head', p.headM, 1), d?.pctBep !== undefined ? d.pctBep.toFixed(0) : '–', p.efficiency !== undefined ? `${(p.efficiency * 100).toFixed(1)} %` : '–', d?.shaftKw !== undefined ? U.f('power', d.shaftKw, 2) : '–', p.npshMarginM !== undefined ? U.f('head', p.npshMarginM, 2) : '–', `${(p.speedRatio * 100).toFixed(1)} %${ui?.kind === 'pump' && ui.control ? ' (controlled)' : ''}`, off ? 'off' : p.flowM3s > 1e-9 ? 'running' : 'no flow'];
    })));
  }
  if (chartSvg) out.push(`<div>${chartSvg}</div>`);

  out.push('<h2>Nodes</h2>');
  out.push(table(['Node', 'Type', `Elevation [${U.u('elevation')}]`, `Head [${U.u('head')}]`, `Gauge pressure [${U.u('pressure')}]`, `Net outflow [${U.u('flow')}]`], r.nodes.map((n) => [n.id, n.kind, U.f('elevation', n.elevationM, 2), U.f('head', n.headM, 2), U.f('pressure', n.gaugePressurePa / 1000, 1), U.f('flow', n.netOutflowM3s * 1000, 2)])));

  out.push('<h2>Pipes</h2>');
  out.push(table(['Pipe', 'From → To', `Length [${U.u('length')}]`, `Diameter [${U.u('diameter')}]`, `Q [${U.u('flow')}]`, `Velocity [${U.u('velocity')}]`, `Head loss [${U.u('head')}]`], r.pipes.map((p) => {
    const ui = project.edges.find((e) => e.kind === 'pipe' && e.name === p.id);
    return [p.id, `${p.from} → ${p.to}`, ui?.kind === 'pipe' ? U.f('length', pipeLengthM(project, ui), 1) : '–', ui?.kind === 'pipe' ? U.f('diameter', ui.diameterMm, 1) : '–', U.f('flow', p.flowM3s * 1000, 2), U.f('velocity', p.flow.velocity, 2), U.f('head', p.headDropM, 2)];
  })));

  if (r.valves.length) {
    out.push('<h2>Valves</h2>');
    out.push(table(['Valve', 'From → To', 'Status', `Q [${U.u('flow')}]`, `Drop [${U.u('pressure')}]`, 'K effective'], r.valves.map((v) => [v.id, `${v.from} → ${v.to}`, v.status, U.f('flow', v.flowM3s * 1000, 2), U.f('pressure', v.pressureDropPa / 1000, 1), v.effectiveK.toFixed(2)])));
  }

  const assumptions = project.assumptions ?? [];
  if (assumptions.length) {
    out.push('<h2>Assumptions</h2><ul>' + assumptions.map((a) => `<li><b>${esc(a.category)}:</b> ${esc(a.text)}</li>`).join('') + '</ul>');
  }
  out.push('<div class="note">Calculated by a steady-state, single-phase network solver (Darcy–Weisbach with Colebrook–White friction). This is an engineering aid, not a certified design: check inputs against vendor data and have a competent engineer review any design before it is built. See docs/THEORY.md for the equations and limits.</div></div>');
  return out.join('');
}

/** Print HTML through a hidden frame, so the browser's print dialog (and "Save as PDF") shows only the report. */
export function printHtml(html: string, title = 'Pipe network report'): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc || !frame.contentWindow) {
    frame.remove();
    throw new Error('The print frame could not be created.');
  }
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${html}</body></html>`);
  doc.close();
  const win = frame.contentWindow;
  const cleanup = () => setTimeout(() => frame.remove(), 1000);
  win.addEventListener('afterprint', cleanup);
  setTimeout(() => { win.focus(); win.print(); }, 50);
}
