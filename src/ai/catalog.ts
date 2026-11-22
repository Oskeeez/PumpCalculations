/**
 * Catalogues the AI can pick from. There is no vendor pump data in this app, so "pumps" are generic centrifugal
 * curves generated from a best-efficiency point: H = 1.25 Hbep (1 - 0.2 x²), eta = eta_peak (2x - x²), x = Q / Qbep.
 * They are placeholders with realistic shape, NOT a real product. Replace with vendor curves for a real design.
 */
import { FITTINGS, MATERIALS, SCH40 } from '../library';
import type { PumpUI } from '../model';
import { FLUID_LIBRARY } from '../solver';

export type PumpCurveSet = Pick<PumpUI, 'head' | 'efficiency' | 'npshr'>;

export function genericPumpCurves(bepFlowLps: number, bepHeadM: number, peakEtaPct?: number): PumpCurveSet {
  const q = bepFlowLps;
  const h = bepHeadM;
  const eta = peakEtaPct ?? Math.max(45, Math.min(85, 55 + 10 * Math.log10(Math.max(q, 0.1))));
  const n0 = Math.max(1, 0.12 * h);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  // all three curves share the same flow points, so they read as one tidy table
  const xs = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
  return {
    head: xs.map((x) => ({ q: r(q * x), h: r(1.25 * h * (1 - 0.2 * x * x)) })),
    efficiency: xs.filter((x) => x > 0).map((x) => ({ q: r(q * x), eta: r(eta * (2 * x - x * x)) })),
    npshr: xs.map((x) => ({ q: r(q * x), h: r(n0 * (0.7 + 0.3 * x * x)) })),
  };
}

export const genericPumpId = (q: number, h: number): string => `generic:${+q.toPrecision(4)}:${+h.toPrecision(4)}`;

export function parseGenericPumpId(id: string): { q: number; h: number } | undefined {
  const m = /^generic:([0-9.]+):([0-9.]+)$/.exec(id);
  return m && +m[1] > 0 && +m[2] > 0 ? { q: +m[1], h: +m[2] } : undefined;
}

export interface CatalogFilters {
  duty_flow_lps?: number;
  duty_head_m?: number;
  min_id_mm?: number;
  max_id_mm?: number;
}

/** Generic pumps whose BEP puts the duty point at 85 %, 100% and 115 % of BEP flow. */
export function pumpCandidates(dutyFlowLps: number, dutyHeadM: number) {
  return [0.85, 1, 1.15].map((x) => {
    const bepQ = dutyFlowLps / x;
    const bepH = dutyHeadM / (1.25 * (1 - 0.2 * x * x));
    return { catalog_id: genericPumpId(bepQ, bepH), bep_flow_lps: +bepQ.toPrecision(4), bep_head_m: +bepH.toPrecision(4), duty_at_pct_bep: Math.round(x * 100), shutoff_head_m: +(1.25 * bepH).toPrecision(4), note: 'generic curve, not a vendor product' };
  });
}

export function listCatalog(type: string, f: CatalogFilters = {}): unknown {
  switch (type) {
    case 'pipe_sizes':
      return SCH40.filter((s) => (f.min_id_mm === undefined || s.idMm >= f.min_id_mm) && (f.max_id_mm === undefined || s.idMm <= f.max_id_mm)).map((s) => ({ nominal: s.nps, inside_diameter_mm: s.idMm, note: 'Schedule 40 steel' }));
    case 'materials':
      return MATERIALS.map((m) => ({ material: m.name, roughness_mm: m.roughnessMm }));
    case 'fittings':
      return FITTINGS.map((x) => ({ name: x.name, k: x.k, note: 'typical, not vendor data' }));
    case 'fluids':
      return FLUID_LIBRARY.map((x) => ({ id: x.id, name: x.name, t_min_c: x.tMinC, t_max_c: x.tMaxC }));
    case 'pumps':
      if (f.duty_flow_lps === undefined || f.duty_head_m === undefined) throw new Error('Give filters.duty_flow_lps and filters.duty_head_m to size generic pumps.');
      return pumpCandidates(f.duty_flow_lps, f.duty_head_m);
    default:
      throw new Error(`Unknown catalog type "${type}".`);
  }
}
