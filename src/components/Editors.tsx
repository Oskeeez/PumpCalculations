import type { FittingUI, PipeUI, PumpUI, TankUI } from '../model';
import { NumField } from './NumField';

export function TankEditor({ title, tank, onChange }: { title: string; tank: TankUI; onChange: (t: TankUI) => void }) {
  return (
    <section className="editor">
      <h3>{title}</h3>
      <div className="grid">
        <NumField label="Bottom elevation" unit="m" value={tank.elevationM} onChange={(v) => onChange({ ...tank, elevationM: v })} />
        <NumField label="Liquid level" unit="m" value={tank.levelM} onChange={(v) => onChange({ ...tank, levelM: v })} />
        <NumField label="Pressure above liquid (abs)" unit="kPa" value={tank.pressureKPa} onChange={(v) => onChange({ ...tank, pressureKPa: v })} title="101.325 kPa = atmospheric" />
      </div>
      <p className="hint">Liquid surface elevation = bottom elevation + level. Default pressure is atmospheric (101.325 kPa abs).</p>
    </section>
  );
}

export function PipeEditor({ pipe, onChange }: { pipe: PipeUI; onChange: (p: PipeUI) => void }) {
  const setFit = (i: number, f: FittingUI) => onChange({ ...pipe, fittings: pipe.fittings.map((x, j) => (j === i ? f : x)) });
  const total = pipe.fittings.reduce((s, f) => s + f.k, 0);
  return (
    <section className="editor">
      <h3>Pipe</h3>
      <label className="field">
        <span>Name</span>
        <input value={pipe.name} onChange={(e) => onChange({ ...pipe, name: e.target.value })} />
      </label>
      <div className="grid">
        <NumField label="Length" unit="m" value={pipe.lengthM} onChange={(v) => onChange({ ...pipe, lengthM: v })} />
        <NumField label="Inner diameter" unit="mm" value={pipe.diameterMm} onChange={(v) => onChange({ ...pipe, diameterMm: v })} />
        <NumField label="Roughness ε" unit="mm" value={pipe.roughnessMm} onChange={(v) => onChange({ ...pipe, roughnessMm: v })} />
        <NumField label="Elevation change" unit="m" value={pipe.elevationChangeM} onChange={(v) => onChange({ ...pipe, elevationChangeM: v })} />
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
      <button onClick={() => onChange({ ...pipe, fittings: [...pipe.fittings, { name: 'Fitting', k: 0.5 }] })}>+ Add fitting</button>
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

export function PumpEditor({ pump, onChange, headFitRmse }: { pump: PumpUI; onChange: (p: PumpUI) => void; headFitRmse?: number }) {
  return (
    <section className="editor">
      <h3>Pump</h3>
      <label className="field">
        <span>Name</span>
        <input value={pump.name} onChange={(e) => onChange({ ...pump, name: e.target.value })} />
      </label>
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
