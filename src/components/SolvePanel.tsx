import { useMemo } from 'react';
import type { TargetStatus } from '../ai/types';
import { DEFAULT_SOLVE_SETTINGS, type SolveOutcome, type SolveSettings } from '../autosolve';
import { PIPE_SERIES } from '../library';
import type { ProjectUI } from '../model';
import { NumField } from './NumField';

interface Props {
  project: ProjectUI;
  statuses: TargetStatus[];
  settings: SolveSettings;
  onSettings: (s: SolveSettings) => void;
  locked: ReadonlySet<string>;
  onToggleLock: (uid: string) => void;
  onUnlockAll: () => void;
  running?: { solves: number; shortfall: number };
  onRun: () => void;
  onCancel: () => void;
  /** The last result, and whether the network has changed since it was worked out. */
  outcome?: SolveOutcome;
  stale: boolean;
  onApply: () => void;
  onDiscard: () => void;
  onShowTargets: () => void;
}

const SETTING_LABEL: Record<string, string> = {
  diameter: 'Pipe diameter',
  speed: 'Pump speed (× rated)',
  'impeller trim': 'Impeller trim (D / D full)',
  'orifice bore': 'Orifice bore diameter',
  'flow setting': 'Flow set point',
  'pressure setting': 'Pressure set point',
  'throttle position': 'Valve resistance (× present)',
  'liquid level': 'Tank liquid level',
};

const STATUS_TEXT: Record<SolveOutcome['status'], { kind: 'ok' | 'warn' | 'error'; text: string }> = {
  solved: { kind: 'ok', text: 'All targets can be met.' },
  'already-passing': { kind: 'ok', text: 'All targets already pass.' },
  improved: { kind: 'warn', text: 'Targets not fully met. Closest result shown.' },
  'no-improvement': { kind: 'error', text: 'No allowed change helps.' },
  'nothing-allowed': { kind: 'error', text: 'Nothing can change.' },
};

/** "Solve this for me": choose what may change and what must not, run the search, review the changes, then apply them (one undo step). */
export function SolvePanel(p: Props) {
  const s = p.settings;
  const set = <K extends keyof SolveSettings>(k: K, v: SolveSettings[K]) => p.onSettings({ ...s, [k]: v });
  const failing = p.statuses.filter((x) => !x.pass);
  const items = useMemo(() => [...p.project.nodes.map((n) => ({ uid: n.uid, name: n.name, kind: n.kind as string })), ...p.project.edges.map((e) => ({ uid: e.uid, name: e.name, kind: e.kind === 'valve' && e.lossType === 'orifice' ? 'orifice' : e.kind }))], [p.project.nodes, p.project.edges]);
  const o = p.outcome;

  return (
    <div className="solve">
      <section className="solve-head">
        {p.statuses.length === 0 ? (
          <div className="banner warn">No targets. <button onClick={p.onShowTargets}>Add targets</button></div>
        ) : failing.length === 0 ? (
          <div className="banner ok">All targets pass.</div>
        ) : (
          <div className="banner warn">Failing: {failing.map((f) => `${f.label} (${f.text})`).join('; ')}</div>
        )}
        <div className="toolbar">
          {p.running ? (
            <>
              <button disabled>Working… {p.running.solves} tries</button>
              <button onClick={p.onCancel}>Stop</button>
            </>
          ) : (
            <button className="primary" disabled={p.statuses.length === 0} onClick={p.onRun}>Solve this for me</button>
          )}
          <button onClick={p.onShowTargets}>Edit targets…</button>
        </div>
      </section>

      {o && (
        <section className="solve-result">
          <div className={`banner ${STATUS_TEXT[o.status].kind}`}>{STATUS_TEXT[o.status].text}</div>
          {p.stale && <div className="banner warn">The network has changed. Solve again before applying.</div>}
          {o.notes.map((n, i) => <p key={i} className="hint">{n}</p>)}
          {o.changes.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Component</th><th>Setting</th><th>Current</th><th>Proposed</th></tr></thead>
                <tbody>
                  {o.changes.map((c) => <tr key={c.uid + c.parameter}><td>{c.component}</td><td>{SETTING_LABEL[c.parameter] ?? c.parameter}</td><td>{c.from}</td><td><b>{c.to}</b></td></tr>)}
                </tbody>
              </table>
            </div>
          )}
          {o.after.length > 0 && (
            <ul className="status-list">
              {o.after.map((a) => <li key={a.targetId} className={a.pass ? 'pass-text' : 'fail-text'}>{a.pass ? '✓' : '✗'} {a.label}: {a.text}</li>)}
            </ul>
          )}
          {o.changes.length > 0 && <p className="hint">Cost {Math.round(o.costBefore).toLocaleString()} → {Math.round(o.costAfter).toLocaleString()}</p>}
          <div className="toolbar">
            <button className="primary" disabled={o.changes.length === 0 || p.stale} onClick={p.onApply}>Apply these changes</button>
            <button onClick={p.onDiscard}>Discard</button>
          </div>
        </section>
      )}

      <details className="panel" open>
        <summary>May change</summary>
        <div className="allow">
          <label className="check"><input type="checkbox" checked={s.pipes.on} onChange={(e) => set('pipes', { ...s.pipes, on: e.target.checked })} /> <b>Pipe diameters</b></label>
          {s.pipes.on && (
            <div className="grid">
              <label className="field"><span>Size series</span>
                <select value={s.pipes.series} onChange={(e) => set('pipes', { ...s.pipes, series: e.target.value })}>{PIPE_SERIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
              </label>
              <NumField label="Smallest" q="diameter" value={s.pipes.minMm} onChange={(v) => v > 0 && set('pipes', { ...s.pipes, minMm: v })} />
              <NumField label="Largest" q="diameter" value={s.pipes.maxMm} onChange={(v) => v > 0 && set('pipes', { ...s.pipes, maxMm: v })} />
            </div>
          )}
          <label className="check"><input type="checkbox" checked={s.pumpSpeed.on} onChange={(e) => set('pumpSpeed', { ...s.pumpSpeed, on: e.target.checked })} /> <b>Pump speed</b></label>
          {s.pumpSpeed.on && (
            <div className="grid">
              <NumField label="Slowest" unit="× rated" value={s.pumpSpeed.min} onChange={(v) => v > 0 && set('pumpSpeed', { ...s.pumpSpeed, min: v })} />
              <NumField label="Fastest" unit="× rated" value={s.pumpSpeed.max} onChange={(v) => v > 0 && set('pumpSpeed', { ...s.pumpSpeed, max: v })} />
            </div>
          )}
          <label className="check"><input type="checkbox" checked={s.trim.on} onChange={(e) => set('trim', { ...s.trim, on: e.target.checked })} /> <b>Impeller trim</b></label>
          {s.trim.on && <div className="grid"><NumField label="Smallest D / D_full" value={s.trim.min} onChange={(v) => v > 0 && v < 1 && set('trim', { ...s.trim, min: v })} /></div>}
          <label className="check"><input type="checkbox" checked={s.valves.on} onChange={(e) => set('valves', { ...s.valves, on: e.target.checked })} /> <b>Throttle valves</b></label>
          {s.valves.on && (
            <div className="grid">
              <NumField label="Most open" unit="× current" value={s.valves.minFactor} onChange={(v) => v > 0 && v < 1 && set('valves', { ...s.valves, minFactor: v })} />
              <NumField label="Most closed" unit="× present resistance" value={s.valves.maxFactor} onChange={(v) => v > 1 && set('valves', { ...s.valves, maxFactor: v })} />
            </div>
          )}
          <label className="check"><input type="checkbox" checked={s.orifices.on} onChange={(e) => set('orifices', { on: e.target.checked })} /> <b>Orifice bores</b></label>
          <label className="check"><input type="checkbox" checked={s.regulators.on} onChange={(e) => set('regulators', { ...s.regulators, on: e.target.checked })} /> <b>Regulator settings</b></label>
          {s.regulators.on && <div className="grid"><NumField label="Range" unit="fraction" value={s.regulators.spanFraction} onChange={(v) => v > 0 && v < 1 && set('regulators', { ...s.regulators, spanFraction: v })} /></div>}
          <label className="check"><input type="checkbox" checked={s.tanks.on} onChange={(e) => set('tanks', { ...s.tanks, on: e.target.checked })} /> <b>Tank liquid levels</b></label>
          {s.tanks.on && (
            <div className="grid">
              <NumField label="Lowest level" q="length" value={s.tanks.minLevelM} onChange={(v) => v >= 0 && set('tanks', { ...s.tanks, minLevelM: v })} />
              <NumField label="Highest level" q="length" value={s.tanks.maxLevelM} onChange={(v) => v > 0 && set('tanks', { ...s.tanks, maxLevelM: v })} />
            </div>
          )}
          <hr />
          <label className="check"><input type="checkbox" checked={s.keepDesignLimits} onChange={(e) => set('keepDesignLimits', e.target.checked)} /> Keep velocity limit and NPSH margin</label>
          <div className="grid">
            <NumField label="Safety margin" unit="fraction" value={s.marginFraction} onChange={(v) => v >= 0 && v < 0.5 && set('marginFraction', v)} />
            <NumField label="Search limit" unit="solves" value={s.maxSolves} onChange={(v) => v >= 20 && set('maxSolves', Math.round(v))} />
          </div>
          <button onClick={() => p.onSettings(DEFAULT_SOLVE_SETTINGS)}>Reset to defaults</button>
        </div>
      </details>

      <details className="panel" open={p.locked.size > 0}>
        <summary>Locked ({p.locked.size})</summary>
        <div className="lock-list">
          {items.map((i) => (
            <label key={i.uid} className="check"><input type="checkbox" checked={p.locked.has(i.uid)} onChange={() => p.onToggleLock(i.uid)} /> {i.name} <small>{i.kind}</small></label>
          ))}
        </div>
        <button disabled={p.locked.size === 0} onClick={p.onUnlockAll}>Unlock all</button>
      </details>
    </div>
  );
}
