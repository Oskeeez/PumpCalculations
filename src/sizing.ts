/**
 * Sizing helpers for the valve editor: the flow coefficient a control valve needs, and the bore an orifice plate needs, to give a
 * wanted pressure drop at a design flow. Pure functions in SI-based units (L/s, kPa, mm, kg/m3).
 */
import { ORIFICE_CD_DEFAULT, orificeKMeasured, orificeKPermanent } from './solver';
import { brent } from './solver';

const GPM_PER_LPS = 15.8503232;
const PSI_PER_KPA = 0.1450377377;
const M3H_PER_LPS = 3.6;
const BAR_PER_KPA = 0.01;
const RHO_WATER = 999;

/** Specific gravity of a liquid relative to water (999 kg/m3, the reference of the Cv and Kv definitions). */
export const specificGravity = (density: number): number => density / RHO_WATER;

function check(flowLps: number, dropKPa: number): void {
  if (!(flowLps > 0)) throw new RangeError('The design flow must be greater than 0.');
  if (!(dropKPa > 0)) throw new RangeError('The allowable pressure drop must be greater than 0.');
}

/** US flow coefficient: gpm of water at 1 psi drop. Cv = Q[gpm] / sqrt(dP[psi] / SG). */
export function requiredCv(flowLps: number, dropKPa: number, density: number): number {
  check(flowLps, dropKPa);
  return (flowLps * GPM_PER_LPS) / Math.sqrt((dropKPa * PSI_PER_KPA) / specificGravity(density));
}

/** Metric flow coefficient: m3/h of water at 1 bar drop. Kv = Q[m3/h] / sqrt(dP[bar] / SG). */
export function requiredKv(flowLps: number, dropKPa: number, density: number): number {
  check(flowLps, dropKPa);
  return (flowLps * M3H_PER_LPS) / Math.sqrt((dropKPa * BAR_PER_KPA) / specificGravity(density));
}

export interface OrificeSizing {
  boreMm: number;
  /** Bore / pipe diameter. */
  beta: number;
  /** Velocity through the bore [m/s]. */
  boreVelocityMps: number;
  /** The differential pressure a flow meter would read across the plate [kPa]; larger than the permanent loss. */
  measuredDropKPa: number;
  /** Plain-language cautions (beta out of the usual range, high velocity). */
  warnings: string[];
}

/**
 * The bore giving the wanted PERMANENT pressure loss at the design flow in a pipe of the given inside diameter
 * (square-edged plate, ISO 5167-2 relations, see solver/orifice.ts). Throws a readable error if no plate can do it:
 * the drop is smaller than even a very large bore causes, or larger than a very small bore does.
 */
export function orificeBoreForDrop(flowLps: number, dropKPa: number, pipeMm: number, density: number, cd = ORIFICE_CD_DEFAULT): OrificeSizing {
  check(flowLps, dropKPa);
  if (!(pipeMm > 0)) throw new RangeError('The pipe diameter must be greater than 0.');
  const D = pipeMm / 1000;
  const v = flowLps / 1000 / ((Math.PI / 4) * D * D);
  const kNeeded = (dropKPa * 1000) / (0.5 * density * v * v);
  const lo = 0.05;
  const hi = 0.95;
  const kAt = (b: number) => orificeKPermanent(b, cd);
  if (kNeeded > kAt(lo)) throw new RangeError(`A drop of ${dropKPa} kPa at ${flowLps} L/s is more than any orifice in this pipe can give (even a ${(lo * pipeMm).toFixed(1)} mm bore). Use a larger drop budget in steps, or a smaller line.`);
  if (kNeeded < kAt(hi)) throw new RangeError(`A drop of ${dropKPa} kPa at ${flowLps} L/s is less than a plate with a ${(hi * pipeMm).toFixed(0)} mm bore gives. The pipe already loses more than that; no orifice is needed.`);
  const beta = brent((b) => kAt(b) - kNeeded, lo, hi, 1e-10, 100);
  const boreV = v / (beta * beta);
  const measured = (0.5 * density * v * v * orificeKMeasured(beta, cd)) / 1000;
  const warnings: string[] = [];
  if (beta < 0.2 || beta > 0.75) warnings.push(`Beta ratio ${beta.toFixed(2)} is outside the usual 0.2 to 0.75 range, so the discharge coefficient is less certain.`);
  if (boreV > 12) warnings.push(`Velocity through the bore is ${boreV.toFixed(1)} m/s: expect noise and possible cavitation. Consider two plates in series.`);
  return { boreMm: beta * pipeMm, beta, boreVelocityMps: boreV, measuredDropKPa: measured, warnings };
}
