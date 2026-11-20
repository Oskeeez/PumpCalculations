import { G, MIN_PUMP_EFFICIENCY, PUMP_CHECK_VALVE_STIFFNESS } from './constants';
import type { HydraulicElement } from './element';
import { evalQuadratic, fitQuadratic, type Quadratic } from './polynomial';

/** Pump data points at rated speed. SI units. */
export interface PumpCurveData {
  /** Head-flow points: flow [m^3/s], head [m]. At least 2 (3+ recommended). */
  head: readonly { flowM3s: number; headM: number }[];
  /** Optional efficiency points: flow [m^3/s], eta [0..1]. */
  efficiency?: readonly { flowM3s: number; eta: number }[];
  /** Optional NPSH required points: flow [m^3/s], NPSHr [m]. */
  npshr?: readonly { flowM3s: number; npshrM: number }[];
}

/** Fitted pump model at rated speed (speed ratio 1). */
export interface PumpModel {
  /** H(Q) = a0 + a1 Q + a2 Q^2 [m], Q in m^3/s. */
  head: Quadratic;
  efficiency?: Quadratic;
  npshr?: Quadratic;
  /** Flow range covered by the head data [m^3/s] (used to flag extrapolation). */
  headDataRange: { minFlowM3s: number; maxFlowM3s: number };
  /** RMS fit residuals, for display. */
  fitRmse: { head: number; efficiency?: number; npshr?: number };
}

export function fitPump(data: PumpCurveData): PumpModel {
  const headFit = fitQuadratic(data.head.map((p) => ({ x: p.flowM3s, y: p.headM })));
  const effFit = data.efficiency && data.efficiency.length >= 2
    ? fitQuadratic(data.efficiency.map((p) => ({ x: p.flowM3s, y: p.eta })))
    : undefined;
  const npshFit = data.npshr && data.npshr.length >= 2
    ? fitQuadratic(data.npshr.map((p) => ({ x: p.flowM3s, y: p.npshrM })))
    : undefined;
  const flows = data.head.map((p) => p.flowM3s);
  return {
    head: headFit.poly,
    efficiency: effFit?.poly,
    npshr: npshFit?.poly,
    headDataRange: { minFlowM3s: Math.min(...flows), maxFlowM3s: Math.max(...flows) },
    fitRmse: { head: headFit.rmse, efficiency: effFit?.rmse, npshr: npshFit?.rmse },
  };
}

/**
 * Head at speed ratio r = N2/N1 via the affinity laws applied to the fitted curve:
 *   H(Q, r) = r^2 H1(Q/r) = a0 r^2 + a1 r Q + a2 Q^2
 * Extended to Q < 0 as a check valve (head requirement rises steeply with reverse flow).
 */
export function pumpHead(model: PumpModel, flowM3s: number, speedRatio = 1): number {
  const r = speedRatio;
  const { a0, a1, a2 } = model.head;
  if (flowM3s >= 0) return a0 * r * r + a1 * r * flowM3s + a2 * flowM3s * flowM3s;
  return a0 * r * r - PUMP_CHECK_VALVE_STIFFNESS * flowM3s;
}

/** dH/dQ at speed ratio r [m per m^3/s]. */
export function pumpHeadSlope(model: PumpModel, flowM3s: number, speedRatio = 1): number {
  if (flowM3s >= 0) return model.head.a1 * speedRatio + 2 * model.head.a2 * flowM3s;
  return -PUMP_CHECK_VALVE_STIFFNESS;
}

/** Shutoff (Q = 0) head at speed ratio r [m]. */
export function pumpShutoffHead(model: PumpModel, speedRatio = 1): number {
  return model.head.a0 * speedRatio * speedRatio;
}

/**
 * Efficiency at the homologous point: eta(Q, r) = eta1(Q/r), clamped to [MIN_PUMP_EFFICIENCY, 1].
 * Returns undefined if no efficiency data were given.
 */
export function pumpEfficiency(model: PumpModel, flowM3s: number, speedRatio = 1): number | undefined {
  if (!model.efficiency) return undefined;
  const eta = evalQuadratic(model.efficiency, flowM3s / speedRatio);
  return Math.min(1, Math.max(MIN_PUMP_EFFICIENCY, eta));
}

/** NPSH required at speed ratio r: NPSHr(Q, r) = r^2 NPSHr1(Q/r), floored at 0 [m]. */
export function pumpNpshr(model: PumpModel, flowM3s: number, speedRatio = 1): number | undefined {
  if (!model.npshr) return undefined;
  return Math.max(0, speedRatio * speedRatio * evalQuadratic(model.npshr, flowM3s / speedRatio));
}

/** Hydraulic power rho g Q H [W]. */
export function hydraulicPower(density: number, flowM3s: number, headM: number): number {
  return density * G * flowM3s * headM;
}

/** Shaft power P = rho g Q H / eta [W]. */
export function shaftPower(density: number, flowM3s: number, headM: number, eta: number): number {
  return hydraulicPower(density, flowM3s, headM) / eta;
}

/** Pump as a network element between suction node (from) and discharge node (to). */
export function createPumpElement(model: PumpModel, speedRatio = 1): HydraulicElement {
  if (!(speedRatio > 0)) throw new RangeError('Pump speed ratio must be > 0');
  return {
    kind: 'pump',
    headDrop: (q) => -pumpHead(model, q, speedRatio),
    dHeadDrop: (q) => -pumpHeadSlope(model, q, speedRatio),
  };
}
