/**
 * Design criteria: structured data that is both used by the code (defaults, limits, cost rates) and fed into the
 * AI prompt. A company's own standards can be pasted over this in the AI tab (stored in the browser).
 * The numbers below are generic starting points, NOT a standard. Replace them with your own.
 */
export interface DesignCriteria {
  /** Velocity limits [m/s]. */
  velocity: { suctionMax: number; dischargeMax: number; generalMax: number; min: number };
  /** Minimum residual pressure at a demand point [kPa gauge]. */
  minResidualPressureKPaG: number;
  /** Roughness defaults [mm] by material, for pipes the AI creates. */
  roughnessMm: Record<string, number>;
  /** Default fitting K values the AI may assume. */
  fittingK: Record<string, number>;
  pump: {
    /** Preferred operating window as % of best-efficiency flow. */
    minPctBep: number;
    maxPctBep: number;
    /** Below this % of BEP flow the pump is flagged for minimum-flow problems. */
    minFlowPctBep: number;
    npshMarginM: number;
  };
  orifice: {
    /** Warn about noise / cavitation above this bore velocity [m/s] or pressure drop [kPa]. */
    maxBoreVelocityMps: number;
    maxDropKPa: number;
    minBeta: number;
    maxBeta: number;
  };
  /** Rough installed-cost rates, for ranking drafts only. Not a quote. Currency units are arbitrary. */
  cost: {
    pipePerM: { base: number; perMmDiameter: number };
    valve: { base: number; perMmDiameter: number };
    orifice: { base: number; perMmDiameter: number };
    pump: { base: number; perKwShaft: number };
    tank: number;
  };
  notes: string;
}

export const DEFAULT_CRITERIA: DesignCriteria = {
  velocity: { suctionMax: 1.5, dischargeMax: 3, generalMax: 3, min: 0.3 },
  minResidualPressureKPaG: 100,
  roughnessMm: { 'commercial steel': 0.046, 'galvanised iron': 0.15, 'ductile iron, cement-lined': 0.12, 'copper / plastic': 0.0015, 'concrete': 1.0 },
  fittingK: { 'elbow 90': 0.75, 'tee run': 0.4, 'tee branch': 1.2, 'gate valve open': 0.15, 'swing check': 2.0, 'entrance sharp': 0.5, exit: 1.0 },
  pump: { minPctBep: 70, maxPctBep: 120, minFlowPctBep: 50, npshMarginM: 0.5 },
  orifice: { maxBoreVelocityMps: 12, maxDropKPa: 300, minBeta: 0.2, maxBeta: 0.75 },
  cost: {
    pipePerM: { base: 20, perMmDiameter: 0.6 },
    valve: { base: 150, perMmDiameter: 5 },
    orifice: { base: 80, perMmDiameter: 1.5 },
    pump: { base: 2500, perKwShaft: 350 },
    tank: 3000,
  },
  notes: 'Generic placeholder criteria. Replace with company standards.',
};

const KEY = 'pipe-network-design-criteria';

export function loadCriteria(): DesignCriteria {
  try {
    const t = localStorage.getItem(KEY);
    if (t) return mergeCriteria(JSON.parse(t) as unknown);
  } catch {
    /* ignore */
  }
  return DEFAULT_CRITERIA;
}

export function saveCriteria(c: DesignCriteria): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

/** Overlay user-supplied JSON on the defaults (one level deep), so partial files work. */
export function mergeCriteria(user: unknown): DesignCriteria {
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw new Error('Design criteria must be a JSON object.');
  const out = JSON.parse(JSON.stringify(DEFAULT_CRITERIA)) as Record<string, unknown>;
  for (const [k, v] of Object.entries(user as Record<string, unknown>)) {
    if (!(k in out)) throw new Error(`Unknown design-criteria section "${k}".`);
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`"${k}" must be an object.`);
      out[k] = { ...(cur as object), ...(v as object) };
    } else out[k] = v;
  }
  return out as unknown as DesignCriteria;
}
