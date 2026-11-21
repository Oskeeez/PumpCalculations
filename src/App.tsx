import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { loadCriteria, type DesignCriteria } from './ai/criteria';
import { mergeDraft } from './ai/drafts';
import { loadAiSettings, type AiSettings } from './ai/llm';
import { evaluateTargets } from './ai/targets';
import type { Draft } from './ai/types';
import { compareScenarios, snapshotScenario, speedRatios, speedSweep } from './analysis';
import { Canvas, type ConnectKind, type Selection, type Tool } from './components/Canvas';
import { AiPanel } from './components/AiPanel';
import { CanvasPanel } from './components/CanvasPanel';
import { DraftsView } from './components/DraftsView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NodeEditor, PipeEditor, PumpEditor, ValveEditor } from './components/Editors';
import { NumField } from './components/NumField';
import { Results } from './components/Results';
import { ScenarioPanel } from './components/ScenarioPanel';
import { TargetsPanel } from './components/TargetsPanel';
import { SpeedPanel, type SpeedConfig } from './components/SpeedPanel';
import { EXPORT_THEME, SCREEN_THEME, SI_AXES, pumpChartSvg, svgToPngBase64, CHART_H, CHART_W } from './curveChart';
import { calibrate } from './geometry';
import { useHistory } from './history';
import {
  blankProject,
  compute,
  defaultProject,
  hydraulicKey,
  insertOnPipe,
  makeEdge,
  connectToNewNode,
  placeStandalone,
  type InsertKind,
  newNode,
  parseProject,
  pipeLengthM,
  serializeProject,
  syncUidCounter,
  type EdgeUI,
  type FluidUI,
  type ImageLayer,
  type NodeKind,
  type NodeUI,
  type PipeUI,
  type ProjectUI,
} from './model';
import { FLUID_LIBRARY, fluidInfo } from './solver';
import { UnitsContext, makeUnits, unitFactor, type UnitSystem } from './units';

const View3D = lazy(() => import('./components/View3D'));

const TOOLS: { id: Exclude<Tool, 'select' | 'scale'>; label: string; title: string }[] = [
  { id: 'tank', label: '▭ Tank', title: 'Place a tank' },
  { id: 'junction', label: '● Junction', title: 'Place a junction' },
  { id: 'pipe', label: '— Pipe', title: 'Drag from node to node' },
  { id: 'valve', label: '⋈ Valve', title: 'Click a pipe to insert, or drag from node to node' },
  { id: 'orifice', label: '⫴ Orifice', title: 'Click a pipe to insert an orifice plate, or drag from node to node' },
  { id: 'pump', label: '◉ Pump', title: 'Drag from suction node to discharge node' },
];

const STORAGE_KEY = 'pipe-network-autosave-v1';
const UNITS_KEY = 'pipe-network-units';

function loadInitial(): ProjectUI {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return parseProject(saved);
  } catch {
    /* storage unavailable or corrupt: fall back to the example */
  }
  return defaultProject();
}

const SIDE_KEY = 'pipe-network-side-width';
const SIDE_MIN = 260;
const SIDE_MAX = 760;
function loadSideWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDE_KEY));
    if (Number.isFinite(n) && n >= SIDE_MIN && n <= SIDE_MAX) return n;
  } catch {
    /* ignore */
  }
  return 340;
}

function loadUnits(): UnitSystem {
  try {
    return localStorage.getItem(UNITS_KEY) === 'us' ? 'us' : 'si';
  } catch {
    return 'si';
  }
}

export function App() {
  const [boot] = useState(loadInitial);
  const { state: project, set: setProject, undo, redo, canUndo, canRedo } = useHistory<ProjectUI>(() => ({ ...boot, drafts: undefined }));
  // AI drafts live outside the undo history (the AI changes them asynchronously) but are saved with the project.
  const [drafts, setDrafts] = useState<Draft[]>(boot.drafts ?? []);
  const [aiSettings, setAiSettings] = useState<AiSettings>(loadAiSettings);
  const [criteria, setCriteria] = useState<DesignCriteria>(loadCriteria);
  const [draftTab, setDraftTab] = useState('compare');
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(loadUnits);
  const [view, setView] = useState<'network' | '3d' | 'ai' | 'drafts'>('network');
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pending, setPending] = useState<string>();
  const [adjustImageId, setAdjustImageId] = useState<string>();
  const [sideW, setSideW] = useState(loadSideWidth);
  const [calib, setCalib] = useState<{ x: number; y: number }[]>([]);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string }>();
  const [speedCfg, setSpeedCfg] = useState<SpeedConfig>({ pumpUid: '', minPct: 60, maxPct: 100, stepPct: 10 });
  const fileInput = useRef<HTMLInputElement>(null);
  const units = useMemo(() => makeUnits(unitSystem), [unitSystem]);

  const key = hydraulicKey(project);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const computed = useMemo(() => compute(project), [key]);

  // pump curve chart (screen: selected unit system; Excel export: always SI to match the sheets)
  const chartSeries = computed.pumpCurves.map((c) => ({ name: c.name, pts: c.pts, op: c.op }));
  const axes = useMemo(
    () => ({ flowLabel: units.u('flow'), headLabel: units.u('head'), flowFactor: unitFactor('flow', unitSystem), headFactor: unitFactor('head', unitSystem) }),
    [units, unitSystem],
  );
  const chart = useMemo(
    () => (chartSeries.length ? { screen: pumpChartSvg(chartSeries, SCREEN_THEME, axes), exportSvg: pumpChartSvg(chartSeries, EXPORT_THEME, SI_AXES) } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [computed, axes],
  );

  // speed analysis
  const pumpEdges = project.edges.filter((e): e is Extract<EdgeUI, { kind: 'pump' }> => e.kind === 'pump');
  const speedPumpUid = pumpEdges.some((p) => p.uid === speedCfg.pumpUid) ? speedCfg.pumpUid : (pumpEdges[0]?.uid ?? '');
  const sweep = useMemo(
    () => (speedPumpUid ? speedSweep(project, speedPumpUid, speedRatios(speedCfg.minPct, speedCfg.maxPct, speedCfg.stepPct)) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, speedPumpUid, speedCfg.minPct, speedCfg.maxPct, speedCfg.stepPct],
  );

  // scenarios
  const scenarios = project.scenarios ?? [];
  const scenarioKey = JSON.stringify(scenarios);
  const comparison = useMemo(
    () => compareScenarios([{ name: 'Current', computed }, ...scenarios.map((s) => ({ name: s.name, computed: compute(s.project) }))]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [computed, scenarioKey],
  );

  // Autosave (debounced). Failures (private mode, quota) are ignored: saving to a file still works.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, serializeProject({ ...project, drafts }));
      } catch {
        /* ignore */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [project, drafts]);
  useEffect(() => {
    try {
      localStorage.setItem(UNITS_KEY, unitSystem);
    } catch {
      /* ignore */
    }
  }, [unitSystem]);

  const nodeName = (uid: string) => project.nodes.find((n) => n.uid === uid)?.name ?? '?';

  /** Tool buttons toggle: pressing the active one returns to select mode. */
  const pickTool = (t: Tool) => {
    setTool((cur) => (cur === t ? 'select' : t));
    setAdjustImageId(undefined);
    setPending(undefined);
    setCalib([]);
  };
  const toSelect = (t: Tool) => {
    setTool(t);
    setPending(undefined);
    if (t !== 'scale') setCalib([]);
  };

  const addNode = (kind: NodeKind, x: number, y: number) => {
    const n = newNode(kind, x, y, project.nodes.map((q) => q.name));
    setProject((p) => ({ ...p, nodes: [...p.nodes, n] }));
    setSelection({ type: 'node', uid: n.uid });
  };
  const p0Diameter = (nodeUid: string) => (project.edges.find((e) => e.kind === 'pipe' && (e.from === nodeUid || e.to === nodeUid)) as PipeUI | undefined)?.diameterMm ?? 102.26;
  const connect = (kind: ConnectKind, from: string, to: string) => {
    const taken = project.edges.map((e) => e.name);
    const e = makeEdge(kind, from, to, taken, p0Diameter(from));
    setProject((p) => ({ ...p, edges: [...p.edges, e] }));
    setSelection({ type: 'edge', uid: e.uid });
  };
  const insertInto = (kind: InsertKind, pipeUid: string, x: number, y: number) => {
    try {
      const r = insertOnPipe(project, pipeUid, kind, x, y);
      setProject(r.project);
      setSelection({ type: kind === 'junction' ? 'node' : 'edge', uid: r.selectUid });
      setMessage(undefined);
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };
  const connectNew = (kind: ConnectKind, from: string, x: number, y: number) => {
    try {
      const r = connectToNewNode(project, kind, from, x, y, p0Diameter(from));
      setProject(r.project);
      setSelection({ type: 'edge', uid: r.selectUid });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };
  const placeAlone = (kind: 'pump' | 'valve' | 'orifice', x: number, y: number) => {
    const r = placeStandalone(project, kind, x, y);
    setProject(r.project);
    setSelection({ type: 'edge', uid: r.selectUid });
    setMessage(undefined);
  };
  const reverseEdge = (uid: string) => setProject((p) => ({ ...p, edges: p.edges.map((e) => (e.uid === uid ? { ...e, from: e.to, to: e.from } : e)) }), `edge:${uid}`);
  const zoomImage = (id: string, factor: number, cx: number, cy: number) =>
    setProject((p) => ({
      ...p,
      images: p.images.map((im) => {
        if (im.id !== id) return im;
        const f = Math.max(0.2, Math.min(5, factor));
        const width = Math.max(20, Math.min(20000, im.width * f));
        const k = width / im.width;
        return { ...im, width, height: im.height * k, x: Math.round(cx - (cx - im.x) * k), y: Math.round(cy - (cy - im.y) * k) };
      }),
    }), `imgzoom:${id}`);
  const startSideDrag = (ev: React.PointerEvent) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = sideW;
    const move = (e: PointerEvent) => setSideW(Math.max(SIDE_MIN, Math.min(SIDE_MAX, startW + (startX - e.clientX))));
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const w = Math.max(SIDE_MIN, Math.min(SIDE_MAX, startW + (startX - e.clientX)));
      try {
        localStorage.setItem(SIDE_KEY, String(w));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const moveNode = (uid: string, x: number, y: number) => setProject((p) => ({ ...p, nodes: p.nodes.map((n) => (n.uid === uid ? { ...n, x, y } : n)) }), `drag:${uid}`);
  const updateNode = (n: NodeUI) => setProject((p) => ({ ...p, nodes: p.nodes.map((q) => (q.uid === n.uid ? n : q)) }), `node:${n.uid}`);
  const updateEdge = (e: EdgeUI) => setProject((p) => ({ ...p, edges: p.edges.map((q) => (q.uid === e.uid ? e : q)) }), `edge:${e.uid}`);
  const updateFluid = (patch: Partial<FluidUI>) => setProject((p) => ({ ...p, fluid: { ...p.fluid, ...patch } }), 'fluid');

  // canvas, scale, images
  const addImage = (layer: ImageLayer) => setProject((p) => ({ ...p, images: [...p.images, layer] }));
  const updateImage = (id: string, patch: Partial<ImageLayer>) => setProject((p) => ({ ...p, images: p.images.map((im) => (im.id === id ? { ...im, ...patch } : im)) }), `img:${id}`);
  const deleteImage = (id: string) => setProject((p) => ({ ...p, images: p.images.filter((im) => im.id !== id) }));
  const applyCalib = (real: number) => {
    const s = calib.length === 2 ? calibrate(calib[0], calib[1], real) : undefined;
    if (s) setProject((p) => ({ ...p, scaleMPerPx: s }));
    else setMessage({ kind: 'error', text: 'Enter a distance greater than 0 between two different points.' });
    setCalib([]);
    setTool('select');
  };

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
    setDrafts(p.drafts ?? []);
    setDraftTab('compare');
    setProject({ ...p, drafts: undefined });
    setSelection(null);
    setPending(undefined);
    setCalib([]);
    setTool('select');
    setMessage(text ? { kind: 'info', text } : undefined);
  };

  // scenario actions
  const saveScenario = (name: string) => setProject((p) => ({ ...p, scenarios: [...(p.scenarios ?? []), snapshotScenario(p, name || `Scenario ${(p.scenarios?.length ?? 0) + 1}`)] }));
  const loadScenario = (id: string) => {
    const s = scenarios.find((x) => x.id === id);
    if (!s) return;
    const snap = JSON.parse(JSON.stringify(s.project)) as Omit<ProjectUI, 'images' | 'scenarios'>;
    replaceProject({ ...snap, images: project.images, scenarios: project.scenarios, targets: project.targets, assumptions: project.assumptions, drafts }, `Loaded “${s.name}”.`);
  };
  // AI drafts: accept (merge into main), discard
  const acceptDraft = (id: string, keys: Set<string> | 'all'): string[] => {
    const d = drafts.find((x) => x.id === id);
    if (!d || d.status !== 'open') return ['That draft is read-only.'];
    const res = mergeDraft(project, d, keys);
    syncUidCounter(res.project);
    setProject(res.project);
    const pickedAll = keys === 'all';
    setDrafts((all) =>
      all.map((x) => {
        if (x.id === id) {
          const applied = [...new Set([...(x.appliedKeys ?? []), ...res.applied])];
          return { ...x, appliedKeys: applied, status: pickedAll ? 'merged' : x.status };
        }
        // siblings of a picked draft stay as read-only reference
        return pickedAll && x.runId === d.runId && x.status === 'open' ? { ...x, status: 'reference' } : x;
      }),
    );
    setMessage({ kind: 'info', text: `Merged ${pickedAll ? 'all changes' : `${res.applied.length} change(s)`} from “${d.name}” into the main model. Undo reverts the main model.` });
    return res.notes;
  };
  const discardDraft = (id: string) => {
    setDrafts((all) => all.filter((x) => x.id !== id));
    setDraftTab('compare');
  };
  const targets = project.targets ?? [];
  const targetStatuses = useMemo(
    () => evaluateTargets(project, targets, computed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [computed, project.targets, project.nodes, project.edges],
  );
  const deleteScenario = (id: string) => setProject((p) => ({ ...p, scenarios: (p.scenarios ?? []).filter((s) => s.id !== id) }));
  const renameScenario = (id: string, name: string) => setProject((p) => ({ ...p, scenarios: (p.scenarios ?? []).map((s) => (s.id === id ? { ...s, name } : s)) }), `scn:${id}`);

  const saveFile = () => {
    const url = URL.createObjectURL(new Blob([serializeProject({ ...project, drafts })], { type: 'application/json' }));
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
      replaceProject(parseProject(await file.text()), `Opened ${file.name}.`);
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
        setAdjustImageId(undefined);
        setPending(undefined);
        setCalib([]);
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
      const speedPng = sweep && sweep.series.length ? await svgToPngBase64(pumpChartSvg(sweep.series, EXPORT_THEME, SI_AXES)) : undefined;
      const { buildNetworkWorkbook, workbookToBuffer } = await import('./excel/networkExport'); // lazy: keeps ExcelJS out of first load
      const wb = await buildNetworkWorkbook({
        model: computed.model,
        result: computed.result,
        npshMarginM: project.npshMarginM,
        pumpCurves: computed.pumpCurves,
        chartPngBase64: png,
        speedChartPngBase64: speedPng,
        speedSweep: sweep && sweep.rows.some((r) => !r.error) ? sweep : undefined,
        comparison: scenarios.length ? comparison : undefined,
      });
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
  const hasSide = !!(selNode || selEdge);

  return (
    <UnitsContext.Provider value={unitSystem}>
      <div className="app">
        <header>
          <h1>Pipe Network Calculator</h1>
          <button className="primary" disabled={!canExport} onClick={exportXlsx} title="Excel sheets are always in SI units">Export Excel</button>
        </header>

        <div className="menu" role="toolbar" aria-label="Project">
          <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
          <span className="sep" />
          <button onClick={() => replaceProject(blankProject())}>New</button>
          <button onClick={() => replaceProject(defaultProject())}>Example</button>
          <button onClick={() => fileInput.current?.click()}>Open…</button>
          <button onClick={saveFile}>Save…</button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={openFile} />
          <span className="sep" />
          <span className="seg" role="group" aria-label="Unit system">
            <button className={unitSystem === 'si' ? 'active' : ''} aria-pressed={unitSystem === 'si'} onClick={() => setUnitSystem('si')}>SI</button>
            <button className={unitSystem === 'us' ? 'active' : ''} aria-pressed={unitSystem === 'us'} onClick={() => setUnitSystem('us')}>US</button>
          </span>
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
              <NumField label="Density" q="density" value={project.fluid.customDensity} onChange={(v) => updateFluid({ customDensity: v })} />
              <NumField label="Viscosity" q="viscosity" value={project.fluid.customViscosityMPas} onChange={(v) => updateFluid({ customViscosityMPas: v })} />
              <NumField label="Vapour pressure (abs)" q="pressure" value={project.fluid.customVaporKPa} onChange={(v) => updateFluid({ customVaporKPa: v })} />
            </>
          ) : (
            <NumField label="Temperature" q="temperature" value={project.temperatureC} onChange={(v) => setProject((p) => ({ ...p, temperatureC: v }), 'temp')} title={`${units.f('temperature', info.tMinC, 0)} to ${units.fu('temperature', info.tMaxC, 0)}`} />
          )}
          <NumField label="NPSH margin" q="head" value={project.npshMarginM} onChange={(v) => setProject((p) => ({ ...p, npshMarginM: v }), 'npsh')} />
          <NumField label="Max velocity" q="velocity" value={project.maxVelocityMps} onChange={(v) => setProject((p) => ({ ...p, maxVelocityMps: v }), 'vmax')} title="0 = off" />
          {computed.model && (
            <span className="fluid-props">
              ρ {units.fu('density', computed.model.fluid.density, 1)} · μ {units.fu('viscosity', computed.model.fluid.dynamicViscosity * 1000, 3)} · p<sub>v</sub> {units.fu('pressure', computed.model.fluid.vaporPressure / 1000, 2)}
            </span>
          )}
        </div>
        {message && <div className={`banner ${message.kind === 'error' ? 'error' : 'ok'}`}>{message.text}</div>}

        <nav className="tabs" aria-label="Page">
          <button className={view === 'network' ? 'active' : ''} onClick={() => setView('network')}>Network</button>
          <button className={view === '3d' ? 'active' : ''} onClick={() => setView('3d')}>3D view</button>
          <button className={view === 'ai' ? 'active' : ''} onClick={() => setView('ai')}>AI assistant</button>
          <button className={view === 'drafts' ? 'active' : ''} onClick={() => setView('drafts')}>Drafts ({drafts.filter((d) => d.status !== 'discarded').length})</button>
        </nav>

        {view === 'ai' ? (
          <ErrorBoundary title="The AI assistant failed">
            <AiPanel
              main={project}
              drafts={drafts}
              activeDraftId={draftTab === 'compare' ? undefined : draftTab}
              settings={aiSettings}
              onSettings={setAiSettings}
              criteria={criteria}
              onCriteria={setCriteria}
              onDrafts={setDrafts}
              onShow={(ids) => { setDraftTab(ids.length === 1 ? ids[0] : 'compare'); setView('drafts'); }}
            />
          </ErrorBoundary>
        ) : view === 'drafts' ? (
          <ErrorBoundary title="The drafts view failed">
            <DraftsView main={project} drafts={drafts} criteria={criteria} tab={draftTab} onTab={setDraftTab} onAccept={acceptDraft} onDiscard={discardDraft} />
          </ErrorBoundary>
        ) : view === '3d' ? (
          <ErrorBoundary title="The 3D view failed">
            <Suspense fallback={<p className="hint">Loading 3D view…</p>}>
              <View3D project={project} computed={computed} />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <>
            <div className="toolbar" role="toolbar" aria-label="Network tools">
              <button className={tool === 'select' ? 'active' : ''} aria-pressed={tool === 'select'} title="Select and move (Esc)" onClick={() => toSelect('select')}>↖ Select</button>
              {TOOLS.map((t) => (
                <button key={t.id} className={tool === t.id ? 'active' : ''} title={t.title} aria-pressed={tool === t.id} onClick={() => pickTool(t.id)}>{t.label}</button>
              ))}
              <button onClick={deleteSelected} disabled={!selection}>Delete</button>
            </div>

            <div className="workspace" style={{ '--side-w': `${sideW}px` } as React.CSSProperties}>
              <Canvas
                project={project}
                result={computed.result}
                selection={selection}
                tool={tool}
                pending={pending}
                calib={calib}
                onSelect={setSelection}
                onTool={toSelect}
                onAddNode={addNode}
                onMoveNode={moveNode}
                onMoveImage={(id, x, y) => updateImage(id, { x, y })}
                onConnect={connect}
                onInsert={insertInto}
                onPlace={placeAlone}
                onConnectNew={connectNew}
                onReverse={reverseEdge}
                adjustImageId={adjustImageId}
                onZoomImage={zoomImage}
                onAdjustDone={() => setAdjustImageId(undefined)}
                onPending={setPending}
                onCalibPoint={(p) => setCalib((c) => (c.length >= 2 ? [p] : [...c, p]))}
              />
              <div className="side-handle" role="separator" aria-orientation="vertical" aria-label="Drag to resize the side panel" title="Drag to resize" onPointerDown={startSideDrag} onDoubleClick={() => { setSideW(340); try { localStorage.setItem(SIDE_KEY, '340'); } catch { /* ignore */ } }} />
              {(
                <aside className="side">
                  {!hasSide && (
                    <section className="editor empty-side">
                      <h3>Properties</h3>
                      <p className="hint">Nothing selected. Click a node, pipe, valve or pump to edit it here.</p>
                      <p className="hint">Drag the bar on the left edge of this panel to resize it (double-click to reset).</p>
                    </section>
                  )}
                  {selNode && <NodeEditor node={selNode} onChange={updateNode} />}
                  {selEdge?.kind === 'pipe' && <PipeEditor pipe={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} canvasLengthM={pipeLengthM(project, selEdge)} onChange={updateEdge} />}
                  {selEdge?.kind === 'valve' && <ValveEditor valve={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} onChange={updateEdge} />}
                  {selEdge?.kind === 'pump' && <PumpEditor pump={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} onChange={updateEdge} headFitRmse={pumpFit} />}
                </aside>
              )}
            </div>

            <details className="panel" open={targets.length > 0}>
              <summary>Targets ({targets.length}{targets.length ? `, ${targetStatuses.filter((s) => !s.pass).length} failing` : ''})</summary>
              <TargetsPanel project={project} targets={targets} statuses={targetStatuses} onChange={(t) => setProject((p) => ({ ...p, targets: t }), 'targets')} />
              {(project.assumptions ?? []).length > 0 && (
                <>
                  <h4>Assumptions from AI-built parts ({project.assumptions!.length})</h4>
                  <ul className="status-list">{project.assumptions!.map((a) => <li key={a.id}><b>{a.category}:</b> {a.text}</li>)}</ul>
                </>
              )}
            </details>

            <details className="panel">
              <summary>Scale and images</summary>
              <CanvasPanel
                scaleMPerPx={project.scaleMPerPx}
                canvasW={project.canvasW}
                canvasH={project.canvasH}
                images={project.images}
                calib={calib}
                calibActive={tool === 'scale'}
                onScale={(s) => setProject((p) => ({ ...p, scaleMPerPx: s }), 'scale')}
                onCanvasSize={(w, h) => setProject((p) => ({ ...p, canvasW: w, canvasH: h }), 'canvas')}
                onAddImage={addImage}
                onUpdateImage={updateImage}
                adjustImageId={adjustImageId}
                onAdjust={setAdjustImageId}
                onZoom={(id, f) => { const im = project.images.find((q) => q.id === id); if (im) zoomImage(id, f, im.x + im.width / 2, im.y + im.height / 2); }}
                onDeleteImage={deleteImage}
                onStartCalib={() => { setCalib([]); setPending(undefined); setTool('scale'); }}
                onApplyCalib={applyCalib}
                onCancelCalib={() => { setCalib([]); setTool('select'); }}
              />
            </details>

            <div className="below">
              <Results computed={computed} onSelectName={selectByName} />
              {chart && <div className="chart" style={{ aspectRatio: `${CHART_W} / ${CHART_H}` }} dangerouslySetInnerHTML={{ __html: chart.screen }} />}
            </div>

            <details className="panel">
              <summary>Pump speed analysis</summary>
              <SpeedPanel pumps={pumpEdges} config={{ ...speedCfg, pumpUid: speedPumpUid }} onConfig={setSpeedCfg} sweep={sweep} />
            </details>

            <details className="panel" open={scenarios.length > 0}>
              <summary>Scenarios ({scenarios.length})</summary>
              <ScenarioPanel scenarios={scenarios} comparison={comparison} onSave={saveScenario} onLoad={loadScenario} onDelete={deleteScenario} onRename={renameScenario} />
            </details>
          </>
        )}
      </div>
    </UnitsContext.Provider>
  );
}
