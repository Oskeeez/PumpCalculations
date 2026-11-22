/**
 * "Solve this for me": keep every component, and change only what the user allows (and has not locked) until the design targets pass.
 * A deterministic search that calls the same solver as the rest of the app.
 *
 *  1. Work out how far the targets are missed (the sum of the relative shortfalls).
 *  2. Try each allowed change (one step to the next pipe size, or a step in a pump speed, valve setting, bore, ...). Keep the one that
 *     reduces the shortfall most, following a promising direction for as long as it keeps helping. Repeat.
 *  3. Once everything passes, tighten: pull every change back toward the original as far as the targets still allow, so the result is
 *     the smallest change that works (plus an optional safety margin).
 *
 * Locked nodes and components are never changed, and neither is anything connected to a locked node.
 */
import { estimateCost } from './ai/drafts';
import { DEFAULT_CRITERIA } from './ai/criteria';
import { evaluateTargets, feasibilityNotes, totalShortfall } from './ai/targets';
import type { Target, TargetStatus } from './ai/types';
import { PIPE_SERIES, matchPipeSize } from './library';
import { compute, type EdgeUI, type ProjectUI } from './model';

export interface SolveSettings {
  /** Choose a different diameter for pipes, from a standard series. */
  pipes: { on: boolean; series: string; minMm: number; maxMm: number };
  /** Change the speed ratio of pumps that run at a typed speed. */
  pumpSpeed: { on: boolean; min: number; max: number };
  /** Trim impellers (D/D_full). */
  trim: { on: boolean; min: number };
  /** Open or close throttle valves, as a multiple of their present resistance. */
  valves: { on: boolean; minFactor: number; maxFactor: number };
  /** Move PRV / PSV pressure settings and FCV flow settings by up to this fraction. */
  regulators: { on: boolean; spanFraction: number };
  /** Change orifice bores. */
  orifices: { on: boolean };
  /** Change tank liquid levels. */
  tanks: { on: boolean; minLevelM: number; maxLevelM: number };
  /** Aim this far past a flow, pressure or velocity target (a fraction), so the result is not exactly on the limit. */
  marginFraction: number;
  /** Do not let a change break the velocity limit or the NPSH margin set in the top bar, where they hold now. */
  keepDesignLimits: boolean;
  /** Stop after this many network solutions. */
  maxSolves: number;
}

export const DEFAULT_SOLVE_SETTINGS: SolveSettings = {
  pipes: { on: true, series: 'sch40', minMm: 15, maxMm: 310 },
  pumpSpeed: { on: true, min: 0.5, max: 1.1 },
  trim: { on: false, min: 0.75 },
  valves: { on: true, minFactor: 0.2, maxFactor: 50 },
  regulators: { on: false, spanFraction: 0.6 },
  orifices: { on: true },
  tanks: { on: false, minLevelM: 0, maxLevelM: 10 },
  marginFraction: 0.03,
  keepDesignLimits: true,
  maxSolves: 1500,
};

export interface Change {
  uid: string;
  component: string;
  parameter: string;
  from: string;
  to: string;
}

export type SolveStatus = 'already-passing' | 'solved' | 'improved' | 'no-improvement' | 'nothing-allowed';

export interface SolveOutcome {
  status: SolveStatus;
  /** The project with the changes applied (the same object when nothing changed). */
  project: ProjectUI;
  changes: Change[];
  before: TargetStatus[];
  after: TargetStatus[];
  /** Rough installed cost before and after (placeholder rates, for comparison only). */
  costBefore: number;
  costAfter: number;
  solves: number;
  notes: string[];
}

export interface SolveHooks {
  /** Called now and then with the number of solutions tried and the remaining shortfall. */
  onProgress?: (info: { solves: number; shortfall: number }) => void;
  /** Return true to stop early; the best result so far is returned. */
  shouldCancel?: () => boolean;
}

interface Variable {
  uid: string;
  component: string;
  parameter: string;
  kind: 'discrete' | 'continuous';
  /** Candidate values for a discrete variable, ascending. */
  values?: number[];
  lo: number;
  hi: number;
  /** Continuous variables move by multiples (log scale) rather than by amounts. */
  log: boolean;
  start: number;
  /** Apply a value to the project. */
  apply: (p: ProjectUI, v: number) => ProjectUI;
  format: (v: number) => string;
}

const mapEdge = (p: ProjectUI, uid: string, f: (e: EdgeUI) => EdgeUI): ProjectUI => ({ ...p, edges: p.edges.map((e) => (e.uid === uid ? f(e) : e)) });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const fmt = (v: number, d = 2) => String(+v.toFixed(d));

/** Targets made a little stricter, so a solved design has some room (flow, pressure and velocity only). */
export function withMargin(targets: Target[], margin: number): Target[] {
  if (!(margin > 0)) return targets;
  const up = (v: number) => v + Math.abs(v) * margin;
  return targets.map((t): Target => {
    if (t.type === 'flow') return { ...t, minLps: up(t.minLps) };
    if (t.type === 'pressure') return { ...t, minKPaG: t.minKPaG === undefined ? undefined : up(t.minKPaG), maxKPaG: t.maxKPaG === undefined ? undefined : t.maxKPaG - Math.abs(t.maxKPaG) * margin };
    if (t.type === 'velocity') return { ...t, maxMps: t.maxMps * (1 - margin) };
    return t;
  });
}

/** The things the search may change, given the settings and the locks. */
export function findVariables(p: ProjectUI, s: SolveSettings, locked: ReadonlySet<string>, scope?: ReadonlySet<string>): Variable[] {
  const vars: Variable[] = [];
  const nodeFree = (uid: string) => !locked.has(uid);
  // an element can change only if neither it nor either of its end nodes is locked
  const edgeFree = (e: EdgeUI) => !locked.has(e.uid) && nodeFree(e.from) && nodeFree(e.to) && (!scope || scope.has(e.uid));

  for (const e of p.edges) {
    if (!edgeFree(e)) continue;
    if (e.kind === 'pipe' && s.pipes.on) {
      const series = PIPE_SERIES.find((x) => x.id === s.pipes.series) ?? PIPE_SERIES[0];
      const sizes = series.sizes.map((x) => x.idMm).filter((d) => d >= s.pipes.minMm && d <= s.pipes.maxMm);
      const values = [...new Set([...sizes, e.diameterMm])].sort((a, b) => a - b);
      if (values.length > 1) {
        vars.push({
          uid: e.uid, component: e.name, parameter: 'diameter', kind: 'discrete', values, lo: values[0], hi: values[values.length - 1], log: false, start: e.diameterMm,
          apply: (q, v) => mapEdge(q, e.uid, (x) => (x.kind === 'pipe' ? { ...x, diameterMm: v } : x)),
          format: (v) => {
            const m = matchPipeSize(v, s.pipes.series);
            return `${fmt(v, 1)} mm${m ? ` (${m.nps})` : ''}`;
          },
        });
      }
    } else if (e.kind === 'pump' && e.running !== false) {
      if (s.pumpSpeed.on && !e.control) {
        const lo = Math.min(s.pumpSpeed.min, e.speedRatio);
        const hi = Math.max(s.pumpSpeed.max, e.speedRatio);
        vars.push({
          uid: e.uid, component: e.name, parameter: 'speed', kind: 'continuous', lo, hi, log: false, start: e.speedRatio,
          apply: (q, v) => mapEdge(q, e.uid, (x) => (x.kind === 'pump' ? { ...x, speedRatio: v } : x)),
          format: (v) => `${fmt(v * 100, 1)} % of rated`,
        });
      }
      if (s.trim.on) {
        const t0 = e.impellerTrim ?? 1;
        vars.push({
          uid: e.uid, component: e.name, parameter: 'impeller trim', kind: 'continuous', lo: Math.min(s.trim.min, t0), hi: 1, log: false, start: t0,
          apply: (q, v) => mapEdge(q, e.uid, (x) => (x.kind === 'pump' ? { ...x, impellerTrim: v, curveId: x.curveId } : x)),
          format: (v) => `${fmt(v * 100, 1)} % diameter`,
        });
      }
    } else if (e.kind === 'valve' && e.open) {
      if (e.lossType === 'orifice' && s.orifices.on) {
        vars.push({
          uid: e.uid, component: e.name, parameter: 'orifice bore', kind: 'continuous', lo: Math.min(0.15 * e.diameterMm, e.lossValue), hi: Math.max(0.92 * e.diameterMm, e.lossValue), log: true, start: e.lossValue,
          apply: (q, v) => mapEdge(q, e.uid, (x) => (x.kind === 'valve' ? { ...x, lossValue: v } : x)),
          format: (v) => `${fmt(v, 2)} mm bore`,
        });
      } else if (e.controlType !== 'none' && s.regulators.on) {
        const v0 = e.controlValue;
        const span = s.regulators.spanFraction;
        const lo = e.controlType === 'fcv' ? Math.max(v0 * (1 - span), v0 * 0.05) : Math.max(0, v0 * (1 - span));
        vars.push({
          uid: e.uid, component: e.name, parameter: e.controlType === 'fcv' ? 'flow setting' : 'pressure setting', kind: 'continuous', lo, hi: v0 * (1 + span) || 1, log: false, start: v0,
          apply: (q, v) => mapEdge(q, e.uid, (x) => (x.kind === 'valve' ? { ...x, controlValue: v } : x)),
          format: (v) => (e.controlType === 'fcv' ? `${fmt(v, 2)} L/s` : `${fmt(v, 1)} kPa gauge`),
        });
      } else if (e.controlType === 'none' && !e.checkValve && s.valves.on && e.lossType !== 'orifice') {
        // a multiple of the present resistance: K scales directly, Cv and Kv with the inverse square
        const k0 = e.lossType === 'K' ? Math.max(e.lossValue, 0.05) : e.lossValue;
        vars.push({
          uid: e.uid, component: e.name, parameter: 'throttle position', kind: 'continuous', lo: s.valves.minFactor, hi: s.valves.maxFactor, log: true, start: 1,
          apply: (q, m) => mapEdge(q, e.uid, (x) => (x.kind === 'valve' ? { ...x, lossValue: e.lossType === 'K' ? k0 * m : k0 / Math.sqrt(m) } : x)),
          format: (m) => `${e.lossType} ${fmt(e.lossType === 'K' ? k0 * m : k0 / Math.sqrt(m), e.lossType === 'K' ? 2 : 1)}`,
        });
      }
    }
  }
  if (s.tanks.on) {
    for (const n of p.nodes) {
      if (n.kind !== 'tank' || !nodeFree(n.uid) || (scope && !scope.has(n.uid))) continue;
      vars.push({
        uid: n.uid, component: n.name, parameter: 'liquid level', kind: 'continuous', lo: Math.min(s.tanks.minLevelM, n.levelM), hi: Math.max(s.tanks.maxLevelM, n.levelM), log: false, start: n.levelM,
        apply: (q, v) => ({ ...q, nodes: q.nodes.map((x) => (x.uid === n.uid ? { ...x, levelM: v } : x)) }),
        format: (v) => `${fmt(v, 2)} m`,
      });
    }
  }
  return vars;
}

/** Search and tighten as described at the top of this file. */
export async function solveForTargets(
  project: ProjectUI,
  targets: Target[],
  settings: SolveSettings = DEFAULT_SOLVE_SETTINGS,
  locked: ReadonlySet<string> = new Set(),
  hooks: SolveHooks = {},
  scope?: ReadonlySet<string>,
): Promise<SolveOutcome> {
  let solves = 0;
  const margined = withMargin(targets, settings.marginFraction);
  const evaluate = (p: ProjectUI, ts: Target[]) => {
    solves++;
    const c = compute(p);
    if (c.error || !c.result || !c.result.converged) return { S: Number.POSITIVE_INFINITY, statuses: [] as TargetStatus[], computed: c };
    const statuses = evaluateTargets(p, ts, c);
    return { S: totalShortfall(statuses), statuses, computed: c };
  };
  const cost = (p: ProjectUI, c: ReturnType<typeof compute>) => (c.model || c.result ? estimateCost(p, c, DEFAULT_CRITERIA).total : 0);

  const start = evaluate(project, targets);
  // guards: limits that hold now must keep holding (no margin: they are not the thing being solved for)
  const guards: Target[] = [];
  const guardNotes: string[] = [];
  if (settings.keepDesignLimits && Number.isFinite(start.S)) {
    const candidates: [Target, string][] = [];
    if (project.maxVelocityMps > 0) candidates.push([{ id: 'guard-velocity', type: 'velocity', scope: 'all', maxMps: project.maxVelocityMps }, `the ${project.maxVelocityMps} m/s velocity limit`]);
    if (project.npshMarginM > 0 && project.edges.some((e) => e.kind === 'pump')) candidates.push([{ id: 'guard-npsh', type: 'npsh', pumpUid: 'all', marginM: project.npshMarginM }, `the ${project.npshMarginM} m NPSH margin`]);
    for (const [t, label] of candidates) {
      if (evaluateTargets(project, [t], start.computed).every((x) => x.pass)) {
        guards.push(t);
        guardNotes.push(label);
      }
    }
  }
  const strict = [...margined, ...guards];
  const costBefore = cost(project, start.computed);
  const done = (status: SolveStatus, p: ProjectUI, changes: Change[], notes: string[]): SolveOutcome => {
    const fin = evaluate(p, targets);
    return { status, project: p, changes, before: start.statuses, after: fin.statuses, costBefore, costAfter: cost(p, fin.computed), solves, notes };
  };

  if (!targets.length) return done('nothing-allowed', project, [], ['There are no targets to meet. Add a target first.']);
  if (!Number.isFinite(start.S)) return done('no-improvement', project, [], [start.computed.error ?? 'The network does not solve as it is, so there is nothing to start from. Fix that first.']);
  if (start.S === 0) return done('already-passing', project, [], ['Every target already passes.']);

  const vars = findVariables(project, settings, locked, scope);
  if (!vars.length) return done('nothing-allowed', project, [], ['Nothing is allowed to change. Switch on a category of changes, or unlock some components.']);

  // ---- search
  const value = new Map<string, number>(vars.map((v) => [v.uid + v.parameter, v.start]));
  const keyOf = (v: Variable) => v.uid + v.parameter;
  const build = (vals: Map<string, number>): ProjectUI => vars.reduce((p, v) => (vals.get(keyOf(v)) === v.start ? p : v.apply(p, vals.get(keyOf(v)) as number)), project);
  let S = evaluate(project, strict).S;
  let stepScale = 1;
  let cancelled = false;
  const trySet = (v: Variable, x: number) => {
    const vals = new Map(value);
    vals.set(keyOf(v), x);
    const p = build(vals);
    return { vals, p, S: evaluate(p, strict).S };
  };
  const move = (v: Variable, cur: number, dir: 1 | -1, scale: number): number => {
    if (v.kind === 'discrete') {
      const vs = v.values as number[];
      const i = vs.findIndex((d) => d === cur);
      const j = clamp((i < 0 ? vs.findIndex((d) => d >= cur) : i) + dir, 0, vs.length - 1);
      return vs[j];
    }
    if (v.log) return clamp(cur * Math.exp(dir * 0.5 * scale), v.lo, v.hi);
    return clamp(cur + dir * (v.hi - v.lo) * 0.12 * scale, v.lo, v.hi);
  };

  for (let iter = 0; iter < 80 && S > 0; iter++) {
    let best: { vals: Map<string, number>; p: ProjectUI; S: number } | undefined;
    for (const v of vars) {
      if (solves >= settings.maxSolves || hooks.shouldCancel?.()) {
        cancelled = hooks.shouldCancel?.() ?? false;
        break;
      }
      const cur = value.get(keyOf(v)) as number;
      for (const dir of [1, -1] as const) {
        let x = move(v, cur, dir, stepScale);
        if (x === cur) continue;
        let trial = trySet(v, x);
        if (!(trial.S < S - 1e-12)) continue;
        // keep going in this direction while it keeps helping (doubling the step for continuous variables)
        let scale = stepScale;
        for (let k = 0; k < 8 && trial.S > 0 && solves < settings.maxSolves; k++) {
          scale *= v.kind === 'continuous' ? 2 : 1;
          const nx = move(v, x, dir, scale);
          if (nx === x) break;
          const next = trySet(v, nx);
          if (!(next.S < trial.S - 1e-12)) break;
          trial = next;
          x = nx;
        }
        if (!best || trial.S < best.S) best = trial;
      }
    }
    hooks.onProgress?.({ solves, shortfall: best ? best.S : S });
    await tick();
    if (best) {
      value.clear();
      for (const [k, x] of best.vals) value.set(k, x);
      S = best.S;
      stepScale = 1;
    } else if (stepScale > 0.1 && solves < settings.maxSolves && !hooks.shouldCancel?.()) {
      stepScale /= 2; // nothing helped at this step size: look closer
    } else break;
    if (solves >= settings.maxSolves || cancelled || hooks.shouldCancel?.()) break;
  }

  const notes: string[] = [];
  const reached = S === 0;

  // ---- tighten: pull each change back toward where it started while the targets (with their margin) still pass
  if (reached) {
    const passes = (p: ProjectUI) => evaluate(p, strict).S === 0; // keep the margin
    const changed = vars.filter((v) => value.get(keyOf(v)) !== v.start);
    changed.sort((a, b) => Math.abs(((value.get(keyOf(b)) as number) - b.start) / (b.hi - b.lo || 1)) - Math.abs(((value.get(keyOf(a)) as number) - a.start) / (a.hi - a.lo || 1)));
    for (const v of changed) {
      if (solves >= settings.maxSolves + 400) break;
      const x1 = value.get(keyOf(v)) as number;
      let best = x1;
      if (v.kind === 'discrete') {
        const vs = v.values as number[];
        let i = vs.indexOf(x1);
        const target = vs.indexOf(v.start);
        const stepBack = i > target ? -1 : 1;
        while (i !== target) {
          const vals = new Map(value);
          vals.set(keyOf(v), vs[i + stepBack]);
          if (!passes(build(vals))) break;
          i += stepBack;
          best = vs[i];
          value.set(keyOf(v), best);
        }
      } else {
        let good = x1; // passes
        let bad = v.start; // the original does not pass (checked as part of the search)
        for (let k = 0; k < 12; k++) {
          const mid = v.log ? Math.sqrt(good * bad) : (good + bad) / 2;
          const vals = new Map(value);
          vals.set(keyOf(v), mid);
          if (passes(build(vals))) good = mid;
          else bad = mid;
        }
        best = good;
        value.set(keyOf(v), best);
      }
    }
  }

  const changes: Change[] = vars
    .filter((v) => value.get(keyOf(v)) !== v.start)
    .map((v) => ({ uid: v.uid, component: v.component, parameter: v.parameter, from: v.format(v.start), to: v.format(value.get(keyOf(v)) as number) }));
  const final = build(value);

  if (!reached) {
    const sc = evaluate(final, targets);
    const better = sc.S < start.S - 1e-12;
    const atLimit = vars.filter((v) => {
      const x = value.get(keyOf(v)) as number;
      return v.kind === 'discrete' ? x === (v.values as number[])[(v.values as number[]).length - 1] : x >= v.hi * 0.999;
    });
    notes.push(better ? 'The targets are not all met: this is the best the allowed changes could do.' : 'None of the allowed changes helped.');
    if (solves >= settings.maxSolves) notes.push(`The search stopped after ${settings.maxSolves} tries. Raise the limit in the settings to let it keep going.`);
    if (cancelled) notes.push('Stopped early.');
    if (atLimit.length) notes.push(`At their limit: ${atLimit.map((v) => `${v.component} ${v.parameter}`).join(', ')}. Widen those limits or allow more things to change.`);
    notes.push(...feasibilityNotes(final, targets, compute(final)));
    return { status: better ? 'improved' : 'no-improvement', project: better ? final : project, changes: better ? changes : [], before: start.statuses, after: better ? sc.statuses : start.statuses, costBefore, costAfter: cost(better ? final : project, sc.computed), solves, notes };
  }

  if (guardNotes.length) notes.push(`Kept within ${guardNotes.join(' and ')}.`);
  notes.push(`${changes.length} change${changes.length === 1 ? '' : 's'}, each pulled back to the smallest that still meets the targets${settings.marginFraction > 0 ? `, with about ${(settings.marginFraction * 100).toFixed(0)} % to spare on flow, pressure and velocity limits` : ''}.`);
  return done('solved', final, changes, notes);
}
