import type { Target, TargetStatus } from '../ai/types';
import { newTargetId } from '../ai/targets';
import type { HydraulicProject } from '../model';
import type { Quantity } from '../units';
import { NumField } from './NumField';

interface Props {
  project: HydraulicProject;
  targets: Target[];
  statuses: TargetStatus[];
  onChange: (t: Target[]) => void;
}

const TYPES: { id: Target['type']; label: string }[] = [
  { id: 'flow', label: 'Required flow at a node' },
  { id: 'pressure', label: 'Residual pressure at a node' },
  { id: 'velocity', label: 'Velocity limit' },
  { id: 'pumpRange', label: 'Pump operating range' },
  { id: 'npsh', label: 'NPSH margin' },
];

export function TargetsPanel({ project, targets, statuses, onChange }: Props) {
  const nodes = project.nodes;
  const pumps = project.edges.filter((e) => e.kind === 'pump');
  const lines = project.edges.filter((e) => e.kind === 'pipe' || e.kind === 'valve');
  const set = (t: Target) => onChange(targets.map((x) => (x.id === t.id ? t : x)));
  const add = (type: Target['type']) => {
    const id = newTargetId();
    const node = nodes.find((n) => n.kind === 'junction') ?? nodes[0];
    const pump = pumps[0];
    const t: Target | undefined =
      type === 'flow' && node ? { id, type, nodeUid: node.uid, minLps: 1 }
      : type === 'pressure' && node ? { id, type, nodeUid: node.uid, minKPaG: 100 }
      : type === 'velocity' ? { id, type, scope: 'all', maxMps: project.maxVelocityMps || 3 }
      : type === 'pumpRange' && pump ? { id, type, pumpUid: pump.uid, minPctBep: 70, maxPctBep: 120, withinCurveData: true }
      : type === 'npsh' ? { id, type, pumpUid: 'all', marginM: project.npshMarginM }
      : undefined;
    if (t) onChange([...targets, t]);
  };
  const stat = (id: string) => statuses.find((s) => s.targetId === id);

  const nodeSelect = (t: Extract<Target, { nodeUid: string }>) => (
    <label className="field">
      <span>Node</span>
      <select value={t.nodeUid} onChange={(e) => set({ ...t, nodeUid: e.target.value })}>
        {nodes.map((n) => <option key={n.uid} value={n.uid}>{n.name}</option>)}
      </select>
    </label>
  );
  const pumpSelect = (t: Extract<Target, { pumpUid: string }>, all: boolean) => (
    <label className="field">
      <span>Pump</span>
      <select value={t.pumpUid} onChange={(e) => set({ ...t, pumpUid: e.target.value })}>
        {all && <option value="all">All pumps</option>}
        {pumps.map((n) => <option key={n.uid} value={n.uid}>{n.name}</option>)}
      </select>
    </label>
  );
  const optNum = (label: string, q: Quantity | undefined, unit: string | undefined, value: number | undefined, on: (v: number | undefined) => void) => (
    <div className="field opt">
      <label><input type="checkbox" checked={value !== undefined} onChange={(e) => on(e.target.checked ? 0 : undefined)} /> {label}</label>
      {value !== undefined && <NumField q={q} unit={unit} value={value} onChange={on} />}
    </div>
  );

  return (
    <div className="targets">
      <p className="hint">Targets are checked against the solver every time the network changes. Pressures are gauge. The AI works toward these.</p>
      {targets.length === 0 && <p className="hint">No targets yet. Add one below.</p>}
      {targets.map((t) => {
        const s = stat(t.id);
        return (
          <div key={t.id} className={`target-row ${s ? (s.pass ? 'pass' : 'fail') : ''}`}>
            <div className="target-head">
              <b>{TYPES.find((x) => x.id === t.type)?.label}</b>
              <span className={`badge ${s?.pass ? 'ok' : 'bad'}`}>{s ? (s.pass ? 'PASS' : 'FAIL') : '–'}</span>
              <span className="target-text">{s?.text}</span>
              <button onClick={() => onChange(targets.filter((x) => x.id !== t.id))} aria-label="Remove target">Remove</button>
            </div>
            <div className="grid">
              {t.type === 'flow' && <>{nodeSelect(t)}<NumField label="Required flow" q="flow" value={t.minLps} onChange={(v) => set({ ...t, minLps: v })} /></>}
              {t.type === 'pressure' && <>
                {nodeSelect(t)}
                {optNum('Minimum', 'pressure', undefined, t.minKPaG, (v) => set({ ...t, minKPaG: v }))}
                {optNum('Maximum', 'pressure', undefined, t.maxKPaG, (v) => set({ ...t, maxKPaG: v }))}
              </>}
              {t.type === 'velocity' && <>
                <label className="field"><span>Applies to</span>
                  <select value={t.scope} onChange={(e) => set({ ...t, scope: e.target.value })}>
                    <option value="all">All pipes and valves</option>
                    {lines.map((n) => <option key={n.uid} value={n.uid}>{n.name}</option>)}
                  </select>
                </label>
                <NumField label="Max velocity" q="velocity" value={t.maxMps} onChange={(v) => set({ ...t, maxMps: v })} />
                {optNum('Min velocity', 'velocity', undefined, t.minMps, (v) => set({ ...t, minMps: v }))}
              </>}
              {t.type === 'pumpRange' && <>
                {pumpSelect(t, false)}
                {optNum('Min % of BEP', undefined, '%', t.minPctBep, (v) => set({ ...t, minPctBep: v }))}
                {optNum('Max % of BEP', undefined, '%', t.maxPctBep, (v) => set({ ...t, maxPctBep: v }))}
                <div className="field opt"><label><input type="checkbox" checked={!!t.withinCurveData} onChange={(e) => set({ ...t, withinCurveData: e.target.checked })} /> Stay inside the curve (no runout)</label></div>
              </>}
              {t.type === 'npsh' && <>{pumpSelect(t, true)}<NumField label="Required margin" q="head" value={t.marginM} onChange={(v) => set({ ...t, marginM: v })} /></>}
            </div>
          </div>
        );
      })}
      <div className="toolbar">
        <span>Add target:</span>
        {TYPES.map((t) => <button key={t.id} onClick={() => add(t.id)}>{t.label}</button>)}
      </div>
    </div>
  );
}
