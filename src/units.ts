import { createContext, useContext } from 'react';

/**
 * Unit systems for display and entry. The project always stores canonical values
 * (m, mm, L/s, kPa, degC, mPa.s, kg/m3, kW, m/s); a unit system only changes how a number is shown or typed,
 * so saved files and calculations never depend on the chosen system.
 */
export type UnitSystem = 'si' | 'us';

export type Quantity =
  | 'length' // m
  | 'elevation' // m
  | 'head' // m of fluid
  | 'diameter' // mm
  | 'roughness' // mm
  | 'flow' // L/s
  | 'pressure' // kPa
  | 'temperature' // degC
  | 'velocity' // m/s
  | 'viscosity' // mPa.s
  | 'density' // kg/m3
  | 'power'; // kW

interface Def {
  label: string;
  /** display = canonical * factor + offset */
  factor: number;
  offset: number;
}

const FT = 3.280839895; // ft per m

const DEFS: Record<Quantity, Record<UnitSystem, Def>> = {
  length: { si: { label: 'm', factor: 1, offset: 0 }, us: { label: 'ft', factor: FT, offset: 0 } },
  elevation: { si: { label: 'm', factor: 1, offset: 0 }, us: { label: 'ft', factor: FT, offset: 0 } },
  head: { si: { label: 'm', factor: 1, offset: 0 }, us: { label: 'ft', factor: FT, offset: 0 } },
  diameter: { si: { label: 'mm', factor: 1, offset: 0 }, us: { label: 'in', factor: 1 / 25.4, offset: 0 } },
  roughness: { si: { label: 'mm', factor: 1, offset: 0 }, us: { label: 'mil', factor: 1000 / 25.4, offset: 0 } },
  flow: { si: { label: 'L/s', factor: 1, offset: 0 }, us: { label: 'gpm', factor: 15.8503232, offset: 0 } },
  pressure: { si: { label: 'kPa', factor: 1, offset: 0 }, us: { label: 'psi', factor: 0.1450377377, offset: 0 } },
  temperature: { si: { label: '°C', factor: 1, offset: 0 }, us: { label: '°F', factor: 1.8, offset: 32 } },
  velocity: { si: { label: 'm/s', factor: 1, offset: 0 }, us: { label: 'ft/s', factor: FT, offset: 0 } },
  viscosity: { si: { label: 'mPa·s', factor: 1, offset: 0 }, us: { label: 'cP', factor: 1, offset: 0 } },
  density: { si: { label: 'kg/m³', factor: 1, offset: 0 }, us: { label: 'lb/ft³', factor: 0.0624279606, offset: 0 } },
  power: { si: { label: 'kW', factor: 1, offset: 0 }, us: { label: 'hp', factor: 1.34102209, offset: 0 } },
};

export const unitLabel = (q: Quantity, s: UnitSystem): string => DEFS[q][s].label;
export const toDisplay = (q: Quantity, v: number, s: UnitSystem): number => v * DEFS[q][s].factor + DEFS[q][s].offset;
export const fromDisplay = (q: Quantity, d: number, s: UnitSystem): number => (d - DEFS[q][s].offset) / DEFS[q][s].factor;
/** Multiplier for a canonical value (no offset): used for chart axes. */
export const unitFactor = (q: Quantity, s: UnitSystem): number => DEFS[q][s].factor;

export const UnitsContext = createContext<UnitSystem>('si');

export interface Units {
  system: UnitSystem;
  /** Unit label for a quantity. */
  u: (q: Quantity) => string;
  /** Format a canonical value for display with a fixed number of decimals ('–' for undefined / non-finite). */
  f: (q: Quantity, v: number | undefined, digits?: number) => string;
  /** Format with the unit label appended. */
  fu: (q: Quantity, v: number | undefined, digits?: number) => string;
  to: (q: Quantity, v: number) => number;
  from: (q: Quantity, d: number) => number;
}

export function makeUnits(system: UnitSystem): Units {
  const f = (q: Quantity, v: number | undefined, digits = 2) => (v === undefined || !Number.isFinite(v) ? '–' : toDisplay(q, v, system).toFixed(digits));
  return {
    system,
    u: (q) => unitLabel(q, system),
    f,
    fu: (q, v, d) => (v === undefined || !Number.isFinite(v) ? '–' : `${f(q, v, d)} ${unitLabel(q, system)}`),
    to: (q, v) => toDisplay(q, v, system),
    from: (q, d) => fromDisplay(q, d, system),
  };
}

export function useUnits(): Units {
  return makeUnits(useContext(UnitsContext));
}
