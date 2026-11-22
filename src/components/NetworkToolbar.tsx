import { useEffect, useRef, useState, type ReactNode } from 'react';
import { JUNCTION_FITTING_LABELS, VALVE_TYPES, type JunctionFittingType } from '../fittings';
import type { ImageLayer } from '../model';
import type { Tool } from './Canvas';

const TOOLS: { id: Exclude<Tool, 'select' | 'scale'>; label: string; title: string }[] = [
  { id: 'tank', label: '▭ Tank', title: 'Place a tank' },
  { id: 'junction', label: '● Junction', title: 'Place a junction' },
  { id: 'pipe', label: '— Pipe', title: 'Drag from node to node' },
  { id: 'valve', label: '⋈ Valve', title: 'Click a pipe or empty space, or click two nodes' },
  { id: 'orifice', label: '⫴ Orifice', title: 'Click a pipe or empty space, or click two nodes' },
  { id: 'pump', label: '◉ Pump', title: 'Click a pipe or empty space, or click the suction node then the discharge node' },
];

interface Props {
  tool: Tool;
  junctionPreset: JunctionFittingType | 'none';
  onJunctionPreset: (t: JunctionFittingType | 'none') => void;
  valvePreset: string;
  onValvePreset: (id: string) => void;
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
      {TOOLS.map((t) => {
        const button = (
          <button className={p.tool === t.id ? 'active' : ''} title={t.title} aria-pressed={p.tool === t.id} onClick={() => p.onPickTool(t.id)}>{t.label}</button>
        );
        if (t.id === 'junction') {
          const options = (['none', 'elbow', 'tee', 'wye', 'cross', 'reducer'] as const).map((k) => ({ value: k as string, label: JUNCTION_FITTING_LABELS[k] }));
          return <ToolMenu key={t.id} button={button} label="Junction type" value={p.junctionPreset} options={options} onPick={(v) => { p.onJunctionPreset(v as JunctionFittingType | 'none'); p.onPickTool('junction'); }} />;
        }
        if (t.id === 'valve') {
          const options = [{ value: '', label: 'Custom' }, ...VALVE_TYPES.map((v) => ({ value: v.id as string, label: v.label }))];
          return <ToolMenu key={t.id} button={button} label="Valve type" value={p.valvePreset} options={options} onPick={(v) => { p.onValvePreset(v); p.onPickTool('valve'); }} />;
        }
        return <span key={t.id} style={{ display: 'contents' }}>{button}</span>;
      })}
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

/** A tool button with a ▾ that opens its type list right underneath it. */
function ToolMenu({ button, label, value, options, onPick }: { button: ReactNode; label: string; value: string; options: { value: string; label: string }[]; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const current = options.find((o) => o.value === value)?.label ?? '';
  return (
    <div className="menu-wrap tool-menu" ref={wrap}>
      {button}
      <button className="tool-caret" aria-haspopup="menu" aria-expanded={open} aria-label={label} title={`${label}: ${current}`} onClick={() => setOpen((o) => !o)}>▾</button>
      {open && (
        <div className="ws-menu top" role="menu" aria-label={label}>
          {options.map((o) => (
            <button key={o.value} role="menuitemradio" aria-checked={o.value === value} onClick={() => { onPick(o.value); setOpen(false); }}>{o.value === value ? '✓ ' : ''}{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
