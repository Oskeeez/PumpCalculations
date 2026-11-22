/** Target evaluation against solver output, and a quick feasibility screen. Deterministic; the AI never decides pass/fail. */
import { newUid, type Computed, type HydraulicProject } from '../model';
import { G, pumpShutoffHead } from '../solver';
import { pumpDuty } from './duty';
import type { Target, TargetStatus } from './types';

export const newTargetId = (): string => `t${newUid()}`;

const f = (v: number, d = 1) => v.toFixed(d);

export function describeTarget(project: HydraulicProject, t: Target): string {
  if (t.label) return t.label;
  const nm = (uid: string) => project.nodes.find((n) => n.uid === uid)?.name ?? project.edges.find((e) => e.uid === uid)?.name ?? uid;
  switch (t.type) {
    case 'flow': return `Flow at ${nm(t.nodeUid)}`;
    case 'pressure': return `Pressure at ${nm(t.nodeUid)}`;
    case 'velocity': return t.scope === 'all' ? 'Velocity, all pipes' : `Velocity in ${nm(t.scope)}`;
    case 'pumpRange': return `Operating range of ${nm(t.pumpUid)}`;
    case 'npsh': return t.pumpUid === 'all' ? 'NPSH margin, all pumps' : `NPSH margin of ${nm(t.pumpUid)}`;
  }
}

function fail(t: Target, label: string, text: string, unit: string, shortfall = 1, rel = 1): TargetStatus {
  return { targetId: t.id, label, type: t.type, pass: false, text, shortfall, unit, relShortfall: rel };
}

/** Evaluate every target. A project that does not solve fails every target with the solver's message. */
export function evaluateTargets(project: HydraulicProject, targets: Target[], c: Computed): TargetStatus[] {
  return targets.map((t): TargetStatus => {
    const label = describeTarget(project, t);
    const r = c.result;
    if (!r || !c.model) return fail(t, label, c.error ?? 'The network could not be solved.', '', 1, 1);
    if (!r.converged) return fail(t, label, 'The solver did not converge.', '', 1, 1);
    const pass = (text: string, unit: string): TargetStatus => ({ targetId: t.id, label, type: t.type, pass: true, text, shortfall: 0, unit, relShortfall: 0 });
    const nodeName = (uid: string) => project.nodes.find((n) => n.uid === uid)?.name;
    const edgeName = (uid: string) => project.edges.find((e) => e.uid === uid)?.name;

    if (t.type === 'flow' || t.type === 'pressure') {
      const name = nodeName(t.nodeUid);
      const n = name ? r.nodes.find((x) => x.id === name) : undefined;
      if (!n) return fail(t, label, 'The node no longer exists.', '');
      if (t.type === 'flow') {
        const q = n.netOutflowM3s * 1000;
        const short = t.minLps - q;
        const txt = `${f(q, 2)} L/s vs ≥ ${f(t.minLps, 2)} L/s`;
        return short > 1e-6 ? fail(t, label, txt, 'L/s', short, short / Math.max(t.minLps, 1e-9)) : pass(txt, 'L/s');
      }
      const p = n.gaugePressurePa / 1000;
      const lo = t.minKPaG;
      const hi = t.maxKPaG;
      const txt = `${f(p, 0)} kPa vs ${lo !== undefined ? `≥ ${f(lo, 0)}` : ''}${lo !== undefined && hi !== undefined ? ' and ' : ''}${hi !== undefined ? `≤ ${f(hi, 0)}` : ''} kPa (gauge)`;
      if (lo !== undefined && p < lo - 1e-6) return fail(t, label, txt, 'kPa', lo - p, (lo - p) / Math.max(Math.abs(lo), 50));
      if (hi !== undefined && p > hi + 1e-6) return fail(t, label, txt, 'kPa', p - hi, (p - hi) / Math.max(Math.abs(hi), 50));
      return pass(txt, 'kPa');
    }

    if (t.type === 'velocity') {
      const items = [
        ...r.pipes.map((x) => ({ id: x.id, v: x.flow.velocity })),
        ...r.valves.map((x) => ({ id: x.id, v: x.velocity })),
      ].filter((x) => t.scope === 'all' || x.id === edgeName(t.scope));
      if (!items.length) return fail(t, label, 'No matching pipe.', '');
      let worst = 0;
      let worstId = '';
      for (const x of items) {
        const over = Math.max(x.v - t.maxMps, t.minMps !== undefined && x.v > 1e-9 ? t.minMps - x.v : 0);
        if (over > worst) { worst = over; worstId = x.id; }
      }
      const peak = items.reduce((a, b) => (b.v > a.v ? b : a));
      const txt = worst > 1e-6 ? `${worstId} at ${f(items.find((x) => x.id === worstId)?.v ?? 0, 2)} m/s vs ${t.minMps !== undefined ? `${t.minMps}–` : '≤ '}${t.maxMps} m/s` : `max ${f(peak.v, 2)} m/s (${peak.id}) vs ≤ ${t.maxMps} m/s`;
      return worst > 1e-6 ? fail(t, label, txt, 'm/s', worst, worst / t.maxMps) : pass(txt, 'm/s');
    }

    if (t.type === 'pumpRange') {
      const name = edgeName(t.pumpUid);
      const res = name ? r.pumps.find((x) => x.id === name) : undefined;
      const edge = name ? c.model.edges.find((e) => e.id === name) : undefined;
      if (!res || !edge || edge.kind !== 'pump') return fail(t, label, 'The pump no longer exists.', '');
      const d = pumpDuty(edge.model, res);
      const issues: string[] = [];
      let rel = 0;
      let short = 0;
      let unit = '';
      if (t.minPctBep !== undefined && d.pctBep !== undefined && d.pctBep < t.minPctBep) { issues.push(`${f(d.pctBep, 0)} % of BEP < ${t.minPctBep} %`); rel += (t.minPctBep - d.pctBep) / t.minPctBep; short = t.minPctBep - d.pctBep; unit = '% BEP'; }
      if (t.maxPctBep !== undefined && d.pctBep !== undefined && d.pctBep > t.maxPctBep) { issues.push(`${f(d.pctBep, 0)} % of BEP > ${t.maxPctBep} %`); rel += (d.pctBep - t.maxPctBep) / t.maxPctBep; short = d.pctBep - t.maxPctBep; unit = '% BEP'; }
      if (t.minFlowLps !== undefined && d.flowLps < t.minFlowLps) { issues.push(`${f(d.flowLps, 2)} L/s < min ${t.minFlowLps} L/s`); rel += (t.minFlowLps - d.flowLps) / t.minFlowLps; short = t.minFlowLps - d.flowLps; unit = 'L/s'; }
      if (t.withinCurveData && d.beyondCurve) { issues.push('beyond the end of the pump curve (runout)'); rel += d.fractionOfRunout - 1; short = (d.fractionOfRunout - 1) * 100; unit = '% of runout'; }
      const txt = issues.length ? issues.join('; ') : `${f(d.flowLps, 2)} L/s${d.pctBep !== undefined ? `, ${f(d.pctBep, 0)} % of BEP` : ''}`;
      return issues.length ? fail(t, label, txt, unit, short, rel) : pass(txt, unit);
    }

    // npsh
    const pumps = r.pumps.filter((p) => t.pumpUid === 'all' || p.id === edgeName(t.pumpUid));
    if (!pumps.length) return fail(t, label, 'No matching pump.', '');
    const worst = pumps.filter((p) => p.flowM3s > 1e-9).reduce<{ id: string; m: number } | undefined>((a, p) => (p.npshMarginM !== undefined && (!a || p.npshMarginM < a.m) ? { id: p.id, m: p.npshMarginM } : a), undefined);
    if (!worst) return pass('no pump running or no NPSHr data', 'm');
    const txt = `${worst.id}: margin ${f(worst.m, 2)} m vs ≥ ${t.marginM} m`;
    return worst.m < t.marginM - 1e-6 ? fail(t, label, txt, 'm', t.marginM - worst.m, (t.marginM - worst.m) / Math.max(t.marginM, 1)) : pass(txt, 'm');
  });
}

export const allPass = (s: TargetStatus[]): boolean => s.every((x) => x.pass);
export const totalShortfall = (s: TargetStatus[]): number => s.reduce((a, x) => a + x.relShortfall, 0);

/**
 * Cheap physical screen for "this target can never be met". Uses an upper bound on the hydraulic grade anywhere in
 * the network: highest tank surface plus every pump's shutoff head, with zero friction. If a pressure target needs
 * more than that, no arrangement of the existing tanks and pumps can meet it.
 */
export function feasibilityNotes(project: HydraulicProject, targets: Target[], c: Computed): string[] {
  const out: string[] = [];
  const m = c.model;
  if (!m) return out;
  const rho = m.fluid.density;
  const tanks = project.nodes.filter((n) => n.kind === 'tank');
  if (!tanks.length) return out;
  const tankHead = Math.max(...tanks.map((n) => n.elevationM + n.levelM + (n.pressureKPa * 1000 - 101325) / (rho * G)));
  const pumpHead = m.edges.reduce((s, e) => (e.kind === 'pump' ? s + pumpShutoffHead(e.model, Math.max(e.speedRatio, 1)) : s), 0);
  for (const t of targets) {
    if (t.type !== 'pressure' || t.minKPaG === undefined) continue;
    const n = project.nodes.find((x) => x.uid === t.nodeUid);
    if (!n) continue;
    const need = n.elevationM + (t.minKPaG * 1000) / (rho * G);
    if (need > tankHead + pumpHead) out.push(`${describeTarget(project, t)}: needs a hydraulic grade of ${f(need)} m but the highest tank (${f(tankHead)} m) plus every pump's shutoff head (${f(pumpHead)} m) gives at most ${f(tankHead + pumpHead)} m even with zero friction. Infeasible without a bigger pump or a higher supply.`);
    else if (need > tankHead + 0.0001 && pumpHead === 0) out.push(`${describeTarget(project, t)}: static head alone is not enough (needs ${f(need)} m, supply tank gives ${f(tankHead)} m) and there is no pump.`);
  }
  return out;
}
