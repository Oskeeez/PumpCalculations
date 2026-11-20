/** Pump duty relative to the curve: best-efficiency point, % of BEP, runout. Pure functions on solver output. */
import { pumpEfficiency, type PumpModel, type SystemPumpResult } from '../solver';

export interface Bep {
  flowM3s: number;
  eta: number;
}

/** Best-efficiency point at the given speed ratio, from the fitted efficiency curve; undefined without efficiency data. */
export function pumpBep(model: PumpModel, speedRatio: number): Bep | undefined {
  if (!model.efficiency) return undefined;
  const qMax = model.headDataRange.maxFlowM3s;
  let best: Bep | undefined;
  for (let i = 1; i <= 400; i++) {
    const q = (qMax * i) / 400;
    const eta = pumpEfficiency(model, q, 1);
    if (eta !== undefined && (!best || eta > best.eta)) best = { flowM3s: q, eta };
  }
  return best ? { flowM3s: best.flowM3s * speedRatio, eta: best.eta } : undefined;
}

export interface PumpDuty {
  flowLps: number;
  headM: number;
  pctBep?: number;
  bepFlowLps?: number;
  eta?: number;
  shaftKw?: number;
  /** Flow as a fraction of the end of the head data at this speed (1 = at runout). */
  fractionOfRunout: number;
  beyondCurve: boolean;
}

export function pumpDuty(model: PumpModel, res: SystemPumpResult): PumpDuty {
  const bep = pumpBep(model, res.speedRatio);
  const runout = model.headDataRange.maxFlowM3s * res.speedRatio;
  return {
    flowLps: res.flowM3s * 1000,
    headM: res.headM,
    pctBep: bep && res.flowM3s > 1e-9 ? (res.flowM3s / bep.flowM3s) * 100 : undefined,
    bepFlowLps: bep ? bep.flowM3s * 1000 : undefined,
    eta: res.efficiency,
    shaftKw: res.shaftPowerW !== undefined ? res.shaftPowerW / 1000 : undefined,
    fractionOfRunout: runout > 0 ? res.flowM3s / runout : 0,
    beyondCurve: res.flowM3s > runout * 1.0000001,
  };
}
