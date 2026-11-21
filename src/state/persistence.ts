/** Browser storage and file download helpers for the project, units and exported workbooks. All storage access is wrapped: failures are ignored. */
import { useEffect } from 'react';
import type { Draft } from '../ai/types';
import { defaultProject, parseProject, serializeProject, type ProjectUI } from '../model';
import type { UnitSystem } from '../units';

const STORAGE_KEY = 'pipe-network-autosave-v1';
const UNITS_KEY = 'pipe-network-units';

/** The last autosaved project, or the example if there is none (or it cannot be read). */
export function loadInitial(): ProjectUI {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return parseProject(saved);
  } catch {
    /* storage unavailable or corrupt: fall back to the example */
  }
  return defaultProject();
}

export function loadUnits(): UnitSystem {
  try {
    return localStorage.getItem(UNITS_KEY) === 'us' ? 'us' : 'si';
  } catch {
    return 'si';
  }
}

/** Autosave (debounced) the project with its drafts, and remember the unit system. */
export function useAutosave(project: ProjectUI, drafts: Draft[], unitSystem: UnitSystem): void {
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, serializeProject({ ...project, drafts }));
      } catch {
        /* private mode or quota: saving to a file still works */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [project, drafts]);
  useEffect(() => {
    try {
      localStorage.setItem(UNITS_KEY, unitSystem);
    } catch {
      /* ignore */
    }
  }, [unitSystem]);
}

/** Offer a blob to the user as a file download. */
export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export const downloadProject = (project: ProjectUI, drafts: Draft[]): void => download('pipe-network.json', new Blob([serializeProject({ ...project, drafts })], { type: 'application/json' }));
