import { FITTINGS, MATERIALS, SCH40, matchMaterial, matchSize } from '../library';
import type { FittingUI, NodeUI, PipeUI, PumpUI, ValveControlType, ValveLossType, ValveUI } from '../model';
import { useUnits, type Quantity } from '../units';
import { NumField } from './NumField';

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>Name</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function NodeEditor({ node, onChange }: { node: NodeUI; onChange: (n: NodeUI) => void }) {
  const isTank = node.kind === 'tank';
  return (
    <section className="editor">
      <h3>{isTank ? 'Tank' : 'Junction'}</h3>
      <NameField value={node.name} onChange={(name) => onChange({ ...node, name })} />
      <div className="grid">
        <NumField label={isTank ? 'Base height (z)' : 'Height (z)'} q="elevation" value={node.elevationM} onChange={(v) => onChange({ ...node, elevationM: v })} />
        {isTank ? (
          <>
            <NumField label="Fluid height" q="length" value={node.levelM} onChange={(v) => onChange({ ...node, levelM: v })} />
            <NumField label="Pressure above liquid (abs)" q="pressure" value={node.pressureKPa} onChange={(v) => onChange({ ...node, pressureKPa: v })} />
          </>
        ) : (
          <NumField label="Demand (withdrawal)" q="flow" value={node.demandLps} onChange={(v) => onChange({ ...node, demandLps: v })} />
        )}
      </div>
    </section>
  );
}

function Ends({ from, to, onSwap }: { from: string; to: string; onSwap: () => void }) {
  return (
    <p className="ends">
      <b>{from}</b> → <b>{to}</b>
      <button onClick={onSwap} title="Reverse the positive flow direction">⇄ Swap direction</button>
    </p>
  );
}

/** Prominent flow-direction control for a pump or a directional valve. */
function Direction({ inLabel, outLabel, from, to, onSwap, note }: { inLabel: string; outLabel: string; from: string; to: string; onSwap: () => void; note?: string }) {
  return (
    <div className="direction">
      <div className="dir-row">
        <div className="dir-end"><small>{inLabel}</small><b>{from}</b></div>
        <div className="dir-arrow" aria-hidden="true">━━▶</div>
        <div className="dir-end"><small>{outLabel}</small><b>{to}</b></div>
      </div>
      <button className="primary" onClick={onSwap} title="Swap the two ends so the flow runs the other way">⇄ Reverse direction</button>
      {note && <small className="hint">{note}</small>}
    </div>
  );
}

export function PipeEditor({ pipe, from, to, canvasLengthM, onChange }: { pipe: PipeUI; from: string; to: string; canvasLengthM: number; onChange: (p: PipeUI) => void }) {
  const U = useUnits();
  const setFit = (i: number, f: FittingUI) => onChange({ ...pipe, fittings: pipe.fittings.map((x, j) => (j === i ? f : x)) });
  const total = pipe.fittings.reduce((s, f) => s + f.k, 0);
  return (
    <section className="editor">
      <h3>Pipe</h3>
      <NameField value={pipe.name} onChange={(name) => onChange({ ...pipe, name })} />
      <Ends from={from} to={to} onSwap={() => onChange({ ...pipe, from: pipe.to, to: pipe.from })} />
      <div className="grid">
        {pipe.lengthMode === 'canvas' ? (
          <label className="field">
            <span>Length <em>[{U.u('length')}]</em></span>
            <input value={U.f('length', canvasLengthM, 2)} readOnly aria-label="Length from canvas" />
          </label>
        ) : (
          <NumField label="Length" q="length" value={pipe.lengthM} onChange={(v) => onChange({ ...pipe, lengthM: v })} />
        )}
        <NumField label="Inner diameter" q="diameter" value={pipe.diameterMm} onChange={(v) => onChange({ ...pipe, diameterMm: v })} />
        <NumField label="Roughness ε" q="roughness" value={pipe.roughnessMm} onChange={(v) => onChange({ ...pipe, roughnessMm: v })} />
      </div>
      <div className="checks">
        <label>
          <input
            type="checkbox"
            checked={pipe.lengthMode === 'canvas'}
            onChange={(e) => onChange(e.target.checked ? { ...pipe, lengthMode: 'canvas' } : { ...pipe, lengthMode: 'manual', lengthM: canvasLengthM })}
          />{' '}
          Length from canvas distance
        </label>
      </div>
      <div className="grid">
        <label className="field">
          <span>Material</span>
          <select value={matchMaterial(pipe.roughnessMm) ?? ''} onChange={(e) => { const m = MATERIALS.find((x) => x.name === e.target.value); if (m) onChange({ ...pipe, roughnessMm: m.roughnessMm }); }}>
            <option value="">Custom</option>
            {MATERIALS.map((m) => <option key={m.name} value={m.name}>{m.name} ({U.f('roughness', m.roughnessMm, 4)} {U.u('roughness')})</option>)}
          </select>
        </label>
        <label className="field">
          <span>Nominal size (Sch 40 steel)</span>
          <select value={matchSize(pipe.diameterMm) ?? ''} onChange={(e) => { const s = SCH40.find((x) => x.nps === e.target.value); if (s) onChange({ ...pipe, diameterMm: s.idMm }); }}>
            <option value="">Custom</option>
            {SCH40.map((s) => <option key={s.nps} value={s.nps}>{s.nps} ({U.f('diameter', s.idMm, 2)} {U.u('diameter')} ID)</option>)}
          </select>
        </label>
      </div>
      <h4>Fittings (K values), total K = {total.toFixed(2)}</h4>
      <table className="pts">
        <thead>
          <tr><th>Fitting</th><th>K</th><th /></tr>
        </thead>
        <tbody>
          {pipe.fittings.map((f, i) => (
            <tr key={i}>
              <td><input value={f.name} onChange={(e) => setFit(i, { ...f, name: e.target.value })} /></td>
              <td><NumField value={f.k} onChange={(v) => setFit(i, { ...f, k: v })} /></td>
              <td><button className="icon" aria-label="Remove fitting" onClick={() => onChange({ ...pipe, fittings: pipe.fittings.filter((_, j) => j !== i) })}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="field">
        <span>Add standard fitting</span>
        <select
          value=""
          onChange={(e) => {
            const p = FITTINGS.find((x) => x.name === e.target.value);
            if (p) onChange({ ...pipe, fittings: [...pipe.fittings, { name: p.name, k: p.k }] });
          }}
        >
          <option value="">Choose…</option>
          {FITTINGS.map((p) => <option key={p.name} value={p.name}>{p.name} (K {p.k})</option>)}
        </select>
      </label>
      <button onClick={() => onChange({ ...pipe, fittings: [...pipe.fittings, { name: 'Fitting', k: 0.5 }] })}>+ Add custom fitting</button>
    </section>
  );
}

export function ValveEditor({ valve, from, to, onChange }: { valve: ValveUI; from: string; to: string; onChange: (v: ValveUI) => void }) {
  const unit = valve.lossType === 'orifice' ? '' : valve.lossType === 'K' ? '–' : valve.lossType === 'Cv' ? 'gpm @ 1 psi' : 'm³/h @ 1 bar';
  const controlQ: Quantity = valve.controlType === 'fcv' ? 'flow' : 'pressure';
  return (
    <section className="editor">
      <h3>Valve</h3>
      <NameField value={valve.name} onChange={(name) => onChange({ ...valve, name })} />
      {valve.checkValve || valve.controlType !== 'none' ? (
        <Direction inLabel="IN" outLabel="OUT" from={from} to={to} onSwap={() => onChange({ ...valve, from: valve.to, to: valve.from })} note="Check valves and regulators only pass flow from IN to OUT." />
      ) : (
        <Ends from={from} to={to} onSwap={() => onChange({ ...valve, from: valve.to, to: valve.from })} />
      )}
      <div className="grid">
        <label className="field">
          <span>Function</span>
          <select value={valve.controlType} onChange={(e) => onChange({ ...valve, controlType: e.target.value as ValveControlType })}>
            <option value="none">None</option>
            <option value="prv">Pressure-reducing (PRV)</option>
            <option value="psv">Pressure-sustaining (PSV)</option>
            <option value="fcv">Flow-control (FCV)</option>
          </select>
        </label>
        {valve.controlType !== 'none' && (
          <NumField
            label={valve.controlType === 'fcv' ? 'Set flow' : valve.controlType === 'prv' ? 'Set pressure, downstream (gauge)' : 'Set pressure, upstream (gauge)'}
            q={controlQ}
            value={valve.controlValue}
            onChange={(v) => onChange({ ...valve, controlValue: v })}
          />
        )}
      </div>
      <h4>{valve.controlType === 'none' ? 'Loss' : 'Loss (fully open)'}</h4>
      <div className="grid">
        <NumField label="Diameter" q="diameter" value={valve.diameterMm} onChange={(v) => onChange({ ...valve, diameterMm: v })} />
        <label className="field">
          <span>Loss by</span>
          <select value={valve.lossType} onChange={(e) => onChange({ ...valve, lossType: e.target.value as ValveLossType })}>
            <option value="K">Loss coefficient K</option>
            <option value="Cv">Cv (US)</option>
            <option value="Kv">Kv (metric)</option>
            <option value="orifice">Orifice plate (bore)</option>
          </select>
        </label>
        {valve.lossType === 'orifice' ? (
          <>
            <NumField label="Bore diameter" q="diameter" value={valve.lossValue} onChange={(v) => onChange({ ...valve, lossValue: v })} />
            <NumField label="Discharge coeff. Cd" unit="–" value={valve.orificeCd ?? 0.61} onChange={(v) => onChange({ ...valve, orificeCd: v })} title="0.61 is typical for a sharp-edged plate at high Reynolds number" />
          </>
        ) : (
          <NumField label={valve.lossType} unit={unit} value={valve.lossValue} onChange={(v) => onChange({ ...valve, lossValue: v })} />
        )}
      </div>
      <div className="checks">
        <label><input type="checkbox" checked={valve.open} onChange={(e) => onChange({ ...valve, open: e.target.checked })} /> Open</label>
        {valve.controlType === 'none' && (
          <label><input type="checkbox" checked={valve.checkValve} onChange={(e) => onChange({ ...valve, checkValve: e.target.checked })} /> Check valve (blocks reverse flow)</label>
        )}
      </div>
    </section>
  );
}

interface PointsProps<T> {
  title: string;
  cols: [string, string];
  /** Quantities of the two columns when they have units (values are stored canonical). */
  qty: [Quantity | undefined, Quantity | undefined];
  rows: T[];
  get: (r: T) => [number, number];
  make: (a: number, b: number) => T;
  onChange: (rows: T[]) => void;
}

function Points<T>({ title, cols, qty, rows, get, make, onChange }: PointsProps<T>) {
  const U = useUnits();
  const head = (c: string, q: Quantity | undefined) => (q ? `${c} [${U.u(q)}]` : c);
  return (
    <div>
      <h4>{title}</h4>
      <table className="pts">
        <thead>
          <tr><th>{head(cols[0], qty[0])}</th><th>{head(cols[1], qty[1])}</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const [a, b] = get(r);
            return (
              <tr key={i}>
                <td><NumField q={qty[0]} value={a} onChange={(v) => onChange(rows.map((x, j) => (j === i ? make(v, b) : x)))} /></td>
                <td><NumField q={qty[1]} value={b} onChange={(v) => onChange(rows.map((x, j) => (j === i ? make(a, v) : x)))} /></td>
                <td><button className="icon" aria-label="Remove point" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button
        onClick={() => {
          const last = rows.length ? get(rows[rows.length - 1]) : [0, 0];
          onChange([...rows, make(last[0] + 5, last[1])]);
        }}
      >
        + Add point
      </button>
    </div>
  );
}

export function PumpEditor({ pump, from, to, onChange, headFitRmse }: { pump: PumpUI; from: string; to: string; onChange: (p: PumpUI) => void; headFitRmse?: number }) {
  const U = useUnits();
  return (
    <section className="editor">
      <h3>Pump</h3>
      <NameField value={pump.name} onChange={(name) => onChange({ ...pump, name })} />
      <Direction inLabel="SUCTION (in)" outLabel="DISCHARGE (out)" from={from} to={to} onSwap={() => onChange({ ...pump, from: pump.to, to: pump.from })} note="A pump only pushes flow from suction to discharge; flow cannot run backwards through it." />
      <div className="grid">
        <NumField label="Speed ratio N/N_rated" value={pump.speedRatio} onChange={(v) => onChange({ ...pump, speedRatio: v })} />
        <NumField label="Rated speed" unit="rpm" value={pump.ratedRpm} onChange={(v) => onChange({ ...pump, ratedRpm: v })} />
      </div>
      <p className="hint">Head fit RMS error: {headFitRmse !== undefined ? U.fu('head', headFitRmse, 3) : '–'}</p>
      <div className="three">
        <Points title="Head curve" cols={['Q', 'H']} qty={['flow', 'head']} rows={pump.head} get={(r) => [r.q, r.h]} make={(q, h) => ({ q, h })} onChange={(head) => onChange({ ...pump, head })} />
        <Points title="Efficiency (optional)" cols={['Q', 'η [%]']} qty={['flow', undefined]} rows={pump.efficiency} get={(r) => [r.q, r.eta]} make={(q, eta) => ({ q, eta })} onChange={(efficiency) => onChange({ ...pump, efficiency })} />
        <Points title="NPSH required (optional)" cols={['Q', 'NPSHr']} qty={['flow', 'head']} rows={pump.npshr} get={(r) => [r.q, r.h]} make={(q, h) => ({ q, h })} onChange={(npshr) => onChange({ ...pump, npshr })} />
      </div>
    </section>
  );
}
