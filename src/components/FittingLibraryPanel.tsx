import { useRef, useState } from 'react';
import { addFittings, fittingTemplate, parseFittingSheet, removeFitting, useFittingLibrary } from '../fittingLibrary';
import { download } from '../download';
import { fittingK } from '../fittings';
import { readSheetFile } from '../pipeLibrary';

/** The fitting loss list. Company fittings come from an Excel or CSV file. */
export function FittingLibraryPanel() {
  const lib = useFittingLibrary();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string; problems: string[] }>();
  const [filter, setFilter] = useState('');
  const [size, setSize] = useState(100);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseFittingSheet(await readSheetFile(file));
      if (parsed.fittings.length) addFittings(parsed.fittings);
      setResult({
        kind: parsed.fittings.length ? (parsed.problems.length ? 'warn' : 'ok') : 'error',
        text: parsed.fittings.length ? `Imported ${parsed.fittings.length} fitting${parsed.fittings.length === 1 ? '' : 's'}.` : 'Nothing imported.',
        problems: parsed.problems,
      });
    } catch (err) {
      setResult({ kind: 'error', text: `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`, problems: [] });
    }
  };
  const rows = lib.all.filter((f) => `${f.category} ${f.name}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="pipelib">
      <div className="toolbar">
        <button className="primary" onClick={() => input.current?.click()}>Import from Excel…</button>
        <button onClick={() => void fittingTemplate().then((b) => download(b, 'fittings-template.xlsx'))}>Download template</button>
        <input ref={input} type="file" accept=".xlsx,.csv" hidden aria-label="Fitting file" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {result && (
        <div className={`banner ${result.kind}`}>
          {result.text}
          {result.problems.length > 0 && <ul>{result.problems.slice(0, 8).map((p) => <li key={p}>{p}</li>)}{result.problems.length > 8 && <li>and {result.problems.length - 8} more</li>}</ul>}
        </div>
      )}
      <div className="toolbar">
        <input className="find" value={filter} placeholder="Filter…" aria-label="Filter fittings" onChange={(e) => setFilter(e.target.value)} />
        <label>K for pipe <input type="number" min={5} value={size} onChange={(e) => setSize(Math.max(5, Number(e.target.value) || 100))} style={{ width: 70 }} aria-label="Pipe diameter for K" /> mm</label>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Category</th><th>Fitting</th><th>K</th><th>L/D</th><th>Source</th><th /></tr></thead>
          <tbody>
            {rows.map((f) => (
              <tr key={`${f.category}|${f.name}`}>
                <td>{f.category}</td>
                <td>{f.name}</td>
                <td>{fittingK(f, size).toFixed(3)}</td>
                <td>{f.ld === undefined ? '' : typeof f.ld === 'function' ? 'by size' : f.ld}</td>
                <td>{f.source}</td>
                <td>{f.custom && <button aria-label={`Remove ${f.name}`} onClick={() => removeFitting(f)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
