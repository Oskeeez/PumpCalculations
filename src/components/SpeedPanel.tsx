import { useMemo } from 'react';
import type { SpeedSweep } from '../analysis';
import { CHART_H, CHART_W, SCREEN_THEME, pumpChartSvg } from '../curveChart';
import type { PumpUI } from '../model';
import { unitFactor, useUnits } from '../units';
import type { PickAccept } from './Canvas';
import { NumField } from './NumField';

export interface SpeedConfig {
  pumpUid: string;
  minPct: number;
  maxPct: number;
  stepPct: number;
}

interface Props {
  pumps: PumpUI[];
  config: SpeedConfig;
  onConfig: (c: SpeedConfig) => void;
  sweep?: SpeedSweep;
  pickId?: string;
  onPick: (id: string, accept: PickAccept, label: string, apply: (uid: string) => void) => void;
}

/** Pump curves at several speeds (affinity laws) with the system's operating point at each speed. */
export function SpeedPanel({ pumps, config, onConfig, sweep, pickId, onPick }: Props) {
  const U = useUnits();
  const svg = useMemo(
    () =>
      sweep && sweep.series.length
        ? pumpChartSvg(sweep.series, SCREEN_THEME, {
            flowLabel: U.u('flow'),
            headLabel: U.u('head'),
            flowFactor: unitFactor('flow', U.system),
            headFactor: unitFactor('head', U.system),
          })
        : '',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sweep, U.system],
  );
  if (pumps.length === 0) return <p className="hint">No pumps.</p>;
  const num = (v: number | undefined, d = 1) => (v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));
  return (
    <div>
      <div className="grid">
        <div className="field-pick">
          <label className="field">
            <span>Pump</span>
            <select value={config.pumpUid} onChange={(e) => onConfig({ ...config, pumpUid: e.target.value })}>
              {pumps.map((p) => <option key={p.uid} value={p.uid}>{p.name}</option>)}
            </select>
          </label>
          <button className={`pick-btn ${pickId === 'speed:pump' ? 'active' : ''}`} aria-pressed={pickId === 'speed:pump'} title="Choose by clicking a pump on the network" onClick={() => onPick('speed:pump', 'pump', 'Speed analysis pump', (uid) => onConfig({ ...config, pumpUid: uid }))}>◎ Pick</button>
        </div>
        <NumField label="From" unit="% of rated speed" value={config.minPct} onChange={(v) => onConfig({ ...config, minPct: v })} />
        <NumField label="To" unit="% of rated speed" value={config.maxPct} onChange={(v) => onConfig({ ...config, maxPct: v })} />
        <NumField label="Step" unit="%" value={config.stepPct} onChange={(v) => onConfig({ ...config, stepPct: v })} />
      </div>
      {sweep && sweep.rows.length === 0 && <div className="banner warn">Enter a valid speed range (from ≤ to, step &gt; 0).</div>}
      {sweep && sweep.rows.length > 0 && (
        <div className="below">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Speed</th><th>rpm</th><th>Q [{U.u('flow')}]</th><th>H [{U.u('head')}]</th><th>η [%]</th><th>Shaft [{U.u('power')}]</th><th>NPSH margin [{U.u('head')}]</th><th>Tank supply [{U.u('flow')}]</th><th>Warn</th>
                </tr>
              </thead>
              <tbody>
                {sweep.rows.map((r) => (
                  <tr key={r.speedRatio} className={r.error || r.warnings ? 'bad' : ''}>
                    <td>{num(r.speedRatio * 100, 1)} %</td>
                    <td>{num(r.rpm, 0)}</td>
                    {r.error ? <td colSpan={6}>{r.error}</td> : (
                      <>
                        <td>{U.f('flow', r.flowLps, 2)}</td>
                        <td>{U.f('head', r.headM, 2)}</td>
                        <td>{r.efficiency !== undefined ? num(r.efficiency * 100, 1) : '–'}</td>
                        <td>{U.f('power', r.shaftKw, 3)}</td>
                        <td>{U.f('head', r.npshMarginM, 2)}</td>
                        <td>{U.f('flow', r.systemSupplyLps, 2)}</td>
                      </>
                    )}
                    <td>{r.error ? '' : r.warnings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {svg && <div className="chart" style={{ aspectRatio: `${CHART_W} / ${CHART_H}` }} dangerouslySetInnerHTML={{ __html: svg }} />}
        </div>
      )}
    </div>
  );
}
