import { useSyncExternalStore } from 'react';
import { FITTING_LIBRARY, type LibraryFitting } from './fittings';

const KEY = 'pipe-network-fitting-library';

function load(): LibraryFitting[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((f) => f && typeof f.category === 'string' && typeof f.name === 'string' && (Number.isFinite(f.k) || Number.isFinite(f.ld)))
      .map((f): LibraryFitting => ({ category: f.category, name: f.name, k: Number.isFinite(f.k) ? f.k : undefined, ld: Number.isFinite(f.ld) ? f.ld : undefined, source: String(f.source ?? ''), custom: true }));
  } catch {
    return [];
  }
}

let custom: LibraryFitting[] = load();
let snapshot = { custom, all: [...FITTING_LIBRARY, ...custom] as LibraryFitting[] };
const listeners = new Set<() => void>();
function emit() {
  snapshot = { custom, all: [...FITTING_LIBRARY, ...custom] };
  try {
    localStorage.setItem(KEY, JSON.stringify(custom));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export const allFittings = (): readonly LibraryFitting[] => snapshot.all;
export function useFittingLibrary() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => snapshot);
}

const same = (a: LibraryFitting, b: LibraryFitting) => a.category.toLowerCase() === b.category.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** Add imported fittings. An entry with the same category and name replaces the old one. */
export function addFittings(list: LibraryFitting[]) {
  for (const f of list) {
    const i = custom.findIndex((c) => same(c, f));
    custom = i >= 0 ? custom.map((c, j) => (j === i ? { ...f, custom: true } : c)) : [...custom, { ...f, custom: true }];
  }
  emit();
}
export function removeFitting(f: LibraryFitting) {
  custom = custom.filter((c) => !same(c, f));
  emit();
}
export function resetFittingLibrary() {
  custom = [];
  emit();
}

// ---- reading a sheet

export const FITTING_TEMPLATE_HEADER = ['Category', 'Name', 'K', 'L/D', 'Source'];
export const FITTING_TEMPLATE_EXAMPLE: (string | number)[][] = [
  ['Company elbows', '90° elbow, cast, 3D radius', '', 12, 'Supplier datasheet 2024'],
  ['Company valves', 'Knife gate valve, open', 0.1, '', 'Supplier datasheet 2024'],
  ['Company valves', 'Plug valve, eccentric', '', 25, 'Standard WI-12'],
];

export interface ParsedFittings {
  fittings: LibraryFitting[];
  problems: string[];
}

const norm = (v: unknown) => String(v ?? '').trim();
const num = (v: unknown): number | undefined => {
  const t = norm(v).replace(/,/g, '');
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

/** Turn rows (first row = headers) into fittings. Each needs a name and either a fixed K or an L/D. */
export function parseFittingSheet(rows: unknown[][]): ParsedFittings {
  const header = (rows[0] ?? []).map((h) => norm(h).toLowerCase());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const iName = find(/name|fitting|description|item/);
  const iCat = find(/categor|group|type/);
  const iL = find(/l\s*\/\s*d|equivalent|length/);
  const iK = header.findIndex((h, i) => i !== iL && /^k\b|\bk\b|loss|resistance|coefficient/.test(h));
  const iSrc = find(/source|reference|notes?|ref/);
  if (iName < 0) return { fittings: [], problems: ['No "Name" column found in the first row.'] };
  if (iK < 0 && iL < 0) return { fittings: [], problems: ['Need a "K" column, an "L/D" column, or both.'] };
  const out: LibraryFitting[] = [];
  const problems: string[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (row.every((c) => norm(c) === '')) continue;
    const name = norm(row[iName]);
    if (!name) { problems.push(`Row ${r + 1}: no name.`); continue; }
    const k = iK >= 0 ? num(row[iK]) : undefined;
    const ld = iL >= 0 ? num(row[iL]) : undefined;
    if (k === undefined && ld === undefined) { problems.push(`Row ${r + 1} (${name}): needs a K or an L/D.`); continue; }
    if ((k !== undefined && k < 0) || (ld !== undefined && ld < 0)) { problems.push(`Row ${r + 1} (${name}): losses cannot be negative.`); continue; }
    const f: LibraryFitting = { category: (iCat >= 0 ? norm(row[iCat]) : '') || 'Company', name, source: (iSrc >= 0 ? norm(row[iSrc]) : '') || 'Company data', custom: true };
    if (k !== undefined) f.k = k; else f.ld = ld;
    if (out.some((o) => same(o, f))) { problems.push(`Row ${r + 1}: ${name} appears twice. The first is kept.`); continue; }
    out.push(f);
  }
  return { fittings: out, problems };
}

export async function fittingTemplate(): Promise<Blob> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fittings');
  ws.addRow(FITTING_TEMPLATE_HEADER).font = { bold: true };
  FITTING_TEMPLATE_EXAMPLE.forEach((r) => ws.addRow(r));
  ws.columns = [{ width: 22 }, { width: 34 }, { width: 10 }, { width: 10 }, { width: 28 }];
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
