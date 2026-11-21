import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
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
import { NodeEditor, PipeEditor, PumpEditor, ValveEditor } from './components/Editors';
import { NumField } from './components/NumField';
import { PumpCurvesPanel } from './components/PumpCurvesPanel';
import { Results } from './components/Results';
import { ScenarioPanel } from './components/ScenarioPanel';
import { TargetsPanel } from './components/TargetsPanel';
import { SpeedPanel, type SpeedConfig } from './components/SpeedPanel';
import { EXPORT_THEME, SCREEN_THEME, SI_AXES, pumpChartSvg, svgToPngBase64, CHART_H, CHART_W } from './curveChart';
import { calibrate } from './geometry';
import { layerFromFile } from './images';
import { LayoutMenu, PanelsMenu, Workspace } from './layout/Workspace';
import { activatePanel, loadLayout, openPanel, saveLayout, type LayoutNode, type PanelId } from './layout/layout';
import { applyCurve, checkCurve, curveFromPump } from './pumpCurves';
import { useHistory } from './history';
import {
  blankProject,
  compute,
  defaultProject,
  hydraulicKey,
  insertOnPipe,
  makeEdge,
  connectToNewNode,
  connectBlank,
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
  type PumpCurveEntry,
  type PumpUI,
  type PipeUI,
  type ProjectUI,
} from './model';
import { FLUID_LIBRARY, fluidInfo } from './solver';
import { UnitsContext, makeUnits, unitFactor, type UnitSystem } from './units';

const View3D = lazy(() => import('./components/View3D'));
const Coords3D = lazy(() => import('./components/View3D').then((m) => ({ default: m.Coords3D })));

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
  const [layout, setLayout] = useState<LayoutNode>(loadLayout);
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pending, setPending] = useState<string>();
  const [adjustImageId, setAdjustImageId] = useState<string>();
  const [adjustPick, setAdjustPick] = useState('');
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
  const connectBlankDrag = (kind: ConnectKind, a: { x: number; y: number }, b: { x: number; y: number } | { uid: string }) => {
    try {
      const r = connectBlank(project, kind, a, b);
      setProject(r.project);
      setSelection({ type: 'edge', uid: r.selectUid });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };
  const imageInput = useRef<HTMLInputElement>(null);
  const addImageFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const layer = await layerFromFile(file, project.canvasW, project.canvasH);
      setProject((p) => ({ ...p, images: [...p.images, layer] }));
      setMessage({ kind: 'info', text: `Added “${file.name}”. Press Adjust image to move or zoom it.` });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };
  const adjustTarget = project.images.find((im) => im.id === adjustPick) ?? project.images[0];
  const toggleAdjust = () => {
    setTool('select');
    setPending(undefined);
    setAdjustImageId((cur) => (cur ? undefined : adjustTarget?.id));
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
    replaceProject({ ...snap, images: project.images, scenarios: project.scenarios, targets: project.targets, assumptions: project.assumptions, pumpCurves: project.pumpCurves, drafts }, `Loaded “${s.name}”.`);
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

  // pump curve library
  const curves = project.pumpCurves ?? [];
  const [curveFocus, setCurveFocus] = useState<string>();
  const updateCurves = (next: PumpCurveEntry[], changedId?: string) =>
    setProject((p) => {
      const changed = changedId ? next.find((c) => c.id === changedId) : undefined;
      let edges = p.edges;
      if (changed && checkCurve(changed).errors.length === 0) {
        // pumps that use this curve follow its edits (they keep their speed and trim)
        edges = edges.map((e) => (e.kind === 'pump' && e.curveId === changed.id ? { ...applyCurve(e, changed), impellerTrim: e.impellerTrim } : e));
      } else if (changedId && !changed) {
        edges = edges.map((e) => (e.kind === 'pump' && e.curveId === changedId ? { ...e, curveId: undefined } : e)); // curve deleted: pumps keep their points
      }
      return { ...p, pumpCurves: next, edges };
    }, changedId ? `curve:${changedId}` : undefined);
  const assignCurve = (pumpUid: string, curveId: string) => {
    if (!curveId) {
      setProject((p) => ({ ...p, edges: p.edges.map((e) => (e.uid === pumpUid && e.kind === 'pump' ? { ...e, curveId: undefined } : e)) }));
      return;
    }
    const c = curves.find((x) => x.id === curveId);
    if (!c) return;
    const bad = checkCurve(c).errors[0];
    if (bad) return setMessage({ kind: 'error', text: `“${c.name}” cannot be used yet: ${bad}` });
    setProject((p) => ({ ...p, edges: p.edges.map((e) => (e.uid === pumpUid && e.kind === 'pump' ? applyCurve(e, c) : e)) }));
    setCurveFocus(c.id);
  };
  const saveCurveFromPump = (pump: PumpUI) => {
    const c = curveFromPump(pump, `${pump.name} curve`);
    setProject((p) => ({ ...p, pumpCurves: [...(p.pumpCurves ?? []), c], edges: p.edges.map((e) => (e.uid === pump.uid && e.kind === 'pump' ? { ...e, curveId: c.id } : e)) }));
    setCurveFocus(c.id);
    setMessage({ kind: 'info', text: `Saved “${c.name}” to the pump curve library.` });
  };
  const showPanel = (id: PanelId) => setLayout((l) => openPanel(l, id));

  useEffect(() => {
    const t = setTimeout(() => saveLayout(layout), 300);
    return () => clearTimeout(t);
  }, [layout]);
  // selecting something brings the Properties tab forward (if it is open)
  useEffect(() => {
    if (selection) setLayout((l) => activatePanel(l, 'properties'));
  }, [selection]);

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

  const failing = targetStatuses.filter((x) => !x.pass).length;
  const badge = (id: PanelId): string | undefined =>
    id === 'targets' ? (targets.length ? `(${targets.length}${failing ? `, ${failing} failing` : ''})` : undefined)
    : id === 'drafts' ? `(${drafts.filter((d) => d.status !== 'discarded').length})`
    : id === 'pumpcurves' ? (curves.length ? `(${curves.length})` : undefined)
    : undefined;

  const networkPanel = (
    <div className="net-panel">
      <div className="toolbar" role="toolbar" aria-label="Network tools">
        <button className={tool === 'select' ? 'active' : ''} aria-pressed={tool === 'select'} title="Select and move (Esc)" onClick={() => toSelect('select')}>↖ Select</button>
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'active' : ''} title={t.title} aria-pressed={tool === t.id} onClick={() => pickTool(t.id)}>{t.label}</button>
        ))}
        <button onClick={deleteSelected} disabled={!selection}>Delete</button>
        <span className="sep" />
        {project.images.length === 0 ? (
          <button onClick={() => imageInput.current?.click()} title="Add a drawing or photo under the network">🖼 Add image…</button>
        ) : (
          <>
            {project.images.length > 1 && (
              <select value={adjustTarget?.id ?? ''} onChange={(e) => setAdjustPick(e.target.value)} aria-label="Image to adjust" disabled={!!adjustImageId}>
                {project.images.map((im) => <option key={im.id} value={im.id}>{im.name}</option>)}
              </select>
            )}
            <button className={adjustImageId ? 'active' : ''} aria-pressed={!!adjustImageId} onClick={toggleAdjust} title="Move and zoom the image. Otherwise images cannot be moved or selected.">{adjustImageId ? '✓ Done adjusting' : '🖼 Adjust image'}</button>
            <button onClick={() => imageInput.current?.click()} title="Add another image">+ Image</button>
          </>
        )}
        <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => { void addImageFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
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
        onConnectBlank={connectBlankDrag}
        onReverse={reverseEdge}
        adjustImageId={adjustImageId}
        onZoomImage={zoomImage}
        onAdjustDone={() => setAdjustImageId(undefined)}
        onPending={setPending}
        onCalibPoint={(p) => setCalib((c) => (c.length >= 2 ? [p] : [...c, p]))}
      />
    </div>
  );

  const renderPanel = (id: PanelId): ReactNode => {
    switch (id) {
      case 'network':
        return networkPanel;
      case 'properties':
        return (
          <div className="side">
            {!hasSide && (
              <section className="editor empty-side">
                <h3>Properties</h3>
                <p className="hint">Nothing selected. Click a node, pipe, valve or pump on the network to edit it here.</p>
              </section>
            )}
            {selNode && <NodeEditor node={selNode} onChange={updateNode} />}
            {selEdge?.kind === 'pipe' && <PipeEditor pipe={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} canvasLengthM={pipeLengthM(project, selEdge)} onChange={updateEdge} />}
            {selEdge?.kind === 'valve' && <ValveEditor valve={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} onChange={updateEdge} />}
            {selEdge?.kind === 'pump' && (
              <PumpEditor
                pump={selEdge}
                from={nodeName(selEdge.from)}
                to={nodeName(selEdge.to)}
                onChange={updateEdge}
                headFitRmse={pumpFit}
                curves={curves}
                onAssignCurve={(cid) => assignCurve(selEdge.uid, cid)}
                onSaveCurve={() => saveCurveFromPump(selEdge)}
                onManageCurves={() => { setCurveFocus(selEdge.curveId); showPanel('pumpcurves'); }}
              />
            )}
          </div>
        );
      case 'pumpcurves':
        return <PumpCurvesPanel curves={curves} pumps={pumpEdges} selectedPump={selEdge?.kind === 'pump' ? selEdge : undefined} focusId={curveFocus} onChange={updateCurves} onUse={assignCurve} />;
      case 'results':
        return <Results computed={computed} onSelectName={selectByName} />;
      case 'pumpchart':
        return chart ? <div className="chart" style={{ aspectRatio: `${CHART_W} / ${CHART_H}` }} dangerouslySetInnerHTML={{ __html: chart.screen }} /> : <p className="hint">Add a pump to see its curve and operating point.</p>;
      case 'targets':
        return (
          <>
            <TargetsPanel project={project} targets={targets} statuses={targetStatuses} onChange={(t) => setProject((p) => ({ ...p, targets: t }), 'targets')} />
            {(project.assumptions ?? []).length > 0 && (
              <>
                <h4>Assumptions from AI-built parts ({project.assumptions!.length})</h4>
                <ul className="status-list">{project.assumptions!.map((a) => <li key={a.id}><b>{a.category}:</b> {a.text}</li>)}</ul>
              </>
            )}
          </>
        );
      case 'scale':
        return (
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
            onZoom={(iid, f) => { const im = project.images.find((q) => q.id === iid); if (im) zoomImage(iid, f, im.x + im.width / 2, im.y + im.height / 2); }}
            onDeleteImage={deleteImage}
            onStartCalib={() => { setCalib([]); setPending(undefined); setTool('scale'); }}
            onApplyCalib={applyCalib}
            onCancelCalib={() => { setCalib([]); setTool('select'); }}
          />
        );
      case 'speed':
        return <SpeedPanel pumps={pumpEdges} config={{ ...speedCfg, pumpUid: speedPumpUid }} onConfig={setSpeedCfg} sweep={sweep} />;
      case 'scenarios':
        return <ScenarioPanel scenarios={scenarios} comparison={comparison} onSave={saveScenario} onLoad={loadScenario} onDelete={deleteScenario} onRename={renameScenario} />;
      case 'view3d':
        return (
          <Suspense fallback={<p className="hint">Loading 3D view…</p>}>
            <View3D project={project} computed={computed} />
          </Suspense>
        );
      case 'coords3d':
        return (
          <Suspense fallback={<p className="hint">Loading…</p>}>
            <Coords3D project={project} computed={computed} />
          </Suspense>
        );
      case 'ai':
        return (
          <AiPanel
            main={project}
            drafts={drafts}
            activeDraftId={draftTab === 'compare' ? undefined : draftTab}
            settings={aiSettings}
            onSettings={setAiSettings}
            criteria={criteria}
            onCriteria={setCriteria}
            onDrafts={setDrafts}
            onShow={(ids) => { setDraftTab(ids.length === 1 ? ids[0] : 'compare'); showPanel('drafts'); }}
          />
        );
      case 'drafts':
        return <DraftsView main={project} drafts={drafts} criteria={criteria} tab={draftTab} onTab={setDraftTab} onAccept={acceptDraft} onDiscard={discardDraft} />;
    }
  };

  return (
    <UnitsContext.Provider value={unitSystem}>
      <div className="app">
        <header className="topbar">
          <h1>Pipe Network Calculator</h1>
          <small className="build-id" title="Version of this build. Compare it with the latest commit on GitHub to check the live site is up to date.">build {typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}</small>
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
            <span className="sep" />
            <LayoutMenu onLayout={setLayout} />
            <PanelsMenu layout={layout} onLayout={setLayout} />
          </div>
          <button className="primary export" disabled={!canExport} onClick={exportXlsx} title="Excel sheets are always in SI units">Export Excel</button>
        </header>

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

        <Workspace layout={layout} onLayout={setLayout} render={renderPanel} badge={badge} />

        {message && (
          <div className={`toast ${message.kind === 'error' ? 'error' : 'ok'}`} role="status">
            <span>{message.text}</span>
            <button aria-label="Dismiss" onClick={() => setMessage(undefined)}>×</button>
          </div>
        )}
      </div>
    </UnitsContext.Provider>
  );
}
