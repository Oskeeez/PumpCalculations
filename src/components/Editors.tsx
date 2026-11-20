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
      <h3>{isTank ? 'Tank (fixed-head boundary)' : 'Junction'}</h3>
      <NameField value={node.name} onChange={(name) => onChange({ ...node, name })} />
      <div className="grid">
        <NumField label={isTank ? 'Bottom elevation' : 'Elevation'} q="elevation" value={node.elevationM} onChange={(v) => onChange({ ...node, elevationM: v })} />
        {isTank ? (
          <>
            <NumField label="Liquid level" q="length" value={node.levelM} onChange={(v) => onChange({ ...node, levelM: v })} />
            <NumField label="Pressure above liquid (abs)" q="pressure" value={node.pressureKPa} onChange={(v) => onChange({ ...node, pressureKPa: v })} title="Atmospheric = 101.325 kPa = 14.696 psi absolute" />
          </>
        ) : (
          <NumField label="Demand (withdrawal)" q="flow" value={node.demandLps} onChange={(v) => onChange({ ...node, demandLps: v })} title="Negative = flow injected into the network" />
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
  const U = useUnits();
  const setFit = (i: number, f: FittingUI) => onChange({ ...pipe, fittings: pipe.fittings.map((x, j) => (j === i ? f : x)) });
  const total = pipe.fittings.reduce((s, f) => s + f.k, 0);
  return (
    <section className="editor">
      <h3>Pipe</h3>
      <NameField value={pipe.name} onChange={(name) => onChange({ ...pipe, name })} />
      <Ends from={from} to={to} onSwap={() => onChange({ ...pipe, from: pipe.to, to: pipe.from })} />
      <div className="grid">
        <NumField label="Length" q="length" value={pipe.lengthM} onChange={(v) => onChange({ ...pipe, lengthM: v })} />
        <NumField label="Inner diameter" q="diameter" value={pipe.diameterMm} onChange={(v) => onChange({ ...pipe, diameterMm: v })} />
        <NumField label="Roughness ε" q="roughness" value={pipe.roughnessMm} onChange={(v) => onChange({ ...pipe, roughnessMm: v })} />
      </div>
      <div className="grid">
        <label className="field">
          <span>Material (sets roughness)</span>
          <select value={matchMaterial(pipe.roughnessMm) ?? ''} onChange={(e) => { const m = MATERIALS.find((x) => x.name === e.target.value); if (m) onChange({ ...pipe, roughnessMm: m.roughnessMm }); }}>
            <option value="">Custom</option>
            {MATERIALS.map((m) => <option key={m.name} value={m.name}>{m.name} ({U.f('roughness', m.roughnessMm, 4)} {U.u('roughness')})</option>)}
          </select>
        </label>
        <label className="field">
          <span>Nominal size, Sch 40 steel (sets diameter)</span>
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

const CONTROL_HELP: Record<ValveControlType, string> = {
  none: 'Fixed resistance. Set Cv or Kv to the value at the valve position being modelled (smaller = more throttled).',
  prv: 'Pressure-reducing: holds the downstream node at the set pressure when the upstream pressure is higher; fully open otherwise; closes on reverse flow. The loss below applies when fully open.',
  psv: 'Pressure-sustaining: throttles to hold the upstream node at the set pressure; fully open when the upstream pressure is higher than the set value. The loss below applies when fully open.',
  fcv: 'Flow-control: limits the flow to the set value when the network would pass more; fully open otherwise. The loss below applies when fully open.',
};

export function ValveEditor({ valve, from, to, onChange }: { valve: ValveUI; from: string; to: string; onChange: (v: ValveUI) => void }) {
  const unit = valve.lossType === 'K' ? '–' : valve.lossType === 'Cv' ? 'gpm @ 1 psi' : 'm³/h @ 1 bar';
  const controlQ: Quantity = valve.controlType === 'fcv' ? 'flow' : 'pressure';
  return (
    <section className="editor">
      <h3>Valve</h3>
      <NameField value={valve.name} onChange={(name) => onChange({ ...valve, name })} />
      <Ends from={from} to={to} onSwap={() => onChange({ ...valve, from: valve.to, to: valve.from })} />
      <div className="grid">
        <label className="field">
          <span>Function</span>
          <select value={valve.controlType} onChange={(e) => onChange({ ...valve, controlType: e.target.value as ValveControlType })}>
            <option value="none">Fixed resistance (isolation / throttling)</option>
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
      <h4>{valve.controlType === 'none' ? 'Loss' : 'Loss when fully open'}</h4>
      <div className="grid">
        <NumField label="Diameter" q="diameter" value={valve.diameterMm} onChange={(v) => onChange({ ...valve, diameterMm: v })} />
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
        {valve.controlType === 'none' && (
          <label><input type="checkbox" checked={valve.checkValve} onChange={(e) => onChange({ ...valve, checkValve: e.target.checked })} /> Check valve (blocks reverse flow)</label>
        )}
      </div>
      <p className="hint">{CONTROL_HELP[valve.controlType]} A closed valve is removed from the network.</p>
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
  note?: string;
}

function Points<T>({ title, cols, qty, rows, get, make, onChange, note }: PointsProps<T>) {
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
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

export function PumpEditor({ pump, from, to, onChange, headFitRmse }: { pump: PumpUI; from: string; to: string; onChange: (p: PumpUI) => void; headFitRmse?: number }) {
  const U = useUnits();
  return (
    <section className="editor">
      <h3>Pump</h3>
      <NameField value={pump.name} onChange={(name) => onChange({ ...pump, name })} />
      <Ends from={`${from} (suction)`} to={`${to} (discharge)`} onSwap={() => onChange({ ...pump, from: pump.to, to: pump.from })} />
      <div className="grid">
        <NumField label="Speed ratio N/N_rated" value={pump.speedRatio} onChange={(v) => onChange({ ...pump, speedRatio: v })} title="Affinity laws: Q ∝ N, H ∝ N², P ∝ N³" />
        <NumField label="Rated speed" unit="rpm" value={pump.ratedRpm} onChange={(v) => onChange({ ...pump, ratedRpm: v })} />
      </div>
      <p className="hint">
        Curves are entered at rated speed and fitted to H = a0 + a1·Q + a2·Q². Head fit RMS error: {headFitRmse !== undefined ? U.fu('head', headFitRmse, 3) : '–'}. Use the speed analysis panel to see the curves at other speeds.
      </p>
      <div className="three">
        <Points title="Head curve" cols={['Q', 'H']} qty={['flow', 'head']} rows={pump.head} get={(r) => [r.q, r.h]} make={(q, h) => ({ q, h })} onChange={(head) => onChange({ ...pump, head })} note="At least 2 points; 3+ recommended." />
        <Points title="Efficiency (optional)" cols={['Q', 'η [%]']} qty={['flow', undefined]} rows={pump.efficiency} get={(r) => [r.q, r.eta]} make={(q, eta) => ({ q, eta })} onChange={(efficiency) => onChange({ ...pump, efficiency })} note="Needed for shaft power." />
        <Points title="NPSH required (optional)" cols={['Q', 'NPSHr']} qty={['flow', 'head']} rows={pump.npshr} get={(r) => [r.q, r.h]} make={(q, h) => ({ q, h })} onChange={(npshr) => onChange({ ...pump, npshr })} note="Needed for the NPSH margin and warning." />
      </div>
    </section>
  );
}
