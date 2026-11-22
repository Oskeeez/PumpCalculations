import { useSyncExternalStore } from 'react';
import { PIPE_SERIES, type NominalSize, type PipeSeries } from './library';

const KEY = 'pipe-network-pipe-library';
const STD_KEY = 'pipe-network-standard-series';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const isSize = (s: unknown): s is NominalSize => !!s && typeof s === 'object' && typeof (s as NominalSize).nps === 'string' && Number.isFinite((s as NominalSize).idMm) && (s as NominalSize).idMm > 0;
function load(): PipeSeries[] {
  const raw = read<unknown>(KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is PipeSeries => !!s && typeof s.id === 'string' && typeof s.label === 'string' && Array.isArray(s.sizes))
    .map((s) => ({ id: s.id, label: s.label, custom: true, sizes: s.sizes.filter(isSize) }))
    .filter((s) => s.sizes.length > 0);
}

let user: PipeSeries[] = load();
let standard: string = read<string>(STD_KEY, 'sch40');
let snapshot = { user, standard, all: [...PIPE_SERIES, ...user] as PipeSeries[] };
const listeners = new Set<() => void>();
function emit() {
  snapshot = { user, standard, all: [...PIPE_SERIES, ...user] };
  write(KEY, user);
  write(STD_KEY, standard);
  listeners.forEach((l) => l());
}

/** Every series: the built-in ones and those imported by the company. */
export const allPipeSeries = (): readonly PipeSeries[] => snapshot.all;
export const standardSeriesId = (): string => (snapshot.all.some((s) => s.id === snapshot.standard) ? snapshot.standard : 'sch40');
export const findSeries = (id: string): PipeSeries => snapshot.all.find((s) => s.id === id) ?? snapshot.all[0];

export function usePipeLibrary() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => snapshot);
}

/** Add imported series. A series with the same label replaces the old one. */
export function addSeries(list: PipeSeries[]) {
  for (const s of list) {
    const clash = user.findIndex((u) => u.label.toLowerCase() === s.label.toLowerCase());
    if (clash >= 0) user = user.map((u, i) => (i === clash ? { ...s, id: u.id, custom: true } : u));
    else user = [...user, { ...s, custom: true }];
  }
  emit();
}
export function removeSeries(id: string) {
  user = user.filter((s) => s.id !== id);
  if (standard === id) standard = 'sch40';
  emit();
}
export function setStandardSeries(id: string) {
  standard = id;
  emit();
}
/** For tests. */
export function resetPipeLibrary() {
  user = [];
  standard = 'sch40';
  emit();
}

// ---- reading a sheet

export const TEMPLATE_HEADER = ['Series', 'Nominal size', 'Inside diameter (mm)', 'Outside diameter (mm)', 'Wall thickness (mm)', 'Roughness (mm)', 'Pressure rating (kPa)'];
export const TEMPLATE_EXAMPLE: (string | number)[][] = [
  ['Company PE100 PN10', 'DN50', 44, 50, 3, 0.0015, 1000],
  ['Company PE100 PN10', 'DN63', 55.4, 63, 3.8, 0.0015, 1000],
  ['Company PE100 PN10', 'DN90', 79.2, 90, 5.4, 0.0015, 1000],
  ['Company steel', 'DN100', 105, '', '', 0.046, ''],
];

export interface ParsedSheet {
  series: PipeSeries[];
  /** Rows that were skipped, with the reason. */
  problems: string[];
}

const norm = (v: unknown) => String(v ?? '').trim();
const num = (v: unknown): number | undefined => {
  const t = norm(v).replace(/,/g, '');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

type Col = 'series' | 'nominal' | 'id' | 'od' | 'wall' | 'rough' | 'rating';
function columnFor(header: string): { col: Col; factor: number } | undefined {
  const h = header.toLowerCase();
  const inches = /\((in|inch|inches|")\)|\binch/.test(h);
  const factor = inches ? 25.4 : 1;
  if (/series|material|schedule|class|name/.test(h) && !/diameter/.test(h)) return { col: 'series', factor: 1 };
  if (/nominal|size|dn|nps/.test(h) && !/diameter/.test(h)) return { col: 'nominal', factor: 1 };
  if (/inside|inner|\bid\b/.test(h)) return { col: 'id', factor };
  if (/outside|outer|\bod\b/.test(h)) return { col: 'od', factor };
  if (/wall/.test(h)) return { col: 'wall', factor };
  if (/rough/.test(h)) return { col: 'rough', factor: /\(m\)/.test(h) ? 1000 : factor };
  if (/rating|pressure|pn|kpa/.test(h)) return { col: 'rating', factor: /\(bar\)/.test(h) ? 100 : /\(mpa\)/.test(h) ? 1000 : /\(psi\)/.test(h) ? 6.894757 : 1 };
  return undefined;
}

/** Turn rows from a spreadsheet (first row = headers) into pipe series. */
export function parsePipeSheet(rows: unknown[][]): ParsedSheet {
  const problems: string[] = [];
  const header = (rows[0] ?? []).map(norm);
  const cols = new Map<Col, { index: number; factor: number }>();
  header.forEach((h, i) => {
    const c = columnFor(h);
    if (c && !cols.has(c.col)) cols.set(c.col, { index: i, factor: c.factor });
  });
  if (!cols.has('nominal')) return { series: [], problems: ['No "Nominal size" column found in the first row.'] };
  if (!cols.has('id') && !(cols.has('od') && cols.has('wall'))) return { series: [], problems: ['Need an "Inside diameter" column, or both "Outside diameter" and "Wall thickness".'] };
  const get = (row: unknown[], c: Col) => { const k = cols.get(c); return k ? row[k.index] : undefined; };
  const getNum = (row: unknown[], c: Col) => { const v = num(get(row, c)); return v === undefined ? undefined : v * (cols.get(c)?.factor ?? 1); };
  const bySeries = new Map<string, NominalSize[]>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (row.every((c) => norm(c) === '')) continue;
    const nps = norm(get(row, 'nominal'));
    const seriesName = norm(get(row, 'series')) || 'Imported pipe sizes';
    let id = getNum(row, 'id');
    const od = getNum(row, 'od');
    const wall = getNum(row, 'wall');
    if (id === undefined && od !== undefined && wall !== undefined) id = od - 2 * wall;
    if (!nps) { problems.push(`Row ${r + 1}: no nominal size.`); continue; }
    if (id === undefined || !(id > 0)) { problems.push(`Row ${r + 1} (${nps}): no usable inside diameter.`); continue; }
    if (od !== undefined && od <= id) { problems.push(`Row ${r + 1} (${nps}): outside diameter must be larger than the inside diameter.`); continue; }
    const size: NominalSize = { nps, idMm: Math.round(id * 1000) / 1000 };
    if (od !== undefined) size.odMm = od;
    const rough = getNum(row, 'rough');
    if (rough !== undefined && rough >= 0) size.roughnessMm = rough;
    const rating = getNum(row, 'rating');
    if (rating !== undefined && rating > 0) size.ratingKPaG = rating;
    const list = bySeries.get(seriesName) ?? [];
    if (list.some((s) => s.nps === nps)) { problems.push(`Row ${r + 1}: ${nps} appears twice in ${seriesName}. The first is kept.`); continue; }
    list.push(size);
    bySeries.set(seriesName, list);
  }
  const series = [...bySeries.entries()].map(([label, sizes]): PipeSeries => ({
    id: `user-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'series'}`,
    label,
    custom: true,
    sizes: sizes.sort((a, b) => a.idMm - b.idMm),
  }));
  return { series, problems };
}

/** Read the first sheet of an .xlsx file, or a .csv file, into rows. */
export async function readSheetFile(file: File): Promise<unknown[][]> {
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
    return (await file.text()).split(/\r?\n/).map((line) => line.split(/,|;|\t/));
  }
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1).map((v) => (v && typeof v === 'object' && 'result' in (v as object) ? (v as { result: unknown }).result : v));
    rows.push(values);
  });
  return rows;
}

/** A spreadsheet to fill in. Returns the file bytes. */
export async function pipeTemplate(): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Pipe sizes');
  ws.addRow(TEMPLATE_HEADER).font = { bold: true };
  TEMPLATE_EXAMPLE.forEach((r) => ws.addRow(r));
  ws.columns = TEMPLATE_HEADER.map((h) => ({ width: Math.max(14, h.length + 2) }));
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---- standard sizing

export interface SizeChoice {
  size: NominalSize;
  velocityMps: number;
  headLossPer100m: number;
}

/** Smallest size in the series that keeps velocity and (optionally) head loss per 100 m within limits at the given flow. */
export function smallestStandardSize(
  series: PipeSeries,
  flowLps: number,
  limits: { maxVelocityMps?: number; maxHeadLossPer100m?: number },
  headLossPer100m: (idMm: number, roughnessMm: number | undefined) => number,
): SizeChoice | undefined {
  for (const size of [...series.sizes].sort((a, b) => a.idMm - b.idMm)) {
    const area = (Math.PI / 4) * (size.idMm / 1000) ** 2;
    const v = flowLps / 1000 / area;
    const hl = headLossPer100m(size.idMm, size.roughnessMm);
    if (limits.maxVelocityMps !== undefined && v > limits.maxVelocityMps) continue;
    if (limits.maxHeadLossPer100m !== undefined && hl > limits.maxHeadLossPer100m) continue;
    return { size, velocityMps: v, headLossPer100m: hl };
  }
  return undefined;
}
