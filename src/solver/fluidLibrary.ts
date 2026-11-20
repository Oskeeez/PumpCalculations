import type { Fluid } from './fluid';
import { water } from './fluid';

/**
 * Fluid library. Water uses fitted correlations (fluid.ts). Other fluids use tabulated published data,
 * interpolated linearly in density and linearly in ln(viscosity) between table points.
 *
 * Sources:
 *  - Ethylene glycol 30 / 50 % by mass: Melinder (2010) correlations via CoolProp 8.0 (fluidprops.com), ~1 % density, 3-5 % viscosity.
 *  - Propylene glycol 30 / 50 % by volume: ASHRAE Handbook - Fundamentals (2013), inhibited glycol, tabulated in deg F, converted.
 *  - Seawater 35 g/kg: MIT seawater property library (Sharqawy, Lienhard, Zubair; Nayar et al.), atmospheric pressure.
 * Vapour pressure of the solutions is estimated as pure-water vapour pressure times a Raoult's-law water
 * fraction (ideal-solution approximation), which is adequate for NPSH screening but not for design margins
 * close to vapour pressure.
 */

export type FluidId = 'water' | 'seawater' | 'eg30' | 'eg50' | 'pg30' | 'pg50' | 'custom';

export interface CustomFluid {
  name: string;
  /** kg/m3 */
  density: number;
  /** Pa.s */
  dynamicViscosity: number;
  /** Pa abs */
  vaporPressure: number;
}

export interface FluidInfo {
  id: FluidId;
  name: string;
  tMinC: number;
  tMaxC: number;
  note: string;
}

type Row = readonly [tC: number, density: number, viscosityMPas: number];

const F2C = (f: number) => (f - 32) / 1.8;
const LB_FT3 = 16.01846;

const TABLES: Record<Exclude<FluidId, 'water' | 'custom'>, { rows: readonly Row[]; waterFraction: number }> = {
  seawater: {
    waterFraction: 0.98,
    rows: [
      [0, 1028.0, 1.906],
      [10, 1027.0, 1.397],
      [20, 1024.9, 1.077],
      [30, 1022.0, 0.861],
      [40, 1018.3, 0.707],
    ],
  },
  eg30: {
    waterFraction: 0.889,
    rows: [
      [0, 1044.972, 4.2976],
      [10, 1041.813, 2.983],
      [20, 1038.046, 2.1664],
      [30, 1033.699, 1.6389],
      [40, 1028.8, 1.2856],
      [50, 1023.379, 1.0409],
      [60, 1017.462, 0.866],
      [70, 1011.079, 0.7371],
      [80, 1004.257, 0.6388],
      [90, 997.026, 0.5613],
      [100, 989.413, 0.4977],
    ],
  },
  eg50: {
    waterFraction: 0.775,
    rows: [
      [0, 1074.624, 7.9298],
      [10, 1070.021, 5.2565],
      [20, 1064.929, 3.6932],
      [30, 1059.388, 2.7287],
      [40, 1053.441, 2.1033],
      [50, 1047.128, 1.6781],
      [60, 1040.49, 1.3749],
      [70, 1033.569, 1.1477],
      [80, 1026.406, 0.9685],
      [90, 1019.043, 0.8195],
      [100, 1011.52, 0.69],
    ],
  },
  pg30: {
    waterFraction: 0.9,
    rows: [
      [F2C(20), 64.9 * LB_FT3, 9.91],
      [F2C(40), 64.67 * LB_FT3, 5.75],
      [F2C(60), 64.39 * LB_FT3, 3.61],
      [F2C(80), 64.08 * LB_FT3, 2.43],
      [F2C(100), 63.73 * LB_FT3, 1.73],
      [F2C(120), 63.33 * LB_FT3, 1.3],
    ],
  },
  pg50: {
    waterFraction: 0.8,
    rows: [
      [F2C(20), 65.97 * LB_FT3, 27.83],
      [F2C(40), 65.67 * LB_FT3, 14.28],
      [F2C(60), 65.33 * LB_FT3, 8.13],
      [F2C(80), 64.95 * LB_FT3, 5.04],
      [F2C(100), 64.53 * LB_FT3, 3.35],
      [F2C(120), 64.06 * LB_FT3, 2.36],
    ],
  },
};

const NAMES: Record<Exclude<FluidId, 'water' | 'custom'>, { name: string; note: string }> = {
  seawater: { name: 'Seawater (35 g/kg)', note: 'MIT seawater library, 0-40 °C' },
  eg30: { name: 'Ethylene glycol 30 % (mass)', note: 'Melinder/CoolProp, 0-100 °C' },
  eg50: { name: 'Ethylene glycol 50 % (mass)', note: 'Melinder/CoolProp, 0-100 °C' },
  pg30: { name: 'Propylene glycol 30 % (volume)', note: 'ASHRAE 2013, -7 to 49 °C' },
  pg50: { name: 'Propylene glycol 50 % (volume)', note: 'ASHRAE 2013, -7 to 49 °C' },
};

export const FLUID_LIBRARY: readonly FluidInfo[] = [
  { id: 'water', name: 'Water', tMinC: 0, tMaxC: 100, note: 'Fitted correlations (Kell, Vogel, Antoine), 0-100 °C' },
  ...(Object.keys(TABLES) as (keyof typeof TABLES)[]).map((id) => ({
    id,
    name: NAMES[id].name,
    tMinC: TABLES[id].rows[0][0],
    tMaxC: TABLES[id].rows[TABLES[id].rows.length - 1][0],
    note: NAMES[id].note,
  })),
  { id: 'custom', name: 'Custom (constant properties)', tMinC: -Infinity, tMaxC: Infinity, note: 'You supply density, viscosity and vapour pressure' },
];

export function fluidInfo(id: FluidId): FluidInfo {
  return FLUID_LIBRARY.find((f) => f.id === id) as FluidInfo;
}

/** Fluid properties at a temperature. Throws RangeError outside the fluid's data range. */
export function fluidAt(id: FluidId, temperatureC: number, custom?: CustomFluid): Fluid {
  if (id === 'water') return water(temperatureC);
  if (id === 'custom') {
    if (!custom || !(custom.density > 0) || !(custom.dynamicViscosity > 0) || !(custom.vaporPressure >= 0)) {
      throw new RangeError('Custom fluid needs positive density and viscosity, and non-negative vapour pressure.');
    }
    return { name: custom.name || 'Custom fluid', temperatureC, density: custom.density, dynamicViscosity: custom.dynamicViscosity, vaporPressure: custom.vaporPressure };
  }
  const { rows, waterFraction } = TABLES[id];
  const info = fluidInfo(id);
  if (!Number.isFinite(temperatureC) || temperatureC < info.tMinC - 1e-9 || temperatureC > info.tMaxC + 1e-9) {
    throw new RangeError(`${info.name}: temperature must be between ${info.tMinC.toFixed(0)} and ${info.tMaxC.toFixed(0)} °C.`);
  }
  let i = 0;
  while (i < rows.length - 2 && temperatureC > rows[i + 1][0]) i++;
  const [t0, d0, v0] = rows[i];
  const [t1, d1, v1] = rows[i + 1];
  const f = (temperatureC - t0) / (t1 - t0);
  const density = d0 + f * (d1 - d0);
  const mu = Math.exp(Math.log(v0) + f * (Math.log(v1) - Math.log(v0))) / 1000;
  return {
    name: info.name,
    temperatureC,
    density,
    dynamicViscosity: mu,
    vaporPressure: water(Math.min(100, Math.max(0, temperatureC))).vaporPressure * waterFraction,
  };
}
