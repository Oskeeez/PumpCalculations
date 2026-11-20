/**
 * Higher-level analyses built on `compute`: pump speed sweeps (affinity-scaled curves at several speeds)
 * and scenario comparison. Values stay in the model's canonical units (L/s, m, kPa, kW, m/s);
 * the UI converts for display.
 */
import type { ChartSeries } from './curveChart';
import { compute, newUid, type Computed, type ProjectUI, type Scenario } from './model';
import { pumpHead } from './solver';

// ---------------------------------------------------------------- speed sweep

export interface SpeedRow {
  speedRatio: number;
  rpm: number;
  error?: string;
  /** Pump flow [L/s] and head [m]. */
  flowLps?: number;
  headM?: number;
  efficiency?: number;
  shaftKw?: number;
  npshaM?: number;
  npshrM?: number;
  npshMarginM?: number;
  /** Total flow supplied by all tanks [L/s]. */
  systemSupplyLps?: number;
  warnings: number;
}

export interface SpeedSweep {
  pump: string;
  rows: SpeedRow[];
  /** Pump head curves at each speed with their operating points, plus the locus of operating points. */
  series: ChartSeries[];
}

/** Speed ratios from `minPct` to `maxPct` in `stepPct` steps (percent of rated speed), at most 30 values. */
export function speedRatios(minPct: number, maxPct: number, stepPct: number): number[] {
  if (!(minPct > 0) || !(maxPct >= minPct) || !(stepPct > 0)) return [];
  const out: number[] = [];
  for (let p = minPct; p <= maxPct + 1e-9 && out.length < 30; p += stepPct) out.push(Math.round(p * 1e6) / 1e8);
  return out;
}

export function speedSweep(project: ProjectUI, pumpUid: string, ratios: number[]): SpeedSweep | undefined {
  const pump = project.edges.find((e) => e.uid === pumpUid);
  if (!pump || pump.kind !== 'pump') return undefined;
  const rows: SpeedRow[] = [];
  const series: ChartSeries[] = [];
  const results = ratios.map((r) => ({ r, c: compute({ ...project, edges: project.edges.map((e) => (e.uid === pumpUid ? { ...e, speedRatio: r } : e)) }) }));
  const maxRatio = Math.max(...ratios, 1e-9);
  // common flow axis for every curve
  const first = results.find((x) => x.c.model);
  const pm = first?.c.model?.edges.find((e) => e.id === pump.name);
  const dataMaxLps = pm && pm.kind === 'pump' ? pm.model.headDataRange.maxFlowM3s * 1000 : 40;
  const qMaxLps = Math.max(dataMaxLps * maxRatio * 1.05, 1e-3);
  for (const { r, c } of results) {
    const row: SpeedRow = { speedRatio: r, rpm: r * pump.ratedRpm, warnings: c.result ? c.result.warnings.length : 0 };
    if (c.error || !c.result || !c.model) {
      row.error = c.error ?? 'No result';
      rows.push(row);
      continue;
    }
    const res = c.result.pumps.find((p) => p.id === pump.name);
    const edge = c.model.edges.find((e) => e.id === pump.name);
    if (res && edge && edge.kind === 'pump') {
      const forward = res.flowM3s > 1e-9;
      row.flowLps = res.flowM3s * 1000;
      row.headM = res.headM;
      row.efficiency = res.efficiency;
      row.shaftKw = res.shaftPowerW !== undefined ? res.shaftPowerW / 1000 : undefined;
      row.npshaM = res.npshaM;
      row.npshrM = res.npshrM;
      row.npshMarginM = res.npshMarginM;
      row.systemSupplyLps = c.result.nodes.filter((n) => n.kind === 'tank').reduce((s, n) => s + Math.max(0, -n.netOutflowM3s), 0) * 1000;
      series.push({
        name: `${Math.round(r * 100 * 10) / 10} %`,
        pts: Array.from({ length: 61 }, (_, i) => {
          const q = (qMaxLps * i) / 60;
          return { q, h: pumpHead(edge.model, q / 1000, r) };
        }),
        op: forward ? { q: res.flowM3s * 1000, h: res.headM } : undefined,
      });
    }
    rows.push(row);
  }
  const ops = series.flatMap((s) => (s.op ? [s.op] : [])).sort((a, b) => a.q - b.q);
  if (ops.length > 1) series.push({ name: 'System operating points', pts: ops, dashed: true });
  return { pump: pump.name, rows, series };
}

// ---------------------------------------------------------------- scenarios

export function snapshotScenario(project: ProjectUI, name: string): Scenario {
  const { scenarios: _scenarios, images: _images, targets: _targets, assumptions: _assumptions, drafts: _drafts, ...rest } = project;
  return { id: newUid(), name: name.trim() || 'Scenario', project: JSON.parse(JSON.stringify(rest)) as Scenario['project'] };
}

export type CompareQty = 'flow' | 'head' | 'pressure' | 'power' | 'velocity' | 'text' | 'count';

export interface CompareRow {
  label: string;
  qty: CompareQty;
  values: (number | string | undefined)[];
}

export interface CompareSection {
  title: string;
  rows: CompareRow[];
}

export interface Comparison {
  columns: string[];
  /** Per column: an error message if that scenario could not be solved. */
  errors: (string | undefined)[];
  sections: CompareSection[];
}

export interface CompareItem {
  name: string;
  computed: Computed;
}

/** Side-by-side key results of several solved scenarios. Elements are matched by name. */
export function compareScenarios(items: CompareItem[]): Comparison {
  const n = items.length;
  const results = items.map((i) => i.computed.result);
  const col = <T,>(f: (r: NonNullable<(typeof results)[number]>) => T): (T | undefined)[] => results.map((r) => (r ? f(r) : undefined));
  const names = (pick: (r: NonNullable<(typeof results)[number]>) => string[]): string[] => {
    const seen: string[] = [];
    for (const r of results) if (r) for (const x of pick(r)) if (!seen.includes(x)) seen.push(x);
    return seen;
  };
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

  const system: CompareRow[] = [
    { label: 'Solved', qty: 'text', values: items.map((i) => (i.computed.error ? 'error' : i.computed.result?.converged ? 'yes' : 'no')) },
    { label: 'Supplied by tanks', qty: 'flow', values: col((r) => sum(r.nodes.filter((x) => x.kind === 'tank').map((x) => Math.max(0, -x.netOutflowM3s))) * 1000) },
    { label: 'Junction demand', qty: 'flow', values: col((r) => sum(r.nodes.filter((x) => x.kind === 'junction').map((x) => x.netOutflowM3s)) * 1000) },
    { label: 'Total pump shaft power', qty: 'power', values: col((r) => sum(r.pumps.map((p) => (p.shaftPowerW ?? 0) / 1000))) },
    { label: 'Lowest junction pressure (gauge)', qty: 'pressure', values: col((r) => Math.min(...r.nodes.filter((x) => x.kind === 'junction').map((x) => x.gaugePressurePa / 1000))) },
    { label: 'Highest junction pressure (gauge)', qty: 'pressure', values: col((r) => Math.max(...r.nodes.filter((x) => x.kind === 'junction').map((x) => x.gaugePressurePa / 1000))) },
    { label: 'Warnings + design alerts', qty: 'count', values: items.map((i) => (i.computed.result ? i.computed.result.warnings.length + i.computed.alerts.length : undefined)) },
  ];

  const sections: CompareSection[] = [{ title: 'System', rows: system }];

  const pumpRows: CompareRow[] = [];
  for (const name of names((r) => r.pumps.map((p) => p.id))) {
    const get = <T,>(f: (p: NonNullable<(typeof results)[number]>['pumps'][number]) => T) => col((r) => { const p = r.pumps.find((x) => x.id === name); return p ? f(p) : undefined; }) as (T | undefined)[];
    pumpRows.push({ label: `${name}: flow`, qty: 'flow', values: get((p) => p.flowM3s * 1000) });
    pumpRows.push({ label: `${name}: head`, qty: 'head', values: get((p) => p.headM) });
    pumpRows.push({ label: `${name}: shaft power`, qty: 'power', values: get((p) => (p.shaftPowerW !== undefined ? p.shaftPowerW / 1000 : undefined)) });
    pumpRows.push({ label: `${name}: NPSH margin`, qty: 'head', values: get((p) => p.npshMarginM) });
  }
  if (pumpRows.length) sections.push({ title: 'Pumps', rows: pumpRows });

  const valveRows: CompareRow[] = [];
  for (const name of names((r) => r.valves.map((v) => v.id))) {
    const get = <T,>(f: (v: NonNullable<(typeof results)[number]>['valves'][number]) => T) => col((r) => { const v = r.valves.find((x) => x.id === name); return v ? f(v) : undefined; }) as (T | undefined)[];
    valveRows.push({ label: `${name}: status`, qty: 'text', values: get((v) => v.status) });
    valveRows.push({ label: `${name}: flow`, qty: 'flow', values: get((v) => v.flowM3s * 1000) });
    valveRows.push({ label: `${name}: pressure drop`, qty: 'pressure', values: get((v) => v.pressureDropPa / 1000) });
  }
  if (valveRows.length) sections.push({ title: 'Valves', rows: valveRows });

  const pipeRows: CompareRow[] = [];
  for (const name of names((r) => r.pipes.map((p) => p.id))) {
    const get = <T,>(f: (p: NonNullable<(typeof results)[number]>['pipes'][number]) => T) => col((r) => { const p = r.pipes.find((x) => x.id === name); return p ? f(p) : undefined; }) as (T | undefined)[];
    pipeRows.push({ label: `${name}: flow`, qty: 'flow', values: get((p) => p.flowM3s * 1000) });
    pipeRows.push({ label: `${name}: velocity`, qty: 'velocity', values: get((p) => p.flow.velocity) });
  }
  if (pipeRows.length) sections.push({ title: 'Pipes', rows: pipeRows });

  const nodeRows: CompareRow[] = names((r) => r.nodes.filter((x) => x.kind === 'junction').map((x) => x.id)).map((name) => ({
    label: `${name}: pressure (gauge)`,
    qty: 'pressure' as const,
    values: col((r) => r.nodes.find((x) => x.id === name)?.gaugePressurePa).map((v) => (v === undefined ? undefined : v / 1000)),
  }));
  if (nodeRows.length) sections.push({ title: 'Junctions', rows: nodeRows });

  return { columns: items.map((i) => i.name), errors: items.map((i) => i.computed.error), sections: n ? sections : [] };
}
