/**
 * Square-edged orifice plate in a full pipe (ISO 5167-2 style relations).
 *
 * With beta = d / D and discharge coefficient Cd, the differential pressure measured across the plate corresponds to
 *   K_meas = (1 - beta^4) / (Cd^2 beta^4)         (referenced to the velocity in the pipe, D)
 * but part of that pressure is recovered downstream. What the pump actually has to overcome is the permanent loss
 *   K_perm = K_meas * (sqrt(1 - beta^4 (1 - Cd^2)) - Cd beta^2) / (sqrt(1 - beta^4 (1 - Cd^2)) + Cd beta^2)
 * Cd = 0.61 is the usual value for a sharp-edged plate at high Reynolds number; the real value depends on Re, beta
 * and tap arrangement, so treat results as an estimate.
 */
export const ORIFICE_CD_DEFAULT = 0.61;

export function orificeKMeasured(beta: number, cd: number = ORIFICE_CD_DEFAULT): number {
  const b4 = beta ** 4;
  return (1 - b4) / (cd * cd * b4);
}

/** Permanent loss coefficient, referenced to the pipe velocity. Throws if beta is outside (0, 1). */
export function orificeKPermanent(beta: number, cd: number = ORIFICE_CD_DEFAULT): number {
  if (!(beta > 0 && beta < 1)) throw new Error('Orifice bore must be smaller than the pipe diameter and greater than 0.');
  if (!(cd > 0 && cd <= 1)) throw new Error('Orifice discharge coefficient must be between 0 and 1.');
  const s = Math.sqrt(1 - beta ** 4 * (1 - cd * cd));
  return orificeKMeasured(beta, cd) * ((s - cd * beta * beta) / (s + cd * beta * beta));
}
