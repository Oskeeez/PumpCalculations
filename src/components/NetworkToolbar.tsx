import { useRef, useState } from 'react';
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
  /** Everything that can be found by name. */
  findItems: { uid: string; label: string }[];
  onFind: (uid: string) => void;
}

/** Drawing tools, delete, and the image controls above the network canvas. */
export function NetworkToolbar(p: Props) {
  const imageInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const find = (value: string) => {
    setQuery(value);
    const hit = p.findItems.find((i) => i.label.toLowerCase() === value.trim().toLowerCase());
    if (hit) {
      p.onFind(hit.uid);
      setQuery('');
    }
  };
  return (
    <div className="toolbar" role="toolbar" aria-label="Network tools">
      <button className={p.tool === 'select' ? 'active' : ''} aria-pressed={p.tool === 'select'} title="Select and move (Esc)" onClick={p.onSelectTool}>↖ Select</button>
      {TOOLS.map((t) => (
        <button key={t.id} className={p.tool === t.id ? 'active' : ''} title={t.title} aria-pressed={p.tool === t.id} onClick={() => p.onPickTool(t.id)}>{t.label}</button>
      ))}
      <button onClick={p.onDelete} disabled={!p.canDelete}>Delete</button>
      <span className="sep" />
      <input className="find" list="find-items" value={query} placeholder="Find a node or pipe…" aria-label="Find a node or pipe by name" onChange={(e) => find(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { const m = p.findItems.find((i) => i.label.toLowerCase().includes(query.trim().toLowerCase())); if (m && query.trim()) { p.onFind(m.uid); setQuery(''); } } }} />
      <datalist id="find-items">{p.findItems.map((i) => <option key={i.uid} value={i.label} />)}</datalist>
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
          <button className={p.adjustId ? 'active' : ''} aria-pressed={!!p.adjustId} onClick={p.onToggleAdjust}>{p.adjustId ? '✓ Done adjusting' : '🖼 Adjust image'}</button>
          <button onClick={() => imageInput.current?.click()} title="Add another image">+ Image</button>
        </>
      )}
      <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => { p.onAddImageFile(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}
