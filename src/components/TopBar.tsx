import { useRef } from 'react';
import { LayoutMenu, PanelsMenu } from '../layout/Workspace';
import type { LayoutNode } from '../layout/layout';
import type { UnitSystem } from '../units';

interface Props {
  buildId: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onNew: () => void;
  onExample: () => void;
  onOpenFile: (file: File) => void;
  onSave: () => void;
  onExportInp: () => void;
  unitSystem: UnitSystem;
  onUnits: (u: UnitSystem) => void;
  layout: LayoutNode;
  onLayout: (l: LayoutNode) => void;
  canExport: boolean;
  onExport: () => void;
  onHelp: () => void;
}

/** Title, project menu (undo, new, open, save), units, layout and panel menus, and Excel export. */
export function TopBar(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <header className="topbar">
      <h1>Pipe Network Calculator</h1>
      <small className="build-id">build {p.buildId}</small>
      <div className="menu" role="toolbar" aria-label="Project">
        <button onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
        <button onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
        <span className="sep" />
        <button onClick={p.onNew}>New</button>
        <button onClick={p.onExample}>Example</button>
        <button onClick={() => fileInput.current?.click()} title="Project (.json), EPANET (.inp) or piping component file (.pcf)">Open…</button>
        <button onClick={p.onSave}>Save…</button>
        <button onClick={p.onExportInp} title="EPANET input file">Export .inp</button>
        <input ref={fileInput} type="file" accept=".json,.inp,.pcf,application/json" aria-label="Open project file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) p.onOpenFile(f); }} />
        <span className="sep" />
        <span className="seg" role="group" aria-label="Unit system">
          <button className={p.unitSystem === 'si' ? 'active' : ''} aria-pressed={p.unitSystem === 'si'} onClick={() => p.onUnits('si')}>SI</button>
          <button className={p.unitSystem === 'us' ? 'active' : ''} aria-pressed={p.unitSystem === 'us'} onClick={() => p.onUnits('us')}>US</button>
        </span>
        <span className="sep" />
        <LayoutMenu layout={p.layout} onLayout={p.onLayout} />
        <PanelsMenu layout={p.layout} onLayout={p.onLayout} />
      </div>
      <button onClick={p.onHelp} title="Mouse and keyboard help (?)" aria-label="Help">? Help</button>
      <button className="primary export" disabled={!p.canExport} onClick={p.onExport} title="Excel sheets are always in SI units">Export Excel</button>
    </header>
  );
}
