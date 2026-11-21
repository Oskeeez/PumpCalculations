import { useRef, useState } from 'react';
import { planDistancePx } from '../geometry';
import { loadImageFile } from '../images';
import type { ImageLayer } from '../model';
import { NumField } from './NumField';

interface Props {
  scaleMPerPx: number;
  canvasW: number;
  canvasH: number;
  images: ImageLayer[];
  calib: { x: number; y: number }[];
  calibActive: boolean;
  onScale: (mPerPx: number) => void;
  onCanvasSize: (w: number, h: number) => void;
  onAddImage: (layer: ImageLayer) => void;
  onUpdateImage: (id: string, patch: Partial<ImageLayer>) => void;
  /** Image currently being adjusted on the canvas (move by dragging, zoom with the wheel or the buttons). */
  adjustImageId?: string;
  onAdjust: (id: string | undefined) => void;
  onZoom: (id: string, factor: number) => void;
  onDeleteImage: (id: string) => void;
  onStartCalib: () => void;
  onApplyCalib: (realMetres: number) => void;
  onCancelCalib: () => void;
}

export function CanvasPanel(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [real, setReal] = useState(10);
  const [error, setError] = useState<string>();
  const ready = p.calib.length === 2;

  const addImage = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(undefined);
    try {
      const img = await loadImageFile(file);
      const k = Math.min(1, p.canvasW / img.width, p.canvasH / img.height);
      p.onAddImage({
        id: `img${Date.now()}`,
        name: file.name,
        dataUrl: img.dataUrl,
        x: 0,
        y: 0,
        width: Math.round(img.width * k),
        height: Math.round(img.height * k),
        opacity: 0.6,
        locked: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <h4>Scale</h4>
      <div className="grid">
        <NumField label="Distance per 100 px" q="length" value={p.scaleMPerPx * 100} onChange={(v) => v > 0 && p.onScale(v / 100)} />
        <div className="field">
          <span>Calibrate from the canvas</span>
          <button onClick={p.onStartCalib} className={p.calibActive ? 'active' : ''}>Pick two points…</button>
        </div>
        <NumField label="Canvas width" unit="px" value={p.canvasW} onChange={(v) => v >= 400 && v <= 6000 && p.onCanvasSize(Math.round(v), p.canvasH)} />
        <NumField label="Canvas height" unit="px" value={p.canvasH} onChange={(v) => v >= 300 && v <= 4000 && p.onCanvasSize(p.canvasW, Math.round(v))} />
      </div>
      {p.calibActive && (
        <div className="calib-box">
          {!ready ? (
            <span>Click two points on the canvas ({p.calib.length}/2).</span>
          ) : (
            <>
              <span>Picked points are {Math.round(planDistancePx(p.calib[0], p.calib[1]))} px apart.</span>
              <NumField label="Real distance" q="length" value={real} onChange={setReal} />
              <button className="primary" onClick={() => p.onApplyCalib(real)}>Apply scale</button>
            </>
          )}
          <button onClick={p.onCancelCalib}>Cancel</button>
        </div>
      )}

      <h4>Images</h4>
      <button onClick={() => fileInput.current?.click()}>Add image…</button>
      <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { void addImage(e.target.files); e.target.value = ''; }} />
      {error && <div className="banner error">{error}</div>}
      {p.images.length > 0 && (
        <ul className="img-list">
          {p.images.map((im) => (
            <li key={im.id}>
              <div className="img-head">
                <input value={im.name} aria-label="Image name" onChange={(e) => p.onUpdateImage(im.id, { name: e.target.value })} />
                <button className={p.adjustImageId === im.id ? 'active primary' : ''} aria-pressed={p.adjustImageId === im.id} onClick={() => p.onAdjust(p.adjustImageId === im.id ? undefined : im.id)} title="Drag the image on the canvas to move it, scroll to zoom">{p.adjustImageId === im.id ? 'Done adjusting' : 'Adjust'}</button>
                <button onClick={() => p.onUpdateImage(im.id, { x: 0, y: 0, width: p.canvasW, height: Math.round((p.canvasW * im.height) / im.width) })}>Fit width</button>
                <button onClick={() => p.onDeleteImage(im.id)} aria-label={`Remove ${im.name}`}>Remove</button>
              </div>
 {p.adjustImageId === im.id && (
                <div className="calib-box">
                  <span>Drag the image on the canvas to move it. Scroll over the canvas, or use the buttons, to zoom.</span>
                  <button onClick={() => p.onZoom(im.id, 1 / 1.1)}>Zoom −</button>
                  <button onClick={() => p.onZoom(im.id, 1.1)}>Zoom +</button>
                </div>
              )}
              <div className="grid">
                <NumField label="X" unit="px" value={im.x} onChange={(v) => p.onUpdateImage(im.id, { x: v })} />
                <NumField label="Y" unit="px" value={im.y} onChange={(v) => p.onUpdateImage(im.id, { y: v })} />
                <NumField label="Width" unit="px" value={im.width} onChange={(v) => v > 10 && p.onUpdateImage(im.id, { width: v, height: Math.round((v * im.height) / im.width) })} />
                <label className="field">
                  <span>Opacity</span>
                  <input type="range" min={0.05} max={1} step={0.05} value={im.opacity} onChange={(e) => p.onUpdateImage(im.id, { opacity: Number(e.target.value) })} />
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
