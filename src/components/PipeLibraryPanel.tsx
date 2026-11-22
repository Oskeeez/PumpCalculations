import { useRef, useState } from 'react';
import { addSeries, parsePipeSheet, pipeTemplate, readSheetFile, removeSeries, setStandardSeries, usePipeLibrary } from '../pipeLibrary';
import { download } from '../download';
import { useUnits } from '../units';

/** The pipe size lists. Company lists come from an Excel or CSV file. */
export function PipeLibraryPanel() {
  const U = useUnits();
  const lib = usePipeLibrary();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string; problems: string[] }>();
  const [open, setOpen] = useState<string>();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parsePipeSheet(await readSheetFile(file));
      if (parsed.series.length) addSeries(parsed.series);
      const count = parsed.series.reduce((n, s) => n + s.sizes.length, 0);
      setResult({
        kind: parsed.series.length ? (parsed.problems.length ? 'warn' : 'ok') : 'error',
        text: parsed.series.length ? `Imported ${count} sizes in ${parsed.series.length} list${parsed.series.length === 1 ? '' : 's'}.` : 'Nothing imported.',
        problems: parsed.problems,
      });
    } catch (err) {
      setResult({ kind: 'error', text: `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`, problems: [] });
    }
  };

  return (
    <div className="pipelib">
      <div className="toolbar">
        <button className="primary" onClick={() => input.current?.click()}>Import from Excel…</button>
        <button onClick={() => void pipeTemplate().then((b) => download(b, 'pipe-sizes-template.xlsx'))}>Download template</button>
        <input ref={input} type="file" accept=".xlsx,.csv" hidden aria-label="Pipe size file" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {result && (
        <div className={`banner ${result.kind}`}>
          {result.text}
          {result.problems.length > 0 && <ul>{result.problems.slice(0, 8).map((p) => <li key={p}>{p}</li>)}{result.problems.length > 8 && <li>and {result.problems.length - 8} more</li>}</ul>}
        </div>
      )}
      <label className="field">
        <span>Standard list (used for sizing)</span>
        <select aria-label="Standard pipe list" value={lib.standard} onChange={(e) => setStandardSeries(e.target.value)}>
          {lib.all.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <div className="table-wrap">
        <table>
          <thead><tr><th>List</th><th>Sizes</th><th /></tr></thead>
          <tbody>
            {lib.all.map((s) => (
              <>
                <tr key={s.id}>
                  <td><button className="link" onClick={() => setOpen(open === s.id ? undefined : s.id)}>{s.label}</button>{s.custom ? '' : ' (built in)'}</td>
                  <td>{s.sizes.length}</td>
                  <td>{s.custom && <button aria-label={`Remove ${s.label}`} onClick={() => removeSeries(s.id)}>Remove</button>}</td>
                </tr>
                {open === s.id && (
                  <tr key={`${s.id}-sizes`}>
                    <td colSpan={3}>
                      <table className="pts">
                        <thead><tr><th>Size</th><th>Inside diameter [{U.u('diameter')}]</th>{s.sizes.some((z) => z.roughnessMm !== undefined) && <th>Roughness [{U.u('roughness')}]</th>}{s.sizes.some((z) => z.ratingKPaG !== undefined) && <th>Rating [kPa]</th>}</tr></thead>
                        <tbody>
                          {s.sizes.map((z) => (
                            <tr key={z.nps}>
                              <td>{z.nps}</td>
                              <td>{U.f('diameter', z.idMm, 2)}</td>
                              {s.sizes.some((q) => q.roughnessMm !== undefined) && <td>{z.roughnessMm !== undefined ? U.f('roughness', z.roughnessMm, 4) : ''}</td>}
                              {s.sizes.some((q) => q.ratingKPaG !== undefined) && <td>{z.ratingKPaG ?? ''}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
