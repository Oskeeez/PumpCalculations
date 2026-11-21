import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { fitView, panBy, viewBox, zoomAbout, type Bounds, type Size, type View } from '../viewport';

interface Options {
  /** The drawing's logical size, used before the canvas has been measured. */
  canvas: Size;
  /** What a fit should show (nodes with label room, images, or the whole canvas) at a given symbol size. */
  bounds: (symbolScale: number) => Bounds;
  symbolScale: number;
  /** Changes when a different project is loaded: the view is fitted again. */
  fitKey?: number;
  /** Called on a wheel turn with the pointer's canvas position; return true to take the event (e.g. zoom an image instead of the view). */
  wheelOverride?: (p: { x: number; y: number }, zoomIn: boolean) => boolean;
}

/**
 * The canvas viewport: pixel size tracking, the view (centre and scale), fit, wheel zoom about the pointer, button zoom, and drag-pan.
 * Pure maths lives in viewport.ts; this hook is the React wiring.
 */
export function useViewport(o: Options) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ cx: o.canvas.w / 2, cy: o.canvas.h / 2, scale: 1 });
  const pan = useRef<{ sx: number; sy: number; cx: number; cy: number; moved: boolean } | null>(null);

  // pixel size of the canvas, kept up to date as tiles are resized
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const ready = size.w > 0 && size.h > 0;
  const fit = (symbolScale = o.symbolScale) => {
    if (ready) setView(fitView(o.bounds(symbolScale), size, 48));
  };

  // fit once the size is known, and again whenever a different project is loaded
  const fitted = useRef<number | undefined>(undefined);
  useEffect(() => {
    const key = o.fitKey ?? 0;
    if (ready && fitted.current !== key) {
      fitted.current = key;
      fit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, o.fitKey]);

  /** Pointer position in canvas units, via the SVG's own transform so it is exact at any zoom. */
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current as SVGSVGElement;
    const m = svg.getScreenCTM();
    if (m) {
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const q = pt.matrixTransform(m.inverse());
      return { x: q.x, y: q.y };
    }
    const r = svg.getBoundingClientRect();
    return { x: view.cx + (e.clientX - r.left - r.width / 2) / view.scale, y: view.cy + (e.clientY - r.top - r.height / 2) / view.scale };
  };

  // Wheel: zoom about the pointer. Needs a non-passive listener so the page itself never scrolls.
  const live = useRef({ toSvg, wheelOverride: o.wheelOverride });
  live.current = { toSvg, wheelOverride: o.wheelOverride };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const p = live.current.toSvg(ev);
      const zoomIn = ev.deltaY < 0;
      if (live.current.wheelOverride?.(p, zoomIn)) return;
      const f = zoomIn ? 1.12 : 1 / 1.12;
      setView((v) => zoomAbout(v, f, p.x, p.y));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (f: number) => setView((v) => zoomAbout(v, f, v.cx, v.cy));
  /** Move the view so a canvas point is in the middle, zooming in if the view is too far out to see it clearly. */
  const centerOn = (x: number, y: number, minScale = 0.8) => setView((v) => ({ cx: x, cy: y, scale: Math.max(v.scale, minScale) }));

  const beginPan = (e: RPointerEvent) => {
    pan.current = { sx: e.clientX, sy: e.clientY, cx: view.cx, cy: view.cy, moved: false };
    svgRef.current?.setPointerCapture(e.pointerId);
  };
  /** Feed pointer moves; returns true while a pan is in progress (the move was used). */
  const movePan = (e: RPointerEvent): boolean => {
    const p = pan.current;
    if (!p) return false;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    if (!p.moved && Math.hypot(dx, dy) > 3) p.moved = true;
    if (p.moved) setView((v) => panBy({ ...v, cx: p.cx, cy: p.cy }, dx, dy));
    return true;
  };
  /** End a pan: 'click' if the pointer never really moved, 'dragged' if it did, undefined if no pan was active. */
  const endPan = (): 'click' | 'dragged' | undefined => {
    const p = pan.current;
    pan.current = null;
    return p ? (p.moved ? 'dragged' : 'click') : undefined;
  };
  const cancelPan = () => {
    pan.current = null;
  };

  return { svgRef, size, view, ready, fit, zoomBy, centerOn, toSvg, beginPan, movePan, endPan, cancelPan, viewBoxString: ready ? viewBox(view, size) : `0 0 ${o.canvas.w} ${o.canvas.h}` };
}
