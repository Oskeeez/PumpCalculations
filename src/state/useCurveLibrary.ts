import { useState } from 'react';
import type { Message, SetProject } from './types';
import type { ProjectUI, PumpCurveEntry, PumpUI } from '../model';
import { applyCurve, checkCurve, curveFromPump } from '../pumpCurves';


/** The pump curve library: edits flow through to the pumps that use a curve; assigning copies a curve onto a pump. */
export function useCurveLibrary(project: ProjectUI, setProject: SetProject, setMessage: (m: Message | undefined) => void) {
  const curves = project.pumpCurves ?? [];
  /** The curve the library panel should show (e.g. the one a pump just started using). */
  const [curveFocus, setCurveFocus] = useState<string>();

  const updateCurves = (next: PumpCurveEntry[], changedId?: string) =>
    setProject((p) => {
      const changed = changedId ? next.find((c) => c.id === changedId) : undefined;
      let edges = p.edges;
      if (changed && checkCurve(changed).errors.length === 0) {
        // pumps that use this curve follow its edits (they keep their speed and trim)
        edges = edges.map((e) => (e.kind === 'pump' && e.curveId === changed.id ? { ...applyCurve(e, changed), impellerTrim: e.impellerTrim } : e));
      } else if (changedId && !changed) {
        edges = edges.map((e) => (e.kind === 'pump' && e.curveId === changedId ? { ...e, curveId: undefined } : e)); // curve deleted: pumps keep their points
      }
      return { ...p, pumpCurves: next, edges };
    }, changedId ? `curve:${changedId}` : undefined);

  /** Use a library curve on a pump; an empty id detaches the pump from its library curve (it keeps its points). */
  const assignCurve = (pumpUid: string, curveId: string) => {
    if (!curveId) {
      setProject((p) => ({ ...p, edges: p.edges.map((e) => (e.uid === pumpUid && e.kind === 'pump' ? { ...e, curveId: undefined } : e)) }));
      return;
    }
    const c = curves.find((x) => x.id === curveId);
    if (!c) return;
    const bad = checkCurve(c).errors[0];
    if (bad) return setMessage({ kind: 'error', text: `“${c.name}” cannot be used yet: ${bad}` });
    setProject((p) => ({ ...p, edges: p.edges.map((e) => (e.uid === pumpUid && e.kind === 'pump' ? applyCurve(e, c) : e)) }));
    setCurveFocus(c.id);
  };

  const saveCurveFromPump = (pump: PumpUI) => {
    const c = curveFromPump(pump, `${pump.name} curve`);
    setProject((p) => ({ ...p, pumpCurves: [...(p.pumpCurves ?? []), c], edges: p.edges.map((e) => (e.uid === pump.uid && e.kind === 'pump' ? { ...e, curveId: c.id } : e)) }));
    setCurveFocus(c.id);
    setMessage({ kind: 'info', text: `Saved “${c.name}” to the pump curve library.` });
  };

  return { curves, curveFocus, setCurveFocus, updateCurves, assignCurve, saveCurveFromPump };
}
