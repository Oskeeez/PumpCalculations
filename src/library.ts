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

/** Typical Hazen-Williams C for new pipe (NFPA 13 table values for steel, copper and plastic). */
export const HAZEN_C: readonly { name: string; c: number }[] = [
  { name: 'Black steel, dry system', c: 100 },
  { name: 'Black steel, wet system', c: 120 },
  { name: 'Galvanised steel', c: 120 },
  { name: 'Cast iron, unlined', c: 100 },
  { name: 'Ductile iron, cement-lined', c: 140 },
  { name: 'Copper tube', c: 150 },
  { name: 'Stainless steel', c: 150 },
  { name: 'Plastic (PVC, CPVC, PE)', c: 150 },
];

export interface NominalSize {
  nps: string;
  /** Inside diameter [mm]. */
  idMm: number;
  /** Optional data from a company list. */
  odMm?: number;
  roughnessMm?: number;
  ratingKPaG?: number;
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

const IN_MM = 25.4;
const fromInches = (rows: [string, number][]): NominalSize[] => rows.map(([nps, id]) => ({ nps, idMm: Math.round(id * IN_MM * 100) / 100 }));

/** ASME B36.10M Schedule 80 steel pipe inside diameters. */
export const SCH80: readonly NominalSize[] = fromInches([
  ['1/2"', 0.546], ['3/4"', 0.742], ['1"', 0.957], ['1-1/4"', 1.278], ['1-1/2"', 1.5], ['2"', 1.939], ['2-1/2"', 2.323],
  ['3"', 2.9], ['4"', 3.826], ['5"', 4.813], ['6"', 5.761], ['8"', 7.625], ['10"', 9.562], ['12"', 11.374],
]);

/** Copper tube Type L (ASTM B88), nominal sizes with typical inside diameters. */
export const COPPER_L: readonly NominalSize[] = fromInches([
  ['1/2"', 0.545], ['3/4"', 0.785], ['1"', 1.025], ['1-1/4"', 1.265], ['1-1/2"', 1.505], ['2"', 1.985], ['2-1/2"', 2.465], ['3"', 2.945], ['4"', 3.905],
]);

export interface PipeSeries {
  id: string;
  label: string;
  sizes: readonly NominalSize[];
  /** True for a series imported by the user. */
  custom?: boolean;
}

/** Standard pipe size series for the pipe editor. Typical inside diameters: check against the pipe you will buy. */
export const PIPE_SERIES: readonly PipeSeries[] = [
  { id: 'sch40', label: 'Sch 40 steel', sizes: SCH40 },
  { id: 'sch80', label: 'Sch 80 steel', sizes: SCH80 },
  { id: 'copperL', label: 'Copper, Type L', sizes: COPPER_L },
];

/** The series and nominal size whose inside diameter is within 1 % of the given one, if any. */
export function matchPipeSize(idMm: number, preferred?: string, all: readonly PipeSeries[] = PIPE_SERIES): { series: string; nps: string } | undefined {
  const order = [...all].sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));
  for (const series of order) {
    const hit = series.sizes.find((s) => Math.abs(s.idMm - idMm) / s.idMm < 0.01);
    if (hit) return { series: series.id, nps: hit.nps };
  }
  return undefined;
}

/** Closest Schedule 40 nominal size to a diameter, if within 1 %. */
export function matchSize(idMm: number): string | undefined {
  return SCH40.find((s) => Math.abs(s.idMm - idMm) / s.idMm < 0.01)?.nps;
}

export function matchMaterial(roughnessMm: number): string | undefined {
  return MATERIALS.find((m) => Math.abs(m.roughnessMm - roughnessMm) < 1e-9)?.name;
}
