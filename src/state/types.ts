import type { ProjectUI } from '../model';

/** A short message shown to the user as a pop-up. */
export interface Message {
  kind: 'error' | 'info';
  text: string;
}

export type SetProject = (u: ProjectUI | ((p: ProjectUI) => ProjectUI), key?: string) => void;
