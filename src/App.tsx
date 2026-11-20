import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Canvas, type Selection, type Tool } from './components/Canvas';
import { NodeEditor, PipeEditor, PumpEditor, ValveEditor } from './components/Editors';
import { NumField } from './components/NumField';
import { Results } from './components/Results';
import { EXPORT_THEME, SCREEN_THEME, pumpChartSvg, svgToPngBase64, CHART_H, CHART_W } from './curveChart';
import { useHistory } from './history';
import {
  blankProject,
  compute,
  defaultProject,
  hydraulicKey,
  newNode,
  newPipe,
  newPump,
  newValve,
  parseProject,
  serializeProject,
  syncUidCounter,
  type EdgeUI,
  type FluidUI,
  type NodeKind,
  type NodeUI,
  type ProjectUI,
} from './model';
import { FLUID_LIBRARY, fluidInfo } from './solver';

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: 'select', label: '↖ Select', title: 'Select and drag' },
  { id: 'tank', label: '▭ Tank', title: 'Place a tank (fixed-head boundary)' },
  { id: 'junction', label: '● Junction', title: 'Place a junction / demand node' },
  { id: 'pipe', label: '— Pipe', title: 'Connect two nodes with a pipe' },
  { id: 'valve', label: '⋈ Valve', title: 'Connect two nodes with a valve (K, Cv or Kv; optional check valve)' },
  { id: 'pump', label: '◉ Pump', title: 'Connect two nodes with a pump (suction → discharge)' },
];

const STORAGE_KEY = 'pipe-network-autosave-v1';

function loadInitial(): ProjectUI {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return parseProject(saved);
  } catch {
    /* storage unavailable or corrupt: fall back to the example */
  }
  return defaultProject();
}

export function App() {
  const { state: project, set: setProject, undo, redo, canUndo, canRedo } = useHistory<ProjectUI>(loadInitial);
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string }>();
  const fileInput = useRef<HTMLInputElement>(null);

  const key = hydraulicKey(project);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const computed = useMemo(() => compute(project), [key]);

  const chartSeries = computed.pumpCurves.map((c) => ({ name: c.name, pts: c.pts, op: c.op }));
  const chart = useMemo(
    () => (chartSeries.length ? { screen: pumpChartSvg(chartSeries, SCREEN_THEME), exportSvg: pumpChartSvg(chartSeries, EXPORT_THEME) } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [computed],
  );

  // Autosave (debounced). Failures (private mode, quota) are ignored: saving to a file still works.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, serializeProject(project));
      } catch {
        /* ignore */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [project]);

  const nodeName = (uid: string) => project.nodes.find((n) => n.uid === uid)?.name ?? '?';
  const setTooling = (t: Tool) => {
    setTool(t);
    setPending(undefined);
  };

  const addNode = (kind: NodeKind, x: number, y: number) => {
    const n = newNode(kind, x, y, project.nodes.map((q) => q.name));
    setProject((p) => ({ ...p, nodes: [...p.nodes, n] }));
    setSelection({ type: 'node', uid: n.uid });
  };
  const connect = (kind: 'pipe' | 'pump' | 'valve', from: string, to: string) => {
    const taken = project.edges.map((e) => e.name);
    const e = kind === 'pipe' ? newPipe(from, to, taken) : kind === 'pump' ? newPump(from, to, taken) : newValve(from, to, taken);
    setProject((p) => ({ ...p, edges: [...p.edges, e] }));
    setSelection({ type: 'edge', uid: e.uid });
  };
  const moveNode = (uid: string, x: number, y: number) => setProject((p) => ({ ...p, nodes: p.nodes.map((n) => (n.uid === uid ? { ...n, x, y } : n)) }), `drag:${uid}`);
  const updateNode = (n: NodeUI) => setProject((p) => ({ ...p, nodes: p.nodes.map((q) => (q.uid === n.uid ? n : q)) }), `node:${n.uid}`);
  const updateEdge = (e: EdgeUI) => setProject((p) => ({ ...p, edges: p.edges.map((q) => (q.uid === e.uid ? e : q)) }), `edge:${e.uid}`);
  const updateFluid = (patch: Partial<FluidUI>) => setProject((p) => ({ ...p, fluid: { ...p.fluid, ...patch } }), 'fluid');

  const deleteSelected = () => {
    if (!selection) return;
    setProject((p) =>
      selection.type === 'node'
        ? { ...p, nodes: p.nodes.filter((n) => n.uid !== selection.uid), edges: p.edges.filter((e) => e.from !== selection.uid && e.to !== selection.uid) }
        : { ...p, edges: p.edges.filter((e) => e.uid !== selection.uid) },
    );
    setSelection(null);
  };

  const replaceProject = (p: ProjectUI, text?: string) => {
    syncUidCounter(p);
    setProject(p);
    setSelection(null);
    setPending(undefined);
    setMessage(text ? { kind: 'info', text } : undefined);
  };

  const saveFile = () => {
    const url = URL.createObjectURL(new Blob([serializeProject(project)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pipe-network.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  const openFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      replaceProject(parseProject(await file.text()), `Opened ${file.name}. Undo (Ctrl+Z) returns to the previous network.`);
    } catch (err) {
      setMessage({ kind: 'error', text: `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && !typing && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        ev.shiftKey ? redo() : undo();
      } else if (mod && !typing && ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        redo();
      } else if (typing) return;
      else if (ev.key === 'Escape') {
        setPending(undefined);
        setTool('select');
      } else if (ev.key === 'Delete' || ev.key === 'Backspace') deleteSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selectByName = (name: string) => {
    const n = project.nodes.find((q) => q.name === name);
    if (n) return setSelection({ type: 'node', uid: n.uid });
    const e = project.edges.find((q) => q.name === name);
    if (e) setSelection({ type: 'edge', uid: e.uid });
  };

  const canExport = !!computed.result && computed.result.converged && !!computed.model;
  const exportXlsx = async () => {
    if (!canExport || !computed.model || !computed.result) return;
    setMessage(undefined);
    try {
      const png = chart ? await svgToPngBase64(chart.exportSvg) : undefined;
      const { buildNetworkWorkbook, workbookToBuffer } = await import('./excel/networkExport'); // lazy: keeps ExcelJS out of first load
      const wb = await buildNetworkWorkbook({ model: computed.model, result: computed.result, npshMarginM: project.npshMarginM, pumpCurves: computed.pumpCurves, chartPngBase64: png });
      const buf = await workbookToBuffer(wb);
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pipe-network.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage({ kind: 'error', text: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const selNode = selection?.type === 'node' ? project.nodes.find((n) => n.uid === selection.uid) : undefined;
  const selEdge = selection?.type === 'edge' ? project.edges.find((e) => e.uid === selection.uid) : undefined;
  const pumpFit = selEdge?.kind === 'pump' ? computed.pumpCurves.find((c) => c.name === selEdge.name)?.headFitRmse : undefined;
  const info = fluidInfo(project.fluid.id);
  const isCustom = project.fluid.id === 'custom';

  return (
    <div className="app">
      <header>
        <h1>Pipe Network Calculator</h1>
        <button className="primary" disabled={!canExport} onClick={exportXlsx} title={canExport ? '' : 'Needs a solved network'}>Export Excel</button>
      </header>

      <div className="menu" role="toolbar" aria-label="Project">
        <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
        <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)">↷ Redo</button>
        <span className="sep" />
        <button onClick={() => replaceProject(blankProject())} title="Start an empty network (Undo brings the old one back)">New</button>
        <button onClick={() => replaceProject(defaultProject())} title="Load the looped example network">Example</button>
        <button onClick={() => fileInput.current?.click()}>Open…</button>
        <button onClick={saveFile} title="Download the network as a .json file">Save…</button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={openFile} />
        <small>Changes are autosaved in this browser.</small>
      </div>

      <div className="header-fluid fluidbar">
        <label className="field wide">
          <span>Fluid</span>
          <select value={project.fluid.id} onChange={(e) => updateFluid({ id: e.target.value as FluidUI['id'] })}>
            {FLUID_LIBRARY.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        {isCustom ? (
          <>
            <label className="field">
              <span>Name</span>
              <input value={project.fluid.customName} onChange={(e) => updateFluid({ customName: e.target.value })} />
            </label>
            <NumField label="Density" unit="kg/m³" value={project.fluid.customDensity} onChange={(v) => updateFluid({ customDensity: v })} />
            <NumField label="Viscosity" unit="mPa·s" value={project.fluid.customViscosityMPas} onChange={(v) => updateFluid({ customViscosityMPas: v })} />
            <NumField label="Vapour pressure (abs)" unit="kPa" value={project.fluid.customVaporKPa} onChange={(v) => updateFluid({ customVaporKPa: v })} />
          </>
        ) : (
          <NumField label="Temperature" unit="°C" value={project.temperatureC} onChange={(v) => setProject((p) => ({ ...p, temperatureC: v }), 'temp')} title={`Valid ${info.tMinC.toFixed(0)} to ${info.tMaxC.toFixed(0)} °C`} />
        )}
        <NumField label="NPSH margin" unit="m" value={project.npshMarginM} onChange={(v) => setProject((p) => ({ ...p, npshMarginM: v }), 'npsh')} title="Required NPSHa above NPSHr" />
        <NumField label="Max velocity alert" unit="m/s" value={project.maxVelocityMps} onChange={(v) => setProject((p) => ({ ...p, maxVelocityMps: v }), 'vmax')} title="0 turns the alert off" />
        {computed.model && (
          <span className="fluid-props">
            ρ {computed.model.fluid.density.toFixed(1)} kg/m³ · μ {(computed.model.fluid.dynamicViscosity * 1000).toFixed(3)} mPa·s · p<sub>v</sub> {(computed.model.fluid.vaporPressure / 1000).toFixed(2)} kPa
            {!isCustom && <> · <em>{info.note}</em></>}
          </span>
        )}
      </div>
      {message && <div className={`banner ${message.kind === 'error' ? 'error' : 'ok'}`}>{message.text}</div>}

      <div className="toolbar" role="toolbar" aria-label="Network tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'active' : ''} title={t.title} aria-pressed={tool === t.id} onClick={() => setTooling(t.id)}>{t.label}</button>
        ))}
        <button onClick={deleteSelected} disabled={!selection}>Delete</button>
        <small>Esc returns to Select.</small>
      </div>

      <div className="workspace">
        <Canvas
          project={project}
          result={computed.result}
          selection={selection}
          tool={tool}
          pending={pending}
          onSelect={setSelection}
          onAddNode={addNode}
          onMoveNode={moveNode}
          onConnect={connect}
          onPending={setPending}
        />
        <aside className="side">
          {selNode && <NodeEditor node={selNode} onChange={updateNode} />}
          {selEdge?.kind === 'pipe' && <PipeEditor pipe={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} onChange={updateEdge} />}
          {selEdge?.kind === 'valve' && <ValveEditor valve={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} onChange={updateEdge} />}
          {selEdge?.kind === 'pump' && <PumpEditor pump={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} onChange={updateEdge} headFitRmse={pumpFit} />}
          {!selNode && !selEdge && (
            <section className="editor">
              <h3>Build your network</h3>
              <ol className="steps">
                <li>Place <b>tanks</b> (fixed head) and <b>junctions</b> (set elevation and demand).</li>
                <li>Connect them with <b>pipes</b>, <b>valves</b> and <b>pumps</b>. Loops and branches are fine.</li>
                <li>Click any item to edit it. Results update live on the canvas.</li>
              </ol>
              <p className="hint">At least one tank is required. Arrows show the solved flow direction; “Swap direction” only flips an item's sign convention.</p>
            </section>
          )}
        </aside>
      </div>

      <div className="below">
        <Results computed={computed} onSelectName={selectByName} />
        {chart && <div className="chart" style={{ aspectRatio: `${CHART_W} / ${CHART_H}` }} dangerouslySetInnerHTML={{ __html: chart.screen }} />}
      </div>
    </div>
  );
}
