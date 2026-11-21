/**
 * Pressure units for typing and showing a pressure. The project always stores kPa (gauge unless a field says otherwise); these
 * functions convert for display only. "Head" units express the pressure as a column of the working fluid, so they need its density.
 */
const G = 9.80665;
const FT_PER_M = 3.280839895;

export interface PressureUnit {
  id: string;
  label: string;
  /** Short note for the drop-down. */
  note?: string;
}

/** The units offered in the drop-down, most used first. */
export const PRESSURE_UNITS: readonly PressureUnit[] = [
  { id: 'kPa', label: 'kPa' },
  { id: 'Pa', label: 'Pa' },
  { id: 'MPa', label: 'MPa' },
  { id: 'bar', label: 'bar' },
  { id: 'mbar', label: 'mbar' },
  { id: 'psi', label: 'psi' },
  { id: 'mhead', label: 'm head', note: 'metres of this fluid' },
  { id: 'fthead', label: 'ft head', note: 'feet of this fluid' },
  { id: 'mH2O', label: 'm H₂O', note: 'metres of water (standard)' },
  { id: 'atm', label: 'atm' },
  { id: 'kgfcm2', label: 'kgf/cm²' },
  { id: 'mmHg', label: 'mmHg' },
  { id: 'inH2O', label: 'in H₂O' },
];

/** Units per kPa for the units that do not depend on the fluid. */
const PER_KPA: Record<string, number> = {
  kPa: 1,
  Pa: 1000,
  MPa: 0.001,
  bar: 0.01,
  mbar: 10,
  psi: 0.1450377377,
  mH2O: 1 / 9.80665, // 1 m of water (standard) = 9.80665 kPa
  atm: 1 / 101.325,
  kgfcm2: 1 / 98.0665,
  mmHg: 7.50061683,
  inH2O: 1000 / 249.08891, // 1 inch of water at 4 degrees C = 249.0889 Pa
};

export const isPressureUnit = (id: string): boolean => id in PER_KPA || id === 'mhead' || id === 'fthead';

/** Pressure in kPa to a value in the given unit. `density` [kg/m3] is used by the head units. */
export function fromKPa(unit: string, kPa: number, density: number): number {
  if (unit === 'mhead') return (kPa * 1000) / (density * G);
  if (unit === 'fthead') return ((kPa * 1000) / (density * G)) * FT_PER_M;
  const f = PER_KPA[unit];
  if (f === undefined) throw new RangeError(`Unknown pressure unit "${unit}".`);
  return kPa * f;
}

/** A value in the given unit to kPa. */
export function toKPa(unit: string, value: number, density: number): number {
  if (unit === 'mhead') return (value * density * G) / 1000;
  if (unit === 'fthead') return ((value / FT_PER_M) * density * G) / 1000;
  const f = PER_KPA[unit];
  if (f === undefined) throw new RangeError(`Unknown pressure unit "${unit}".`);
  return value / f;
}

export const pressureUnitLabel = (id: string): string => PRESSURE_UNITS.find((u) => u.id === id)?.label ?? id;
