import { useRef, useState } from 'react';
import { DEFAULT_CRITERIA, mergeCriteria, saveCriteria, type DesignCriteria } from '../ai/criteria';
import { buildConcepts, chatTurn, diagnose, generateFromDescription, proposeConcepts, type Concept, type Diagnosis, type FlowContext, type FlowResult } from '../ai/flows';
import { AnthropicProvider, DEFAULT_MODEL, saveAiSettings, type AiSettings, type LlmMessage } from '../ai/llm';
import { DEFAULT_LIMITS, type LogEntry } from '../ai/tools';
import type { Draft } from '../ai/types';
import type { ProjectUI } from '../model';

interface Props {
  main: ProjectUI;
  drafts: Draft[];
  activeDraftId?: string;
  settings: AiSettings;
  onSettings: (s: AiSettings) => void;
  criteria: DesignCriteria;
  onCriteria: (c: DesignCriteria) => void;
  onDrafts: (d: Draft[]) => void;
  /** Show the created drafts to the user. */
  onShow: (draftIds: string[]) => void;
}

type ChatLine = { role: 'user' | 'assistant'; text: string; drafts?: string[] };

export function AiPanel({ main, drafts, activeDraftId, settings, onSettings, criteria, onCriteria, onDrafts, onShow }: Props) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'ideas' | 'all'>('ideas');
  const [nIdeas, setNIdeas] = useState(4);
  const [diag, setDiag] = useState<Diagnosis>();
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [history, setHistory] = useState<LlmMessage[]>([]);
  const [msg, setMsg] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState<string>();
  const [perVariant, setPerVariant] = useState({ calls: DEFAULT_LIMITS.maxToolCalls, solves: DEFAULT_LIMITS.maxSolves });
  const [critText, setCritText] = useState(() => JSON.stringify(criteria, null, 2));
  const abort = useRef<AbortController | undefined>(undefined);

  const hasKey = settings.apiKey.trim().length > 0;
  const ctx = (): FlowContext => {
    abort.current = new AbortController();
    return {
      provider: new AnthropicProvider({ apiKey: settings.apiKey, model: settings.model || DEFAULT_MODEL }),
      main,
      drafts,
      criteria,
      limits: { maxToolCalls: perVariant.calls, maxSolves: perVariant.solves },
      signal: abort.current.signal,
      onDrafts,
      onProgress: setProgress,
    };
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    setProgress('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? (e.name === 'AbortError' ? 'Stopped.' : e.message) : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const report = (r: FlowResult, label: string) => {
    setLog((l) => [...l, ...r.log]);
    setSummary(`${label}: ${r.created.length} draft(s) created, ${r.usage.toolCalls} tool calls, ${r.usage.solves} solves${r.stoppedBy !== 'done' ? `, stopped by ${r.stoppedBy}` : ''}.`);
    if (r.created.length) onShow(r.created.map((d) => d.id));
    else setError('The AI did not create a draft. Check the log below and try rephrasing.');
  };

  const generate = () => run('Generating a draft…', async () => report(await generateFromDescription(ctx(), description.trim()), 'Generate'));

  const doDiagnose = () => {
    const d = diagnose(main, criteria);
    setDiag(d);
    setConcepts([]);
    setPicked(new Set());
    return d;
  };

  const solveWithAi = () =>
    run('Diagnosing…', async () => {
      const d = doDiagnose();
      if (!d.solved) return;
      setProgress('Asking for ideas…');
      const { concepts: cs, log: l } = await proposeConcepts(ctx(), d, nIdeas);
      setLog((x) => [...x, ...l]);
      setConcepts(cs);
      if (mode === 'ideas') {
        setPicked(new Set());
        return; // wait for the user to pick
      }
      setPicked(new Set(cs.map((_, i) => i)));
      setProgress(`Building ${cs.length} variants…`);
      report(await buildConcepts(ctx(), cs, d), 'Solve every way');
    });

  const buildPicked = () =>
    run('Building the chosen ideas…', async () => {
      const chosen = concepts.filter((_, i) => picked.has(i));
      if (!chosen.length || !diag) return;
      report(await buildConcepts(ctx(), chosen, diag), 'Ideas first');
    });

  const send = () => {
    const m = msg.trim();
    if (!m) return;
    setMsg('');
    setChatLines((c) => [...c, { role: 'user', text: m }]);
    void run('Thinking…', async () => {
      const r = await chatTurn(ctx(), history, m, activeDraftId);
      setHistory(r.history);
      setLog((l) => [...l, ...r.log]);
      setChatLines((c) => [...c, { role: 'assistant', text: r.text || '(no reply)', drafts: r.created.map((d) => d.name) }]);
      if (r.created.length) onShow(r.created.map((d) => d.id));
    });
  };

  const applyCriteria = () => {
    try {
      const c = mergeCriteria(JSON.parse(critText));
      saveCriteria(c);
      onCriteria(c);
      setError(undefined);
    } catch (e) {
      setError(`Design criteria not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const downloadLog = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ model: settings.model, exportedAt: new Date().toISOString(), entries: log }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ai-run-log.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="ai">
      <details className="panel" open={!hasKey}>
        <summary>AI settings {hasKey ? '' : '(add your API key to start)'}</summary>
        <div className="grid">
          <label className="field wide">
            <span>Anthropic API key (kept in this browser only)</span>
            <input type="password" autoComplete="off" value={settings.apiKey} placeholder="sk-ant-…" onChange={(e) => { const s = { ...settings, apiKey: e.target.value }; onSettings(s); saveAiSettings(s); }} />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={settings.model} onChange={(e) => { const s = { ...settings, model: e.target.value }; onSettings(s); saveAiSettings(s); }} />
          </label>
          <label className="field"><span>Tool calls per variant (cap)</span><input type="number" min={5} max={300} value={perVariant.calls} onChange={(e) => setPerVariant((p) => ({ ...p, calls: Math.max(5, Number(e.target.value) || 5) }))} /></label>
          <label className="field"><span>Solver runs per variant (cap)</span><input type="number" min={1} max={200} value={perVariant.solves} onChange={(e) => setPerVariant((p) => ({ ...p, solves: Math.max(1, Number(e.target.value) || 1) }))} /></label>
        </div>
        <p className="hint">The key is sent only to api.anthropic.com from your browser. Anyone with access to this browser profile could read it, so use a key you can revoke.</p>
        <details>
          <summary>Design criteria (company standards)</summary>
          <p className="hint">Limits and defaults the AI follows, and the rates for the rough cost. The values shipped are generic placeholders.</p>
          <textarea className="code" rows={14} value={critText} onChange={(e) => setCritText(e.target.value)} spellCheck={false} />
          <div className="toolbar">
            <button onClick={applyCriteria}>Save criteria</button>
            <button onClick={() => { setCritText(JSON.stringify(DEFAULT_CRITERIA, null, 2)); onCriteria(DEFAULT_CRITERIA); saveCriteria(DEFAULT_CRITERIA); }}>Reset to defaults</button>
          </div>
        </details>
      </details>

      {error && <div className="banner error">{error}</div>}
      {busy && (
        <div className="banner warn">
          {busy} {progress && <small>{progress.slice(0, 160)}</small>}
          <button style={{ marginLeft: 12 }} onClick={() => abort.current?.abort()}>Stop</button>
        </div>
      )}
      {summary && !busy && <div className="banner ok">{summary}</div>}

      <section className="panel">
        <h3>1. Generate a network from a description</h3>
        <p className="hint">Describe the system, flows and pressures. The AI builds a <b>draft</b> (your current network is not touched), lists its assumptions, and you accept or reject it item by item in the Drafts tab.</p>
        <textarea rows={4} value={description} placeholder="e.g. Pump water from a ground tank to three taps on the first floor, 2 L/s each, at least 150 kPa at each tap. 6 m static lift, about 40 m of pipe." onChange={(e) => setDescription(e.target.value)} />
        <div className="toolbar"><button className="primary" disabled={!hasKey || !!busy || !description.trim()} onClick={generate}>Generate draft</button></div>
      </section>

      <section className="panel">
        <h3>2. Solve with AI</h3>
        <p className="hint">Checks your current network against your targets, then proposes fixes as separate drafts. The solver decides what passes.</p>
        <div className="toolbar">
          <label><input type="radio" checked={mode === 'ideas'} onChange={() => setMode('ideas')} /> Ideas first (I pick)</label>
          <label><input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} /> Solve every way</label>
          <label>Ideas: <input type="number" min={2} max={6} value={nIdeas} onChange={(e) => setNIdeas(Math.min(6, Math.max(2, Number(e.target.value) || 3)))} style={{ width: 50 }} /></label>
          <button onClick={doDiagnose} disabled={!!busy}>Diagnose only</button>
          <button className="primary" disabled={!hasKey || !!busy || main.nodes.length === 0} onClick={solveWithAi}>{mode === 'ideas' ? 'Diagnose and suggest ideas' : 'Diagnose and build every variant'}</button>
        </div>
        {diag && (
          <div className="diagnosis">
            <h4>Diagnosis</h4>
            <ul>{diag.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </div>
        )}
        {concepts.length > 0 && (
          <div className="concepts">
            <h4>Ideas</h4>
            <ul>
              {concepts.map((c, i) => (
                <li key={i}>
                  <label>
                    <input type="checkbox" checked={picked.has(i)} disabled={mode === 'all' || !!busy} onChange={() => setPicked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })} />
                    <b>{c.title}</b>: {c.reasoning}
                  </label>
                </li>
              ))}
            </ul>
            {mode === 'ideas' && <button className="primary" disabled={!hasKey || !!busy || picked.size === 0} onClick={buildPicked}>Build {picked.size} chosen idea(s) as drafts</button>}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>3. Chat</h3>
        <p className="hint">Ask why something happens or ask for a change ("add a bypass around that valve"). Changes always go into a draft{activeDraftId ? ' (the one open in the Drafts tab)' : ''}.</p>
        <div className="chat">
          {chatLines.map((l, i) => (
            <div key={i} className={`bubble ${l.role}`}>
              {l.text}
              {l.drafts && l.drafts.length > 0 && <small> Draft: {l.drafts.join(', ')}</small>}
            </div>
          ))}
        </div>
        <div className="toolbar">
          <input className="grow" value={msg} placeholder="Ask a question or request an edit…" onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
          <button className="primary" disabled={!hasKey || !!busy || !msg.trim()} onClick={send}>Send</button>
          <button disabled={!!busy || chatLines.length === 0} onClick={() => { setChatLines([]); setHistory([]); }}>Clear</button>
        </div>
      </section>

      <details className="panel">
        <summary>Run log ({log.length} entries)</summary>
        <p className="hint">Every tool call, solver run and model turn, for auditing.</p>
        <div className="toolbar"><button disabled={!log.length} onClick={downloadLog}>Download log (JSON)</button><button disabled={!log.length} onClick={() => setLog([])}>Clear</button></div>
        <ol className="runlog">
          {log.map((l, i) => (
            <li key={i} className={`${l.kind} ${l.ok === false ? 'bad' : ''}`}>
              <b>{l.kind}</b> {l.name ?? ''} {l.ok === false ? '✗' : ''} <small>{l.note ?? (typeof l.output === 'string' ? l.output.slice(0, 160) : JSON.stringify(l.output ?? '').slice(0, 160))}</small>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
