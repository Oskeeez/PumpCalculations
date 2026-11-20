/** Draft comparison: pass/fail per target, pump duty vs BEP, head burned across valves/orifices, rough cost, warnings. Solver-derived only. */
import type { HydraulicProject } from '../model';
import type { DesignCriteria } from './criteria';
import { diffDraft, estimateCost } from './drafts';
import { pumpDuty } from './duty';
import { allPass, evaluateTargets, feasibilityNotes, totalShortfall } from './targets';
import { solveProject } from './tools';
import type { Draft, Target, TargetStatus } from './types';
import { designWarnings, type DesignWarning } from './warnings';

export interface PumpColumn {
  name: string;
  flowLps: number;
  headM: number;
  pctBep?: number;
  bepFlowLps?: number;
  eta?: number;
  shaftKw?: number;
}

export interface Column {
  id: string;
  name: string;
  rationale: string;
  status: Draft['status'] | 'main';
  solved: boolean;
  error?: string;
  statuses: TargetStatus[];
  allPass: boolean;
  /** Sum of relative shortfalls (0 = all targets met). */
  shortfall: number;
  pumps: PumpColumn[];
  /** Head burned across valves and orifices [m], and where. */
  headBurnedM: number;
  burnedBy: { name: string; headM: number }[];
  cost: number;
  warnings: DesignWarning[];
  feasibility: string[];
  changes: number;
}

export function analyse(id: string, name: string, rationale: string, status: Column['status'], project: HydraulicProject, targets: Target[], criteria: DesignCriteria, changes = 0): Column {
  const c = solveProject(project);
  const r = c.result;
  const statuses = evaluateTargets(project, targets, c);
  const pumps: PumpColumn[] = [];
  const burnedBy: Column['burnedBy'] = [];
  if (r && c.model) {
    for (const p of r.pumps) {
      const e = c.model.edges.find((x) => x.id === p.id);
      const d = e && e.kind === 'pump' ? pumpDuty(e.model, p) : undefined;
      pumps.push({ name: p.id, flowLps: p.flowM3s * 1000, headM: p.headM, pctBep: d?.pctBep, bepFlowLps: d?.bepFlowLps, eta: p.efficiency, shaftKw: d?.shaftKw });
    }
    for (const v of r.valves) if (v.status !== 'closed' && v.status !== 'check-closed' && v.headDropM > 0.005) burnedBy.push({ name: v.id, headM: v.headDropM });
  }
  burnedBy.sort((a, b) => b.headM - a.headM);
  const solved = !!r?.converged && !c.error;
  return {
    id, name, rationale, status, solved, error: c.error ?? (r && !r.converged ? `Not converged: ${r.message}` : undefined),
    statuses, allPass: solved && allPass(statuses), shortfall: solved ? totalShortfall(statuses) : Number.POSITIVE_INFINITY,
    pumps, headBurnedM: burnedBy.reduce((s, x) => s + x.headM, 0), burnedBy,
    cost: estimateCost(project, c, criteria).total, warnings: designWarnings(project, c, criteria), feasibility: feasibilityNotes(project, targets, c), changes,
  };
}

/** Main plus every draft that is not discarded. */
export function compareAll(main: HydraulicProject & { targets?: Target[] }, drafts: Draft[], criteria: DesignCriteria): Column[] {
  const cols: Column[] = [analyse('main', 'Current (main)', '', 'main', main, main.targets ?? [], criteria)];
  for (const d of drafts) if (d.status !== 'discarded') cols.push(analyse(d.id, d.name, d.rationale, d.status, d.project, d.targets, criteria, diffDraft(d).length));
  return cols;
}

/** Best first: all targets met, then smallest shortfall, then lowest cost. Unsolved drafts last. */
export function rank(cols: Column[]): Column[] {
  return [...cols].sort((a, b) => Number(b.allPass) - Number(a.allPass) || a.shortfall - b.shortfall || a.cost - b.cost);
}

/** Plain statement of the outcome. Never calls a failing draft a pass. */
export function verdict(drafts: Column[]): string {
  const real = drafts.filter((c) => c.status !== 'main');
  if (!real.length) return 'No drafts to compare.';
  const passing = real.filter((c) => c.allPass);
  if (passing.length) return `${passing.length} of ${real.length} draft(s) meet every target: ${rank(passing).map((c) => c.name).join(', ')}.`;
  const best = rank(real)[0];
  const worst = best.statuses.filter((s) => !s.pass).map((s) => `${s.label} (${s.text})`);
  const infeasible = real.flatMap((c) => c.feasibility);
  return `No draft meets every target. Closest: "${best.name}", still failing ${worst.length ? worst.join('; ') : best.error ?? 'to solve'}.${infeasible.length ? ` The targets may be infeasible: ${infeasible[0]}` : ''}`;
}
