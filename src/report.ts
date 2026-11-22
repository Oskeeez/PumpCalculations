/**
 * Printable project report. `buildReportHtml` returns a self-contained HTML document body (escaped, with its own styles) that is
 * shown in the Report panel and printed through a hidden frame, so it can be saved as a PDF from the browser's print dialog.
 */
import { pumpDuty } from './ai/duty';
import type { TargetStatus } from './ai/types';
import { allFittings } from './fittingLibrary';
import { JUNCTION_FITTING_LABELS, fittingStatus, junctionLegLosses, VALVE_TYPES } from './fittings';
import { DEFAULT_HAZEN_C, hydraulicKey, pipeLengthM, type CalcRecord, type Computed, type PipeUI, type ProjectUI } from './model';
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
.rp .kpis b { font-size: 16px; } .rp .tb { width: 100%; border: 1.5px solid #333; margin-bottom: 10px; } .rp .tb td { text-align: left; border: 1px solid #999; } .rp .tb .lbl { color: #556; font-size: 10px; display: block; } .rp .sig td { height: 34px; vertical-align: bottom; } .rp .state { font-weight: 700; } .rp .state.changed { color: #9b1c14; } .rp svg { max-width: 560px; height: auto; } .rp .note { color: #667; font-size: 11px; margin-top: 14px; }
`;

/** A short fingerprint of everything that affects the hydraulic result. Two projects with the same fingerprint solve the same. */
export function modelFingerprint(project: ProjectUI): string {
  const str = hydraulicKey(project);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).toUpperCase();
}

/** Whether the model still matches the last issued revision. */
export function issueState(project: ProjectUI): { kind: 'draft' | 'issued' | 'changed'; rev?: string } {
  const revs = (project.calcRecord?.revisions ?? []).filter((r) => r.fingerprint);
  const last = revs[revs.length - 1];
  if (!last) return { kind: 'draft' };
  return { kind: last.fingerprint === modelFingerprint(project) ? 'issued' : 'changed', rev: last.rev };
}

export const emptyCalcRecord = (): CalcRecord => ({ title: 'Pipe network calculation', calcNo: '', project: '', client: '', notes: '', revisions: [] });

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
  const rec = project.calcRecord ?? emptyCalcRecord();
  const revs = rec.revisions;
  const last = revs[revs.length - 1];
  const st = issueState(project);
  const fp = modelFingerprint(project);
  out.push(`<h1>${esc(rec.title || 'Pipe network calculation')}</h1><div class="sub">${esc(date.toISOString().slice(0, 10))}${buildId ? ` · software build ${esc(buildId)}` : ''} · ${esc(U.system === 'si' ? 'SI units' : 'US units')}</div>`);
  const cell = (l: string, v: string) => `<td><span class="lbl">${esc(l)}</span>${esc(v) || '&nbsp;'}</td>`;
  out.push(`<table class="tb"><tbody><tr>${cell('Project', rec.project)}${cell('Client', rec.client)}${cell('Calculation no.', rec.calcNo)}${cell('Revision', last?.rev ?? '–')}</tr>`);
  out.push(`<tr><td colspan="3"><span class="lbl">Status</span><span class="state ${st.kind}">${st.kind === 'draft' ? 'Draft, not issued' : st.kind === 'issued' ? `As issued at revision ${esc(st.rev)}` : `Changed since revision ${esc(st.rev)} was issued: re-check and issue a new revision`}</span></td>${cell('Model fingerprint', fp)}</tr></tbody></table>`);
  if (revs.length) {
    out.push(table(['Rev', 'Date', 'Description', 'Prepared', 'Checked', 'Approved', 'Fingerprint'], revs.map((r) => [r.rev, r.date, r.description, r.preparedBy, r.checkedBy, r.approvedBy, r.fingerprint ?? ''])));
  }
  out.push(`<table class="tb sig"><tbody><tr>${cell('Prepared by', last?.preparedBy ?? '')}${cell('Signature', '')}${cell('Checked by', last?.checkedBy ?? '')}${cell('Signature', '')}${cell('Approved by', last?.approvedBy ?? '')}${cell('Signature', '')}</tr></tbody></table>`);
  if (rec.notes) out.push(`<p>${esc(rec.notes)}</p>`);
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

  const hw = project.frictionMethod === 'hw';
  out.push('<h2>Basis of calculation</h2><ul>');
  out.push(`<li>Steady-state, single-phase, incompressible flow. Network solved by Newton-Raphson on node heads; convergence ${r.converged ? 'reached' : 'NOT reached'} in ${r.iterations} iterations, largest flow imbalance ${esc((r.residualM3s * 1000).toExponential(1))} L/s.</li>`);
  out.push(`<li>Pipe friction: ${hw ? 'Hazen-Williams, h = 10.67 L Q^1.852 / (C^1.852 D^4.871)' : 'Darcy-Weisbach with Colebrook-White friction factor (laminar 64/Re below Re 2300, blended to 4000)'}.</li>`);
  out.push('<li>Fitting losses: K = n x fT (Crane TP-410) unless an own value is given; junction losses added to the connected pipes.</li>');
  out.push(`<li>NPSH margin required ${esc(U.fu('head', project.npshMarginM, 2))}; velocity limit ${project.maxVelocityMps > 0 ? esc(U.fu('velocity', project.maxVelocityMps, 2)) : 'none'}.</li>`);
  out.push('</ul>');

  // ---- input data
  out.push('<h2>Input data: nodes</h2>');
  const pipesUi = project.edges.filter((e): e is PipeUI => e.kind === 'pipe');
  out.push(table(['Node', 'Type', `Elevation [${U.u('elevation')}]`, `Liquid level [${U.u('length')}]`, `Surface pressure, abs [${U.u('pressure')}]`, `Demand [${U.u('flow')}]`, 'Fitting', 'Fitting K (total)', 'Loss source'], project.nodes.map((n) => {
    let fit = '';
    let k = '';
    let src = '';
    if (n.fitting) {
      const stt = fittingStatus(n, project.nodes, pipesUi);
      fit = `${JUNCTION_FITTING_LABELS[n.fitting.type]}${stt.angleDeg !== undefined && n.fitting.type !== 'tee' ? ` ${Math.round(stt.angleDeg)}°` : ''}${n.fitting.type === 'elbow' ? `, ${n.fitting.style}${n.fitting.style === 'flanged' ? ` r/D ${n.fitting.rOverD ?? 1.5}` : ''}` : ''}${stt.problem ? ` (${stt.problem})` : ''}`;
      const legs = junctionLegLosses(project.nodes.map((x) => (x.uid === n.uid ? x : { ...x, fitting: undefined })), pipesUi);
      k = [...legs.values()].reduce((a, b) => a + b, 0).toFixed(3);
      src = n.fitting.override ? 'Own value' : n.fitting.type === 'wye' || n.fitting.type === 'cross' ? 'Estimate (not published data)' : 'Crane TP-410';
    }
    return n.kind === 'tank'
      ? [n.name, 'tank', U.f('elevation', n.elevationM, 2), U.f('length', n.levelM, 2), U.f('pressure', n.pressureKPa, 1), '–', '', '', '']
      : [n.name, 'junction', U.f('elevation', n.elevationM, 2), '–', '–', U.f('flow', n.demandLps, 3), fit, k, src];
  })));

  out.push('<h2>Input data: pipes</h2>');
  out.push(table(['Pipe', 'From → To', `Length [${U.u('length')}]`, 'Length from', `Inside diameter [${U.u('diameter')}]`, hw ? 'Hazen-Williams C' : `Roughness [${U.u('roughness')}]`, 'Fittings (K)', `Rating [${U.u('pressure')}]`], pipesUi.map((e) => {
    const nm = (u: string) => project.nodes.find((n) => n.uid === u)?.name ?? '?';
    return [e.name, `${nm(e.from)} → ${nm(e.to)}`, U.f('length', pipeLengthM(project, e), 2), e.lengthMode === 'canvas' ? 'drawing' : 'typed', U.f('diameter', e.diameterMm, 2), hw ? String(e.hazenC ?? DEFAULT_HAZEN_C) : U.f('roughness', e.roughnessMm, 4), e.fittings.map((f) => `${f.name} ${f.k}`).join('; ') || '–', e.ratingKPaG !== undefined ? U.f('pressure', e.ratingKPaG, 0) : '–'];
  })));

  const valvesUi = project.edges.filter((e) => e.kind === 'valve');
  if (valvesUi.length) {
    out.push('<h2>Input data: valves</h2>');
    out.push(table(['Valve', 'Type', `Diameter [${U.u('diameter')}]`, 'Loss', 'Check', 'Open', 'Regulation'], valvesUi.map((e) => e.kind !== 'valve' ? [] : [
      e.name,
      e.valveType ? VALVE_TYPES.find((t) => t.id === e.valveType)?.label ?? e.valveType : e.lossType === 'orifice' ? 'Orifice plate' : 'Custom',
      U.f('diameter', e.diameterMm, 2),
      e.lossType === 'orifice' ? `bore ${U.f('diameter', e.lossValue, 2)}, Cd ${e.orificeCd ?? 0.61}` : `${e.lossType} ${e.lossValue}`,
      e.checkValve ? 'yes' : 'no',
      e.open ? 'yes' : 'no',
      e.controlType === 'none' ? '–' : e.controlType === 'fcv' ? `FCV ${U.fu('flow', e.controlValue, 2)}` : `${e.controlType.toUpperCase()} ${U.fu('pressure', e.controlValue, 1)}`,
    ])));
  }

  const pumpsUi = project.edges.filter((e) => e.kind === 'pump');
  for (const e of pumpsUi) {
    if (e.kind !== 'pump') continue;
    out.push(`<h2>Input data: pump ${esc(e.name)}</h2>`);
    out.push(`<p>Rated speed ${e.ratedRpm} rpm, speed ${(e.speedRatio * 100).toFixed(1)} %, impeller trim ${((e.impellerTrim ?? 1) * 100).toFixed(1)} %${e.control ? `, controlled to ${e.control.mode === 'flow' ? U.fu('flow', e.control.lps, 2) : U.fu('pressure', e.control.kPaG, 1)}` : ''}${e.running === false ? ', switched off' : ''}.</p>`);
    out.push(table([`Q [${U.u('flow')}]`, `H [${U.u('head')}]`], e.head.map((x) => [U.f('flow', x.q, 2), U.f('head', x.h, 2)])));
  }

  // library sources used by pipe fittings
  const used = new Map<string, string>();
  const lib = allFittings();
  for (const e of pipesUi) for (const f of e.fittings) { const hit = lib.find((x) => x.name === f.name); used.set(f.name, hit ? hit.source : 'Typed by the user'); }
  if (used.size) {
    out.push('<h2>Loss data sources</h2>');
    out.push(table(['Fitting', 'Source'], [...used.entries()].map(([n, s2]) => [n, s2])));
  }

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
  out.push('<div class="note">Calculated by a steady-state, single-phase network solver. This is an engineering aid, not a certified design: check inputs against vendor data and have a competent engineer review any design before it is built. See docs/THEORY.md for the equations and limits.</div></div>');
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
