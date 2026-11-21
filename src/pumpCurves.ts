/** Pump-curve library helpers: spreadsheet-style rows, pasted-text parsing, summaries and applying a curve to a pump. All canonical units (L/s, m, %). */
import { genericPumpCurves } from './ai/catalog';
import { newUid, type PumpCurveEntry, type PumpUI } from './model';
import { pumpBep } from './ai/duty';
import { fitPump } from './solver';

/** One spreadsheet row: any of the three curves can be blank at a flow. */
export interface CurveRow {
  q: number;
  h?: number;
  eta?: number;
  npshr?: number;
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Merge the three curves into rows keyed by flow, sorted by flow. */
export function rowsFromCurve(c: Pick<PumpCurveEntry, 'head' | 'efficiency' | 'npshr'>): CurveRow[] {
  const rows: CurveRow[] = [];
  const row = (q: number): CurveRow => {
    let r = rows.find((x) => same(x.q, q));
    if (!r) rows.push((r = { q }));
    return r;
  };
  for (const p of c.head) row(p.q).h = p.h;
  for (const p of c.efficiency) row(p.q).eta = p.eta;
  for (const p of c.npshr) row(p.q).npshr = p.h;
  return rows.sort((a, b) => a.q - b.q);
}

/** Split rows back into the three curves, dropping blanks. */
export function curveFromRows(rows: CurveRow[]): Pick<PumpCurveEntry, 'head' | 'efficiency' | 'npshr'> {
  const ok = rows.filter((r) => Number.isFinite(r.q));
  return {
    head: ok.filter((r) => r.h !== undefined && Number.isFinite(r.h)).map((r) => ({ q: r.q, h: r.h as number })),
    efficiency: ok.filter((r) => r.eta !== undefined && Number.isFinite(r.eta)).map((r) => ({ q: r.q, eta: r.eta as number })),
    npshr: ok.filter((r) => r.npshr !== undefined && Number.isFinite(r.npshr)).map((r) => ({ q: r.q, h: r.npshr as number })),
  };
}

export interface ParsedCurve {
  rows: CurveRow[];
  warnings: string[];
}

const HEADER = {
  q: /^(q|flow|capacity|rate|vol)/i,
  h: /^(h|head|tdh)/i,
  eta: /^(e|eta|η|eff)/i,
  npshr: /^(npsh|npshr)/i,
};

/**
 * Parse pasted text (from a datasheet, PDF table or Excel): one point per line, columns separated by tabs, commas, semicolons or
 * spaces, in the order flow, head, efficiency, NPSHr (extra columns are optional). A header line naming the columns is understood
 * and may reorder them. Efficiency given as a fraction (all values <= 1) is converted to %. Values stay in the units pasted.
 */
export function parseCurveText(text: string): ParsedCurve {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // tabs or semicolons separate the columns (then a comma is a decimal comma); otherwise commas and spaces do
  const split = (l: string) => l.split(/[\t;]/.test(l) ? /[\t;]+/ : /[,\s]+/).map((c) => c.trim()).filter((c) => c !== '');
  let map: Record<'q' | 'h' | 'eta' | 'npshr', number> = { q: 0, h: 1, eta: 2, npshr: 3 };
  const rows: CurveRow[] = [];
  for (const l of lines) {
    const cells = split(l);
    const nums = cells.map((c) => Number(c.replace(',', '.')));
    if (cells.length && nums.every((n) => !Number.isFinite(n))) {
      // a header line: find the columns by name
      const m = { ...map };
      cells.forEach((c, i) => {
        for (const k of ['npshr', 'eta', 'h', 'q'] as const) if (HEADER[k].test(c)) { m[k] = i; break; }
      });
      map = m;
      continue;
    }
    const q = nums[map.q];
    if (!Number.isFinite(q)) { warnings.push(`Skipped line "${l.slice(0, 40)}": no flow value.`); continue; }
    const pick = (i: number) => (i < nums.length && Number.isFinite(nums[i]) ? nums[i] : undefined);
    rows.push({ q, h: pick(map.h), eta: pick(map.eta), npshr: pick(map.npshr) });
  }
  const etas = rows.filter((r) => r.eta !== undefined).map((r) => r.eta as number);
  if (etas.length && etas.every((e) => e <= 1)) {
    rows.forEach((r) => { if (r.eta !== undefined) r.eta *= 100; });
    warnings.push('Efficiency looked like a fraction (0 to 1), so it was converted to %.');
  }
  if (!rows.length) warnings.push('No numbers found. Paste columns: flow, head, efficiency (optional), NPSHr (optional).');
  return { rows: rows.sort((a, b) => a.q - b.q), warnings };
}

export interface CurveCheck {
  errors: string[];
  warnings: string[];
}

/** Problems that stop a curve being used (errors) and things worth a second look (warnings). */
export function checkCurve(c: Pick<PumpCurveEntry, 'head' | 'efficiency' | 'npshr'>): CurveCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const flows = c.head.map((p) => p.q);
  if (c.head.length < 2 || new Set(flows.map((q) => +q.toPrecision(9))).size < 2) errors.push('The head curve needs at least 2 points with different flows (3 or more gives a better fit).');
  if (flows.some((q) => q < 0) || c.head.some((p) => p.h < 0)) errors.push('Flow and head must not be negative.');
  if (c.efficiency.length === 1) warnings.push('One efficiency point is ignored; give at least 2 (or none).');
  if (c.efficiency.some((p) => p.eta <= 0 || p.eta > 100)) errors.push('Efficiency must be between 0 and 100 %.');
  if (c.npshr.length === 1) warnings.push('One NPSHr point is ignored; give at least 2 (or none).');
  if (c.head.length >= 2 && errors.length === 0) {
    const sorted = [...c.head].sort((a, b) => a.q - b.q);
    if (sorted.some((p, i) => i > 0 && p.h > sorted[i - 1].h + 1e-9 && sorted[i - 1].h > 0 && p.q > sorted[i - 1].q) && sorted[0].h < sorted[sorted.length - 1].h) warnings.push('Head rises with flow; check the points (a normal curve falls).');
  }
  return { errors, warnings };
}

export interface CurveSummary {
  shutoffHeadM?: number;
  maxFlowLps?: number;
  bepFlowLps?: number;
  peakEfficiencyPct?: number;
  fitRmseM?: number;
}

export function summarize(c: Pick<PumpCurveEntry, 'head' | 'efficiency' | 'npshr'>): CurveSummary {
  if (checkCurve(c).errors.length) return {};
  const model = fitPump({
    head: c.head.map((p) => ({ flowM3s: p.q / 1000, headM: p.h })),
    efficiency: c.efficiency.length >= 2 ? c.efficiency.map((p) => ({ flowM3s: p.q / 1000, eta: p.eta / 100 })) : undefined,
    npshr: c.npshr.length >= 2 ? c.npshr.map((p) => ({ flowM3s: p.q / 1000, npshrM: p.h })) : undefined,
  });
  const bep = pumpBep(model, 1);
  return { shutoffHeadM: model.head.a0, maxFlowLps: model.headDataRange.maxFlowM3s * 1000, bepFlowLps: bep ? bep.flowM3s * 1000 : undefined, peakEfficiencyPct: bep ? bep.eta * 100 : undefined, fitRmseM: model.fitRmse.head };
}

// ---------------------------------------------------------------- library
export const newCurveId = (): string => `c${newUid()}`;

export function newCurve(name: string, o: Partial<Pick<PumpCurveEntry, 'head' | 'efficiency' | 'npshr' | 'ratedRpm' | 'note'>> = {}): PumpCurveEntry {
  return { id: newCurveId(), name, ratedRpm: o.ratedRpm ?? 1450, head: o.head ?? [], efficiency: o.efficiency ?? [], npshr: o.npshr ?? [], note: o.note };
}

/** A generic centrifugal curve through a best-efficiency point. A placeholder with a realistic shape, not a vendor product. */
export function genericCurve(name: string, bepFlowLps: number, bepHeadM: number, peakEtaPct?: number): PumpCurveEntry {
  return newCurve(name, { ...genericPumpCurves(bepFlowLps, bepHeadM, peakEtaPct), note: 'Generic curve generated from a best-efficiency point. Replace with the manufacturer curve for a real design.' });
}

/** Copy a library curve onto a pump (the pump keeps its own copy; curveId records where it came from). Trim is reset to 1. */
export function applyCurve(pump: PumpUI, c: PumpCurveEntry): PumpUI {
  return { ...pump, head: c.head.map((p) => ({ ...p })), efficiency: c.efficiency.map((p) => ({ ...p })), npshr: c.npshr.map((p) => ({ ...p })), ratedRpm: c.ratedRpm, impellerTrim: 1, curveId: c.id };
}

/** Save a pump's own curve as a new library entry. */
export function curveFromPump(pump: PumpUI, name: string): PumpCurveEntry {
  return newCurve(name, { head: pump.head.map((p) => ({ ...p })), efficiency: pump.efficiency.map((p) => ({ ...p })), npshr: pump.npshr.map((p) => ({ ...p })), ratedRpm: pump.ratedRpm });
}

/** Pumps using a library curve. */
export const pumpsUsing = (pumps: PumpUI[], id: string): PumpUI[] => pumps.filter((p) => p.curveId === id);
