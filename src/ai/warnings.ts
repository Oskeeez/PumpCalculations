/**
 * Structured design warnings. The solver reports plain strings; this classifies those (so the AI and the
 * comparison table can count by kind) and adds the checks the solver does not make (min flow, orifice noise).
 */
import type { Computed, HydraulicProject } from '../model';
import type { DesignCriteria } from './criteria';
import { pumpDuty } from './duty';

export type WarningKind = 'cavitation' | 'off-curve' | 'velocity' | 'min-flow' | 'orifice-noise' | 'pressure' | 'check-valve' | 'other';

export interface DesignWarning {
  kind: WarningKind;
  text: string;
}

export function classifySolverWarning(text: string): WarningKind {
  if (/cavitation|NPSHa|flash/i.test(text)) return 'cavitation';
  if (/beyond its head data/i.test(text)) return 'off-curve';
  if (/sub-atmospheric|below the vapour/i.test(text)) return 'pressure';
  if (/check valve is closed|reverse flow is blocked/i.test(text)) return 'check-valve';
  return 'other';
}

export function designWarnings(project: HydraulicProject, c: Computed, criteria: DesignCriteria): DesignWarning[] {
  const out: DesignWarning[] = [];
  const r = c.result;
  if (!r || !c.model) return out;
  for (const w of r.warnings) out.push({ kind: classifySolverWarning(w), text: w });
  for (const a of c.alerts) out.push({ kind: 'velocity', text: a });
  for (const e of c.model.edges) {
    if (e.kind !== 'pump') continue;
    const res = r.pumps.find((p) => p.id === e.id);
    if (!res || res.flowM3s <= 1e-9) continue;
    const d = pumpDuty(e.model, res);
    if (d.pctBep !== undefined && d.pctBep < criteria.pump.minFlowPctBep) out.push({ kind: 'min-flow', text: `Pump "${e.id}": operating at ${d.pctBep.toFixed(0)} % of BEP flow, below the ${criteria.pump.minFlowPctBep} % minimum-flow guideline (heating, recirculation, vibration risk).` });
  }
  for (const ui of project.edges) {
    if (ui.kind !== 'valve' || ui.lossType !== 'orifice') continue;
    const v = r.valves.find((x) => x.id === ui.name);
    if (!v || Math.abs(v.flowM3s) < 1e-9) continue;
    const bore = ui.lossValue / 1000;
    const boreV = Math.abs(v.flowM3s) / (Math.PI * bore * bore / 4);
    const beta = ui.lossValue / ui.diameterMm;
    if (boreV > criteria.orifice.maxBoreVelocityMps || v.pressureDropPa / 1000 > criteria.orifice.maxDropKPa) {
      out.push({ kind: 'orifice-noise', text: `Orifice "${ui.name}": bore velocity ${boreV.toFixed(1)} m/s and drop ${(v.pressureDropPa / 1000).toFixed(0)} kPa risk noise / cavitation (limits ${criteria.orifice.maxBoreVelocityMps} m/s, ${criteria.orifice.maxDropKPa} kPa). Consider two plates in series.` });
    }
    if (beta < criteria.orifice.minBeta || beta > criteria.orifice.maxBeta) out.push({ kind: 'orifice-noise', text: `Orifice "${ui.name}": beta ratio ${beta.toFixed(2)} is outside ${criteria.orifice.minBeta}–${criteria.orifice.maxBeta}; the discharge coefficient is less certain.` });
  }
  return out;
}
