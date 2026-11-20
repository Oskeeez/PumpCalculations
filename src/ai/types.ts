/**
 * Data model for the AI design layer: targets, assumptions, drafts and diffs.
 * Everything here is plain JSON so it is saved in the project file. Units follow model.ts
 * (L/s, mm, kPa gauge, m, m/s, kW).
 */
import type { HydraulicProject } from '../model';

// ------------------------------------------------------------------ targets
export type Target =
  /** Required flow delivered at a demand node [L/s]. */
  | { id: string; type: 'flow'; nodeUid: string; minLps: number; label?: string }
  /** Residual pressure window at a node [kPa gauge]. */
  | { id: string; type: 'pressure'; nodeUid: string; minKPaG?: number; maxKPaG?: number; label?: string }
  /** Velocity limit on one pipe/valve (uid) or on all of them ('all') [m/s]. */
  | { id: string; type: 'velocity'; scope: string; maxMps: number; minMps?: number; label?: string }
  /** Pump operating range: % of best-efficiency flow, minimum flow, runout (end of curve data). */
  | { id: string; type: 'pumpRange'; pumpUid: string; minPctBep?: number; maxPctBep?: number; minFlowLps?: number; withinCurveData?: boolean; label?: string }
  /** NPSH margin (NPSHa - NPSHr) for one pump (uid) or all ('all') [m]. */
  | { id: string; type: 'npsh'; pumpUid: string; marginM: number; label?: string };

export type TargetType = Target['type'];

export interface TargetStatus {
  targetId: string;
  label: string;
  type: TargetType;
  pass: boolean;
  /** Human-readable actual vs required, e.g. "152 kPa vs ≥ 200 kPa". */
  text: string;
  /** Amount by which the target is missed, in `unit` (0 when passing). */
  shortfall: number;
  unit: string;
  /** Shortfall relative to the requirement (for ranking drafts). 0 when passing. */
  relShortfall: number;
}

// -------------------------------------------------------------- assumptions
export interface Assumption {
  id: string;
  category: 'roughness' | 'fluid' | 'temperature' | 'elevation' | 'fitting' | 'demand' | 'pump' | 'other';
  text: string;
}

// ------------------------------------------------------------------- drafts
export interface ChangeNote {
  /** Diff item keys this change touched (e.g. "edge:u123"). */
  keys: string[];
  tool: string;
  /** One-line engineering reason. */
  reason: string;
  /** Side effects the AI wants the user to know about. */
  sideEffects?: string;
}

export type DraftSource = 'generate' | 'solve' | 'chat' | 'manual';

/** The part of a project that drafts hold: the hydraulic model plus its targets. */
export interface DraftState {
  project: HydraulicProject;
  targets: Target[];
}

export interface Draft {
  id: string;
  name: string;
  rationale: string;
  source: DraftSource;
  /** Drafts created by the same AI run are siblings. */
  runId: string;
  createdAt: string;
  /** 'main' for a draft of the main model, or the id of another draft. */
  parentId: string;
  /** Snapshot of the parent at creation. The diff, and the merge, are computed against this. */
  base: DraftState;
  /** The working copy the AI edits. */
  project: HydraulicProject;
  targets: Target[];
  assumptions: Assumption[];
  changes: ChangeNote[];
  /** 'open' drafts are editable by the AI; 'merged' and 'discarded' are read-only reference. */
  status: 'open' | 'merged' | 'discarded';
}

// --------------------------------------------------------------------- diff
export type DiffKind = 'added' | 'removed' | 'modified';

export interface DiffItem {
  /** "node:<uid>", "edge:<uid>", "target:<id>" or "settings". */
  key: string;
  kind: DiffKind;
  type: 'node' | 'edge' | 'target' | 'settings';
  label: string;
  /** Field-level changes for 'modified', e.g. "diameterMm: 100 → 150". */
  details: string[];
  /** Reasons recorded by the AI for this item. */
  reasons: string[];
}
