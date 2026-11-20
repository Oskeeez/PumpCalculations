/**
 * UI-side project model (UI units) and the conversion boundary to the SI solver.
 * UI units: flow L/s, diameter & roughness mm, pressure kPa (absolute), temperature degC,
 * efficiency %, lengths/heads m. Everything past `toSeriesSystem` is SI.
 */
import {
  analyzeSeries,
  findOperatingPoint,
  fitPump,
  P_ATM,
  sampleCurves,
  water,
  type CurvePoint,
  type OperatingPoint,
  type SeriesAnalysis,
  type SeriesElement,
  type SeriesSystem,
  type Tank,
} from './solver';

export interface TankUI {
  /** Tank bottom elevation [m]. */
  elevationM: number;
  /** Liquid depth [m]. */
  levelM: number;
  /** Absolute pressure above the liquid [kPa]. */
  pressureKPa: number;
}

export interface FittingUI {
  name: string;
  k: number;
}

export interface PipeUI {
  kind: 'pipe';
  uid: string;
  name: string;
  lengthM: number;
  diameterMm: number;
  roughnessMm: number;
  elevationChangeM: number;
  fittings: FittingUI[];
}

export interface PumpUI {
  kind: 'pump';
  uid: string;
  name: string;
  speedRatio: number;
  /** flow L/s, head m */
  head: { q: number; h: number }[];
  /** flow L/s, efficiency % */
  efficiency: { q: number; eta: number }[];
  /** flow L/s, NPSHr m */
  npshr: { q: number; h: number }[];
}

export type ElementUI = PipeUI | PumpUI;

export interface ProjectUI {
  temperatureC: number;
  npshMarginM: number;
  source: TankUI;
  destination: TankUI;
  elements: ElementUI[];
}

let counter = 100;
export const newUid = (): string => `e${++counter}`;

export function newPipe(n: number): PipeUI {
  return {
    kind: 'pipe',
    uid: newUid(),
    name: `Pipe ${n}`,
    lengthM: 100,
    diameterMm: 100,
    roughnessMm: 0.045,
    elevationChangeM: 0,
    fittings: [{ name: 'Fittings', k: 1 }],
  };
}

export function newPump(n: number): PumpUI {
  return {
    kind: 'pump',
    uid: newUid(),
    name: `Pump ${n}`,
    speedRatio: 1,
    head: [
      { q: 0, h: 50 },
      { q: 10, h: 46 },
      { q: 20, h: 38 },
      { q: 30, h: 26 },
    ],
    efficiency: [
      { q: 5, eta: 40 },
      { q: 15, eta: 70 },
      { q: 25, eta: 65 },
    ],
    npshr: [
      { q: 0, h: 1.5 },
      { q: 20, h: 2.5 },
      { q: 30, h: 4 },
    ],
  };
}

export function defaultProject(): ProjectUI {
  const suction = { ...newPipe(1), name: 'Suction pipe', lengthM: 10, diameterMm: 150, fittings: [{ name: 'Entrance', k: 0.5 }, { name: 'Valve', k: 0.2 }] };
  const discharge = {
    ...newPipe(2),
    name: 'Discharge pipe',
    lengthM: 200,
    diameterMm: 100,
    elevationChangeM: 15,
    fittings: [{ name: 'Elbows', k: 1.0 }, { name: 'Check valve', k: 2.0 }, { name: 'Exit', k: 0.3 }],
  };
  return {
    temperatureC: 20,
    npshMarginM: 0.5,
    source: { elevationM: 0, levelM: 3, pressureKPa: P_ATM / 1000 },
    destination: { elevationM: 15, levelM: 2, pressureKPa: P_ATM / 1000 },
    elements: [suction, newPump(1), discharge],
  };
}

const tankToSi = (t: TankUI): Tank => ({
  elevationM: t.elevationM,
  liquidLevelM: t.levelM,
  surfacePressurePa: t.pressureKPa * 1000,
});

/** Convert UI units to the SI solver model. Throws Error with a user-readable message if invalid. */
export function toSeriesSystem(p: ProjectUI): SeriesSystem {
  if (p.elements.length === 0) throw new Error('Add at least one pipe or pump.');
  let fluid;
  try {
    fluid = water(p.temperatureC);
  } catch {
    throw new Error('Water temperature must be between 0 and 100 °C.');
  }
  const elements: SeriesElement[] = p.elements.map((e): SeriesElement => {
    if (e.kind === 'pipe') {
      if (!(e.diameterMm > 0)) throw new Error(`${e.name}: diameter must be > 0.`);
      if (!(e.lengthM >= 0)) throw new Error(`${e.name}: length must be ≥ 0.`);
      if (!(e.roughnessMm >= 0)) throw new Error(`${e.name}: roughness must be ≥ 0.`);
      if (e.fittings.some((f) => !(f.k >= 0))) throw new Error(`${e.name}: fitting K values must be ≥ 0.`);
      return {
        kind: 'pipe',
        id: e.name,
        spec: {
          lengthM: e.lengthM,
          innerDiameterM: e.diameterMm / 1000,
          roughnessM: e.roughnessMm / 1000,
          elevationChangeM: e.elevationChangeM,
          fittingsK: e.fittings.map((f) => f.k),
        },
      };
    }
    if (!(e.speedRatio > 0)) throw new Error(`${e.name}: speed ratio must be > 0.`);
    if (e.head.length < 2 || new Set(e.head.map((x) => x.q)).size < 2) throw new Error(`${e.name}: head curve needs at least 2 points with different flows.`);
    const model = fitPump({
      head: e.head.map((x) => ({ flowM3s: x.q / 1000, headM: x.h })),
      efficiency: e.efficiency.length >= 2 ? e.efficiency.map((x) => ({ flowM3s: x.q / 1000, eta: x.eta / 100 })) : undefined,
      npshr: e.npshr.length >= 2 ? e.npshr.map((x) => ({ flowM3s: x.q / 1000, npshrM: x.h })) : undefined,
    });
    return { kind: 'pump', id: e.name, model, speedRatio: e.speedRatio };
  });
  return { fluid, source: tankToSi(p.source), destination: tankToSi(p.destination), elements };
}

export interface Computed {
  system?: SeriesSystem;
  op?: OperatingPoint;
  analysis?: SeriesAnalysis;
  curves?: CurvePoint[];
  qMaxM3s?: number;
  warnings: string[];
  error?: string;
}

export function compute(p: ProjectUI): Computed {
  try {
    const system = toSeriesSystem(p);
    const warnings: string[] = [];
    const sumDz = system.elements.reduce((s, e) => s + (e.kind === 'pipe' ? e.spec.elevationChangeM : 0), 0);
    const tankDz = system.destination.elevationM - system.source.elevationM;
    if (Math.abs(sumDz - tankDz) > 1e-6) {
      warnings.push(
        `Geometry: pipe elevation changes sum to ${sumDz.toFixed(2)} m but the tank bottoms differ by ${tankDz.toFixed(2)} m. ` +
          'Heads use the tank levels; pipe elevation changes only set the pump suction elevation (NPSH).',
      );
    }
    const op = findOperatingPoint(system);
    warnings.push(...op.warnings);
    const analysis = analyzeSeries(system, op.flowM3s, { npshMarginM: p.npshMarginM });
    if (op.status === 'ok') warnings.push(...analysis.warnings);
    let pumpMax = 0;
    for (const e of system.elements) if (e.kind === 'pump') pumpMax = Math.max(pumpMax, e.model.headDataRange.maxFlowM3s * e.speedRatio);
    const qMaxM3s = Math.max(pumpMax * 1.05, op.flowM3s * 1.5, 1e-3);
    return { system, op, analysis, curves: sampleCurves(system, qMaxM3s, 80), qMaxM3s, warnings };
  } catch (err) {
    return { warnings: [], error: err instanceof Error ? err.message : String(err) };
  }
}
