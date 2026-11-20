/** Engineering reference data for the pipe editor. Typical values, to be verified for a design. */

export interface Material {
  name: string;
  /** Absolute roughness [mm]. */
  roughnessMm: number;
}

/** Absolute roughness of new pipe, per the Moody / Crane TP-410 tables. */
export const MATERIALS: readonly Material[] = [
  { name: 'Commercial / welded steel', roughnessMm: 0.046 },
  { name: 'Wrought iron', roughnessMm: 0.046 },
  { name: 'Galvanised iron', roughnessMm: 0.15 },
  { name: 'Cast iron (new)', roughnessMm: 0.26 },
  { name: 'Ductile iron, cement-lined', roughnessMm: 0.12 },
  { name: 'Drawn tubing / copper / brass', roughnessMm: 0.0015 },
  { name: 'PVC / PE / plastic', roughnessMm: 0.0015 },
  { name: 'Concrete (typical)', roughnessMm: 1.0 },
  { name: 'Riveted steel (typical)', roughnessMm: 3.0 },
];

export interface NominalSize {
  nps: string;
  /** Inside diameter, Schedule 40 steel pipe [mm]. */
  idMm: number;
}

/** ASME B36.10M Schedule 40 steel pipe inside diameters. */
export const SCH40: readonly NominalSize[] = [
  { nps: '1/2"', idMm: 15.8 },
  { nps: '3/4"', idMm: 20.93 },
  { nps: '1"', idMm: 26.64 },
  { nps: '1-1/4"', idMm: 35.05 },
  { nps: '1-1/2"', idMm: 40.89 },
  { nps: '2"', idMm: 52.5 },
  { nps: '2-1/2"', idMm: 62.71 },
  { nps: '3"', idMm: 77.93 },
  { nps: '4"', idMm: 102.26 },
  { nps: '5"', idMm: 128.19 },
  { nps: '6"', idMm: 154.05 },
  { nps: '8"', idMm: 202.72 },
  { nps: '10"', idMm: 254.51 },
  { nps: '12"', idMm: 303.23 },
];

export interface FittingPreset {
  name: string;
  k: number;
}

/** Typical loss coefficients (fully turbulent); real values depend on size and manufacturer. */
export const FITTINGS: readonly FittingPreset[] = [
  { name: 'Pipe entrance, sharp-edged', k: 0.5 },
  { name: 'Pipe entrance, well rounded', k: 0.04 },
  { name: 'Pipe exit', k: 1.0 },
  { name: '90° elbow, standard', k: 0.75 },
  { name: '90° elbow, long radius', k: 0.45 },
  { name: '45° elbow', k: 0.35 },
  { name: 'Tee, flow through run', k: 0.4 },
  { name: 'Tee, flow through branch', k: 1.2 },
  { name: 'Gate valve, fully open', k: 0.15 },
  { name: 'Globe valve, fully open', k: 6.5 },
  { name: 'Ball valve, fully open', k: 0.05 },
  { name: 'Butterfly valve, open', k: 0.3 },
  { name: 'Swing check valve', k: 2.0 },
];

/** Closest Schedule 40 nominal size to a diameter, if within 1 %. */
export function matchSize(idMm: number): string | undefined {
  return SCH40.find((s) => Math.abs(s.idMm - idMm) / s.idMm < 0.01)?.nps;
}

export function matchMaterial(roughnessMm: number): string | undefined {
  return MATERIALS.find((m) => Math.abs(m.roughnessMm - roughnessMm) < 1e-9)?.name;
}
