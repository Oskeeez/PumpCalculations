export const SYM_MIN = 0.5;
export const SYM_MAX = 3;

interface Props {
  onZoom: (factor: number) => void;
  onFit: () => void;
  symbolScale: number;
  onSymbolScale: (factor: number) => void;
}

/** Large +, −, Fit and symbol-size buttons in the corner of the canvas. */
export function ZoomControls({ onZoom, onFit, symbolScale, onSymbolScale }: Props) {
  return (
    <div className="zoom-ctl" role="group" aria-label="Zoom and symbol size" onPointerDown={(e) => e.stopPropagation()}>
      <button aria-label="Zoom in" title="Zoom in (or scroll up over the network)" onClick={() => onZoom(1.3)}>+</button>
      <button aria-label="Zoom out" title="Zoom out (or scroll down over the network)" onClick={() => onZoom(1 / 1.3)}>−</button>
      <button aria-label="Fit the network to the window" title="Fit the whole network in the window" className="wide" onClick={onFit}>Fit</button>
      <span className="zsep" />
      <button aria-label="Smaller symbols" title="Make nodes, valves, pumps and labels smaller. The zoom does not change." onClick={() => onSymbolScale(1 / 1.2)} disabled={symbolScale <= SYM_MIN + 1e-9}>A−</button>
      <button aria-label="Larger symbols" title="Make nodes, valves, pumps and labels larger. The zoom does not change." onClick={() => onSymbolScale(1.2)} disabled={symbolScale >= SYM_MAX - 1e-9}>A+</button>
    </div>
  );
}
