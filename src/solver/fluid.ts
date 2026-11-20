import { G } from './constants';

/** Fluid properties at a given temperature. SI units. */
export interface Fluid {
  name: string;
  /** Temperature [deg C]. */
  temperatureC: number;
  /** Density rho [kg/m^3]. */
  density: number;
  /** Dynamic viscosity mu [Pa.s]. */
  dynamicViscosity: number;
  /** Vapour pressure p_v [Pa, absolute]. */
  vaporPressure: number;
}

/**
 * Liquid water properties from simple fitted correlations, valid 0..100 deg C at ~1 atm.
 *  - density: Kell (1975) polynomial/rational fit
 *  - viscosity: Vogel equation  mu = 2.414e-5 * 10^(247.8 / (T[K] - 140))
 *  - vapour pressure: Antoine equation (mmHg -> Pa), A=8.07131 B=1730.63 C=233.426
 */
export function water(temperatureC: number): Fluid {
  const T = temperatureC;
  if (!Number.isFinite(T) || T < 0 || T > 100) {
    throw new RangeError(`water(): temperature ${T} degC outside the 0..100 degC correlation range`);
  }
  const density =
    (999.83952 +
      16.945176 * T -
      7.9870401e-3 * T ** 2 -
      46.170461e-6 * T ** 3 +
      105.56302e-9 * T ** 4 -
      280.54253e-12 * T ** 5) /
    (1 + 16.87985e-3 * T);
  const dynamicViscosity = 2.414e-5 * 10 ** (247.8 / (T + 273.15 - 140));
  const vaporPressure = 133.322368 * 10 ** (8.07131 - 1730.63 / (233.426 + T));
  return { name: 'Water', temperatureC: T, density, dynamicViscosity, vaporPressure };
}

/** Specific weight rho*g [N/m^3]. */
export function specificWeight(fluid: Fluid): number {
  return fluid.density * G;
}
