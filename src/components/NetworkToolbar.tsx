import { useRef } from 'react';
import type { ImageLayer } from '../model';
import type { Tool } from './Canvas';

const TOOLS: { id: Exclude<Tool, 'select' | 'scale'>; label: string; title: string }[] = [
  { id: 'tank', label: '▭ Tank', title: 'Place a tank' },
  { id: 'junction', label: '● Junction', title: 'Place a junction' },
  { id: 'pipe', label: '— Pipe', title: 'Drag from node to node' },
  { id: 'valve', label: '⋈ Valve', title: 'Click a pipe to insert, or drag from node to node' },
  { id: 'orifice', label: '⫴ Orifice', title: 'Click a pipe to insert an orifice plate, or drag from node to node' },
  { id: 'pump', label: '◉ Pump', title: 'Drag from suction node to discharge node' },
];

interface Props {
  tool: Tool;
  onSelectTool: () => void;
  onPickTool: (t: Tool) => void;
  canDelete: boolean;
  onDelete: () => void;
  images: ImageLayer[];
  adjustId?: string;
  adjustTargetId?: string;
  onAdjustPick: (id: string) => void;
  onToggleAdjust: () => void;
  onAddImageFile: (f: File | undefined) => void;
}

/** Drawing tools, delete, and the image controls above the network canvas. */
export function NetworkToolbar(p: Props) {
  const imageInput = useRef<HTMLInputElement>(null);
  return (
    <div className="toolbar" role="toolbar" aria-label="Network tools">
      <button className={p.tool === 'select' ? 'active' : ''} aria-pressed={p.tool === 'select'} title="Select and move (Esc)" onClick={p.onSelectTool}>↖ Select</button>
      {TOOLS.map((t) => (
        <button key={t.id} className={p.tool === t.id ? 'active' : ''} title={t.title} aria-pressed={p.tool === t.id} onClick={() => p.onPickTool(t.id)}>{t.label}</button>
      ))}
      <button onClick={p.onDelete} disabled={!p.canDelete}>Delete</button>
      <span className="sep" />
      {p.images.length === 0 ? (
        <button onClick={() => imageInput.current?.click()} title="Add a drawing or photo under the network">🖼 Add image…</button>
      ) : (
        <>
          {p.images.length > 1 && (
            <select value={p.adjustTargetId ?? ''} onChange={(e) => p.onAdjustPick(e.target.value)} aria-label="Image to adjust" disabled={!!p.adjustId}>
              {p.images.map((im) => <option key={im.id} value={im.id}>{im.name}</option>)}
            </select>
          )}
          <button className={p.adjustId ? 'active' : ''} aria-pressed={!!p.adjustId} onClick={p.onToggleAdjust} title="Move and zoom the image. Otherwise images cannot be moved or selected.">{p.adjustId ? '✓ Done adjusting' : '🖼 Adjust image'}</button>
          <button onClick={() => imageInput.current?.click()} title="Add another image">+ Image</button>
        </>
      )}
      <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => { p.onAddImageFile(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}
