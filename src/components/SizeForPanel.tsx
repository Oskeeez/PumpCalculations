import { useState } from 'react';
import type { Target } from '../ai/types';
import { DEFAULT_SOLVE_SETTINGS, solveForTargets, type SolveOutcome, type SolveSettings } from '../autosolve';
import type { EdgeUI, ProjectUI } from '../model';
import { NumField } from './NumField';
import type { Fluid } from '../solver/fluid';
import { pipeFlowState } from '../solver/pipe';
import { findSeries, smallestStandardSize, standardSeriesId, usePipeLibrary } from '../pipeLibrary';
import { PressureField } from './PressureField';

/** Which kind of change this item can offer, and the matching solver settings (everything else off). */
function settingsFor(e: EdgeUI): { settings: SolveSettings; what: string } {
  const off: SolveSettings = {
    ...DEFAULT_SOLVE_SETTINGS,
    pipes: { ...DEFAULT_SOLVE_SETTINGS.pipes, on: false },
    pumpSpeed: { ...DEFAULT_SOLVE_SETTINGS.pumpSpeed, on: false },
    trim: { ...DEFAULT_SOLVE_SETTINGS.trim, on: false },
    valves: { ...DEFAULT_SOLVE_SETTINGS.valves, on: false },
    orifices: { on: false },
    regulators: { ...DEFAULT_SOLVE_SETTINGS.regulators, on: false },
    tanks: { ...DEFAULT_SOLVE_SETTINGS.tanks, on: false },
    marginFraction: 0,
  };
  if (e.kind === 'pipe') return { settings: { ...off, pipes: { ...off.pipes, on: true } }, what: 'diameter' };
  if (e.kind === 'pump') return { settings: { ...off, pumpSpeed: { ...off.pumpSpeed, on: true } }, what: 'speed' };
  if (e.lossType === 'orifice') return { settings: { ...off, orifices: { on: true } }, what: 'bore' };
  if (e.controlType !== 'none') return { settings: { ...off, regulators: { ...off.regulators, on: true } }, what: 'set point' };
  return { settings: { ...off, valves: { ...off.valves, on: true } }, what: 'resistance' };
}

/** "Size this for a flow or a pressure": changes only the selected item, using the same search as Solve for me. */
export function SizeForPanel({ project, edge, locked, onApply, flowLps, fluid }: { project: ProjectUI; edge: EdgeUI; locked: ReadonlySet<string>; onApply: (p: ProjectUI, summary: string) => void; flowLps?: number; fluid?: Fluid }) {
  const { settings } = settingsFor(edge);
  const [mode, setMode] = useState<'flow' | 'pressure' | 'limits'>('pressure');
  const lib = usePipeLibrary();
  const [seriesId, setSeriesId] = useState(standardSeriesId());
  const [maxV, setMaxV] = useState(project.maxVelocityMps || 3);
  const [maxHl, setMaxHl] = useState(0);
  const [pick, setPick] = useState<ReturnType<typeof smallestStandardSize> | null>();
  const [nodeUid, setNodeUid] = useState(edge.to);
  const [wantLps, setWantLps] = useState(5);
  const [kPa, setKPa] = useState(200);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SolveOutcome>();
  const node = project.nodes.find((n) => n.uid === nodeUid) ?? project.nodes[0];

  const run = async () => {
    if (!node) return;
    setBusy(true);
    setOutcome(undefined);
    const target: Target = mode === 'flow' ? { id: 'size-for', type: 'flow', nodeUid: node.uid, minLps: wantLps } : { id: 'size-for', type: 'pressure', nodeUid: node.uid, minKPaG: kPa };
    try {
      setOutcome(await solveForTargets(project, [target], settings, locked, {}, new Set([edge.uid])));
    } finally {
      setBusy(false);
    }
  };
  const runLimits = () => {
    if (flowLps === undefined || !fluid || edge.kind !== 'pipe') return;
    const hl = (idMm: number, rough: number | undefined) =>
      pipeFlowState({ lengthM: 100, innerDiameterM: idMm / 1000, roughnessM: (rough ?? edge.roughnessMm) / 1000, elevationChangeM: 0, fittingsK: [] }, fluid, flowLps / 1000).frictionHeadLoss;
    setPick(smallestStandardSize(findSeries(seriesId), flowLps, { maxVelocityMps: maxV, maxHeadLossPer100m: maxHl > 0 ? maxHl : undefined }, hl) ?? null);
  };
  const ok = outcome && (outcome.status === 'solved' || outcome.status === 'already-passing');

  return (
    <details className="sizing size-for">
      <summary>Size for flow or pressure</summary>
      <div className="grid">
        <label className="field"><span>Goal</span>
          <select value={mode} onChange={(e) => { setMode(e.target.value as 'flow' | 'pressure' | 'limits'); setOutcome(undefined); setPick(undefined); }}>
            <option value="pressure">Pressure at a node</option>
            <option value="flow">Flow delivered at a node</option>
            {edge.kind === 'pipe' && <option value="limits">Standard size for velocity / head loss</option>}
          </select>
        </label>
        {mode !== 'limits' && (
          <>
        <label className="field"><span>At node</span>
          <select value={node?.uid ?? ''} onChange={(e) => { setNodeUid(e.target.value); setOutcome(undefined); }}>
            {project.nodes.map((n) => <option key={n.uid} value={n.uid}>{n.name}</option>)}
          </select>
        </label>
        {mode === 'pressure' ? <PressureField label="At least (gauge)" value={kPa} onChange={(v) => { setKPa(v); setOutcome(undefined); }} /> : <NumField label="At least" q="flow" value={wantLps} onChange={(v) => { v > 0 && setWantLps(v); setOutcome(undefined); }} />}
          </>
        )}
        {mode === 'limits' && (
          <>
            <label className="field"><span>List</span>
              <select aria-label="Pipe list" value={seriesId} onChange={(e) => { setSeriesId(e.target.value); setPick(undefined); }}>
                {lib.all.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select>
            </label>
            <NumField label="Max velocity" q="velocity" value={maxV} onChange={(v) => { v > 0 && setMaxV(v); setPick(undefined); }} />
            <NumField label="Max head loss per 100 m (0 = none)" unit="m" value={maxHl} onChange={(v) => { v >= 0 && setMaxHl(v); setPick(undefined); }} />
          </>
        )}
      </div>
      {mode === 'limits' && edge.kind === 'pipe' ? (
        <>
          <div className="toolbar"><button className="primary" disabled={flowLps === undefined || !fluid} onClick={runLimits}>Find standard size</button></div>
          {pick === null && <div className="banner warn">No size in this list meets the limits at {flowLps?.toFixed(2)} L/s.</div>}
          {pick && (
            <>
              <div className="banner ok">{pick.size.nps}: {pick.velocityMps.toFixed(2)} m/s, {pick.headLossPer100m.toFixed(2)} m per 100 m, at {flowLps?.toFixed(2)} L/s</div>
              <button onClick={() => { onApply({ ...project, edges: project.edges.map((x) => (x.uid === edge.uid && x.kind === 'pipe' ? { ...x, diameterMm: pick.size.idMm, ...(pick.size.roughnessMm !== undefined ? { roughnessMm: pick.size.roughnessMm } : {}), ...(pick.size.ratingKPaG !== undefined ? { ratingKPaG: pick.size.ratingKPaG } : {}) } : x)) }, `${edge.name}: ${pick.size.nps}`); setPick(undefined); }}>Apply {pick.size.nps}</button>
            </>
          )}
        </>
      ) : (
      <div className="toolbar"><button className="primary" disabled={busy || !node} onClick={() => void run()}>{busy ? 'Working…' : mode === 'pressure' ? 'Size for pressure' : 'Size for flow'}</button></div>
      )}
      {mode !== 'limits' && outcome && (
        <>
          <div className={`banner ${ok ? 'ok' : 'warn'}`}>
            {outcome.status === 'already-passing' ? 'Already met.' : ok ? 'Goal can be met.' : outcome.status === 'nothing-allowed' ? 'Cannot change (locked, or no other sizes).' : 'Goal not reachable. Closest result shown.'}
            {outcome.after[0] && <> {outcome.after[0].text}</>}
          </div>
          {outcome.changes.map((c) => <p key={c.parameter}>{c.parameter}: {c.from} → <b>{c.to}</b></p>)}
          {outcome.changes.length > 0 && <button onClick={() => { onApply(outcome.project, `${edge.name}: ${outcome.changes.map((c) => `${c.parameter} ${c.to}`).join(', ')}`); setOutcome(undefined); }}>Apply</button>}
        </>
      )}
    </details>
  );
}
