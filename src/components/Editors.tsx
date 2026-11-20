import { FITTINGS, MATERIALS, SCH40, matchMaterial, matchSize } from '../library';
import type { FittingUI, NodeUI, PipeUI, PumpUI, ValveLossType, ValveUI } from '../model';
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
      <h3>{isTank ? 'Tank (fixed-head boundary)' : 'Junction'}</h3>
      <NameField value={node.name} onChange={(name) => onChange({ ...node, name })} />
      <div className="grid">
        <NumField label={isTank ? 'Bottom elevation' : 'Elevation'} unit="m" value={node.elevationM} onChange={(v) => onChange({ ...node, elevationM: v })} />
        {isTank ? (
          <>
            <NumField label="Liquid level" unit="m" value={node.levelM} onChange={(v) => onChange({ ...node, levelM: v })} />
            <NumField label="Pressure above liquid (abs)" unit="kPa" value={node.pressureKPa} onChange={(v) => onChange({ ...node, pressureKPa: v })} title="101.325 kPa = atmospheric" />
          </>
        ) : (
          <NumField label="Demand (withdrawal)" unit="L/s" value={node.demandLps} onChange={(v) => onChange({ ...node, demandLps: v })} title="Negative = flow injected into the network" />
        )}
      </div>
      <p className="hint">
        {isTank
          ? 'Liquid surface elevation = bottom elevation + level. Tanks hold the head fixed and supply or absorb whatever flow the network needs. Default pressure is atmospheric.'
          : 'Demand is a fixed outflow at this node (negative injects flow). Pipe elevation changes come from the node elevations.'}
      </p>
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

export function PipeEditor({ pipe, from, to, onChange }: { pipe: PipeUI; from: string; to: string; onChange: (p: PipeUI) => void }) {
  const setFit = (i: number, f: FittingUI) => onChange({ ...pipe, fittings: pipe.fittings.map((x, j) => (j === i ? f : x)) });
  const total = pipe.fittings.reduce((s, f) => s + f.k, 0);
  return (
    <section className="editor">
      <h3>Pipe</h3>
      <NameField value={pipe.name} onChange={(name) => onChange({ ...pipe, name })} />
      <Ends from={from} to={to} onSwap={() => onChange({ ...pipe, from: pipe.to, to: pipe.from })} />
      <div className="grid">
        <NumField label="Length" unit="m" value={pipe.lengthM} onChange={(v) => onChange({ ...pipe, lengthM: v })} />
        <NumField label="Inner diameter" unit="mm" value={pipe.diameterMm} onChange={(v) => onChange({ ...pipe, diameterMm: v })} />
        <NumField label="Roughness ε" unit="mm" value={pipe.roughnessMm} onChange={(v) => onChange({ ...pipe, roughnessMm: v })} />
      </div>
      <div className="grid">
        <label className="field">
          <span>Material (sets roughness)</span>
          <select value={matchMaterial(pipe.roughnessMm) ?? ''} onChange={(e) => { const m = MATERIALS.find((x) => x.name === e.target.value); if (m) onChange({ ...pipe, roughnessMm: m.roughnessMm }); }}>
            <option value="">Custom</option>
            {MATERIALS.map((m) => <option key={m.name} value={m.name}>{m.name} ({m.roughnessMm} mm)</option>)}
          </select>
        </label>
        <label className="field">
          <span>Nominal size, Sch 40 steel (sets diameter)</span>
          <select value={matchSize(pipe.diameterMm) ?? ''} onChange={(e) => { const s = SCH40.find((x) => x.nps === e.target.value); if (s) onChange({ ...pipe, diameterMm: s.idMm }); }}>
            <option value="">Custom</option>
            {SCH40.map((s) => <option key={s.nps} value={s.nps}>{s.nps} ({s.idMm} mm ID)</option>)}
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
        <span>Add a standard fitting (typical K, verify for your design)</span>
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
  const unit = valve.lossType === 'K' ? '–' : valve.lossType === 'Cv' ? 'gpm @ 1 psi' : 'm³/h @ 1 bar';
  return (
    <section className="editor">
      <h3>Valve</h3>
      <NameField value={valve.name} onChange={(name) => onChange({ ...valve, name })} />
      <Ends from={from} to={to} onSwap={() => onChange({ ...valve, from: valve.to, to: valve.from })} />
      <div className="grid">
        <NumField label="Diameter" unit="mm" value={valve.diameterMm} onChange={(v) => onChange({ ...valve, diameterMm: v })} />
        <label className="field">
          <span>Loss specified by</span>
          <select value={valve.lossType} onChange={(e) => onChange({ ...valve, lossType: e.target.value as ValveLossType })}>
            <option value="K">Loss coefficient K</option>
            <option value="Cv">Cv (US)</option>
            <option value="Kv">Kv (metric)</option>
          </select>
        </label>
        <NumField label={valve.lossType} unit={unit} value={valve.lossValue} onChange={(v) => onChange({ ...valve, lossValue: v })} />
      </div>
      <div className="checks">
        <label><input type="checkbox" checked={valve.open} onChange={(e) => onChange({ ...valve, open: e.target.checked })} /> Open</label>
        <label><input type="checkbox" checked={valve.checkValve} onChange={(e) => onChange({ ...valve, checkValve: e.target.checked })} /> Check valve (blocks reverse flow)</label>
      </div>
      <p className="hint">Set Cv or Kv to the value at the valve position being modelled (smaller = more throttled). A closed valve is removed from the network.</p>
    </section>
  );
}

interface PointsProps<T> {
  title: string;
  cols: [string, string];
  rows: T[];
  get: (r: T) => [number, number];
  make: (a: number, b: number) => T;
  onChange: (rows: T[]) => void;
  note?: string;
}

function Points<T>({ title, cols, rows, get, make, onChange, note }: PointsProps<T>) {
  return (
    <div>
      <h4>{title}</h4>
      <table className="pts">
        <thead>
          <tr><th>{cols[0]}</th><th>{cols[1]}</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const [a, b] = get(r);
            return (
              <tr key={i}>
                <td><NumField value={a} onChange={(v) => onChange(rows.map((x, j) => (j === i ? make(v, b) : x)))} /></td>
                <td><NumField value={b} onChange={(v) => onChange(rows.map((x, j) => (j === i ? make(a, v) : x)))} /></td>
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
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

export function PumpEditor({ pump, from, to, onChange, headFitRmse }: { pump: PumpUI; from: string; to: string; onChange: (p: PumpUI) => void; headFitRmse?: number }) {
  return (
    <section className="editor">
      <h3>Pump</h3>
      <NameField value={pump.name} onChange={(name) => onChange({ ...pump, name })} />
      <Ends from={`${from} (suction)`} to={`${to} (discharge)`} onSwap={() => onChange({ ...pump, from: pump.to, to: pump.from })} />
      <div className="grid">
        <NumField label="Speed ratio N/N_rated" value={pump.speedRatio} onChange={(v) => onChange({ ...pump, speedRatio: v })} title="Affinity laws: Q ∝ N, H ∝ N², P ∝ N³" />
      </div>
      <p className="hint">
        Curves are entered at rated speed and fitted to H = a0 + a1·Q + a2·Q². Head fit RMS error: {headFitRmse !== undefined ? headFitRmse.toFixed(3) : '–'} m.
      </p>
      <div className="three">
        <Points title="Head curve" cols={['Q [L/s]', 'H [m]']} rows={pump.head} get={(r) => [r.q, r.h]} make={(q, h) => ({ q, h })} onChange={(head) => onChange({ ...pump, head })} note="At least 2 points; 3+ recommended." />
        <Points title="Efficiency (optional)" cols={['Q [L/s]', 'η [%]']} rows={pump.efficiency} get={(r) => [r.q, r.eta]} make={(q, eta) => ({ q, eta })} onChange={(efficiency) => onChange({ ...pump, efficiency })} note="Needed for shaft power." />
        <Points title="NPSH required (optional)" cols={['Q [L/s]', 'NPSHr [m]']} rows={pump.npshr} get={(r) => [r.q, r.h]} make={(q, h) => ({ q, h })} onChange={(npshr) => onChange({ ...pump, npshr })} note="Needed for the NPSH margin and warning." />
      </div>
    </section>
  );
}
