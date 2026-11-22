import { useEffect, useMemo, useRef, useState } from 'react';
import { pumpHead, fitPump } from '../solver';
import { SCREEN_THEME, pumpChartSvg, CHART_H, CHART_W } from '../curveChart';
import type { PumpCurveEntry, PumpUI } from '../model';
import { checkCurve, curveFromRows, genericCurve, newCurve, parseCurveText, pumpsUsing, rowsFromCurve, summarize, type CurveRow } from '../pumpCurves';
import { unitFactor, useUnits, type Quantity } from '../units';

interface Props {
  curves: PumpCurveEntry[];
  pumps: PumpUI[];
  /** The pump selected on the canvas, if any: offers a one-click "use this curve". */
  selectedPump?: PumpUI;
  /** Curve to show (e.g. the one a pump just used). */
  focusId?: string;
  onChange: (next: PumpCurveEntry[], changedId?: string) => void;
  onUse: (pumpUid: string, curveId: string) => void;
}

type Local = { q?: number; h?: number; eta?: number; npshr?: number };

/** A number cell shown in the current unit system; blank means "no value". */
function Cell({ q, value, onChange, label }: { q?: Quantity; value?: number; onChange: (v: number | undefined) => void; label: string }) {
  const U = useUnits();
  const show = (v: number | undefined) => (v === undefined ? '' : String(+(q ? U.to(q, v) : v).toPrecision(6)));
  const [text, setText] = useState(() => show(value));
  useEffect(() => {
    const n = parseFloat(text);
    const cur = Number.isFinite(n) ? (q ? U.from(q, n) : n) : undefined;
    const same = cur === value || (cur !== undefined && value !== undefined && Math.abs(cur - value) <= 1e-9 * Math.max(1, Math.abs(value)));
    if (!same) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, U.system]);
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseFloat(e.target.value.replace(',', '.'));
        onChange(Number.isFinite(n) ? (q ? U.from(q, n) : n) : undefined);
      }}
    />
  );
}

export function PumpCurvesPanel({ curves, pumps, selectedPump, focusId, onChange, onUse }: Props) {
  const U = useUnits();
  const [selId, setSelId] = useState<string | undefined>(curves[0]?.id);
  const [mode, setMode] = useState<'none' | 'generate' | 'paste'>('none');
  const [rev, setRev] = useState(0);
  const [gen, setGen] = useState({ q: 10, h: 30, eta: '' });
  const [paste, setPaste] = useState('');
  const [pasteMsg, setPasteMsg] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusId && curves.some((c) => c.id === focusId)) setSelId(focusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);
  const sel = curves.find((c) => c.id === selId) ?? curves[0];

  const update = (c: PumpCurveEntry) => onChange(curves.map((x) => (x.id === c.id ? c : x)), c.id);
  const add = (c: PumpCurveEntry) => {
    onChange([...curves, c]);
    setSelId(c.id);
    setMode('none');
    setRev((r) => r + 1);
  };

  const toCanon = (rows: CurveRow[]): CurveRow[] => rows.map((r) => ({ q: U.from('flow', r.q), h: r.h === undefined ? undefined : U.from('head', r.h), eta: r.eta, npshr: r.npshr === undefined ? undefined : U.from('head', r.npshr) }));
  const nextName = () => `Pump curve ${curves.length + 1}`;

  /** Pasted or imported text: into the selected curve (replace or append) or as a new curve. */
  const applyPasted = (text: string, how: 'replace' | 'append' | 'new') => {
    const parsed = parseCurveText(text);
    setPasteMsg(parsed.warnings);
    if (!parsed.rows.length) return;
    const rows = toCanon(parsed.rows);
    if (sel && how !== 'new') {
      const base = how === 'append' ? rowsFromCurve(sel) : [];
      update({ ...sel, ...curveFromRows([...base, ...rows].sort((a, b) => a.q - b.q)) });
      setRev((r) => r + 1);
      setMode('none');
    } else add(newCurve(nextName(), curveFromRows(rows)));
    setPaste('');
  };

  return (
    <div className="pc">
      <div className="pc-list">
        <h4>Pump curves</h4>
        {curves.length === 0 && <p className="hint">No curves.</p>}
        <ul>
          {curves.map((c) => (
            <li key={c.id} className={c.id === sel?.id ? 'active' : ''}>
              <button onClick={() => { setSelId(c.id); setRev((r) => r + 1); }}>
                <b>{c.name}</b>
                <small>{pumpsUsing(pumps, c.id).length ? `used by ${pumpsUsing(pumps, c.id).length} pump(s)` : 'not used'}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="pc-add">
          <button className="primary" onClick={() => add(newCurve(nextName()))}>+ New curve</button>
          <button onClick={() => { setMode(mode === 'paste' ? 'none' : 'paste'); setPasteMsg([]); }} className={mode === 'paste' ? 'active' : ''}>Paste from a table…</button>
          <button onClick={() => fileRef.current?.click()}>Open CSV…</button>
          <button onClick={() => setMode(mode === 'generate' ? 'none' : 'generate')} className={mode === 'generate' ? 'active' : ''}>Generic curve…</button>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setMode('none'); applyPasted(await f.text(), 'new'); } }} />
        </div>
      </div>

      <div className="pc-main">
        {mode === 'generate' && (
          <div className="pc-box">
            <h4>Generic curve from a best-efficiency point</h4>
            <div className="grid">
              <label className="field"><span>Best-efficiency flow <em>[{U.u('flow')}]</em></span><Cell q="flow" label="BEP flow" value={gen.q} onChange={(v) => v !== undefined && setGen((g) => ({ ...g, q: v }))} /></label>
              <label className="field"><span>Head at that flow <em>[{U.u('head')}]</em></span><Cell q="head" label="BEP head" value={gen.h} onChange={(v) => v !== undefined && setGen((g) => ({ ...g, h: v }))} /></label>
              <label className="field"><span>Peak efficiency <em>[%]</em> (optional)</span><input value={gen.eta} placeholder="auto" onChange={(e) => setGen((g) => ({ ...g, eta: e.target.value }))} /></label>
            </div>
            <div className="toolbar">
              <button className="primary" disabled={!(gen.q > 0 && gen.h > 0)} onClick={() => add(genericCurve(`Generic ${U.f('flow', gen.q, 1)} ${U.u('flow')} @ ${U.f('head', gen.h, 1)} ${U.u('head')}`, gen.q, gen.h, Number(gen.eta) > 0 ? Number(gen.eta) : undefined))}>Create curve</button>
              <button onClick={() => setMode('none')}>Cancel</button>
            </div>
          </div>
        )}

        {mode === 'paste' && (
          <div className="pc-box">
            <h4>{sel ? `Paste points into “${sel.name}”, or make a new curve` : 'Paste points into a new curve'}</h4>
            <p className="hint">Columns: flow, head, efficiency % (optional), NPSHr (optional).</p>
            <textarea rows={7} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'Flow\tHead\tEff\tNPSHr\n0\t50\t\t\n10\t46\t60\t1.5\n20\t38\t72\t2.5\n30\t26\t68\t4'} spellCheck={false} />
            {pasteMsg.map((m, i) => <div key={i} className="banner warn">{m}</div>)}
            <div className="toolbar">
              {sel ? (
                <>
                  <button className="primary" disabled={!paste.trim()} onClick={() => applyPasted(paste, 'replace')}>Replace this curve’s points</button>
                  <button disabled={!paste.trim()} onClick={() => applyPasted(paste, 'append')}>Add to this curve</button>
                  <button disabled={!paste.trim()} onClick={() => applyPasted(paste, 'new')}>Make a new curve</button>
                </>
              ) : (
                <button className="primary" disabled={!paste.trim()} onClick={() => applyPasted(paste, 'new')}>Create curve</button>
              )}
              <button onClick={() => { setMode('none'); setPasteMsg([]); }}>Cancel</button>
            </div>
          </div>
        )}

        {sel ? (
          <CurveEditor
            key={`${sel.id}:${rev}`}
            curve={sel}
            pumps={pumps}
            selectedPump={selectedPump}
            onChange={update}
            onUse={onUse}
            onDuplicate={() => add({ ...sel, id: newCurve('').id, name: `${sel.name} (copy)`, head: sel.head.map((p) => ({ ...p })), efficiency: sel.efficiency.map((p) => ({ ...p })), npshr: sel.npshr.map((p) => ({ ...p })) })}
            onDelete={() => {
              const n = pumpsUsing(pumps, sel.id).length;
              if (n && !window.confirm(`${n} pump(s) use “${sel.name}”. They keep their own copy of the points. Delete the curve from the library?`)) return;
              const rest = curves.filter((c) => c.id !== sel.id);
              onChange(rest, sel.id);
              setSelId(rest[0]?.id);
              setRev((r) => r + 1);
            }}
          />
        ) : (
          mode === 'none' && <div className="pc-box" />
        )}
      </div>
    </div>
  );
}

interface EditorProps {
  curve: PumpCurveEntry;
  pumps: PumpUI[];
  selectedPump?: PumpUI;
  onChange: (c: PumpCurveEntry) => void;
  onUse: (pumpUid: string, curveId: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function CurveEditor({ curve, pumps, selectedPump, onChange, onUse, onDuplicate, onDelete }: EditorProps) {
  const U = useUnits();
  const [rows, setRows] = useState<Local[]>(() => {
    const r = rowsFromCurve(curve);
    return r.length ? r : [{}, {}, {}, {}];
  });

  const commit = (next: Local[]) => {
    setRows(next);
    onChange({ ...curve, ...curveFromRows(next.filter((r) => r.q !== undefined) as CurveRow[]) });
  };
  const edit = (i: number, patch: Local) => commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const check = checkCurve(curve);
  const sum = summarize(curve);
  const used = pumpsUsing(pumps, curve.id);

  const chart = useMemo(() => {
    if (checkCurve(curve).errors.length) return undefined;
    const model = fitPump({ head: curve.head.map((p) => ({ flowM3s: p.q / 1000, headM: p.h })) });
    const qMax = Math.max(...curve.head.map((p) => p.q), 1e-3) * 1.05;
    const pts = Array.from({ length: 61 }, (_, i) => {
      const q = (qMax * i) / 60;
      return { q, h: Math.max(0, pumpHead(model, q / 1000, 1)) };
    });
    const axes = { flowLabel: U.u('flow'), headLabel: U.u('head'), flowFactor: unitFactor('flow', U.system), headFactor: unitFactor('head', U.system) };
    return pumpChartSvg([{ name: curve.name, pts }], SCREEN_THEME, axes);
  }, [curve, U.system]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pc-box pc-editor">
      <div className="pc-head">
        <label className="field grow"><span>Name</span><input value={curve.name} onChange={(e) => onChange({ ...curve, name: e.target.value })} /></label>
        <label className="field"><span>Rated speed <em>[rpm]</em></span><Cell label="Rated speed" value={curve.ratedRpm} onChange={(v) => v !== undefined && v > 0 && onChange({ ...curve, ratedRpm: v })} /></label>
      </div>
      <div className="toolbar">
        {selectedPump && (
          <button className="primary" disabled={selectedPump.curveId === curve.id} onClick={() => onUse(selectedPump.uid, curve.id)}>
            {selectedPump.curveId === curve.id ? `✓ In use on ${selectedPump.name}` : `Use for ${selectedPump.name}`}
          </button>
        )}
        <button onClick={onDuplicate}>Duplicate</button>
        <button onClick={onDelete}>Delete</button>
        <span className="hint">{used.length ? `Used by: ${used.map((p) => p.name).join(', ')}.` : 'Not used by any pump yet.'}</span>
      </div>

      <div className="table-wrap">
        <table className="pc-table">
          <thead>
            <tr><th>Flow [{U.u('flow')}]</th><th>Head [{U.u('head')}]</th><th>Efficiency [%]</th><th>NPSHr [{U.u('head')}]</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><Cell q="flow" label={`Flow ${i + 1}`} value={r.q} onChange={(v) => edit(i, { q: v })} /></td>
                <td><Cell q="head" label={`Head ${i + 1}`} value={r.h} onChange={(v) => edit(i, { h: v })} /></td>
                <td><Cell label={`Efficiency ${i + 1}`} value={r.eta} onChange={(v) => edit(i, { eta: v })} /></td>
                <td><Cell q="head" label={`NPSHr ${i + 1}`} value={r.npshr} onChange={(v) => edit(i, { npshr: v })} /></td>
                <td><button aria-label={`Remove row ${i + 1}`} onClick={() => commit(rows.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="toolbar">
        <button onClick={() => setRows((r) => [...r, {}])}>+ Add row</button>
        <button onClick={() => commit([...rows].sort((a, b) => (a.q ?? Infinity) - (b.q ?? Infinity)))}>Sort by flow</button>
      </div>

      {check.errors.map((m, i) => <div key={i} className="banner error">{m}</div>)}
      {check.warnings.map((m, i) => <div key={i} className="banner warn">{m}</div>)}
      {chart && (
        <>
          <div className="chart pc-chart" style={{ aspectRatio: `${CHART_W} / ${CHART_H}` }} dangerouslySetInnerHTML={{ __html: chart }} />
          <p className="hint">
            Shutoff head {U.fu('head', sum.shutoffHeadM, 1)} · end of curve {U.fu('flow', sum.maxFlowLps, 1)}
            {sum.bepFlowLps !== undefined && <> · best efficiency {U.f('flow', sum.bepFlowLps, 1)} {U.u('flow')} at {sum.peakEfficiencyPct?.toFixed(0)} %</>}
            {sum.fitRmseM !== undefined && <> · fit error {U.fu('head', sum.fitRmseM, 2)}</>}
          </p>
        </>
      )}
      {curve.note && <p className="hint">{curve.note}</p>}
    </div>
  );
}
