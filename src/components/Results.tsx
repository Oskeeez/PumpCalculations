import type { Computed } from '../model';
import { useUnits } from '../units';

const num = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));

export function Results({ computed, onSelectName }: { computed: Computed; onSelectName: (name: string) => void }) {
  const U = useUnits();
  if (computed.error) return <div className="banner error">{computed.error}</div>;
  const r = computed.result;
  if (!r) return null;
  const tankSupply = r.nodes.filter((n) => n.kind === 'tank').reduce((s, n) => s + Math.max(0, -n.netOutflowM3s), 0);
  const demand = r.nodes.filter((n) => n.kind === 'junction').reduce((s, n) => s + n.netOutflowM3s, 0);
  const Lps = (m3s: number) => m3s * 1000; // canonical flow for display helpers
  return (
    <div className="results">
      <div className={`banner ${r.converged ? 'ok' : 'error'}`}>
        {r.converged ? `Solved: ${r.message.toLowerCase()} (max node imbalance ${r.residualM3s.toExponential(1)} m³/s).` : `Not converged: ${r.message}`}
      </div>
      <div className="kpis">
        <div><span>Supplied by tanks</span><b>{U.f('flow', Lps(tankSupply))}</b> {U.u('flow')}</div>
        <div><span>Junction demand</span><b>{U.f('flow', Lps(demand))}</b> {U.u('flow')}</div>
        <div><span>Pipes / valves / pumps</span><b>{r.pipes.length}</b> / <b>{r.valves.length}</b> / <b>{r.pumps.length}</b></div>
      </div>
      {computed.alerts.map((w, i) => (
        <div key={`a${i}`} className="banner warn">⚑ Design alert: {w}</div>
      ))}
      {r.warnings.map((w, i) => (
        <div key={i} className="banner warn">⚠ {w}</div>
      ))}

      <h3>Nodes</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Node</th><th>Elev. [{U.u('elevation')}]</th><th>Head [{U.u('head')}]</th><th>Gauge p [{U.u('pressure')}]</th><th>Abs p [{U.u('pressure')}]</th><th>Net out [{U.u('flow')}]</th></tr>
          </thead>
          <tbody>
            {r.nodes.map((n) => (
              <tr key={n.id} className={n.warnings.length ? 'bad' : ''} onClick={() => onSelectName(n.id)}>
                <td>{n.id} <small>({n.kind})</small></td>
                <td>{U.f('elevation', n.elevationM)}</td>
                <td>{U.f('head', n.headM)}</td>
                <td>{U.f('pressure', n.gaugePressurePa / 1000, 1)}</td>
                <td>{U.f('pressure', n.absolutePressurePa / 1000, 1)}</td>
                <td>{U.f('flow', Lps(n.netOutflowM3s))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {r.pipes.length > 0 && (
        <>
          <h3>Pipes</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Pipe</th><th>From → To</th><th>Q [{U.u('flow')}]</th><th>v [{U.u('velocity')}]</th><th>Re</th><th>Regime</th><th>f</th><th>h_f [{U.u('head')}]</th><th>h_m [{U.u('head')}]</th><th>Δh [{U.u('head')}]</th></tr>
              </thead>
              <tbody>
                {r.pipes.map((p) => (
                  <tr key={p.id} onClick={() => onSelectName(p.id)}>
                    <td>{p.id}</td>
                    <td>{p.from} → {p.to}</td>
                    <td>{U.f('flow', Lps(p.flowM3s), 3)}</td>
                    <td>{U.f('velocity', p.flow.velocity, 3)}</td>
                    <td>{Math.round(p.flow.reynolds).toLocaleString()}</td>
                    <td>{p.flow.regime}</td>
                    <td>{Number.isFinite(p.flow.frictionFactor) ? num(p.flow.frictionFactor, 5) : '–'}</td>
                    <td>{U.f('head', p.flow.frictionHeadLoss, 3)}</td>
                    <td>{U.f('head', p.flow.minorHeadLoss, 3)}</td>
                    <td>{U.f('head', p.headDropM, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {r.valves.length > 0 && (
        <>
          <h3>Valves</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Valve</th><th>From → To</th><th>Function</th><th>Status</th><th>Q [{U.u('flow')}]</th><th>v [{U.u('velocity')}]</th><th>K (open)</th><th>K (effective)</th><th>Δp [{U.u('pressure')}]</th><th>Δh [{U.u('head')}]</th></tr>
              </thead>
              <tbody>
                {r.valves.map((v) => (
                  <tr key={v.id} className={v.status === 'open' || v.status === 'active' ? '' : 'bad'} onClick={() => onSelectName(v.id)}>
                    <td>{v.id}</td>
                    <td>{v.from} → {v.to}</td>
                    <td>{v.mode ? v.mode.toUpperCase() : 'fixed'}</td>
                    <td>{v.status}</td>
                    <td>{U.f('flow', Lps(v.flowM3s), 3)}</td>
                    <td>{U.f('velocity', v.velocity, 3)}</td>
                    <td>{num(v.equivalentK, 2)}</td>
                    <td>{num(v.effectiveK, 2)}</td>
                    <td>{U.f('pressure', v.pressureDropPa / 1000, 2)}</td>
                    <td>{U.f('head', v.headDropM, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {r.pumps.length > 0 && (
        <>
          <h3>Pumps</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Pump</th><th>Q [{U.u('flow')}]</th><th>H [{U.u('head')}]</th><th>η</th><th>Shaft [{U.u('power')}]</th><th>NPSHa [{U.u('head')}]</th><th>NPSHr [{U.u('head')}]</th><th>Margin [{U.u('head')}]</th></tr>
              </thead>
              <tbody>
                {r.pumps.map((p) => (
                  <tr key={p.id} className={p.warnings.length ? 'bad' : ''} onClick={() => onSelectName(p.id)}>
                    <td>{p.id}</td>
                    <td>{U.f('flow', Lps(p.flowM3s), 3)}</td>
                    <td>{U.f('head', p.headM)}</td>
                    <td>{p.efficiency !== undefined ? `${num(p.efficiency * 100, 1)} %` : '–'}</td>
                    <td>{U.f('power', p.shaftPowerW !== undefined ? p.shaftPowerW / 1000 : undefined, 3)}</td>
                    <td>{U.f('head', p.npshaM)}</td>
                    <td>{U.f('head', p.npshrM)}</td>
                    <td>{U.f('head', p.npshMarginM)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
