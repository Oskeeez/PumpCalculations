import { G } from './constants';
import type { HydraulicElement } from './element';
import { pipeArea } from './pipe';

/**
 * Valve / fixed-resistance component. Head drop = R Q |Q|, with R from one of:
 *  - K  : loss coefficient referenced to the valve diameter,  R = K / (2 g A^2)
 *  - Cv : US flow coefficient (gpm at 1 psi drop, water),     R = 6894.757 / (rho_ref g (Cv * 6.309e-5)^2)
 *  - Kv : metric flow coefficient (m3/h at 1 bar, water),     R = 1e5 / (rho_ref g (Kv / 3600)^2)
 * The Cv/Kv forms are independent of the fluid density (head of the flowing fluid; rho_ref = 999 kg/m3).
 * A check valve blocks reverse flow (C1 stiff term). A closed valve is removed from the network.
 */
export type ValveLoss = { type: 'K'; k: number } | { type: 'Cv'; cv: number } | { type: 'Kv'; kv: number };

/**
 * Optional regulation. `loss` then describes the valve fully open.
 *  - prv: pressure-reducing; holds the downstream (`to`) node at a gauge pressure when upstream pressure is higher
 *  - psv: pressure-sustaining; holds the upstream (`from`) node at a gauge pressure by throttling
 *  - fcv: flow-control; limits the flow to a set value when the network would otherwise pass more
 * Regulators block reverse flow. They are handled by an active-set loop in `solveSystem`.
 */
export type ValveControl =
  | { type: 'prv' | 'psv'; setpointPa: number }
  | { type: 'fcv'; flowM3s: number };

export interface ValveSpec {
  /** Valve / line diameter [m] (used for velocity and for K-based loss). */
  diameterM: number;
  loss: ValveLoss;
  checkValve: boolean;
  /** false = closed: no flow, removed from the network. */
  open: boolean;
  control?: ValveControl;
}

const RHO_REF = 999; // kg/m3 water reference used by the Cv/Kv definitions
const GPM = 6.30901964e-5; // m3/s per gpm
const PSI = 6894.757; // Pa
/** Reverse-flow stiffness of a check valve [m per (m3/s)^2]. */
export const CHECK_VALVE_REVERSE_K = 1e12;
/** Cv = CV_PER_KV * Kv */
export const CV_PER_KV = 1.1561;

export function validateValve(s: ValveSpec): void {
  if (!(s.diameterM > 0)) throw new RangeError('Valve diameter must be > 0');
  const v = s.loss.type === 'K' ? s.loss.k : s.loss.type === 'Cv' ? s.loss.cv : s.loss.kv;
  if (s.loss.type === 'K' ? !(v >= 0) : !(v > 0)) throw new RangeError(s.loss.type === 'K' ? 'Valve K must be >= 0' : `Valve ${s.loss.type} must be > 0`);
}

/**
 * Loss coefficient used for a valve entered with exactly K = 0. Such a valve would have no head loss at any flow, which the network
 * solver cannot invert (the flow would be undetermined). 1e-4 is a fully open valve for every practical purpose (about 5
 * micrometres of head at 10 m/s). Any K above zero is used as given.
 */
export const MIN_VALVE_K = 1e-4;

/** R in  h = R Q|Q|  [m per (m3/s)^2]. */
export function valveResistance(s: ValveSpec): number {
  const l = s.loss;
  if (l.type === 'K') return (l.k === 0 ? MIN_VALVE_K : l.k) / (2 * G * pipeArea(s.diameterM) ** 2);
  if (l.type === 'Cv') return PSI / (RHO_REF * G * (l.cv * GPM) ** 2);
  return 1e5 / (RHO_REF * G * (l.kv / 3600) ** 2);
}

/** Equivalent K referenced to the valve diameter. */
export function valveEquivalentK(s: ValveSpec): number {
  return valveResistance(s) * 2 * G * pipeArea(s.diameterM) ** 2;
}

export function createValveElement(s: ValveSpec): HydraulicElement {
  validateValve(s);
  const R = valveResistance(s);
  return {
    kind: 'valve',
    headDrop(q) {
      let h = R * q * Math.abs(q);
      if (s.checkValve && q < 0) h -= CHECK_VALVE_REVERSE_K * q * q;
      return h;
    },
    dHeadDrop(q) {
      return 2 * (R + (s.checkValve && q < 0 ? CHECK_VALVE_REVERSE_K : 0)) * Math.abs(q);
    },
  };
}
