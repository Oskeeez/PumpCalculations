import type { Computed } from '../model';

const f = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));

export function Results({ computed }: { computed: Computed }) {
  if (computed.error) return <div className="banner error">{computed.error}</div>;
  const { op, analysis } = computed;
  if (!op || !analysis) return null;
  const ok = op.status === 'ok';
  return (
    <div className="results">
      <div className={`banner ${ok ? 'ok' : 'error'}`}>{ok ? 'Operating point found.' : op.message}</div>
      {ok && (
        <div className="kpis">
          <div><span>Flow Q</span><b>{f(op.flowM3s * 1000, 2)}</b> L/s <small>{f(op.flowM3s * 3600, 1)} m³/h</small></div>
          <div><span>Head H</span><b>{f(op.headM, 2)}</b> m</div>
          <div><span>Friction loss</span><b>{f(analysis.totalFrictionLossM, 2)}</b> m</div>
          <div><span>Minor loss</span><b>{f(analysis.totalMinorLossM, 2)}</b> m</div>
        </div>
      )}
      {computed.warnings.map((w, i) => (
        <div key={i} className="banner warn">⚠ {w}</div>
      ))}
      {ok && analysis.pipes.length > 0 && (
        <>
          <h3>Pipes</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Pipe</th><th>v [m/s]</th><th>Re</th><th>Regime</th><th>f</th><th>h_f [m]</th><th>h_m [m]</th><th>Total [m]</th></tr>
              </thead>
              <tbody>
                {analysis.pipes.map((p, i) => (
                  <tr key={i}>
                    <td>{p.id}</td>
                    <td>{f(p.flow.velocity, 3)}</td>
                    <td>{Math.round(p.flow.reynolds).toLocaleString()}</td>
                    <td>{p.flow.regime}</td>
                    <td>{f(p.flow.frictionFactor, 5)}</td>
                    <td>{f(p.flow.frictionHeadLoss, 3)}</td>
                    <td>{f(p.flow.minorHeadLoss, 3)}</td>
                    <td>{f(p.flow.totalHeadLoss, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {ok && analysis.pumps.length > 0 && (
        <>
          <h3>Pumps</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Pump</th><th>H [m]</th><th>η</th><th>Shaft [kW]</th><th>NPSHa [m]</th><th>NPSHr [m]</th><th>Margin [m]</th></tr>
              </thead>
              <tbody>
                {analysis.pumps.map((p, i) => (
                  <tr key={i} className={p.warnings.length ? 'bad' : ''}>
                    <td>{p.id}</td>
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
