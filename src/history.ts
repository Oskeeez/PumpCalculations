import { useCallback, useState } from 'react';

interface State<T> {
  past: T[];
  present: T;
  future: T[];
  key: string;
  time: number;
}

/**
 * State with undo/redo. Updates that share a `key` within `coalesceMs` of each other (typing in a field,
 * dragging a node) are merged into one undo step.
 */
export function useHistory<T>(initial: () => T, coalesceMs = 1000) {
  const [s, setS] = useState<State<T>>(() => ({ past: [], present: initial(), future: [], key: '', time: 0 }));

  const set = useCallback(
    (updater: T | ((p: T) => T), key?: string) =>
      setS((cur) => {
        const next = typeof updater === 'function' ? (updater as (p: T) => T)(cur.present) : updater;
        if (next === cur.present) return cur;
        const now = Date.now();
        const merge = key !== undefined && key === cur.key && now - cur.time < coalesceMs;
        return { past: merge ? cur.past : [...cur.past.slice(-99), cur.present], present: next, future: [], key: key ?? '', time: now };
      }),
    [coalesceMs],
  );

  const undo = useCallback(
    () => setS((c) => (c.past.length ? { past: c.past.slice(0, -1), present: c.past[c.past.length - 1], future: [c.present, ...c.future], key: '', time: 0 } : c)),
    [],
  );
  const redo = useCallback(
    () => setS((c) => (c.future.length ? { past: [...c.past, c.present], present: c.future[0], future: c.future.slice(1), key: '', time: 0 } : c)),
    [],
  );

  return { state: s.present, set, undo, redo, canUndo: s.past.length > 0, canRedo: s.future.length > 0 };
}
