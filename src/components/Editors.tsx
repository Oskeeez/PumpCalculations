import { useState, type ReactNode } from 'react';
import { FITTINGS, MATERIALS, PIPE_SERIES, matchMaterial, matchPipeSize } from '../library';
import { defaultControl, type FittingUI, type NodeUI, type PipeUI, type PumpControl, type PumpCurveEntry, type PumpUI, type ValveControlType, type ValveLossType, type ValveUI } from '../model';
import { orificeBoreForDrop, requiredCv, requiredKv } from '../sizing';
import { useUnits, type Quantity } from '../units';
import { NumField } from './NumField';
import { PressureField } from './PressureField';

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
      <button onClick={onSwap}>⇄ Swap direction</button>
    </p>
  );
}

/** Prominent flow-direction control for a pump or a directional valve. */
function Direction({ inLabel, outLabel, from, to, onSwap }: { inLabel: string; outLabel: string; from: string; to: string; onSwap: () => void }) {
  return (
    <div className="direction">
      <div className="dir-row">
        <div className="dir-end"><small>{inLabel}</small><b>{from}</b></div>
        <div className="dir-arrow" aria-hidden="true">━━▶</div>
        <div className="dir-end"><small>{outLabel}</small><b>{to}</b></div>
      </div>
      <button className="primary" onClick={onSwap}>⇄ Reverse direction</button>
    </div>
  );
}

export function PipeEditor({ pipe, from, to, canvasLengthM, onChange }: { pipe: PipeUI; from: string; to: string; canvasLengthM: number; onChange: (p: PipeUI) => void }) {
  const U = useUnits();
  const setFit = (i: number, f: FittingUI) => onChange({ ...pipe, fittings: pipe.fittings.map((x, j) => (j === i ? f : x)) });
  const total = pipe.fittings.reduce((s, f) => s + f.k, 0);
  const matched = matchPipeSize(pipe.diameterMm);
  const [series, setSeries] = useState(matched?.series ?? 'sch40');
  const seriesDef = PIPE_SERIES.find((x) => x.id === series) ?? PIPE_SERIES[0];
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
          <span>Size series</span>
          <select value={series} onChange={(e) => setSeries(e.target.value)} aria-label="Pipe size series">
            {PIPE_SERIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Nominal size</span>
          <select value={matched?.series === series ? matched.nps : ''} aria-label="Nominal pipe size" onChange={(e) => { const sz = seriesDef.sizes.find((x) => x.nps === e.target.value); if (sz) onChange({ ...pipe, diameterMm: sz.idMm }); }}>
            <option value="">Custom</option>
            {seriesDef.sizes.map((sz) => <option key={sz.nps} value={sz.nps}>{sz.nps} ({U.f('diameter', sz.idMm, 2)} {U.u('diameter')} ID)</option>)}
          </select>
        </label>
      </div>
      <div className="grid">
        <div className="field opt">
          <label><input type="checkbox" checked={pipe.ratingKPaG !== undefined} onChange={(e) => onChange({ ...pipe, ratingKPaG: e.target.checked ? 1000 : undefined })} /> Pressure rating (gauge)</label>
          {pipe.ratingKPaG !== undefined && <PressureField value={pipe.ratingKPaG} onChange={(v) => v > 0 && onChange({ ...pipe, ratingKPaG: v })} label="Rating" />}
        </div>
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

/** "Size this valve": the Cv or Kv a control valve needs, or the bore an orifice needs, for a wanted drop at a design flow. */
function SizingHelper({ valve, onChange, designFlowLps, density }: { valve: ValveUI; onChange: (v: ValveUI) => void; designFlowLps: number; density: number }) {
  const U = useUnits();
  const [flow, setFlow] = useState(designFlowLps > 0 ? designFlowLps : 10);
  const [drop, setDrop] = useState(50);
  const orifice = valve.lossType === 'orifice';
  let body: ReactNode;
  try {
    if (orifice) {
      const r = orificeBoreForDrop(flow, drop, valve.diameterMm, density, valve.orificeCd);
      body = (
        <>
          <p>Bore needed: <b>{U.fu('diameter', r.boreMm, 2)}</b> (beta {r.beta.toFixed(2)}), velocity through it {U.fu('velocity', r.boreVelocityMps, 1)}. A flow meter across the plate would read {U.fu('pressure', r.measuredDropKPa, 1)}.</p>
          {r.warnings.map((w) => <div key={w} className="banner warn">{w}</div>)}
          <button onClick={() => onChange({ ...valve, lossValue: r.boreMm })}>Use this bore</button>
        </>
      );
    } else {
      const cv = requiredCv(flow, drop, density);
      const kv = requiredKv(flow, drop, density);
      body = (
        <>
          <p>Needs <b>Cv {cv.toFixed(1)}</b> (Kv {kv.toFixed(1)}) when fully open for this flow and drop.</p>
          <div className="toolbar">
            <button onClick={() => onChange({ ...valve, lossType: 'Cv', lossValue: cv })}>Use Cv {cv.toFixed(1)}</button>
            <button onClick={() => onChange({ ...valve, lossType: 'Kv', lossValue: kv })}>Use Kv {kv.toFixed(1)}</button>
          </div>
        </>
      );
    }
  } catch (err) {
    body = <div className="banner warn">{err instanceof Error ? err.message : String(err)}</div>;
  }
  return (
    <details className="sizing">
      <summary>Size this {orifice ? 'orifice' : 'valve'}</summary>
      <div className="grid">
        <NumField label="Design flow" q="flow" value={flow} onChange={(v) => v > 0 && setFlow(v)} />
        <PressureField label={orifice ? 'Permanent pressure loss' : 'Pressure drop'} value={drop} onChange={(v) => v > 0 && setDrop(v)} />
      </div>
      {body}
    </details>
  );
}

export function ValveEditor({ valve, from, to, onChange, designFlowLps = 0, density = 998 }: { valve: ValveUI; from: string; to: string; onChange: (v: ValveUI) => void; designFlowLps?: number; density?: number }) {
  const unit = valve.lossType === 'orifice' ? '' : valve.lossType === 'K' ? '–' : valve.lossType === 'Cv' ? 'gpm @ 1 psi' : 'm³/h @ 1 bar';
  const controlQ: Quantity = valve.controlType === 'fcv' ? 'flow' : 'pressure';
  return (
    <section className="editor">
      <h3>Valve</h3>
      <NameField value={valve.name} onChange={(name) => onChange({ ...valve, name })} />
      {valve.checkValve || valve.controlType !== 'none' ? (
        <Direction inLabel="IN" outLabel="OUT" from={from} to={to} onSwap={() => onChange({ ...valve, from: valve.to, to: valve.from })} />
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
        {valve.controlType === 'fcv' && <NumField label="Set flow" q={controlQ} value={valve.controlValue} onChange={(v) => onChange({ ...valve, controlValue: v })} />}
        {(valve.controlType === 'prv' || valve.controlType === 'psv') && (
          <PressureField label={valve.controlType === 'prv' ? 'Set pressure, downstream (gauge)' : 'Set pressure, upstream (gauge)'} value={valve.controlValue} onChange={(v) => onChange({ ...valve, controlValue: v })} />
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
            <NumField label="Discharge coeff. Cd" unit="–" value={valve.orificeCd ?? 0.61} onChange={(v) => onChange({ ...valve, orificeCd: v })} />
          </>
        ) : (
          <NumField label={valve.lossType} unit={unit} value={valve.lossValue} onChange={(v) => onChange({ ...valve, lossValue: v })} />
        )}
      </div>
      <SizingHelper key={valve.uid + valve.lossType} valve={valve} onChange={onChange} designFlowLps={designFlowLps} density={density} />
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

interface PumpEditorProps {
  pump: PumpUI;
  from: string;
  to: string;
  onChange: (p: PumpUI) => void;
  headFitRmse?: number;
  curves: PumpCurveEntry[];
  onAssignCurve: (curveId: string) => void;
  onSaveCurve: () => void;
  onManageCurves: () => void;
  /** Junctions and tanks, for choosing the node whose pressure a controlled pump holds. */
  nodes: { uid: string; name: string }[];
  /** Ask the user to click a node on the network; `apply` receives its uid. */
  onPickNode: (apply: (uid: string) => void) => void;
  pickActive: boolean;
  /** Speed ratio the solver ended up with (differs from the typed one under speed control). */
  solvedSpeed?: number;
}

/** Running / standby and variable-speed control of a pump. */
function PumpControlSection({ pump, onChange, nodes, onPickNode, pickActive, solvedSpeed }: Pick<PumpEditorProps, 'pump' | 'onChange' | 'nodes' | 'onPickNode' | 'pickActive' | 'solvedSpeed'>) {
  const c = pump.control;
  const set = (control: PumpControl | undefined) => onChange({ ...pump, control });
  return (
    <div className="pump-ctl">
      <label className="check"><input type="checkbox" checked={pump.running !== false} onChange={(e) => onChange({ ...pump, running: e.target.checked })} /> Running (untick to switch this pump off, e.g. standby)</label>
      <label className="field">
        <span>Speed</span>
        <select value={c?.mode ?? 'fixed'} aria-label="Speed control" onChange={(e) => {
          const m = e.target.value;
          if (m === 'fixed') set(undefined);
          else if (m === 'flow') set({ mode: 'flow', lps: 10, minRatio: c?.minRatio ?? 0.5, maxRatio: c?.maxRatio ?? 1 });
          else set(c?.mode === 'pressure' ? c : { ...defaultControl(nodes.find((n) => n.name !== undefined)?.uid ?? ''), minRatio: c?.minRatio ?? 0.5, maxRatio: c?.maxRatio ?? 1 });
        }}>
          <option value="fixed">Fixed (set the speed ratio below)</option>
          <option value="pressure">Variable: hold a pressure at a node</option>
          <option value="flow">Variable: hold a flow through this pump</option>
        </select>
      </label>
      {c?.mode === 'pressure' && (
        <div className="field-pick">
          <label className="field"><span>Node</span>
            <select value={c.nodeUid} onChange={(e) => set({ ...c, nodeUid: e.target.value })}>
              {nodes.map((n) => <option key={n.uid} value={n.uid}>{n.name}</option>)}
            </select>
          </label>
          <button className={`pick-btn ${pickActive ? 'active' : ''}`} aria-pressed={pickActive} title="Choose the node by clicking it on the network" onClick={() => onPickNode((uid) => set({ ...c, nodeUid: uid }))}>◎ Pick</button>
        </div>
      )}
      {c?.mode === 'pressure' && <PressureField label="Pressure to hold (gauge)" value={c.kPaG} onChange={(v) => set({ ...c, kPaG: v })} />}
      {c?.mode === 'flow' && <NumField label="Flow to hold" q="flow" value={c.lps} onChange={(v) => set({ ...c, lps: v })} />}
      {c && (
        <div className="grid">
          <NumField label="Slowest" unit="× rated" value={c.minRatio} onChange={(v) => v > 0 && set({ ...c, minRatio: v })} title="Lowest speed ratio the drive may use" />
          <NumField label="Fastest" unit="× rated" value={c.maxRatio} onChange={(v) => v > 0 && set({ ...c, maxRatio: v })} title="Highest speed ratio the drive may use" />
        </div>
      )}
      {c && solvedSpeed !== undefined && pump.running !== false && <p className="hint">Speed found: <b>{(solvedSpeed * 100).toFixed(1)} %</b> of rated ({Math.round(solvedSpeed * pump.ratedRpm)} rpm).</p>}
    </div>
  );
}

export function PumpEditor({ pump, from, to, onChange, headFitRmse, curves, onAssignCurve, onSaveCurve, onManageCurves, nodes, onPickNode, pickActive, solvedSpeed }: PumpEditorProps) {
  const U = useUnits();
  const lib = curves.find((c) => c.id === pump.curveId);
  /** Editing the points by hand detaches the pump from its library curve. */
  const own = (patch: Partial<PumpUI>) => onChange({ ...pump, ...patch, curveId: undefined });
  return (
    <section className="editor">
      <h3>Pump</h3>
      <NameField value={pump.name} onChange={(name) => onChange({ ...pump, name })} />
      <Direction inLabel="SUCTION (in)" outLabel="DISCHARGE (out)" from={from} to={to} onSwap={() => onChange({ ...pump, from: pump.to, to: pump.from })} />
      <div className="curve-pick">
        <label className="field">
          <span>Pump curve</span>
          <select value={lib ? lib.id : ''} onChange={(e) => onAssignCurve(e.target.value)} aria-label="Pump curve">
            <option value="">Custom (this pump only)</option>
            {curves.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div className="toolbar">
          <button onClick={onManageCurves}>Add / edit curves…</button>
          {!lib && <button onClick={onSaveCurve} title="Save this pump's points as a reusable curve">Save to library</button>}
        </div>
      </div>
      <PumpControlSection pump={pump} onChange={onChange} nodes={nodes} onPickNode={onPickNode} pickActive={pickActive} solvedSpeed={solvedSpeed} />
      <div className="grid">
        {pump.control ? (
          <label className="field"><span>Speed ratio N/N_rated</span><input readOnly value={solvedSpeed !== undefined ? solvedSpeed.toFixed(3) : String(pump.speedRatio)} aria-label="Speed ratio (set by control)" title="Set by the speed control above" /></label>
        ) : (
          <NumField label="Speed ratio N/N_rated" value={pump.speedRatio} onChange={(v) => onChange({ ...pump, speedRatio: v })} />
        )}
        <NumField label="Rated speed" unit="rpm" value={pump.ratedRpm} onChange={(v) => own({ ratedRpm: v })} />
        <NumField label="Impeller trim D/D_full" value={pump.impellerTrim ?? 1} onChange={(v) => v > 0 && v <= 1 && onChange({ ...pump, impellerTrim: v })} title="1 = full diameter; 0.9 = trimmed to 90 %" />
      </div>
      <p className="hint">Head fit RMS error: {headFitRmse !== undefined ? U.fu('head', headFitRmse, 3) : '–'}</p>
      <details open={!lib}>
        <summary>This pump's own points{lib ? ' (editing detaches it from the library curve)' : ''}</summary>
        <div className="three">
          <Points title="Head curve" cols={['Q', 'H']} qty={['flow', 'head']} rows={pump.head} get={(r) => [r.q, r.h]} make={(q, h) => ({ q, h })} onChange={(head) => own({ head })} />
          <Points title="Efficiency (optional)" cols={['Q', 'η [%]']} qty={['flow', undefined]} rows={pump.efficiency} get={(r) => [r.q, r.eta]} make={(q, eta) => ({ q, eta })} onChange={(efficiency) => own({ efficiency })} />
          <Points title="NPSH required (optional)" cols={['Q', 'NPSHr']} qty={['flow', 'head']} rows={pump.npshr} get={(r) => [r.q, r.h]} make={(q, h) => ({ q, h })} onChange={(npshr) => own({ npshr })} />
        </div>
      </details>
    </section>
  );
}
