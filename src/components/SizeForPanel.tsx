import { useState } from 'react';
import type { Target } from '../ai/types';
import { DEFAULT_SOLVE_SETTINGS, solveForTargets, type SolveOutcome, type SolveSettings } from '../autosolve';
import type { EdgeUI, ProjectUI } from '../model';
import { NumField } from './NumField';
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
export function SizeForPanel({ project, edge, locked, onApply }: { project: ProjectUI; edge: EdgeUI; locked: ReadonlySet<string>; onApply: (p: ProjectUI, summary: string) => void }) {
  const { settings, what } = settingsFor(edge);
  const [mode, setMode] = useState<'flow' | 'pressure'>('pressure');
  const [nodeUid, setNodeUid] = useState(edge.to);
  const [flowLps, setFlowLps] = useState(5);
  const [kPa, setKPa] = useState(200);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SolveOutcome>();
  const node = project.nodes.find((n) => n.uid === nodeUid) ?? project.nodes[0];

  const run = async () => {
    if (!node) return;
    setBusy(true);
    setOutcome(undefined);
    const target: Target = mode === 'flow' ? { id: 'size-for', type: 'flow', nodeUid: node.uid, minLps: flowLps } : { id: 'size-for', type: 'pressure', nodeUid: node.uid, minKPaG: kPa };
    try {
      setOutcome(await solveForTargets(project, [target], settings, locked, {}, new Set([edge.uid])));
    } finally {
      setBusy(false);
    }
  };
  const ok = outcome && (outcome.status === 'solved' || outcome.status === 'already-passing');

  return (
    <details className="sizing size-for">
      <summary>Size this for a flow or pressure ({what})</summary>
      <div className="grid">
        <label className="field"><span>Goal</span>
          <select value={mode} onChange={(e) => { setMode(e.target.value as 'flow' | 'pressure'); setOutcome(undefined); }}>
            <option value="pressure">Pressure at a node</option>
            <option value="flow">Flow delivered at a node</option>
          </select>
        </label>
        <label className="field"><span>At node</span>
          <select value={node?.uid ?? ''} onChange={(e) => { setNodeUid(e.target.value); setOutcome(undefined); }}>
            {project.nodes.map((n) => <option key={n.uid} value={n.uid}>{n.name}</option>)}
          </select>
        </label>
        {mode === 'pressure' ? <PressureField label="At least (gauge)" value={kPa} onChange={(v) => { setKPa(v); setOutcome(undefined); }} /> : <NumField label="At least" q="flow" value={flowLps} onChange={(v) => { v > 0 && setFlowLps(v); setOutcome(undefined); }} />}
      </div>
      <div className="toolbar"><button className="primary" disabled={busy || !node} onClick={() => void run()}>{busy ? 'Working…' : mode === 'pressure' ? 'Size for pressure' : 'Size for flow'}</button></div>
      {outcome && (
        <>
          <div className={`banner ${ok ? 'ok' : 'warn'}`}>
            {outcome.status === 'already-passing' ? 'Already meets this goal. Nothing to change.' : ok ? 'This item can meet the goal.' : outcome.status === 'nothing-allowed' ? 'This item cannot be changed (it, or a node it joins, is locked, or it has no other sizes to try).' : 'This item alone cannot meet the goal. Closest it can get is shown.'}
            {outcome.after[0] && <> Result: {outcome.after[0].text}.</>}
          </div>
          {outcome.changes.map((c) => <p key={c.parameter}>{c.parameter}: {c.from} → <b>{c.to}</b></p>)}
          {outcome.changes.length > 0 && <button onClick={() => { onApply(outcome.project, `${edge.name}: ${outcome.changes.map((c) => `${c.parameter} ${c.to}`).join(', ')}`); setOutcome(undefined); }}>Apply</button>}
        </>
      )}
    </details>
  );
}
