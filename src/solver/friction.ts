import { RE_LAMINAR_MAX, RE_TURBULENT_MIN } from './constants';

/**
 * Colebrook-White friction factor (Darcy), solved by Newton iteration on x = 1/sqrt(f):
 *   g(x) = x + 2 log10( a + b x ),  a = (eps/D)/3.7,  b = 2.51/Re
 *   g'(x) = 1 + 2 b / (ln10 (a + b x))       (g is increasing and concave => Newton is safe)
 * Initial guess from the Swamee-Jain explicit approximation.
 * @param reynolds Reynolds number (> 0)
 * @param relativeRoughness eps/D [-]
 */
export function colebrookFrictionFactor(reynolds: number, relativeRoughness: number): number {
  if (!(reynolds > 0)) throw new RangeError('colebrookFrictionFactor: Re must be > 0');
  const a = relativeRoughness / 3.7;
  const b = 2.51 / reynolds;
  const f0 = 0.25 / Math.log10(a + 5.74 / reynolds ** 0.9) ** 2;
  let x = 1 / Math.sqrt(f0);
  for (let i = 0; i < 50; i++) {
    const arg = a + b * x;
    const g = x + 2 * Math.log10(arg);
    const dg = 1 + (2 * b) / (Math.LN10 * arg);
    const dx = g / dg;
    x -= dx;
    if (Math.abs(dx) <= 1e-14 * Math.abs(x)) break;
  }
  return 1 / (x * x);
}

/**
 * Darcy friction factor over all regimes.
 *  Re < 2300         : f = 64/Re
 *  2300 <= Re < 4000 : smoothstep blend of 64/Re and Colebrook (C1-continuous, monotone head loss)
 *  Re >= 4000        : Colebrook-White
 * Returns Infinity for Re <= 0 (callers must handle zero flow before using f).
 */
export function darcyFrictionFactor(reynolds: number, relativeRoughness: number): number {
  if (!(reynolds > 0)) return Infinity;
  if (reynolds < RE_LAMINAR_MAX) return 64 / reynolds;
  const fTurb = colebrookFrictionFactor(reynolds, relativeRoughness);
  if (reynolds >= RE_TURBULENT_MIN) return fTurb;
  const t = (reynolds - RE_LAMINAR_MAX) / (RE_TURBULENT_MIN - RE_LAMINAR_MAX);
  const w = t * t * (3 - 2 * t);
  return (1 - w) * (64 / reynolds) + w * fTurb;
}

export type FlowRegime = 'zero' | 'laminar' | 'transitional' | 'turbulent';

export function flowRegime(reynolds: number): FlowRegime {
  if (!(reynolds > 0)) return 'zero';
  if (reynolds < RE_LAMINAR_MAX) return 'laminar';
  if (reynolds < RE_TURBULENT_MIN) return 'transitional';
  return 'turbulent';
}
