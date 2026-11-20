import { Fragment, useState } from 'react';
import type { CompareQty, Comparison } from '../analysis';
import type { Scenario } from '../model';
import { useUnits, type Quantity } from '../units';

interface Props {
  scenarios: Scenario[];
  comparison: Comparison;
  onSave: (name: string) => void;
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

const QTY: Partial<Record<CompareQty, Quantity>> = { flow: 'flow', head: 'head', pressure: 'pressure', power: 'power', velocity: 'velocity' };

/** Save the current network as a named scenario and compare scenarios side by side (first column = current). */
export function ScenarioPanel({ scenarios, comparison, onSave, onLoad, onDelete, onRename }: Props) {
  const U = useUnits();
  const [name, setName] = useState('');
  const fmt = (qty: CompareQty, v: number | string | undefined): string => {
    if (v === undefined) return '–';
    if (typeof v === 'string') return v;
    const q = QTY[qty];
    if (q) return U.f(q, v, qty === 'velocity' ? 3 : 2);
    return qty === 'count' ? String(v) : v.toFixed(2);
  };
  const delta = (qty: CompareQty, base: number | string | undefined, v: number | string | undefined): string => {
    if (typeof base !== 'number' || typeof v !== 'number' || qty === 'count') return '';
    const d = v - base;
    if (Math.abs(d) < 1e-9 * Math.max(1, Math.abs(base))) return '';
    const q = QTY[qty];
    const shown = q ? U.to(q, v) - U.to(q, base) : d;
    return `${shown > 0 ? '+' : '−'}${Math.abs(shown).toFixed(2)}`;
  };
  return (
    <div>
      <div className="scn-add">
        <input value={name} placeholder="Scenario name, e.g. 80 % speed, valve throttled" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (onSave(name), setName(''))} />
        <button className="primary" onClick={() => { onSave(name); setName(''); }}>Save current network as scenario</button>
      </div>
      <p className="hint">
        A scenario is a snapshot of the whole network (fluid, pipes, valves, pump speeds, demands…). Change the network, save another, and compare. Loading a scenario replaces the current network (Undo brings it back). Scenarios are saved in the project file.
      </p>
      {scenarios.length > 0 && (
        <ul className="scn-list">
          {scenarios.map((s) => (
            <li key={s.id}>
              <input value={s.name} aria-label="Scenario name" onChange={(e) => onRename(s.id, e.target.value)} />
              <button onClick={() => onLoad(s.id)}>Load</button>
              <button onClick={() => onDelete(s.id)} aria-label={`Delete ${s.name}`}>Delete</button>
            </li>
          ))}
        </ul>
      )}
      {scenarios.length === 0 ? (
        <p className="hint">No saved scenarios yet.</p>
      ) : (
        <>
          {comparison.errors.map((e, i) => (e ? <div key={i} className="banner error">{comparison.columns[i]}: {e}</div> : null))}
          <div className="table-wrap">
            <table className="cmp">
              <thead>
                <tr>
                  <th />
                  {comparison.columns.map((c, i) => <th key={i}>{c}{i === 0 ? ' (now)' : ''}</th>)}
                </tr>
              </thead>
              <tbody>
                {comparison.sections.map((sec) => (
                  <Fragment key={sec.title}>
                    <tr className="sec"><td colSpan={comparison.columns.length + 1}>{sec.title}</td></tr>
                    {sec.rows.map((row) => (
                      <tr key={`${sec.title}:${row.label}`}>
                        <td>{row.label}{QTY[row.qty] ? <small> [{U.u(QTY[row.qty] as Quantity)}]</small> : null}</td>
                        {row.values.map((v, i) => (
                          <td key={i}>
                            {fmt(row.qty, v)}
                            {i > 0 && delta(row.qty, row.values[0], v) ? <small className="delta"> ({delta(row.qty, row.values[0], v)})</small> : null}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">Differences in brackets are relative to the current network (first column).</p>
        </>
      )}
    </div>
  );
}
