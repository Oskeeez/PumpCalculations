import { useMemo, useState, type ReactNode } from 'react';
import type { PickAccept } from './Canvas';
import { findPath, profile } from '../profile';
import type { ProjectUI } from '../model';
import type { SystemResult } from '../solver/system';
import { PALETTE } from '../curveChart';
import { useUnits } from '../units';

interface Props {
  project: ProjectUI;
  result?: SystemResult;
  pickId?: string;
  onPick: (id: string, accept: PickAccept, label: string, apply: (uid: string) => void) => void;
}

function niceStep(range: number, target = 6): number {
  const raw = Math.max(range, 1e-9) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

/** Elevation, hydraulic grade line and energy grade line along the path between two nodes. */
export function ProfilePanel({ project, result, pickId, onPick }: Props) {
  const U = useUnits();
  const [from, setFrom] = useState(project.nodes[0]?.uid ?? '');
  const [to, setTo] = useState(project.nodes[project.nodes.length - 1]?.uid ?? '');
  const path = useMemo(() => (from && to && from !== to ? findPath(project, from, to) : undefined), [project, from, to]);
  const pts = useMemo(() => (path && result ? profile(project, result, path) : undefined), [project, result, path]);

  const select = (value: string, set: (v: string) => void, label: string, id: string) => (
    <label className="field"><span>{label}</span>
      <span className="pick-row">
        <select aria-label={`Profile ${label.toLowerCase()}`} value={value} onChange={(e) => set(e.target.value)}>
          {project.nodes.map((n) => <option key={n.uid} value={n.uid}>{n.name}</option>)}
        </select>
        <button className={`pick-btn ${pickId === id ? 'active' : ''}`} aria-pressed={pickId === id} onClick={() => onPick(id, 'node', `Profile ${label.toLowerCase()}`, set)}>◎ Pick</button>
      </span>
    </label>
  );

  const W = 720;
  const H = 360;
  const m = { l: 62, r: 20, t: 20, b: 46 };
  let svg: ReactNode;
  if (pts && pts.length > 1) {
    const fl = (v: number) => v * (U.system === 'si' ? 1 : 1 / 0.3048);
    const sMax = Math.max(pts[pts.length - 1].s, 1e-6);
    const vals = pts.flatMap((p) => [p.elevationM, p.hglM, p.eglM]).filter(Number.isFinite);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || 1;
    const y0 = lo - pad;
    const y1 = hi + pad;
    const X = (s: number) => m.l + (s / sMax) * (W - m.l - m.r);
    const Y = (h: number) => m.t + (1 - (h - y0) / (y1 - y0)) * (H - m.t - m.b);
    const line = (k: 'elevationM' | 'hglM' | 'eglM') => pts.map((p) => `${X(p.s).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(' ');
    const xs = niceStep(fl(sMax));
    const ys = niceStep(fl(y1 - y0));
    const ground = `${X(0)},${H - m.b} ${line('elevationM')} ${X(sMax)},${H - m.b}`;
    svg = (
      <svg viewBox={`0 0 ${W} ${H}`} className="profile-chart" role="img" aria-label="Hydraulic grade profile" fontSize={12}>
        {Array.from({ length: Math.floor(fl(sMax) / xs) + 1 }, (_, i) => i * xs).map((v) => (
          <g key={`x${v}`}><line x1={X(v / fl(1))} x2={X(v / fl(1))} y1={m.t} y2={H - m.b} stroke="var(--border)" /><text x={X(v / fl(1))} y={H - m.b + 16} textAnchor="middle" fill="var(--fg)">{+v.toPrecision(4)}</text></g>
        ))}
        {Array.from({ length: Math.floor(fl(y1 - y0) / ys) + 2 }, (_, i) => Math.ceil(fl(y0) / ys) * ys + i * ys).filter((v) => v <= fl(y1)).map((v) => (
          <g key={`y${v}`}><line x1={m.l} x2={W - m.r} y1={Y(v / fl(1))} y2={Y(v / fl(1))} stroke="var(--border)" /><text x={m.l - 6} y={Y(v / fl(1)) + 4} textAnchor="end" fill="var(--fg)">{+v.toPrecision(5)}</text></g>
        ))}
        <polygon points={ground} fill="var(--muted)" opacity={0.25} />
        <polyline points={line('elevationM')} fill="none" stroke="var(--muted)" strokeWidth={2} />
        <polyline points={line('hglM')} fill="none" stroke={PALETTE[0]} strokeWidth={2.5} />
        <polyline points={line('eglM')} fill="none" stroke={PALETTE[1]} strokeWidth={1.5} strokeDasharray="5 4" />
        {pts.map((p) => <circle key={p.node.uid} cx={X(p.s)} cy={Y(p.hglM)} r={3} fill={PALETTE[0]}><title>{`${p.node.name}: HGL ${U.fu('head', p.hglM, 2)}, z ${U.fu('elevation', p.elevationM, 2)}`}</title></circle>)}
        <rect x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} fill="none" stroke="var(--fg)" />
        <text x={(m.l + W - m.r) / 2} y={H - 8} textAnchor="middle" fill="var(--fg)">Distance along path [{U.u('length')}]</text>
        <text transform={`translate(16 ${(m.t + H - m.b) / 2}) rotate(-90)`} textAnchor="middle" fill="var(--fg)">Elevation / head [{U.u('head')}]</text>
        <g transform={`translate(${m.l + 10} ${m.t + 14})`}>
          <line x1={0} x2={22} y1={0} y2={0} stroke={PALETTE[0]} strokeWidth={2.5} /><text x={28} y={4} fill="var(--fg)">Hydraulic grade (HGL)</text>
          <line x1={0} x2={22} y1={16} y2={16} stroke={PALETTE[1]} strokeWidth={1.5} strokeDasharray="5 4" /><text x={28} y={20} fill="var(--fg)">Energy grade (EGL)</text>
          <line x1={0} x2={22} y1={32} y2={32} stroke="var(--muted)" strokeWidth={2} /><text x={28} y={36} fill="var(--fg)">Elevation</text>
        </g>
      </svg>
    );
  }

  return (
    <div className="profile">
      <div className="grid">
        {select(from, setFrom, 'From', 'profile:from')}
        {select(to, setTo, 'To', 'profile:to')}
      </div>
      {from === to ? <p className="hint">Choose two different nodes.</p> : !path ? <div className="banner warn">These nodes are not connected.</div> : !result ? <div className="banner warn">No solution to show.</div> : svg}
      {pts && pts.length > 1 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Node</th><th>Distance [{U.u('length')}]</th><th>z [{U.u('elevation')}]</th><th>HGL [{U.u('head')}]</th><th>Pressure [{U.u('pressure')}]</th></tr></thead>
            <tbody>
              {pts.map((p) => (
                <tr key={p.node.uid}>
                  <td>{p.node.name}</td>
                  <td>{U.f('length', p.s, 1)}</td>
                  <td>{U.f('elevation', p.elevationM, 2)}</td>
                  <td>{U.f('head', p.hglM, 2)}</td>
                  <td>{U.f('pressure', (result?.nodes.find((n) => n.id === p.node.name)?.gaugePressurePa ?? NaN) / 1000, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
