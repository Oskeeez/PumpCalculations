import { useMemo, useState } from 'react';
import { Diagram } from './components/Diagram';
import { PipeEditor, PumpEditor, TankEditor } from './components/Editors';
import { NumField } from './components/NumField';
import { Results } from './components/Results';
import { CHART_H, CHART_W, EXPORT_THEME, SCREEN_THEME, curveChartSvg, svgToPngBase64 } from './curveChart';
import { compute, defaultProject, newPipe, newPump, type ElementUI, type ProjectUI } from './model';

export function App() {
  const [project, setProject] = useState<ProjectUI>(defaultProject);
  const [selected, setSelected] = useState<string>('source');
  const [exportError, setExportError] = useState<string>();
  const computed = useMemo(() => compute(project), [project]);

  const chart = useMemo(() => {
    if (!computed.curves) return '';
    const op = computed.op?.status === 'ok' ? { flowM3s: computed.op.flowM3s, headM: computed.op.headM } : undefined;
    return { screen: curveChartSvg({ curves: computed.curves, op }, SCREEN_THEME), exportSvg: curveChartSvg({ curves: computed.curves, op }, EXPORT_THEME) };
  }, [computed]);

  const selIndex = project.elements.findIndex((e) => e.uid === selected);
  const selEl = selIndex >= 0 ? project.elements[selIndex] : undefined;

  const setElements = (elements: ElementUI[]) => setProject({ ...project, elements });
  const replace = (el: ElementUI) => setElements(project.elements.map((e) => (e.uid === el.uid ? el : e)));
  const add = (el: ElementUI) => {
    const at = selIndex >= 0 ? selIndex + 1 : project.elements.length;
    setElements([...project.elements.slice(0, at), el, ...project.elements.slice(at)]);
    setSelected(el.uid);
  };
  const count = (k: 'pipe' | 'pump') => project.elements.filter((e) => e.kind === k).length + 1;
  const remove = () => {
    if (!selEl) return;
    setElements(project.elements.filter((e) => e.uid !== selEl.uid));
    setSelected('source');
  };
  const move = (d: -1 | 1) => {
    const j = selIndex + d;
    if (selIndex < 0 || j < 0 || j >= project.elements.length) return;
    const els = [...project.elements];
    [els[selIndex], els[j]] = [els[j], els[selIndex]];
    setElements(els);
  };

  const canExport = computed.op?.status === 'ok' && !!computed.system && !!computed.analysis && !!computed.curves;
  const exportXlsx = async () => {
    if (!canExport || !computed.system || !computed.op || !computed.analysis || !computed.curves || typeof chart === 'string') return;
    setExportError(undefined);
    try {
      const png = await svgToPngBase64(chart.exportSvg);
      const { buildWorkbook, workbookToBuffer } = await import('./excel/export'); // lazy: keeps ExcelJS out of the first load
      const wb = await buildWorkbook({
        system: computed.system,
        op: computed.op,
        analysis: computed.analysis,
        curves: computed.curves,
        npshMarginM: project.npshMarginM,
        chartPngBase64: png,
      });
      const buf = await workbookToBuffer(wb);
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pump-calculation.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    }
  };

  const pumpModelFor = (uid: string) => {
    const idx = project.elements.findIndex((e) => e.uid === uid);
    const el = computed.system?.elements[idx];
    return el && el.kind === 'pump' ? el.model : undefined;
  };

  return (
    <div className="app">
      <header>
        <h1>Pump &amp; Pipe Calculator</h1>
        <div className="header-fluid">
          <NumField label="Water temperature" unit="°C" value={project.temperatureC} onChange={(v) => setProject({ ...project, temperatureC: v })} />
          <NumField label="NPSH margin" unit="m" value={project.npshMarginM} onChange={(v) => setProject({ ...project, npshMarginM: v })} title="Required NPSHa above NPSHr" />
          {computed.system && (
            <span className="fluid-props">
              ρ {computed.system.fluid.density.toFixed(1)} kg/m³ · μ {(computed.system.fluid.dynamicViscosity * 1000).toFixed(3)} mPa·s · p<sub>v</sub> {(computed.system.fluid.vaporPressure / 1000).toFixed(2)} kPa
            </span>
          )}
        </div>
        <button className="primary" disabled={!canExport} onClick={exportXlsx} title={canExport ? '' : 'Needs a valid operating point'}>
          Export Excel
        </button>
      </header>
      {exportError && <div className="banner error">Export failed: {exportError}</div>}

      <div className="toolbar">
        <span>Chain (flow left → right):</span>
        <button onClick={() => add(newPipe(count('pipe')))}>+ Pipe</button>
        <button onClick={() => add(newPump(count('pump')))}>+ Pump</button>
        <button onClick={() => move(-1)} disabled={!selEl || selIndex === 0} aria-label="Move selected element upstream">← Move</button>
        <button onClick={() => move(1)} disabled={!selEl || selIndex === project.elements.length - 1} aria-label="Move selected element downstream">Move →</button>
        <button onClick={remove} disabled={!selEl}>Remove</button>
        <small>New elements are inserted after the selected one. Click a block to edit it.</small>
      </div>

      <Diagram project={project} computed={computed} selected={selected} onSelect={setSelected} />

      <main>
        <div className="col">
          {selected === 'source' && <TankEditor title="Source tank" tank={project.source} onChange={(source) => setProject({ ...project, source })} />}
          {selected === 'dest' && <TankEditor title="Destination tank" tank={project.destination} onChange={(destination) => setProject({ ...project, destination })} />}
          {selEl?.kind === 'pipe' && <PipeEditor pipe={selEl} onChange={replace} />}
          {selEl?.kind === 'pump' && <PumpEditor pump={selEl} onChange={replace} headFitRmse={pumpModelFor(selEl.uid)?.fitRmse.head} />}
        </div>
        <div className="col">
          <Results computed={computed} />
          {typeof chart !== 'string' && (
            <div className="chart" style={{ aspectRatio: `${CHART_W} / ${CHART_H}` }} dangerouslySetInnerHTML={{ __html: chart.screen }} />
          )}
        </div>
      </main>
    </div>
  );
}
