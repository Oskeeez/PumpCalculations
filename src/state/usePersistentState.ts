import { useEffect, useState } from 'react';

/** State kept in localStorage. `restore` turns whatever was saved (or nothing) into a valid value, so old or damaged data is harmless. */
export function usePersistentState<T>(key: string, restore: (saved: unknown) => T): [T, (v: T | ((cur: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return restore(raw ? JSON.parse(raw) : undefined);
    } catch {
      return restore(undefined);
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}
