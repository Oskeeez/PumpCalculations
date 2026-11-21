export const SYM_MIN = 0.5;
export const SYM_MAX = 3;

export type LabelMode = 'full' | 'names' | 'none';
export const LABEL_MODES: LabelMode[] = ['full', 'names', 'none'];
const LABEL_TEXT: Record<LabelMode, string> = { full: 'Names and results', names: 'Names only', none: 'No labels' };

interface Props {
  onZoom: (factor: number) => void;
  onFit: () => void;
  symbolScale: number;
  onSymbolScale: (factor: number) => void;
  labels: LabelMode;
  onLabels: () => void;
  grid: boolean;
  onGrid: () => void;
  snap: boolean;
  onSnap: () => void;
}

/** Large +, −, Fit and symbol-size buttons in the corner of the canvas. */
export function ZoomControls({ onZoom, onFit, symbolScale, onSymbolScale, labels, onLabels, grid, onGrid, snap, onSnap }: Props) {
  return (
    <div className="zoom-ctl" role="group" aria-label="Zoom and symbol size" onPointerDown={(e) => e.stopPropagation()}>
      <button aria-label="Zoom in" title="Zoom in (or scroll up over the network)" onClick={() => onZoom(1.3)}>+</button>
      <button aria-label="Zoom out" title="Zoom out (or scroll down over the network)" onClick={() => onZoom(1 / 1.3)}>−</button>
      <button aria-label="Fit the network to the window" title="Fit the whole network in the window" className="wide" onClick={onFit}>Fit</button>
      <span className="zsep" />
      <button aria-label="Smaller symbols" title="Make nodes, valves, pumps and labels smaller. The zoom does not change." onClick={() => onSymbolScale(1 / 1.2)} disabled={symbolScale <= SYM_MIN + 1e-9}>A−</button>
      <button aria-label="Larger symbols" title="Make nodes, valves, pumps and labels larger. The zoom does not change." onClick={() => onSymbolScale(1.2)} disabled={symbolScale >= SYM_MAX - 1e-9}>A+</button>
      <span className="zsep" />
      <button className="wide" aria-label={`Labels: ${LABEL_TEXT[labels]}. Click to change.`} title={`Labels: ${LABEL_TEXT[labels]}. Click to cycle: names and results, names only, none.`} onClick={onLabels}>{labels === 'full' ? 'Labels' : labels === 'names' ? 'Names' : 'No labels'}</button>
      <button className={`wide ${grid ? 'on' : ''}`} aria-pressed={grid} aria-label="Show the grid" title="Show or hide the grid" onClick={onGrid}>Grid</button>
      <button className={`wide ${snap ? 'on' : ''}`} aria-pressed={snap} aria-label="Snap to the grid" title="Snap nodes to the 10 px grid while placing and dragging (off = free placement)" onClick={onSnap}>Snap</button>
    </div>
  );
}
