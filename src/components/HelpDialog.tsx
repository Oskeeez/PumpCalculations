import { useLayoutEffect, useRef } from 'react';

const ROWS: [string, string][] = [
  ['Click an item', 'Select it'],
  ['Drag a node', 'Move it'],
  ['Drag empty space', 'Pan (middle button pans in any mode)'],
  ['Scroll wheel', 'Zoom'],
  ['Shift + drag', 'Box select'],
  ['Shift + click', 'Add to or remove from the selection'],
  ['Delete', 'Delete the selection'],
  ['Ctrl+C, Ctrl+V', 'Copy and paste nodes with their pipes'],
  ['Ctrl+Z, Ctrl+Shift+Z', 'Undo, redo'],
  ['Esc, right-click', 'Leave the current tool'],
  ['Pipe tool, drag across empty space', 'Create two nodes and the pipe'],
  ['Any tool, click a pipe', 'Split the pipe and insert the element'],
  ['◎ Pick', 'Choose from the network instead of a list'],
  ['Drag a tab', 'Move a panel; drop on a tile edge to dock it'],
  ['Drag a bar', 'Resize; double-click evens the tiles'],
  ['⤢', 'Maximise a tile'],
  ['?', 'This help'],
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
