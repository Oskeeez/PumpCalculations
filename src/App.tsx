import { useEffect, useMemo, useState } from 'react';
import { Canvas, type Selection, type Tool } from './components/Canvas';
import { NodeEditor, PipeEditor, PumpEditor } from './components/Editors';
import { NumField } from './components/NumField';
import { Results } from './components/Results';
import { EXPORT_THEME, SCREEN_THEME, pumpChartSvg, svgToPngBase64, CHART_H, CHART_W } from './curveChart';
import {
  compute,
  defaultProject,
  hydraulicKey,
  newNode,
  newPipe,
  newPump,
  type EdgeUI,
  type NodeKind,
  type NodeUI,
  type ProjectUI,
} from './model';

const TOOLS: { id: Tool; label: string; title: string }[] = [
  { id: 'select', label: '↖ Select', title: 'Select and drag' },
  { id: 'tank', label: '▭ Tank', title: 'Place a tank (fixed-head boundary)' },
  { id: 'junction', label: '● Junction', title: 'Place a junction / demand node' },
  { id: 'pipe', label: '— Pipe', title: 'Connect two nodes with a pipe' },
  { id: 'pump', label: '◉ Pump', title: 'Connect two nodes with a pump (suction → discharge)' },
];

export function App() {
  const [project, setProject] = useState<ProjectUI>(defaultProject);
  const [selection, setSelection] = useState<Selection>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pending, setPending] = useState<string>();
  const [exportError, setExportError] = useState<string>();

  const key = hydraulicKey(project);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const computed = useMemo(() => compute(project), [key]);

  const chartSeries = computed.pumpCurves.map((c) => ({ name: c.name, pts: c.pts, op: c.op }));
  const chart = useMemo(
    () => (chartSeries.length ? { screen: pumpChartSvg(chartSeries, SCREEN_THEME), exportSvg: pumpChartSvg(chartSeries, EXPORT_THEME) } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [computed],
  );

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
  const connect = (kind: 'pipe' | 'pump', from: string, to: string) => {
    const taken = project.edges.map((e) => e.name);
    const e = kind === 'pipe' ? newPipe(from, to, taken) : newPump(from, to, taken);
    setProject((p) => ({ ...p, edges: [...p.edges, e] }));
    setSelection({ type: 'edge', uid: e.uid });
  };
  const moveNode = (uid: string, x: number, y: number) => setProject((p) => ({ ...p, nodes: p.nodes.map((n) => (n.uid === uid ? { ...n, x, y } : n)) }));
  const updateNode = (n: NodeUI) => setProject((p) => ({ ...p, nodes: p.nodes.map((q) => (q.uid === n.uid ? n : q)) }));
  const updateEdge = (e: EdgeUI) => setProject((p) => ({ ...p, edges: p.edges.map((q) => (q.uid === e.uid ? e : q)) }));

  const deleteSelected = () => {
    if (!selection) return;
    setProject((p) =>
      selection.type === 'node'
        ? { ...p, nodes: p.nodes.filter((n) => n.uid !== selection.uid), edges: p.edges.filter((e) => e.from !== selection.uid && e.to !== selection.uid) }
        : { ...p, edges: p.edges.filter((e) => e.uid !== selection.uid) },
    );
    setSelection(null);
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (ev.key === 'Escape') {
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
    setExportError(undefined);
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
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

  const selNode = selection?.type === 'node' ? project.nodes.find((n) => n.uid === selection.uid) : undefined;
  const selEdge = selection?.type === 'edge' ? project.edges.find((e) => e.uid === selection.uid) : undefined;
  const pumpFit = selEdge?.kind === 'pump' ? computed.pumpCurves.find((c) => c.name === selEdge.name)?.headFitRmse : undefined;

  return (
    <div className="app">
      <header>
        <h1>Pipe Network Calculator</h1>
        <div className="header-fluid">
          <NumField label="Water temperature" unit="°C" value={project.temperatureC} onChange={(v) => setProject({ ...project, temperatureC: v })} />
          <NumField label="NPSH margin" unit="m" value={project.npshMarginM} onChange={(v) => setProject({ ...project, npshMarginM: v })} title="Required NPSHa above NPSHr" />
          {computed.model && (
            <span className="fluid-props">
              ρ {computed.model.fluid.density.toFixed(1)} kg/m³ · μ {(computed.model.fluid.dynamicViscosity * 1000).toFixed(3)} mPa·s · p<sub>v</sub> {(computed.model.fluid.vaporPressure / 1000).toFixed(2)} kPa
            </span>
          )}
        </div>
        <button className="primary" disabled={!canExport} onClick={exportXlsx} title={canExport ? '' : 'Needs a solved network'}>Export Excel</button>
      </header>
      {exportError && <div className="banner error">Export failed: {exportError}</div>}

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
          {selEdge?.kind === 'pump' && <PumpEditor pump={selEdge} from={nodeName(selEdge.from)} to={nodeName(selEdge.to)} onChange={updateEdge} headFitRmse={pumpFit} />}
          {!selNode && !selEdge && (
            <section className="editor">
              <h3>Build your network</h3>
              <ol className="steps">
                <li>Place <b>tanks</b> (fixed head) and <b>junctions</b> (set elevation and demand).</li>
                <li>Connect them with <b>pipes</b> and <b>pumps</b>. Loops and branches are fine.</li>
                <li>Click any item to edit it. Results update live on the canvas.</li>
              </ol>
              <p className="hint">At least one tank is required. Flow direction arrows show the solved flow; “Swap direction” on a pipe or pump only flips its sign convention.</p>
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
