import { useState } from 'react';
import { mergeDraft } from '../ai/drafts';
import type { Draft } from '../ai/types';
import { syncUidCounter, type ProjectUI } from '../model';
import type { Message, SetProject } from './types';

/**
 * AI drafts. They live outside the undo history (the AI changes them asynchronously) but are saved with the project.
 * Accepting merges changes into the main model; picking a whole draft leaves its siblings as read-only reference.
 */
export function useDrafts(initial: Draft[], project: ProjectUI, setProject: SetProject, setMessage: (m: Message | undefined) => void) {
  const [drafts, setDrafts] = useState<Draft[]>(initial);
  const [draftTab, setDraftTab] = useState('compare');

  const acceptDraft = (id: string, keys: Set<string> | 'all'): string[] => {
    const d = drafts.find((x) => x.id === id);
    if (!d || d.status !== 'open') return ['That draft is read-only.'];
    const res = mergeDraft(project, d, keys);
    syncUidCounter(res.project);
    setProject(res.project);
    const pickedAll = keys === 'all';
    setDrafts((all) =>
      all.map((x) => {
        if (x.id === id) {
          const applied = [...new Set([...(x.appliedKeys ?? []), ...res.applied])];
          return { ...x, appliedKeys: applied, status: pickedAll ? 'merged' : x.status };
        }
        return pickedAll && x.runId === d.runId && x.status === 'open' ? { ...x, status: 'reference' } : x;
      }),
    );
    setMessage({ kind: 'info', text: `Merged ${pickedAll ? 'all changes' : `${res.applied.length} change(s)`} from “${d.name}” into the main model. Undo reverts the main model.` });
    return res.notes;
  };

  const discardDraft = (id: string) => {
    setDrafts((all) => all.filter((x) => x.id !== id));
    setDraftTab('compare');
  };

  return { drafts, setDrafts, draftTab, setDraftTab, acceptDraft, discardDraft };
}
