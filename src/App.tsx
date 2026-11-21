import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadCriteria, type DesignCriteria } from './ai/criteria';
import { loadAiSettings, type AiSettings } from './ai/llm';
import { evaluateTargets } from './ai/targets';
import { compareScenarios, snapshotScenario, speedRatios, speedSweep } from './analysis';
import { AiPanel } from './components/AiPanel';
import { Canvas, type PickAccept, type PickSpec, type Selection, type Tool } from './components/Canvas';
import { CanvasPanel } from './components/CanvasPanel';
import { DraftsView } from './components/DraftsView';
import { NodeEditor, PipeEditor, PumpEditor, ValveEditor } from './components/Editors';
import { FluidBar } from './components/FluidBar';
import { HelpDialog } from './components/HelpDialog';
import { NetworkToolbar } from './components/NetworkToolbar';
import { PumpCurvesPanel } from './components/PumpCurvesPanel';
import { ReportPanel } from './components/ReportPanel';
import { Results } from './components/Results';
import { ScenarioPanel } from './components/ScenarioPanel';
import { SpeedPanel, type SpeedConfig } from './components/SpeedPanel';
import { TargetsPanel } from './components/TargetsPanel';
import { TopBar } from './components/TopBar';
import { EXPORT_THEME, SCREEN_THEME, SI_AXES, pumpChartSvg, CHART_H, CHART_W } from './curveChart';
import { copyNodes, moveNodes, pasteClip, removeNodes, type Clip } from './clipboard';
import { calibrate } from './geometry';
import { useHistory } from './history';
import { Workspace } from './layout/Workspace';
import { activatePanel, groupOfPanel, loadLayout, openPanel, saveLayout, type LayoutNode, type PanelId } from './layout/layout';
import { blankProject, compute, defaultProject, hydraulicKey, parseProject, pipeLengthM, syncUidCounter, type EdgeUI, type ProjectUI } from './model';
import { exportWorkbook } from './state/exportWorkbook';
import { downloadProject, loadInitial, loadUnits, useAutosave } from './state/persistence';
import type { Message } from './state/types';
import { useCurveLibrary } from './state/useCurveLibrary';
import { useDrafts } from './state/useDrafts';
import { useImages } from './state/useImages';
import { useNetworkEditing } from './state/useNetworkEditing';
import { UnitsContext, makeUnits, unitFactor, type UnitSystem } from './units';

const View3D = lazy(() => import('./components/View3D'));
const Coords3D = lazy(() => import('./components/View3D').then((m) => ({ default: m.Coords3D })));

export function App() {
  const [boot] = useState(loadInitial);
  const { state: project, set: setProject, undo, redo, canUndo, canRedo } = useHistory<ProjectUI>(() => ({ ...boot, drafts: undefined }));
  const [message, setMessage] = useState<Message>();
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pending, setPending] = useState<string>();
  const [calib, setCalib] = useState<{ x: number; y: number }[]>([]);
  const [help, setHelp] = useState(false);
  /** Nodes selected together (shift-click or a box). */
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const clip = useRef<Clip | undefined>(undefined);
  const [focus, setFocus] = useState<{ uid: string; n: number }>();
  const [epoch, setEpoch] = useState(0); // changes when a different project is loaded: the canvas re-fits
  const [pick, setPick] = useState<(PickSpec & { id: string; apply: (uid: string) => void }) | null>(null);
  const [unitSystem, setUnitSystem] = useState<UnitSystem>(loadUnits);
  const [layout, setLayout] = useState<LayoutNode>(loadLayout);
  const [aiSettings, setAiSettings] = useState<AiSettings>(loadAiSettings);
  const [criteria, setCriteria] = useState<DesignCriteria>(loadCriteria);
  const [speedCfg, setSpeedCfg] = useState<SpeedConfig>({ pumpUid: '', minPct: 60, maxPct: 100, stepPct: 10 });
  const units = useMemo(() => makeUnits(unitSystem), [unitSystem]);

  const { drafts, setDrafts, draftTab, setDraftTab, acceptDraft, discardDraft } = useDrafts(boot.drafts ?? [], project, setProject, setMessage);
  const lib = useCurveLibrary(project, setProject, setMessage);
  const imgs = useImages(project, setProject, setMessage);
  const edit = useNetworkEditing(project, setProject, selection, setSelection, setMessage);
  useAutosave(project, drafts, unitSystem);

  // ---- calculation (re-solved only when something hydraulic changes)
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

  /** True when a panel is the visible tab of its tile. Heavy secondary calculations only run for panels that can be seen. */
  const visible = (id: PanelId) => groupOfPanel(layout, id)?.active === id;
  const speedVisible = visible('speed');
  const scenariosVisible = visible('scenarios');

  const pumpEdges = project.edges.filter((e): e is Extract<EdgeUI, { kind: 'pump' }> => e.kind === 'pump');
  const speedPumpUid = pumpEdges.some((p) => p.uid === speedCfg.pumpUid) ? speedCfg.pumpUid : (pumpEdges[0]?.uid ?? '');
  const runSweep = () => (speedPumpUid ? speedSweep(project, speedPumpUid, speedRatios(speedCfg.minPct, speedCfg.maxPct, speedCfg.stepPct)) : undefined);
  const sweep = useMemo(
    () => (speedVisible ? runSweep() : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speedVisible, key, speedPumpUid, speedCfg.minPct, speedCfg.maxPct, speedCfg.stepPct],
  );

  const scenarios = project.scenarios ?? [];
  const scenarioKey = JSON.stringify(scenarios);
  const runComparison = () => compareScenarios([{ name: 'Current', computed }, ...scenarios.map((s) => ({ name: s.name, computed: compute(s.project) }))]);
  const comparison = useMemo(
    () => (scenariosVisible ? runComparison() : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenariosVisible, computed, scenarioKey],
  );

  const targets = project.targets ?? [];
  const targetStatuses = useMemo(
    () => evaluateTargets(project, targets, computed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [computed, project.targets, project.nodes, project.edges],
  );

  // ---- tools and modes
  const nodeName = (uid: string) => project.nodes.find((n) => n.uid === uid)?.name ?? '?';
  /** Tool buttons toggle: pressing the active one returns to select mode. */
  const pickTool = (t: Tool) => {
    setTool((cur) => (cur === t ? 'select' : t));
    imgs.setAdjustImageId(undefined);
    setPending(undefined);
    setCalib([]);
  };
  const toSelect = (t: Tool) => {
    setTool(t);
    setPending(undefined);
    if (t !== 'scale') setCalib([]);
  };
  const toggleAdjust = () => {
    setTool('select');
    setPending(undefined);
    imgs.setAdjustImageId((cur) => (cur ? undefined : imgs.adjustTarget?.id));
  };
  const applyCalib = (real: number) => {
    const s = calib.length === 2 ? calibrate(calib[0], calib[1], real) : undefined;
    if (s) setProject((p) => ({ ...p, scaleMPerPx: s }));
    else setMessage({ kind: 'error', text: 'Enter a distance greater than 0 between two different points.' });
    setCalib([]);
    setTool('select');
  };
  const showPanel = (id: PanelId) => setLayout((l) => openPanel(l, id));
  /** A selector in another panel asks the user to click a node / pump / line on the network. */
  const startPick = (id: string, accept: PickAccept, label: string, apply: (uid: string) => void) => {
    if (pick?.id === id) return setPick(null); // pressing the active button again cancels
    setTool('select');
    setPending(undefined);
    imgs.setAdjustImageId(undefined);
    setPick({ id, accept, label, apply });
    showPanel('network');
  };

  /** Delete: a group of selected nodes, or the single selection. */
  const deleteSelection = () => {
    if (multi.size > 0) {
      setProject((p) => removeNodes(p, multi));
      setMulti(new Set());
      setSelection(null);
    } else edit.deleteSelected();
  };
  const copySelection = () => {
    const ids = multi.size > 0 ? multi : selection?.type === 'node' ? new Set([selection.uid]) : new Set<string>();
    const c = copyNodes(project, ids);
    if (!c) return false;
    clip.current = c;
    setMessage({ kind: 'info', text: `Copied ${c.nodes.length} node${c.nodes.length === 1 ? '' : 's'} and ${c.edges.length} pipe, valve or pump${c.edges.length === 1 ? '' : 's'}. Press Ctrl+V to paste.` });
    return true;
  };
  const pasteSelection = () => {
    if (!clip.current) return false;
    const r = pasteClip(project, clip.current);
    syncUidCounter(r.project);
    setProject(r.project);
    setMulti(new Set(r.newNodeUids));
    setSelection(null);
    return true;
  };

  // ---- whole-project actions
  const replaceProject = (p: ProjectUI, text?: string) => {
    setMulti(new Set());
    setEpoch((n) => n + 1);
    setPick(null);
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
  const openFile = async (file: File) => {
    try {
      replaceProject(parseProject(await file.text()), `Opened ${file.name}.`);
    } catch (err) {
      setMessage({ kind: 'error', text: `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const canExport = !!computed.result && computed.result.converged && !!computed.model;
  const exportXlsx = async () => {
    setMessage(undefined);
    try {
      // panels that are not on screen do not keep their results up to date, so work them out now
      await exportWorkbook({ project, computed, chartSvg: chart?.exportSvg, sweep: sweep ?? runSweep(), comparison: scenarios.length ? (comparison ?? runComparison()) : undefined, targets: targetStatuses });
    } catch (err) {
      setMessage({ kind: 'error', text: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // scenarios
  const saveScenario = (name: string) => setProject((p) => ({ ...p, scenarios: [...(p.scenarios ?? []), snapshotScenario(p, name || `Scenario ${(p.scenarios?.length ?? 0) + 1}`)] }));
  const loadScenario = (id: string) => {
    const s = scenarios.find((x) => x.id === id);
    if (!s) return;
    const snap = JSON.parse(JSON.stringify(s.project)) as Omit<ProjectUI, 'images' | 'scenarios'>;
    replaceProject({ ...snap, images: project.images, scenarios: project.scenarios, targets: project.targets, assumptions: project.assumptions, pumpCurves: project.pumpCurves, drafts }, `Loaded “${s.name}”.`);
  };
  const deleteScenario = (id: string) => setProject((p) => ({ ...p, scenarios: (p.scenarios ?? []).filter((s) => s.id !== id) }));
  const renameScenario = (id: string, name: string) => setProject((p) => ({ ...p, scenarios: (p.scenarios ?? []).map((s) => (s.id === id ? { ...s, name } : s)) }), `scn:${id}`);

  // ---- keyboard
  // One keyboard listener for the life of the app. It calls the latest handler through a ref, so it is never removed and re-added
  // in the middle of a key event (which would make the browser skip other listeners for that event).
  const onKeyRef = useRef<(ev: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (ev: KeyboardEvent) => {
    const tag = (ev.target as HTMLElement | null)?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && !typing && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      ev.shiftKey ? redo() : undo();
    } else if (mod && !typing && ev.key.toLowerCase() === 'y') {
      ev.preventDefault();
      redo();
    } else if (mod && !typing && ev.key.toLowerCase() === 'c') {
      if (copySelection()) ev.preventDefault();
    } else if (mod && !typing && ev.key.toLowerCase() === 'v') {
      if (pasteSelection()) ev.preventDefault();
    } else if (typing) return;
    else if (ev.key === '?') setHelp((h) => !h);
    else if (ev.key === 'Escape') {
      setPick(null);
      imgs.setAdjustImageId(undefined);
      setPending(undefined);
      setCalib([]);
      setMulti(new Set());
      setTool('select');
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') deleteSelection();
  };
  useEffect(() => {
    const listener = (ev: KeyboardEvent) => onKeyRef.current(ev);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // ---- layout persistence; selecting something brings the Properties tab forward (if it is open)
  useEffect(() => {
    const t = setTimeout(() => saveLayout(layout), 300);
    return () => clearTimeout(t);
  }, [layout]);
  useEffect(() => {
    if (selection) setLayout((l) => activatePanel(l, 'properties'));
  }, [selection]);

  const selectByName = (name: string) => {
    const n = project.nodes.find((q) => q.name === name);
    if (n) return setSelection({ type: 'node', uid: n.uid });
    const e = project.edges.find((q) => q.name === name);
    if (e) setSelection({ type: 'edge', uid: e.uid });
  };

  const selNode = selection?.type === 'node' ? project.nodes.find((n) => n.uid === selection.uid) : undefined;
  const selEdge = selection?.type === 'edge' ? project.edges.find((e) => e.uid === selection.uid) : undefined;
  const pumpFit = selEdge?.kind === 'pump' ? computed.pumpCurves.find((c) => c.name === selEdge.name)?.headFitRmse : undefined;
  const hasSide = !!(selNode || selEdge);

  const failing = targetStatuses.filter((x) => !x.pass).length;
  const badge = (id: PanelId): string | undefined =>
    id === 'targets' ? (targets.length ? `(${targets.length}${failing ? `, ${failing} failing` : ''})` : undefined)
    : id === 'drafts' ? `(${drafts.filter((d) => d.status !== 'discarded').length})`
    : id === 'pumpcurves' ? (lib.curves.length ? `(${lib.curves.length})` : undefined)
    : undefined;

  const networkPanel = (
    <div className="net-panel">
      <NetworkToolbar
        tool={tool}
        onSelectTool={() => toSelect('select')}
        onPickTool={pickTool}
        canDelete={!!selection || multi.size > 0}
        onDelete={deleteSelection}
        images={project.images}
        adjustId={imgs.adjustImageId}
        adjustTargetId={imgs.adjustTarget?.id}
        onAdjustPick={imgs.setAdjustPick}
        onToggleAdjust={toggleAdjust}
        onAddImageFile={(f) => void imgs.addImageFile(f)}
        findItems={[...project.nodes.map((n) => ({ uid: n.uid, label: n.name })), ...project.edges.map((e) => ({ uid: e.uid, label: e.name }))]}
        onFind={(uid) => {
          setSelection(project.nodes.some((n) => n.uid === uid) ? { type: 'node', uid } : { type: 'edge', uid });
          setFocus((f) => ({ uid, n: (f?.n ?? 0) + 1 }));
        }}
      />
      <Canvas
        project={project}
        result={computed.result}
        selection={selection}
        tool={tool}
        pending={pending}
        calib={calib}
        onSelect={setSelection}
        onTool={toSelect}
        onAddNode={edit.addNode}
        onMoveNode={edit.moveNode}
        multi={multi}
        onMulti={setMulti}
        onMoveNodes={(m) => setProject((p) => moveNodes(p, m), 'drag:group')}
        onMoveImage={(id, x, y) => imgs.updateImage(id, { x, y })}
        onConnect={edit.connect}
        onInsert={edit.insertInto}
        onPlace={edit.placeAlone}
        onConnectNew={edit.connectNew}
        onConnectBlank={edit.connectBlankDrag}
        onReverse={edit.reverseEdge}
        adjustImageId={imgs.adjustImageId}
        onZoomImage={imgs.zoomImage}
        onAdjustDone={() => imgs.setAdjustImageId(undefined)}
        onPending={setPending}
        onCalibPoint={(p) => setCalib((c) => (c.length >= 2 ? [p] : [...c, p]))}
        fitKey={epoch}
        focus={focus}
        pick={pick ?? undefined}
        onPick={(uid) => { const back = pick?.id.startsWith('speed') ? 'speed' : pick?.id.startsWith('pumpctl') ? 'properties' : 'targets'; pick?.apply(uid); setPick(null); setLayout((l) => activatePanel(l, back)); }}
        onPickCancel={() => setPick(null)}
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
            {multi.size > 1 && (
              <section className="editor">
                <h3>{multi.size} nodes selected</h3>
                <p className="hint">Drag one to move them all. Delete removes them and their pipes. Ctrl+C then Ctrl+V copies them with the pipes between them. Click empty space or press Esc to deselect.</p>
              </section>
            )}
            {!hasSide && multi.size <= 1 && (
              <section className="editor empty-side">
                <h3>Properties</h3>
                <p className="hint">Nothing selected. Click a node, pipe, valve or pump on the network to edit it here.</p>
              </section>
            )}
            {selNode && <NodeEditor node={selNode} onChange={edit.updateNode} />}
            {selEdge?.kind === 'pipe' && <PipeEditor pipe={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} canvasLengthM={pipeLengthM(project, selEdge)} onChange={edit.updateEdge} />}
            {selEdge?.kind === 'valve' && (
              <ValveEditor
                valve={selEdge}
                from={nodeName(selEdge.from)}
                to={nodeName(selEdge.to)}
                onChange={edit.updateEdge}
                designFlowLps={Math.abs(computed.result?.valves.find((x) => x.id === selEdge.name)?.flowM3s ?? 0) * 1000}
                density={computed.model?.fluid.density}
              />
            )}
            {selEdge?.kind === 'pump' && (
              <PumpEditor
                pump={selEdge}
                from={nodeName(selEdge.from)}
                to={nodeName(selEdge.to)}
                onChange={edit.updateEdge}
                headFitRmse={pumpFit}
                curves={lib.curves}
                onAssignCurve={(cid) => lib.assignCurve(selEdge.uid, cid)}
                onSaveCurve={() => lib.saveCurveFromPump(selEdge)}
                onManageCurves={() => { lib.setCurveFocus(selEdge.curveId); showPanel('pumpcurves'); }}
                nodes={project.nodes.map((n) => ({ uid: n.uid, name: n.name }))}
                onPickNode={(apply) => startPick(`pumpctl:${selEdge.uid}`, 'node', `${selEdge.name} control node`, apply)}
                pickActive={pick?.id === `pumpctl:${selEdge.uid}`}
                solvedSpeed={computed.result?.pumps.find((x) => x.id === selEdge.name)?.speedRatio}
              />
            )}
          </div>
        );
      case 'pumpcurves':
        return <PumpCurvesPanel curves={lib.curves} pumps={pumpEdges} selectedPump={selEdge?.kind === 'pump' ? selEdge : undefined} focusId={lib.curveFocus} onChange={lib.updateCurves} onUse={lib.assignCurve} />;
      case 'results':
        return <Results computed={computed} onSelectName={selectByName} />;
      case 'pumpchart':
        return chart ? <div className="chart" style={{ aspectRatio: `${CHART_W} / ${CHART_H}` }} dangerouslySetInnerHTML={{ __html: chart.screen }} /> : <p className="hint">Add a pump to see its curve and operating point.</p>;
      case 'targets':
        return (
          <>
            <TargetsPanel project={project} targets={targets} statuses={targetStatuses} onChange={(t) => setProject((p) => ({ ...p, targets: t }), 'targets')} pickId={pick?.id} onPick={startPick} />
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
            onAddImage={imgs.addImage}
            onUpdateImage={imgs.updateImage}
            adjustImageId={imgs.adjustImageId}
            onAdjust={imgs.setAdjustImageId}
            onZoom={(iid, f) => { const im = project.images.find((q) => q.id === iid); if (im) imgs.zoomImage(iid, f, im.x + im.width / 2, im.y + im.height / 2); }}
            onDeleteImage={imgs.deleteImage}
            onStartCalib={() => { setCalib([]); setPending(undefined); setTool('scale'); }}
            onApplyCalib={applyCalib}
            onCancelCalib={() => { setCalib([]); setTool('select'); }}
          />
        );
      case 'speed':
        return <SpeedPanel pumps={pumpEdges} config={{ ...speedCfg, pumpUid: speedPumpUid }} onConfig={setSpeedCfg} sweep={sweep} pickId={pick?.id} onPick={startPick} />;
      case 'scenarios':
        return <ScenarioPanel scenarios={scenarios} comparison={comparison ?? runComparison()} onSave={saveScenario} onLoad={loadScenario} onDelete={deleteScenario} onRename={renameScenario} />;
      case 'report':
        return <ReportPanel project={project} computed={computed} targets={targetStatuses} buildId={typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'} />;
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
        <TopBar
          buildId={typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          onNew={() => replaceProject(blankProject())}
          onExample={() => replaceProject(defaultProject())}
          onOpenFile={(f) => void openFile(f)}
          onSave={() => downloadProject(project, drafts)}
          unitSystem={unitSystem}
          onUnits={setUnitSystem}
          layout={layout}
          onLayout={setLayout}
          canExport={canExport}
          onExport={() => void exportXlsx()}
          onHelp={() => setHelp(true)}
        />
        {help && <HelpDialog onClose={() => setHelp(false)} />}
        <FluidBar project={project} computed={computed} onFluid={edit.updateFluid} onSetting={(patch, k) => setProject((p) => ({ ...p, ...patch }), k)} />
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
