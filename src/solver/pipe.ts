import { G } from './constants';
import type { HydraulicElement } from './element';
import type { Fluid } from './fluid';
import { darcyFrictionFactor, flowRegime, type FlowRegime } from './friction';

/** Pipe line definition. SI units. */
export interface PipeSpec {
  /** Length L [m]. */
  lengthM: number;
  /** Inner diameter D [m]. */
  innerDiameterM: number;
  /** Absolute roughness eps [m]. */
  roughnessM: number;
  /** Outlet elevation minus inlet elevation [m]. Geometry only: does not change head loss. */
  elevationChangeM: number;
  /** Minor-loss coefficients K of fittings [-], referenced to this pipe's velocity head. */
  fittingsK: readonly number[];
}

export interface PipeFlowState {
  /** Mean velocity v = |Q|/A [m/s]. */
  velocity: number;
  reynolds: number;
  /** Darcy friction factor [-] (Infinity at zero flow). */
  frictionFactor: number;
  regime: FlowRegime;
  /** Friction head loss h_f = f (L/D) v^2/2g [m]. */
  frictionHeadLoss: number;
  /** Minor head loss h_m = sum(K) v^2/2g [m]. */
  minorHeadLoss: number;
  totalHeadLoss: number;
}

export function pipeArea(diameterM: number): number {
  return (Math.PI / 4) * diameterM * diameterM;
}

export function totalK(spec: PipeSpec): number {
  return spec.fittingsK.reduce((s, k) => s + k, 0);
}

export function validatePipe(spec: PipeSpec): void {
  if (!(spec.lengthM >= 0)) throw new RangeError('Pipe length must be >= 0');
  if (!(spec.innerDiameterM > 0)) throw new RangeError('Pipe diameter must be > 0');
  if (!(spec.roughnessM >= 0)) throw new RangeError('Pipe roughness must be >= 0');
  if (spec.fittingsK.some((k) => !(k >= 0))) throw new RangeError('Fitting K values must be >= 0');
}

/** Flow state for flow magnitude |Q| (sign is ignored). */
export function pipeFlowState(spec: PipeSpec, fluid: Fluid, flowM3s: number): PipeFlowState {
  const q = Math.abs(flowM3s);
  const D = spec.innerDiameterM;
  const v = q / pipeArea(D);
  const velocityHead = (v * v) / (2 * G);
  const re = (fluid.density * v * D) / fluid.dynamicViscosity;
  const regime = flowRegime(re);
  const f = darcyFrictionFactor(re, spec.roughnessM / D);
  let hf: number;
  if (regime === 'zero') {
    hf = 0;
  } else if (regime === 'laminar') {
    // Hagen-Poiseuille written to stay finite and linear in v as Q -> 0 (f -> infinity)
    hf = (32 * fluid.dynamicViscosity * spec.lengthM * v) / (fluid.density * G * D * D);
  } else {
    hf = f * (spec.lengthM / D) * velocityHead;
  }
  const hm = totalK(spec) * velocityHead;
  return {
    velocity: v,
    reynolds: re,
    frictionFactor: f,
    regime,
    frictionHeadLoss: hf,
    minorHeadLoss: hm,
    totalHeadLoss: hf + hm,
  };
}

/**
 * Loss coefficient used for a pipe with exactly zero resistance (zero length and no fittings). Such a pipe would have no head loss
 * at any flow, which the network solver cannot invert (the flow would be undetermined). 1e-4 is a straight connection for every
 * practical purpose. Pipes with any resistance at all are not touched.
 */
export const MIN_PIPE_K = 1e-4;

/** Pipe as a network element: headDrop(Q) is an odd function of Q. */
export function createPipeElement(spec: PipeSpec, fluid: Fluid): HydraulicElement {
  validatePipe(spec);
  const area = pipeArea(spec.innerDiameterM);
  const degenerate = spec.lengthM === 0 && totalK(spec) === 0;
  const floor = degenerate ? MIN_PIPE_K / (2 * G * area * area) : 0; // head per (m3/s)^2
  const loss = (q: number): number => {
    const s = Math.sign(q);
    return s * (pipeFlowState(spec, fluid, q).totalHeadLoss + floor * q * q);
  };
  return {
    kind: 'pipe',
    headDrop: loss,
    // Central difference. The loss function is C1 across regime changes, so this is accurate to ~1e-10.
    dHeadDrop(q: number): number {
      const h = Math.max(1e-6 * Math.abs(q), 1e-9);
      return (loss(q + h) - loss(q - h)) / (2 * h);
    },
  };
}
