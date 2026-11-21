import { useMemo, useState } from 'react';
import { analyse, compareAll, rank, verdict, type Column } from '../ai/compare';
import type { DesignCriteria } from '../ai/criteria';
import { diffDraft, highlightMap } from '../ai/drafts';
import type { Draft, DiffItem } from '../ai/types';
import { useUnits } from '../units';
import type { ProjectUI } from '../model';
import { Canvas, type Selection } from './Canvas';

interface Props {
  main: ProjectUI;
  drafts: Draft[];
  criteria: DesignCriteria;
  /** Currently open sub-tab: 'compare' or a draft id. */
  tab: string;
  onTab: (t: string) => void;
  onAccept: (draftId: string, keys: Set<string> | 'all') => string[];
  onDiscard: (draftId: string) => void;
}

const badge = (c: Column) => (!c.solved ? '⚠' : c.allPass ? '✓' : '✗');

export function DraftsView({ main, drafts, criteria, tab, onTab, onAccept, onDiscard }: Props) {
  const live = drafts.filter((d) => d.status !== 'discarded');
  const columns = useMemo(() => compareAll(main, live, criteria), [main, drafts, criteria]); // eslint-disable-line react-hooks/exhaustive-deps
  const draft = live.find((d) => d.id === tab);
  return (
    <div className="drafts">
      <nav className="tabs sub" aria-label="Drafts">
        <button className={tab === 'compare' ? 'active' : ''} onClick={() => onTab('compare')}>Comparison</button>
        {live.map((d) => {
          const c = columns.find((x) => x.id === d.id);
          return (
            <button key={d.id} className={tab === d.id ? 'active' : ''} onClick={() => onTab(d.id)} title={d.rationale}>
              {d.name} {c && <span className={`badge ${c.allPass ? 'ok' : 'bad'}`}>{badge(c)}</span>}
              {d.status !== 'open' && <small> ({d.status})</small>}
            </button>
          );
        })}
      </nav>
      {live.length === 0 && <p className="hint">No drafts yet. Use the AI assistant tab to generate or solve with AI, and the drafts appear here.</p>}
      {tab === 'compare' || !draft ? <Comparison columns={columns} /> : <DraftDetail main={main} draft={draft} column={columns.find((c) => c.id === draft.id)!} onAccept={onAccept} onDiscard={onDiscard} />}
    </div>
  );
}

// ------------------------------------------------------------------ comparison
function Comparison({ columns }: { columns: Column[] }) {
  const U = useUnits();
  if (columns.length < 2) return null;
  const ranked = rank(columns.filter((c) => c.status !== 'main'));
  const best = ranked[0]?.id;
  const targetRows = new Map<string, string>();
  for (const c of columns) for (const s of c.statuses) targetRows.set(s.targetId, s.label);
  const pumpNames = [...new Set(columns.flatMap((c) => c.pumps.map((p) => p.name)))];
  const cell = (c: Column, node: React.ReactNode) => <td key={c.id} className={c.id === best ? 'best' : ''}>{node}</td>;
  return (
    <div>
      <div className={`banner ${ranked.some((c) => c.allPass) ? 'ok' : 'warn'}`}>{verdict(columns)}</div>
      <div className="table-wrap">
        <table className="cmp">
          <thead>
            <tr><th />{columns.map((c) => <th key={c.id} className={c.id === best ? 'best' : ''}>{c.name}{c.id === best && ' ★'}</th>)}</tr>
          </thead>
          <tbody>
            <tr><th>Solved</th>{columns.map((c) => cell(c, c.solved ? 'yes' : <span className="bad" title={c.error}>no: {c.error?.slice(0, 60)}</span>))}</tr>
            <tr><th>All targets met</th>{columns.map((c) => cell(c, c.allPass ? <span className="badge ok">PASS</span> : <span className="badge bad">FAIL</span>))}</tr>
            {[...targetRows].map(([id, label]) => (
              <tr key={id}>
                <th>{label}</th>
                {columns.map((c) => {
                  const s = c.statuses.find((x) => x.targetId === id);
                  return cell(c, s ? <span className={s.pass ? 'pass-text' : 'fail-text'}>{s.pass ? '✓' : '✗'} {s.text}</span> : '–');
                })}
              </tr>
            ))}
            {pumpNames.map((n) => (
              <tr key={n}>
                <th>{n}: duty</th>
                {columns.map((c) => {
                  const p = c.pumps.find((x) => x.name === n);
                  return cell(c, p ? `${U.fu('flow', p.flowLps, 1)} @ ${U.fu('head', p.headM, 1)}${p.pctBep !== undefined ? ` · ${p.pctBep.toFixed(0)} % BEP` : ''}${p.shaftKw !== undefined ? ` · ${U.fu('power', p.shaftKw, 2)}` : ''}` : '–');
                })}
              </tr>
            ))}
            <tr><th>Head burned across valves / orifices</th>{columns.map((c) => cell(c, c.solved ? `${U.fu('head', c.headBurnedM, 1)}${c.burnedBy[0] ? ` (mostly ${c.burnedBy[0].name})` : ''}` : '–'))}</tr>
            <tr><th>Rough capital cost (placeholder rates)</th>{columns.map((c) => cell(c, c.solved ? Math.round(c.cost).toLocaleString() : '–'))}</tr>
            <tr><th>Warnings</th>{columns.map((c) => cell(c, c.warnings.length ? <details><summary>{c.warnings.length}</summary><ul className="warn-list">{c.warnings.map((w, i) => <li key={i}>{w.text}</li>)}</ul></details> : '0'))}</tr>
            <tr><th>Changes vs parent</th>{columns.map((c) => cell(c, c.status === 'main' ? '–' : c.changes))}</tr>
            <tr><th>Concept</th>{columns.map((c) => cell(c, <small>{c.rationale || '–'}</small>))}</tr>
          </tbody>
        </table>
      </div>
      {columns.some((c) => c.feasibility.length > 0) && (
        <div className="banner warn">{[...new Set(columns.flatMap((c) => c.feasibility))].join(' ')}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------- detail
function DraftDetail({ main, draft, column, onAccept, onDiscard }: { main: ProjectUI; draft: Draft; column: Column; onAccept: Props['onAccept']; onDiscard: Props['onDiscard'] }) {
  const U = useUnits();
  const items = useMemo(() => diffDraft(draft), [draft]);
  const applied = new Set(draft.appliedKeys ?? []);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const { marks, removed } = useMemo(() => highlightMap(items), [items]);
  const removedStuff = useMemo(() => ({ nodes: draft.base.project.nodes.filter((n) => removed.includes(n.uid)), edges: draft.base.project.edges.filter((e) => removed.includes(e.uid)) }), [draft, removed]);
  const canvasProject: ProjectUI = useMemo(() => ({ ...draft.project, images: main.images }), [draft.project, main.images]);
  const editable = draft.status === 'open';
  const pending = items.filter((i) => !applied.has(i.key));
  const toggle = (k: string) => setChosen((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const accept = (keys: Set<string> | 'all') => { setNotes(onAccept(draft.id, keys)); setChosen(new Set()); };

  const kindLabel: Record<DiffItem['kind'], string> = { added: '+ added', removed: '− removed', modified: '~ changed' };
  return (
    <div className="draft-detail">
      <div className="draft-head">
        <h3>{draft.name} <small>{draft.source} · {draft.status}</small></h3>
        <p>{draft.rationale}</p>
        <div className="toolbar">
          <button className="primary" disabled={!editable || pending.length === 0} onClick={() => accept('all')} title="Merge every change of this draft into the main model">Pick: merge into main</button>
          <button disabled={!editable || chosen.size === 0} onClick={() => accept(chosen)}>Accept selected ({chosen.size})</button>
          <button disabled={!editable || pending.length === 0} onClick={() => setChosen(new Set(pending.map((i) => i.key)))}>Select all</button>
          <button onClick={() => onDiscard(draft.id)}>Discard draft</button>
        </div>
        {!editable && <div className="banner warn">This draft is {draft.status === 'merged' ? 'merged into main' : 'kept as read-only reference'}.</div>}
        {notes.map((n, i) => <div key={i} className="banner warn">{n}</div>)}
      </div>

      <div className={`banner ${column.allPass ? 'ok' : 'warn'}`}>
        {!column.solved ? `Does not solve: ${column.error}` : column.allPass ? (column.statuses.length ? 'All targets pass (checked by the solver).' : 'Solves. This draft has no targets, so there is nothing to pass or fail.') : `${column.statuses.filter((s) => !s.pass).length} target(s) fail.`}
      </div>

      <div className="draft-grid">
        <div>
          <Canvas
            project={canvasProject}
            selection={selection}
            tool="select"
            calib={[]}
            readOnly
            highlight={marks}
            removed={removedStuff}
            onSelect={setSelection}
            onTool={() => {}}
            onAddNode={() => {}}
            onMoveNode={() => {}}
            onMoveImage={() => {}}
            onConnect={() => {}}
            onInsert={() => {}}
            onPlace={() => {}}
            onConnectNew={() => {}}
            onConnectBlank={() => {}}
            onReverse={() => {}}
            onZoomImage={() => {}}
            onPending={() => {}}
            onCalibPoint={() => {}}
          />
          <p className="legend"><span className="lg added" /> added <span className="lg modified" /> changed <span className="lg removed" /> removed</p>
        </div>
        <div className="draft-side">
          <h4>Changes ({items.length})</h4>
          {items.length === 0 && <p className="hint">No changes against the parent.</p>}
          <ul className="diff-list">
            {items.map((i) => (
              <li key={i.key} className={`diff ${i.kind}`}>
                <label>
                  <input type="checkbox" disabled={!editable || applied.has(i.key)} checked={chosen.has(i.key)} onChange={() => toggle(i.key)} />
                  <b>{kindLabel[i.kind]}</b> {i.label} {applied.has(i.key) && <em>(applied)</em>}
                </label>
                {i.details.map((d) => <div key={d} className="detail">{d}</div>)}
                {i.reasons.map((r) => <div key={r} className="reason">Why: {r}</div>)}
              </li>
            ))}
          </ul>

          <h4>Targets</h4>
          {column.statuses.length === 0 && <p className="hint">None.</p>}
          <ul className="status-list">
            {column.statuses.map((s) => <li key={s.targetId} className={s.pass ? 'pass-text' : 'fail-text'}>{s.pass ? '✓' : '✗'} {s.label}: {s.text}</li>)}
          </ul>

          <h4>Key numbers</h4>
          <ul className="status-list">
            {column.pumps.map((p) => <li key={p.name}>{p.name}: {U.fu('flow', p.flowLps, 1)} at {U.fu('head', p.headM, 1)}{p.pctBep !== undefined ? `, ${p.pctBep.toFixed(0)} % of BEP` : ''}{p.shaftKw !== undefined ? `, ${U.fu('power', p.shaftKw, 2)}` : ''}</li>)}
            <li>Head burned across valves/orifices: {U.fu('head', column.headBurnedM, 1)}</li>
            <li>Rough cost: {Math.round(column.cost).toLocaleString()} (placeholder rates)</li>
          </ul>
          {column.warnings.length > 0 && <><h4>Warnings</h4><ul className="warn-list">{column.warnings.map((w, i) => <li key={i}>{w.text}</li>)}</ul></>}

          <h4>Assumptions ({draft.assumptions.length})</h4>
          {draft.assumptions.length === 0 && <p className="hint">None recorded.</p>}
          <ul className="status-list">{draft.assumptions.map((a) => <li key={a.id}><b>{a.category}:</b> {a.text}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}

export { analyse };
