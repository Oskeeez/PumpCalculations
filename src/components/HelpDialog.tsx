import { useLayoutEffect, useRef } from 'react';

const ROWS: [string, string][] = [
  ['Click a node, pipe, valve or pump', 'Select it and edit it in Properties'],
  ['Drag a node', 'Move it (snaps to the grid unless Snap is off)'],
  ['Drag empty space', 'Pan the network. Middle-button drag pans in any mode'],
  ['Scroll wheel', 'Zoom about the pointer (or zoom the image while adjusting it)'],
  ['Shift + drag on empty space', 'Draw a box to select several nodes'],
  ['Shift + click a node', 'Add or remove it from the selection'],
  ['Delete / Backspace', 'Delete the selection (nodes take their pipes with them)'],
  ['Ctrl+C, Ctrl+V', 'Copy the selected nodes and the pipes between them, and paste a copy'],
  ['Ctrl+Z, Ctrl+Shift+Z (or Ctrl+Y)', 'Undo and redo'],
  ['Esc', 'Leave a drawing tool, cancel a pick, stop adjusting an image, restore a maximised tile'],
  ['Right-click on the canvas', 'Leave the current drawing tool'],
  ['Tool buttons (Tank, Junction, Pipe, Valve, Orifice, Pump)', 'Stay active after each placement. Press the button again, Esc or right-click to stop'],
  ['Pipe tool: drag across empty space', 'Creates both end nodes and the pipe'],
  ['Tank, Junction, Valve, Orifice or Pump tool: click a pipe', 'Splits the pipe and puts the new element in'],
  ['◎ Pick buttons', 'Choose a node, pump or pipe by clicking it on the network instead of using the list'],
  ['Drag a tab by its title', 'Move a panel. Drop on a tile edge to dock beside it, or in the middle to add as a tab'],
  ['Drag the bars between tiles', 'Resize them. Double-click a bar to even the tiles out'],
  ['⤢ on a tile', 'Make that tile fill the whole workspace; Esc or ❐ restores it'],
  ['?', 'Show this help'],
];

/** A list of the mouse and keyboard shortcuts. Closes with Esc or a click outside. */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  // one listener for as long as the dialog is open, attached as soon as it is on screen, calling the latest onClose
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-back" onPointerDown={onClose}>
      <div className="modal" role="dialog" aria-label="Help and shortcuts" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>Mouse and keyboard</h3><button onClick={onClose} aria-label="Close help">×</button></div>
        <table>
          <tbody>
            {ROWS.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
