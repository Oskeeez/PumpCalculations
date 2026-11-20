import type { Computed } from '../model';

const f = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));

export function Results({ computed, onSelectName }: { computed: Computed; onSelectName: (name: string) => void }) {
  if (computed.error) return <div className="banner error">{computed.error}</div>;
  const r = computed.result;
  if (!r) return null;
  const tankSupply = r.nodes.filter((n) => n.kind === 'tank').reduce((s, n) => s + Math.max(0, -n.netOutflowM3s), 0);
  const demand = r.nodes.filter((n) => n.kind === 'junction').reduce((s, n) => s + n.netOutflowM3s, 0);
  return (
    <div className="results">
      <div className={`banner ${r.converged ? 'ok' : 'error'}`}>
        {r.converged ? `Solved: ${r.message.toLowerCase()} (max node imbalance ${r.residualM3s.toExponential(1)} m³/s).` : `Not converged: ${r.message}`}
      </div>
      <div className="kpis">
        <div><span>Supplied by tanks</span><b>{f(tankSupply * 1000, 2)}</b> L/s</div>
        <div><span>Junction demand</span><b>{f(demand * 1000, 2)}</b> L/s</div>
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
            <tr><th>Node</th><th>Elev. [m]</th><th>Head [m]</th><th>Gauge p [kPa]</th><th>Abs p [kPa]</th><th>Net out [L/s]</th></tr>
          </thead>
          <tbody>
            {r.nodes.map((n) => (
              <tr key={n.id} className={n.warnings.length ? 'bad' : ''} onClick={() => onSelectName(n.id)}>
                <td>{n.id} <small>({n.kind})</small></td>
                <td>{f(n.elevationM)}</td>
                <td>{f(n.headM)}</td>
                <td>{f(n.gaugePressurePa / 1000, 1)}</td>
                <td>{f(n.absolutePressurePa / 1000, 1)}</td>
                <td>{f(n.netOutflowM3s * 1000, 2)}</td>
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
                <tr><th>Pipe</th><th>From → To</th><th>Q [L/s]</th><th>v [m/s]</th><th>Re</th><th>Regime</th><th>f</th><th>h_f [m]</th><th>h_m [m]</th><th>Δh [m]</th></tr>
              </thead>
              <tbody>
                {r.pipes.map((p) => (
                  <tr key={p.id} onClick={() => onSelectName(p.id)}>
                    <td>{p.id}</td>
                    <td>{p.from} → {p.to}</td>
                    <td>{f(p.flowM3s * 1000, 3)}</td>
                    <td>{f(p.flow.velocity, 3)}</td>
                    <td>{Math.round(p.flow.reynolds).toLocaleString()}</td>
                    <td>{p.flow.regime}</td>
                    <td>{Number.isFinite(p.flow.frictionFactor) ? f(p.flow.frictionFactor, 5) : '–'}</td>
                    <td>{f(p.flow.frictionHeadLoss, 3)}</td>
                    <td>{f(p.flow.minorHeadLoss, 3)}</td>
                    <td>{f(p.headDropM, 3)}</td>
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
                <tr><th>Valve</th><th>From → To</th><th>Status</th><th>Q [L/s]</th><th>v [m/s]</th><th>K (equiv.)</th><th>Δp [kPa]</th><th>Δh [m]</th></tr>
              </thead>
              <tbody>
                {r.valves.map((v) => (
                  <tr key={v.id} className={v.status === 'open' ? '' : 'bad'} onClick={() => onSelectName(v.id)}>
                    <td>{v.id}</td>
                    <td>{v.from} → {v.to}</td>
                    <td>{v.status}</td>
                    <td>{f(v.flowM3s * 1000, 3)}</td>
                    <td>{f(v.velocity, 3)}</td>
                    <td>{f(v.equivalentK, 2)}</td>
                    <td>{f(v.pressureDropPa / 1000, 2)}</td>
                    <td>{f(v.headDropM, 3)}</td>
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
                <tr><th>Pump</th><th>Q [L/s]</th><th>H [m]</th><th>η</th><th>Shaft [kW]</th><th>NPSHa [m]</th><th>NPSHr [m]</th><th>Margin [m]</th></tr>
              </thead>
              <tbody>
                {r.pumps.map((p) => (
                  <tr key={p.id} className={p.warnings.length ? 'bad' : ''} onClick={() => onSelectName(p.id)}>
                    <td>{p.id}</td>
                    <td>{f(p.flowM3s * 1000, 3)}</td>
                    <td>{f(p.headM)}</td>
                    <td>{p.efficiency !== undefined ? `${f(p.efficiency * 100, 1)} %` : '–'}</td>
                    <td>{f(p.shaftPowerW !== undefined ? p.shaftPowerW / 1000 : undefined, 3)}</td>
                    <td>{f(p.npshaM)}</td>
                    <td>{f(p.npshrM)}</td>
                    <td>{f(p.npshMarginM)}</td>
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
