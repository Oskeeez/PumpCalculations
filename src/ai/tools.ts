/**
 * The AI tool layer. Every tool has a strict input schema, validates its input and returns either data or a readable error the
 * model can correct. Edit tools only ever change a draft (a copy); nothing here touches the main model. Hydraulics are computed
 * only by the existing solver (`compute`), never by the model.
 */
import { compute, hydraulicKey, insertOnPipe, newNode, newOrifice, newPipe, newPump, newValve, newUid, pipeLengthM, uniqueName, type Computed, type EdgeUI, type FluidUI, type HydraulicProject, type NodeUI, type PipeUI, type ProjectUI, type PumpUI, type ValveUI } from '../model';
import { FLUID_LIBRARY } from '../solver';
import { MATERIALS, SCH40 } from '../library';
import { genericPumpCurves, listCatalog, parseGenericPumpId } from './catalog';
import type { DesignCriteria } from './criteria';
import { createDraft, diffDraft, estimateCost, stateOf } from './drafts';
import { pumpDuty } from './duty';
import { validate, type Schema } from './schema';
import { evaluateTargets, feasibilityNotes, newTargetId } from './targets';
import type { Assumption, ChangeNote, Draft, DraftSource, Target } from './types';
import { designWarnings } from './warnings';

// ------------------------------------------------------------------ workspace
export interface RunLimits {
  /** Maximum tool calls over the whole run (all agents). */
  maxToolCalls: number;
  /** Maximum solve_draft calls. */
  maxSolves: number;
  /** Maximum model turns per agent. */
  maxTurns: number;
  /** Maximum drafts one run may create. */
  maxDrafts: number;
}

export const DEFAULT_LIMITS: RunLimits = { maxToolCalls: 80, maxSolves: 30, maxTurns: 14, maxDrafts: 6 };

export interface LogEntry {
  t: string;
  kind: 'tool' | 'solve' | 'llm' | 'info' | 'limit' | 'error';
  name?: string;
  ok?: boolean;
  input?: unknown;
  output?: unknown;
  note?: string;
}

export interface Workspace {
  /** Snapshot of the main model. Never modified by tools. */
  main: ProjectUI;
  drafts: Draft[];
  criteria: DesignCriteria;
  limits: RunLimits;
  usage: { toolCalls: number; solves: number; drafts: number };
  log: LogEntry[];
  runId: string;
  source: DraftSource;
  /** Nodes created without a position; they are placed next to their neighbours. */
  unplaced: Set<string>;
  onChange?: () => void;
}

export function newWorkspace(main: ProjectUI, drafts: Draft[], criteria: DesignCriteria, o: { source: DraftSource; runId: string; limits?: Partial<RunLimits> }): Workspace {
  return {
    main,
    drafts: JSON.parse(JSON.stringify(drafts)) as Draft[],
    criteria,
    limits: { ...DEFAULT_LIMITS, ...o.limits },
    usage: { toolCalls: 0, solves: 0, drafts: 0 },
    log: [],
    runId: o.runId,
    source: o.source,
    unplaced: new Set(),
  };
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Schema & { type: 'object' };
  /** true: changes a draft. */
  edits: boolean;
}

// -------------------------------------------------------------------- helpers
const r3 = (v: number | undefined, d = 3): number | undefined => (v === undefined || !Number.isFinite(v) ? undefined : +v.toFixed(d));
const ok = (data: unknown): ToolResult => ({ ok: true, data });
const err = (error: string): ToolResult => ({ ok: false, error });

const cache = new Map<string, Computed>();
export function solveProject(p: HydraulicProject): Computed {
  const key = hydraulicKey(p);
  let c = cache.get(key);
  if (!c) {
    c = compute(p);
    if (cache.size > 200) cache.clear();
    cache.set(key, c);
  }
  return c;
}

const findNode = (p: HydraulicProject, ref: string): NodeUI | undefined => p.nodes.find((n) => n.uid === ref) ?? p.nodes.find((n) => n.name === ref);
const findEdge = (p: HydraulicProject, ref: string): EdgeUI | undefined => p.edges.find((e) => e.uid === ref) ?? p.edges.find((e) => e.name === ref);
const nodeName = (p: HydraulicProject, uid: string) => p.nodes.find((n) => n.uid === uid)?.name ?? uid;

interface View {
  id: string;
  name: string;
  project: HydraulicProject;
  targets: Target[];
  draft?: Draft;
}

function view(ws: Workspace, id: string | undefined): View | string {
  if (!id || id === 'main') return { id: 'main', name: 'Main model', project: ws.main, targets: ws.main.targets ?? [] };
  const d = ws.drafts.find((x) => x.id === id);
  if (!d) return `Unknown draft "${id}". Known drafts: ${ws.drafts.map((x) => x.id).join(', ') || 'none (call create_draft first)'}.`;
  return { id: d.id, name: d.name, project: d.project, targets: d.targets, draft: d };
}

function placeUnplaced(ws: Workspace, d: Draft, final = false): void {
  const key = (uid: string) => `${d.id}|${uid}`;
  const pending = () => d.project.nodes.filter((n) => ws.unplaced.has(key(n.uid)));
  const taken = (x: number, y: number) => d.project.nodes.some((n) => !ws.unplaced.has(key(n.uid)) && Math.hypot(n.x - x, n.y - y) < 60);
  const put = (n: NodeUI, x: number, y: number) => {
    let yy = y;
    for (let i = 0; i < 40 && taken(x, yy); i++) yy = y + 70 * (i % 2 ? -Math.ceil(i / 2) : Math.ceil((i + 1) / 2));
    n.x = Math.round(x / 10) * 10;
    n.y = Math.max(40, Math.round(yy / 10) * 10);
    ws.unplaced.delete(key(n.uid));
  };
  for (let pass = 0; pass < 50 && pending().length; pass++) {
    let progress = false;
    for (const n of pending()) {
      const edge = d.project.edges.find((e) => (e.from === n.uid || e.to === n.uid) && !ws.unplaced.has(key(e.from === n.uid ? e.to : e.from)));
      if (!edge) continue;
      const nb = d.project.nodes.find((x) => x.uid === (edge.from === n.uid ? edge.to : edge.from))!;
      put(n, nb.x + (edge.from === n.uid ? -170 : 170), nb.y);
      progress = true;
    }
    if (!progress) break;
  }
  if (final) {
    let col = 0;
    for (const n of pending()) put(n, 100 + 170 * (col++ % 6), 100 + 90 * Math.floor(col / 6));
    const maxX = Math.max(0, ...d.project.nodes.map((n) => n.x));
    const maxY = Math.max(0, ...d.project.nodes.map((n) => n.y));
    d.project.canvasW = Math.max(d.project.canvasW, maxX + 120);
    d.project.canvasH = Math.max(d.project.canvasH, maxY + 120);
  }
}

/** Place every node the AI created without coordinates and grow the canvas to fit. Call when a run ends. */
export function finalizeLayout(ws: Workspace): void {
  for (const d of ws.drafts) placeUnplaced(ws, d, true);
}

// ------------------------------------------------------------------ solve view
function solveSummary(project: HydraulicProject, targets: Target[], ws: Workspace) {
  const c = solveProject(project);
  const status = evaluateTargets(project, targets, c);
  const warnings = designWarnings(project, c, ws.criteria);
  const base = {
    solved: !!c.result?.converged && !c.error,
    error: c.error ?? (c.result && !c.result.converged ? `Not converged: ${c.result.message}` : undefined),
    targets: { passing: status.filter((s) => s.pass).length, failing: status.filter((s) => !s.pass).length, items: status.map((s) => ({ id: s.targetId, label: s.label, pass: s.pass, actual_vs_required: s.text })) },
    feasibility_notes: feasibilityNotes(project, targets, c),
    warnings: warnings.map((w) => ({ kind: w.kind, text: w.text })),
  };
  const r = c.result;
  if (!r || !c.model) return base;
  const pumps = r.pumps.map((p) => {
    const e = c.model!.edges.find((x) => x.id === p.id);
    const d = e && e.kind === 'pump' ? pumpDuty(e.model, p) : undefined;
    return { name: p.id, flow_lps: r3(p.flowM3s * 1000, 2), head_m: r3(p.headM, 2), pct_bep: r3(d?.pctBep, 0), efficiency_pct: r3(p.efficiency !== undefined ? p.efficiency * 100 : undefined, 1), shaft_kw: r3(d?.shaftKw, 2), npsh_margin_m: r3(p.npshMarginM, 2), speed_ratio: p.speedRatio };
  });
  const junctions = r.nodes.filter((n) => n.kind === 'junction');
  const maxV = [...r.pipes.map((x) => ({ id: x.id, v: x.flow.velocity })), ...r.valves.map((x) => ({ id: x.id, v: x.velocity }))].sort((a, b) => b.v - a.v)[0];
  const burned = r.valves.filter((v) => v.status !== 'closed' && v.status !== 'check-closed').reduce((s, v) => s + Math.max(0, v.headDropM), 0);
  return {
    ...base,
    pumps,
    nodes: { count: r.nodes.length, min_junction_pressure_kpag: r3(junctions.length ? Math.min(...junctions.map((n) => n.gaugePressurePa / 1000)) : undefined, 1), max_junction_pressure_kpag: r3(junctions.length ? Math.max(...junctions.map((n) => n.gaugePressurePa / 1000)) : undefined, 1) },
    max_velocity: maxV ? { component: maxV.id, m_per_s: r3(maxV.v, 2) } : undefined,
    head_burned_across_valves_m: r3(burned, 2),
    rough_cost: Math.round(estimateCost(project, c, ws.criteria).total),
  };
}

// ------------------------------------------------------------------- tool defs
const S = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: 'string', description, minLength: 1, ...extra });
const N = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: 'number', description, ...extra });
const DRAFT = S('Draft id from create_draft.');
const REASON = S('One-line engineering reason for this change.');
const SIDE = S('Side effects the user should know about (optional).', { minLength: 0 });
const obj = (properties: Record<string, Schema>, required: string[] = []): ToolDef['input_schema'] => ({ type: 'object', properties, required, additionalProperties: false });
const editObj = (properties: Record<string, Schema>, required: string[] = []) => obj({ draft_id: DRAFT, ...properties, reason: REASON, side_effects: SIDE }, ['draft_id', ...required, 'reason']);

const PUMP_CURVE_PROPS: Record<string, Schema> = {
  catalog_id: S('Generic pump id from list_catalog("pumps", ...).'),
  bep_flow_lps: N('Best-efficiency flow [L/s] for a generic curve.', { minimum: 0.001 }),
  bep_head_m: N('Best-efficiency head [m] for a generic curve.', { minimum: 0.1 }),
};

const TARGET_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['flow', 'pressure', 'velocity', 'pumpRange', 'npsh'], description: 'flow: required flow at a demand node. pressure: residual pressure window at a node. velocity: limit on one pipe or "all". pumpRange: pump operating window. npsh: NPSH margin.' },
    node: S('Node name (flow, pressure).', { minLength: 0 }),
    pipe: S('Pipe/valve name or "all" (velocity).', { minLength: 0 }),
    pump: S('Pump name, or "all" (npsh).', { minLength: 0 }),
    min_lps: N('Required flow [L/s] (flow).', { minimum: 0 }),
    min_kpag: N('Minimum pressure [kPa gauge] (pressure).'),
    max_kpag: N('Maximum pressure [kPa gauge] (pressure).'),
    max_mps: N('Maximum velocity [m/s] (velocity).', { minimum: 0.01 }),
    min_mps: N('Minimum velocity [m/s] (velocity).', { minimum: 0 }),
    min_pct_bep: N('Minimum % of BEP flow (pumpRange).', { minimum: 1, maximum: 200 }),
    max_pct_bep: N('Maximum % of BEP flow (pumpRange).', { minimum: 1, maximum: 300 }),
    min_flow_lps: N('Minimum pump flow [L/s] (pumpRange).', { minimum: 0 }),
    within_curve: { type: 'boolean', description: 'Pump must stay inside its curve data, i.e. not beyond runout (pumpRange).' },
    margin_m: N('Required NPSH margin NPSHa − NPSHr [m] (npsh).', { minimum: 0 }),
    label: S('Optional label.', { minLength: 0 }),
  },
};

export const TOOL_DEFS: ToolDef[] = [
  // ---- read
  { name: 'get_network_summary', edits: false, description: 'Compact overview of main or a draft: counts, fluid, every node and component (name, type, key numbers), solver status and target status. Call this first, then drill down.', input_schema: obj({ draft_id: S('"main" (default) or a draft id.', { minLength: 0 }) }) },
  { name: 'get_component', edits: false, description: 'Full properties (and solved results) of one node, pipe, valve, orifice or pump, by name or uid.', input_schema: obj({ id: S('Component name or uid.'), draft_id: S('"main" (default) or a draft id.', { minLength: 0 }) }, ['id']) },
  { name: 'get_branch', edits: false, description: 'The components within `depth` hops of a node (nodes and the pipes/valves/pumps between them).', input_schema: obj({ node_id: S('Node name or uid.'), depth: { type: 'integer', minimum: 1, maximum: 6 }, draft_id: S('"main" (default) or a draft id.', { minLength: 0 }) }, ['node_id', 'depth']) },
  { name: 'get_solver_results', edits: false, description: 'Solver results. scope: "all", "nodes", "pipes", "pumps", "valves" or a component name. Units: L/s, m, kPa gauge, m/s, kW.', input_schema: obj({ scope: S('Scope (default "pumps").', { minLength: 0 }), draft_id: S('"main" (default) or a draft id.', { minLength: 0 }) }) },
  { name: 'get_targets_status', edits: false, description: 'Pass/fail and exact shortfall of every target for main or a draft, from the solver. Also physical feasibility notes.', input_schema: obj({ draft_id: S('"main" (default) or a draft id.', { minLength: 0 }) }) },
  { name: 'list_catalog', edits: false, description: 'Catalogues: pipe_sizes (Sch 40), materials (roughness), fittings (typical K), fluids, pumps (generic curves sized for a duty point: give filters.duty_flow_lps and filters.duty_head_m).', input_schema: obj({ type: { type: 'string', enum: ['pipe_sizes', 'materials', 'fittings', 'fluids', 'pumps'] }, filters: obj({ duty_flow_lps: N('Duty flow [L/s].', { minimum: 0.001 }), duty_head_m: N('Duty head [m].', { minimum: 0.1 }), min_id_mm: N('Min inside diameter [mm].'), max_id_mm: N('Max inside diameter [mm].') }) }, ['type']) },
  // ---- edit
  { name: 'create_draft', edits: true, description: 'Create a draft (a working copy) to edit. All edits must go into a draft; main is never changed. start: "copy_main" (default), "empty" (blank network keeping the fluid settings) or "copy_draft" (with from_draft_id).', input_schema: obj({ name: S('Short name.'), rationale: S('One or two sentences: the concept and why.'), start: { type: 'string', enum: ['copy_main', 'empty', 'copy_draft'] }, from_draft_id: S('For copy_draft.', { minLength: 0 }) }, ['name', 'rationale']) },
  { name: 'add_component', edits: true, description: 'Add a tank or junction node. Units: elevation/level m, pressure kPa absolute, demand L/s (positive = withdrawal). Leave x/y out to auto-place next to connected nodes.', input_schema: editObj({ kind: { type: 'string', enum: ['tank', 'junction'] }, name: S('Optional unique name.', { minLength: 0 }), elevation_m: N('Tank bottom / junction elevation [m].'), level_m: N('Tank liquid depth [m].', { minimum: 0 }), surface_pressure_kpa: N('Absolute pressure above the liquid [kPa].', { minimum: 0 }), demand_lps: N('Junction withdrawal [L/s].'), x: N('Canvas x [px].'), y: N('Canvas y [px].') }, ['kind', 'elevation_m']) },
  { name: 'remove_component', edits: true, description: 'Remove a node (and every pipe/valve/pump on it) or a single pipe/valve/pump.', input_schema: editObj({ id: S('Component name or uid.') }, ['id']) },
  { name: 'connect', edits: true, description: 'Connect two existing nodes with a pipe, valve, orifice or pump. Pipes need diameter_mm and length_m. Orifice needs bore_mm. Pumps need catalog_id or bep_flow_lps+bep_head_m.', input_schema: editObj({ kind: { type: 'string', enum: ['pipe', 'valve', 'orifice', 'pump'] }, from: S('Start node name or uid.'), to: S('End node name or uid.'), name: S('Optional unique name.', { minLength: 0 }), diameter_mm: N('Inside diameter [mm].', { minimum: 1 }), length_m: N('Pipe length [m].', { minimum: 0 }), material: S('Material name from list_catalog("materials").', { minLength: 0 }), roughness_mm: N('Roughness [mm].', { minimum: 0 }), fittings: { type: 'array', maxItems: 30, items: obj({ name: S('Fitting name.'), k: N('Loss coefficient K.', { minimum: 0 }) }, ['name', 'k']) }, loss_type: { type: 'string', enum: ['K', 'Cv', 'Kv'] }, loss_value: N('K, Cv or Kv of the valve.', { minimum: 0 }), bore_mm: N('Orifice bore [mm].', { minimum: 0.5 }), ...PUMP_CURVE_PROPS }, ['kind', 'from', 'to']) },
  { name: 'disconnect', edits: true, description: 'Remove one pipe, valve, orifice or pump (keeps both nodes).', input_schema: editObj({ edge: S('Component name or uid.') }, ['edge']) },
  { name: 'set_property', edits: true, description: 'Set one property. id "project": temperatureC, npshMarginM, maxVelocityMps, fluid. Node: name, elevationM, levelM, pressureKPa, demandLps, x, y. Pipe: name, lengthM, lengthMode, diameterMm, roughnessMm. Valve/orifice: name, diameterMm, lossType, lossValue, orificeCd, checkValve, open, controlType, controlValue. Pump: name, speedRatio, ratedRpm.', input_schema: editObj({ id: S('Component name or uid, or "project".'), property: S('Property name.'), value: { type: ['number', 'string', 'boolean'], description: 'New value.' } }, ['id', 'property', 'value']) },
  { name: 'swap_pump_curve', edits: true, description: 'Replace a pump\'s curves with a generic curve (catalog_id, or bep_flow_lps + bep_head_m). Resets impeller trim to 1.', input_schema: editObj({ pump: S('Pump name or uid.'), ...PUMP_CURVE_PROPS, peak_efficiency_pct: N('Peak efficiency [%].', { minimum: 20, maximum: 92 }) }, ['pump']) },
  { name: 'resize_pipe', edits: true, description: 'Change a pipe\'s inside diameter (diameter_mm or nominal Sch 40 size such as 4") and optionally roughness (roughness_mm or material).', input_schema: editObj({ pipe: S('Pipe name or uid.'), diameter_mm: N('Inside diameter [mm].', { minimum: 1 }), nominal: S('Sch 40 nominal size, e.g. 4".', { minLength: 0 }), roughness_mm: N('Roughness [mm].', { minimum: 0 }), material: S('Material from list_catalog.', { minLength: 0 }) }, ['pipe']) },
  { name: 'insert_inline_element', edits: true, description: 'Insert an orifice, control valve or check valve into a pipe (splits the pipe). Orifice: bore_mm or beta (bore/pipe diameter). Control valve: cv or k, optionally control prv/psv/fcv with setpoint (kPa gauge for prv/psv, L/s for fcv).', input_schema: editObj({ pipe: S('Pipe name or uid.'), element: { type: 'string', enum: ['orifice', 'control_valve', 'check_valve'] }, position: N('Where along the pipe, 0 to 1 (default 0.5).', { minimum: 0.1, maximum: 0.9 }), bore_mm: N('Orifice bore [mm].', { minimum: 0.5 }), beta: N('Orifice bore / pipe diameter.', { minimum: 0.1, maximum: 0.9 }), cv: N('Control valve Cv (US).', { minimum: 0.01 }), k: N('Control valve K.', { minimum: 0 }), control: { type: 'string', enum: ['none', 'prv', 'psv', 'fcv'] }, setpoint: N('Setpoint: kPa gauge (prv/psv) or L/s (fcv).') }, ['pipe', 'element']) },
  { name: 'add_recirc_line', edits: true, description: 'Add a minimum-flow recirculation line from a pump\'s discharge node back to its suction node (or return_node), with an orifice (bore_mm) or a flow-control valve (flow_lps).', input_schema: editObj({ pump: S('Pump name or uid.'), return_node: S('Return node (default: pump suction node).', { minLength: 0 }), kind: { type: 'string', enum: ['orifice', 'fcv'] }, bore_mm: N('Orifice bore [mm].', { minimum: 0.5 }), flow_lps: N('FCV set flow [L/s].', { minimum: 0.001 }), diameter_mm: N('Line diameter [mm].', { minimum: 1 }), length_m: N('Line length [m].', { minimum: 0 }) }, ['pump', 'kind']) },
  { name: 'set_pump_speed', edits: true, description: 'Set pump speed as a ratio of rated speed (affinity laws).', input_schema: editObj({ pump: S('Pump name or uid.'), speed_ratio: N('N / N_rated.', { minimum: 0.2, maximum: 1.5 }) }, ['pump', 'speed_ratio']) },
  { name: 'set_impeller_trim', edits: true, description: 'Trim the impeller: D/D_full between 0.6 and 1 (Q ∝ D, H ∝ D²).', input_schema: editObj({ pump: S('Pump name or uid.'), trim_ratio: N('D / D_full.', { minimum: 0.6, maximum: 1 }) }, ['pump', 'trim_ratio']) },
  { name: 'add_target', edits: true, description: 'Add a design target to a draft (targets are checked against the solver, not by you).', input_schema: editObj({ target: TARGET_SCHEMA }, ['target']) },
  { name: 'remove_target', edits: true, description: 'Remove a target from a draft.', input_schema: editObj({ target_id: S('Target id.') }, ['target_id']) },
  { name: 'add_assumption', edits: true, description: 'Record an assumption you made (roughness, fluid, temperature, elevations, fitting K values, demands...). The user reviews these.', input_schema: editObj({ category: { type: 'string', enum: ['roughness', 'fluid', 'temperature', 'elevation', 'fitting', 'demand', 'pump', 'other'] }, text: S('The assumption, with its value.') }, ['category', 'text']) },
  // ---- solve
  { name: 'solve_draft', edits: false, description: 'Run the hydraulic solver on a draft (or main). Returns pump duty, pressures, target pass/fail with shortfalls and warnings (cavitation, off-curve, velocity, min flow, orifice noise). Numbers from here are authoritative.', input_schema: obj({ draft_id: DRAFT }, ['draft_id']) },
];

export const READ_TOOLS = TOOL_DEFS.filter((t) => !t.edits).map((t) => t.name);

// ----------------------------------------------------------------------- exec
const trunc = (v: unknown, n = 1500): unknown => {
  const s = JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : v;
};

export function executeTool(ws: Workspace, name: string, input: unknown): ToolResult {
  const t0 = new Date().toISOString();
  const finish = (res: ToolResult, kind: LogEntry['kind'] = 'tool'): ToolResult => {
    ws.log.push({ t: t0, kind, name, ok: res.ok, input, output: res.ok ? trunc(res.data) : res.error });
    return res;
  };
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (!def) return finish(err(`Unknown tool "${name}". Available: ${TOOL_DEFS.map((d) => d.name).join(', ')}.`));
  if (ws.usage.toolCalls >= ws.limits.maxToolCalls) {
    ws.log.push({ t: t0, kind: 'limit', name, ok: false, note: `Tool-call limit (${ws.limits.maxToolCalls}) reached.` });
    return err(`Tool-call limit of ${ws.limits.maxToolCalls} reached for this run. Stop and summarise what you have.`);
  }
  ws.usage.toolCalls++;
  const bad = validate(def.input_schema, input ?? {});
  if (bad) return finish(err(bad));
  try {
    const res = run(ws, name, (input ?? {}) as Record<string, unknown>);
    if (def.edits && res.ok) ws.onChange?.();
    return finish(res, name === 'solve_draft' ? 'solve' : 'tool');
  } catch (e) {
    return finish(err(e instanceof Error ? e.message : String(e)), 'error');
  }
}

const str = (o: Record<string, unknown>, k: string): string | undefined => (typeof o[k] === 'string' && (o[k] as string).trim() !== '' ? (o[k] as string).trim() : undefined);
const num = (o: Record<string, unknown>, k: string): number | undefined => (typeof o[k] === 'number' ? (o[k] as number) : undefined);

function run(ws: Workspace, name: string, a: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'get_network_summary': return summary(ws, a);
    case 'get_component': return component(ws, a);
    case 'get_branch': return branch(ws, a);
    case 'get_solver_results': return results(ws, a);
    case 'get_targets_status': {
      const v = view(ws, str(a, 'draft_id'));
      if (typeof v === 'string') return err(v);
      const c = solveProject(v.project);
      return ok({ draft: v.id, statuses: evaluateTargets(v.project, v.targets, c).map((s) => ({ id: s.targetId, label: s.label, pass: s.pass, actual_vs_required: s.text, shortfall: r3(s.shortfall, 2), unit: s.unit })), feasibility_notes: feasibilityNotes(v.project, v.targets, c) });
    }
    case 'list_catalog': {
      const f = (a.filters ?? {}) as Record<string, number | undefined>;
      return ok(listCatalog(a.type as string, f));
    }
    case 'create_draft': return createDraftTool(ws, a);
    case 'solve_draft': {
      const v = view(ws, str(a, 'draft_id'));
      if (typeof v === 'string') return err(v);
      if (ws.usage.solves >= ws.limits.maxSolves) {
        ws.log.push({ t: new Date().toISOString(), kind: 'limit', note: `Solve limit (${ws.limits.maxSolves}) reached.` });
        return err(`Solve limit of ${ws.limits.maxSolves} reached for this run. Stop and summarise.`);
      }
      ws.usage.solves++;
      return ok({ draft: v.id, ...solveSummary(v.project, v.targets, ws) });
    }
    default: return editTool(ws, name, a);
  }
}

// ----------------------------------------------------------------------- reads
function nodeLine(n: NodeUI) {
  return n.kind === 'tank' ? { name: n.name, type: 'tank', z_m: n.elevationM, level_m: n.levelM, p_abs_kpa: n.pressureKPa } : { name: n.name, type: 'junction', z_m: n.elevationM, demand_lps: n.demandLps };
}
function edgeLine(p: HydraulicProject, e: EdgeUI) {
  const base = { name: e.name, from: nodeName(p, e.from), to: nodeName(p, e.to) };
  if (e.kind === 'pipe') return { ...base, type: 'pipe', d_mm: e.diameterMm, length_m: r3(pipeLengthM(p, e), 1), rough_mm: e.roughnessMm, fittings_k: r3(e.fittings.reduce((s, f) => s + f.k, 0), 2) };
  if (e.kind === 'valve') return { ...base, type: e.lossType === 'orifice' ? 'orifice' : 'valve', d_mm: e.diameterMm, loss: e.lossType === 'orifice' ? `bore ${e.lossValue} mm, Cd ${e.orificeCd ?? 0.61}` : `${e.lossType} ${e.lossValue}`, check: e.checkValve, open: e.open, control: e.controlType === 'none' ? undefined : `${e.controlType} ${e.controlValue}` };
  return { ...base, type: 'pump', speed_ratio: e.speedRatio, trim: e.impellerTrim ?? 1, shutoff_head_m: e.head[0]?.h, max_flow_lps: Math.max(...e.head.map((x) => x.q)) };
}

function summary(ws: Workspace, a: Record<string, unknown>): ToolResult {
  const v = view(ws, str(a, 'draft_id'));
  if (typeof v === 'string') return err(v);
  const p = v.project;
  const c = solveProject(p);
  const status = evaluateTargets(p, v.targets, c);
  const CAP = 80;
  return ok({
    id: v.id,
    name: v.name,
    fluid: p.fluid.id,
    temperature_c: p.temperatureC,
    counts: { nodes: p.nodes.length, edges: p.edges.length },
    nodes: p.nodes.slice(0, CAP).map(nodeLine),
    components: p.edges.slice(0, CAP).map((e) => edgeLine(p, e)),
    truncated: p.nodes.length > CAP || p.edges.length > CAP,
    solver: { solved: !!c.result?.converged && !c.error, error: c.error, warnings: c.result?.warnings.length ?? 0 },
    targets: { total: status.length, failing: status.filter((s) => !s.pass).map((s) => `${s.label}: ${s.text}`) },
    note: 'Drill down with get_component / get_branch / get_solver_results.',
  });
}

function resultsFor(p: HydraulicProject, c: Computed, ref: string) {
  const r = c.result;
  if (!r) return undefined;
  return r.nodes.find((n) => n.id === ref) ? (() => { const n = r.nodes.find((x) => x.id === ref)!; return { head_m: r3(n.headM, 2), gauge_kpa: r3(n.gaugePressurePa / 1000, 1), net_outflow_lps: r3(n.netOutflowM3s * 1000, 2), warnings: n.warnings }; })()
    : r.pipes.find((x) => x.id === ref) ? (() => { const x = r.pipes.find((q) => q.id === ref)!; return { flow_lps: r3(x.flowM3s * 1000, 2), velocity_mps: r3(x.flow.velocity, 2), head_drop_m: r3(x.headDropM, 2), reynolds: Math.round(x.flow.reynolds), warnings: x.warnings }; })()
    : r.valves.find((x) => x.id === ref) ? (() => { const x = r.valves.find((q) => q.id === ref)!; return { flow_lps: r3(x.flowM3s * 1000, 2), drop_kpa: r3(x.pressureDropPa / 1000, 1), velocity_mps: r3(x.velocity, 2), status: x.status, equivalent_k: r3(x.equivalentK, 2), warnings: x.warnings }; })()
    : r.pumps.find((x) => x.id === ref) ? (() => { const x = r.pumps.find((q) => q.id === ref)!; const e = c.model?.edges.find((q) => q.id === ref); const d = e && e.kind === 'pump' ? pumpDuty(e.model, x) : undefined; return { flow_lps: r3(x.flowM3s * 1000, 2), head_m: r3(x.headM, 2), pct_bep: r3(d?.pctBep, 0), bep_flow_lps: r3(d?.bepFlowLps, 2), efficiency_pct: r3(x.efficiency !== undefined ? x.efficiency * 100 : undefined, 1), shaft_kw: r3(d?.shaftKw, 2), npsha_m: r3(x.npshaM, 2), npshr_m: r3(x.npshrM, 2), npsh_margin_m: r3(x.npshMarginM, 2), warnings: x.warnings }; })()
    : (void p, undefined);
}

function component(ws: Workspace, a: Record<string, unknown>): ToolResult {
  const v = view(ws, str(a, 'draft_id'));
  if (typeof v === 'string') return err(v);
  const ref = str(a, 'id')!;
  const n = findNode(v.project, ref);
  const e = n ? undefined : findEdge(v.project, ref);
  if (!n && !e) return err(`No component "${ref}" in ${v.id}. Use get_network_summary to see names.`);
  const c = solveProject(v.project);
  const item = (n ?? e)!;
  return ok({ properties: item, results: resultsFor(v.project, c, item.name) ?? 'not solved' });
}

function branch(ws: Workspace, a: Record<string, unknown>): ToolResult {
  const v = view(ws, str(a, 'draft_id'));
  if (typeof v === 'string') return err(v);
  const start = findNode(v.project, str(a, 'node_id')!);
  if (!start) return err(`No node "${str(a, 'node_id')}".`);
  const depth = num(a, 'depth') ?? 2;
  const seen = new Set([start.uid]);
  let frontier = [start.uid];
  const edges = new Set<string>();
  for (let i = 0; i < depth; i++) {
    const next: string[] = [];
    for (const e of v.project.edges) {
      for (const [x, y] of [[e.from, e.to], [e.to, e.from]]) {
        if (frontier.includes(x)) { edges.add(e.uid); if (!seen.has(y)) { seen.add(y); next.push(y); } }
      }
    }
    frontier = next;
  }
  const c = solveProject(v.project);
  return ok({
    nodes: v.project.nodes.filter((n) => seen.has(n.uid)).map((n) => ({ ...nodeLine(n), results: resultsFor(v.project, c, n.name) })),
    components: v.project.edges.filter((e) => edges.has(e.uid)).map((e) => ({ ...edgeLine(v.project, e), results: resultsFor(v.project, c, e.name) })),
  });
}

function results(ws: Workspace, a: Record<string, unknown>): ToolResult {
  const v = view(ws, str(a, 'draft_id'));
  if (typeof v === 'string') return err(v);
  const c = solveProject(v.project);
  if (c.error || !c.result) return ok({ solved: false, error: c.error ?? 'No result.' });
  const scope = str(a, 'scope') ?? 'pumps';
  const r = c.result;
  const pick = (names: string[]) => Object.fromEntries(names.map((n) => [n, resultsFor(v.project, c, n)]));
  switch (scope) {
    case 'nodes': return ok(pick(r.nodes.map((n) => n.id)));
    case 'pipes': return ok(pick(r.pipes.map((n) => n.id)));
    case 'valves': return ok(pick(r.valves.map((n) => n.id)));
    case 'pumps': return ok(pick(r.pumps.map((n) => n.id)));
    case 'all': return ok({ converged: r.converged, warnings: r.warnings, ...pick([...r.nodes, ...r.pipes, ...r.valves, ...r.pumps].map((n) => n.id)) });
    default: {
      const x = resultsFor(v.project, c, scope);
      return x ? ok(x) : err(`No result for "${scope}". Scope is all, nodes, pipes, pumps, valves or a component name.`);
    }
  }
}

// ----------------------------------------------------------------------- edits
function createDraftTool(ws: Workspace, a: Record<string, unknown>): ToolResult {
  if (ws.usage.drafts >= ws.limits.maxDrafts) return err(`Draft limit of ${ws.limits.maxDrafts} reached for this run.`);
  const startKind = str(a, 'start') ?? 'copy_main';
  let parent: Draft | undefined;
  if (startKind === 'copy_draft') {
    parent = ws.drafts.find((d) => d.id === str(a, 'from_draft_id'));
    if (!parent) return err('copy_draft needs a valid from_draft_id.');
  }
  const d = createDraft(ws.main, { name: str(a, 'name')!, rationale: str(a, 'rationale')!, source: ws.source, runId: ws.runId, start: startKind === 'empty' ? 'empty' : 'copy', parent });
  ws.drafts.push(d);
  ws.usage.drafts++;
  return ok({ draft_id: d.id, name: d.name, started_from: startKind, nodes: d.project.nodes.length, components: d.project.edges.length, next: 'Edit this draft with the edit tools (pass draft_id), then call solve_draft.' });
}

function resolveRoughness(a: Record<string, unknown>): number | string | undefined {
  const mat = str(a, 'material');
  if (mat) {
    const m = MATERIALS.find((x) => x.name.toLowerCase() === mat.toLowerCase());
    return m ? m.roughnessMm : `Unknown material "${mat}". Use a name from list_catalog("materials").`;
  }
  return num(a, 'roughness_mm');
}

function pumpCurvesFrom(a: Record<string, unknown>): ReturnType<typeof genericPumpCurves> | string {
  const id = str(a, 'catalog_id');
  const eta = num(a, 'peak_efficiency_pct');
  if (id) {
    const g = parseGenericPumpId(id);
    return g ? genericPumpCurves(g.q, g.h, eta) : `Unknown catalog_id "${id}". Get ids from list_catalog("pumps", {duty_flow_lps, duty_head_m}).`;
  }
  const q = num(a, 'bep_flow_lps');
  const h = num(a, 'bep_head_m');
  if (q === undefined || h === undefined) return 'Give catalog_id, or both bep_flow_lps and bep_head_m.';
  return genericPumpCurves(q, h, eta);
}

function editTool(ws: Workspace, name: string, a: Record<string, unknown>): ToolResult {
  const id = str(a, 'draft_id')!;
  if (id === 'main') return err('The main model cannot be edited by the AI. Call create_draft and edit the draft.');
  const d = ws.drafts.find((x) => x.id === id);
  if (!d) return err(`Unknown draft "${id}". Known drafts: ${ws.drafts.map((x) => x.id).join(', ') || 'none; call create_draft first'}.`);
  if (d.status !== 'open') return err(`Draft "${d.name}" is ${d.status} and read-only.`);
  const p = d.project;
  const keys: string[] = [];
  const names = () => [...p.nodes.map((n) => n.name), ...p.edges.map((e) => e.name)];
  const needNode = (ref: string): NodeUI => {
    const n = findNode(p, ref);
    if (!n) throw new Error(`No node "${ref}" in this draft. Nodes: ${p.nodes.map((x) => x.name).join(', ') || 'none'}.`);
    return n;
  };
  const needEdge = <K extends EdgeUI['kind']>(ref: string, kind?: K): Extract<EdgeUI, { kind: K }> => {
    const e = findEdge(p, ref);
    if (!e) throw new Error(`No pipe/valve/pump "${ref}" in this draft. Components: ${p.edges.map((x) => x.name).join(', ') || 'none'}.`);
    if (kind && e.kind !== kind) throw new Error(`"${ref}" is a ${e.kind}, not a ${kind}.`);
    return e as Extract<EdgeUI, { kind: K }>;
  };
  const uniq = (want: string | undefined, base: string): string => {
    if (want && names().includes(want)) throw new Error(`The name "${want}" is already used in this draft.`);
    return want ?? uniqueName(base, names());
  };
  const pumpSet = (pump: PumpUI, c: ReturnType<typeof genericPumpCurves>) => { pump.head = c.head; pump.efficiency = c.efficiency; pump.npshr = c.npshr; pump.impellerTrim = 1; };
  let data: Record<string, unknown> = {};

  switch (name) {
    case 'add_component': {
      const kind = a.kind as 'tank' | 'junction';
      const n = newNode(kind, 0, 0, names());
      n.name = uniq(str(a, 'name'), kind === 'tank' ? 'Tank' : 'Junction');
      n.elevationM = num(a, 'elevation_m')!;
      if (kind === 'tank') {
        n.levelM = num(a, 'level_m') ?? 3;
        n.pressureKPa = num(a, 'surface_pressure_kpa') ?? n.pressureKPa;
      } else n.demandLps = num(a, 'demand_lps') ?? 0;
      const x = num(a, 'x');
      const y = num(a, 'y');
      if (x !== undefined && y !== undefined) { n.x = x; n.y = y; } else ws.unplaced.add(`${d.id}|${n.uid}`);
      p.nodes.push(n);
      keys.push(`node:${n.uid}`);
      data = { name: n.name, uid: n.uid };
      break;
    }
    case 'remove_component': {
      const ref = str(a, 'id')!;
      const n = findNode(p, ref);
      if (n) {
        const gone = p.edges.filter((e) => e.from === n.uid || e.to === n.uid);
        p.nodes = p.nodes.filter((x) => x.uid !== n.uid);
        p.edges = p.edges.filter((e) => e.from !== n.uid && e.to !== n.uid);
        keys.push(`node:${n.uid}`, ...gone.map((e) => `edge:${e.uid}`));
        data = { removed: n.name, also_removed: gone.map((e) => e.name) };
      } else {
        const e = needEdge(ref);
        p.edges = p.edges.filter((x) => x.uid !== e.uid);
        keys.push(`edge:${e.uid}`);
        data = { removed: e.name };
      }
      break;
    }
    case 'disconnect': {
      const e = needEdge(str(a, 'edge')!);
      p.edges = p.edges.filter((x) => x.uid !== e.uid);
      keys.push(`edge:${e.uid}`);
      data = { removed: e.name };
      break;
    }
    case 'connect': {
      const from = needNode(str(a, 'from')!);
      const to = needNode(str(a, 'to')!);
      if (from.uid === to.uid) throw new Error('A component cannot connect a node to itself.');
      const kind = a.kind as string;
      let e: EdgeUI;
      if (kind === 'pipe') {
        const dia = num(a, 'diameter_mm');
        const len = num(a, 'length_m');
        if (dia === undefined || len === undefined) throw new Error('A pipe needs diameter_mm and length_m.');
        const rough = resolveRoughness(a);
        if (typeof rough === 'string') throw new Error(rough);
        const pipe: PipeUI = newPipe(from.uid, to.uid, names());
        pipe.name = uniq(str(a, 'name'), 'Pipe');
        Object.assign(pipe, { diameterMm: dia, lengthM: len, lengthMode: 'manual', roughnessMm: rough ?? ws.criteria.roughnessMm['commercial steel'] ?? 0.046, fittings: ((a.fittings as { name: string; k: number }[] | undefined) ?? []).map((f) => ({ name: f.name, k: f.k })) });
        e = pipe;
      } else if (kind === 'valve') {
        const v: ValveUI = newValve(from.uid, to.uid, names());
        v.name = uniq(str(a, 'name'), 'Valve');
        v.diameterMm = num(a, 'diameter_mm') ?? 100;
        if (a.loss_type) v.lossType = a.loss_type as ValveUI['lossType'];
        v.lossValue = num(a, 'loss_value') ?? v.lossValue;
        e = v;
      } else if (kind === 'orifice') {
        const dia = num(a, 'diameter_mm') ?? 100;
        const bore = num(a, 'bore_mm');
        if (bore === undefined) throw new Error('An orifice needs bore_mm.');
        if (bore >= dia) throw new Error(`Orifice bore (${bore} mm) must be smaller than the pipe diameter (${dia} mm). Give diameter_mm of the line.`);
        const o = newOrifice(from.uid, to.uid, names(), dia);
        o.name = uniq(str(a, 'name'), 'Orifice');
        o.lossValue = bore;
        e = o;
      } else {
        const curves = pumpCurvesFrom(a);
        if (typeof curves === 'string') throw new Error(`A pump needs a curve. ${curves}`);
        const pump = newPump(from.uid, to.uid, names());
        pump.name = uniq(str(a, 'name'), 'Pump');
        pumpSet(pump, curves);
        e = pump;
      }
      p.edges.push(e);
      keys.push(`edge:${e.uid}`);
      data = { name: e.name, uid: e.uid };
      break;
    }
    case 'set_property': {
      const ref = str(a, 'id')!;
      const prop = str(a, 'property')!;
      const val = a.value as number | string | boolean;
      keys.push(...setProperty(ws, d, ref, prop, val, findNode, findEdge));
      data = { set: `${ref}.${prop}`, value: val };
      break;
    }
    case 'swap_pump_curve': {
      const pump = needEdge(str(a, 'pump')!, 'pump');
      const c = pumpCurvesFrom(a);
      if (typeof c === 'string') throw new Error(c);
      pumpSet(pump, c);
      keys.push(`edge:${pump.uid}`);
      data = { pump: pump.name, shutoff_head_m: pump.head[0].h, runout_flow_lps: pump.head[pump.head.length - 1].q };
      break;
    }
    case 'resize_pipe': {
      const pipe = needEdge(str(a, 'pipe')!, 'pipe');
      let dia = num(a, 'diameter_mm');
      const nominal = str(a, 'nominal');
      if (nominal) {
        const s = SCH40.find((x) => x.nps === nominal);
        if (!s) throw new Error(`Unknown nominal size "${nominal}". Use list_catalog("pipe_sizes").`);
        dia = s.idMm;
      }
      const rough = resolveRoughness(a);
      if (typeof rough === 'string') throw new Error(rough);
      if (dia === undefined && rough === undefined) throw new Error('Give diameter_mm, nominal, roughness_mm or material.');
      if (dia !== undefined) pipe.diameterMm = dia;
      if (rough !== undefined) pipe.roughnessMm = rough;
      keys.push(`edge:${pipe.uid}`);
      data = { pipe: pipe.name, diameter_mm: pipe.diameterMm, roughness_mm: pipe.roughnessMm };
      break;
    }
    case 'insert_inline_element': {
      const pipe = needEdge(str(a, 'pipe')!, 'pipe');
      const el = a.element as 'orifice' | 'control_valve' | 'check_valve';
      const pos = num(a, 'position') ?? 0.5;
      const f = p.nodes.find((n) => n.uid === pipe.from)!;
      const t = p.nodes.find((n) => n.uid === pipe.to)!;
      const before = new Set([...p.nodes.map((n) => n.uid), ...p.edges.map((e) => e.uid)]);
      let bore: number | undefined;
      if (el === 'orifice') {
        bore = num(a, 'bore_mm') ?? (num(a, 'beta') !== undefined ? num(a, 'beta')! * pipe.diameterMm : undefined);
        if (bore === undefined) throw new Error('An orifice needs bore_mm or beta.');
        if (!(bore > 0 && bore < pipe.diameterMm)) throw new Error(`Orifice bore (${bore} mm) must be smaller than the pipe diameter (${pipe.diameterMm} mm).`);
      }
      const proj: ProjectUI = { ...p, images: [] };
      const res = insertOnPipe(proj, pipe.uid, el === 'orifice' ? 'orifice' : 'valve', f.x + (t.x - f.x) * pos, f.y + (t.y - f.y) * pos);
      p.nodes = res.project.nodes;
      p.edges = res.project.edges;
      const v = p.edges.find((e) => e.uid === res.selectUid) as ValveUI;
      if (el !== 'orifice') v.name = uniqueName(el === 'check_valve' ? 'Check valve' : 'Control valve', names().filter((n) => n !== v.name));
      if (el === 'orifice') v.lossValue = bore!;
      else if (el === 'check_valve') { v.checkValve = true; v.lossType = 'K'; v.lossValue = ws.criteria.fittingK['swing check'] ?? 2; }
      else {
        const cv = num(a, 'cv');
        if (cv !== undefined) { v.lossType = 'Cv'; v.lossValue = cv; } else { v.lossType = 'K'; v.lossValue = num(a, 'k') ?? 3; }
        const ctl = (str(a, 'control') ?? 'none') as ValveUI['controlType'];
        v.controlType = ctl;
        if (ctl !== 'none') {
          const sp = num(a, 'setpoint');
          if (sp === undefined || !(ctl === 'fcv' ? sp > 0 : sp >= 0)) throw new Error(`control "${ctl}" needs a valid setpoint (${ctl === 'fcv' ? 'L/s > 0' : 'kPa gauge ≥ 0'}).`);
          v.controlValue = sp;
        }
      }
      for (const n of p.nodes) if (!before.has(n.uid)) keys.push(`node:${n.uid}`);
      for (const e of p.edges) if (!before.has(e.uid) || e.uid === pipe.uid) keys.push(`edge:${e.uid}`);
      data = { element: v.name, pipe_split_into: p.edges.filter((e) => e.kind === 'pipe' && (e.from === v.to || e.to === v.from)).map((e) => e.name).concat(pipe.name) };
      break;
    }
    case 'add_recirc_line': {
      const pump = needEdge(str(a, 'pump')!, 'pump');
      const disch = needNode(pump.to);
      const ret = str(a, 'return_node') ? needNode(str(a, 'return_node')!) : needNode(pump.from);
      if (ret.uid === disch.uid) throw new Error('The return node must differ from the pump discharge node.');
      const dia = num(a, 'diameter_mm') ?? 50;
      const len = num(a, 'length_m') ?? 5;
      const mid = newNode('junction', 0, 0, names());
      mid.name = uniq(undefined, 'Recirc');
      mid.elevationM = ret.elevationM;
      ws.unplaced.add(`${d.id}|${mid.uid}`);
      mid.x = disch.x; mid.y = disch.y + 120;
      let el: ValveUI;
      if (a.kind === 'orifice') {
        const bore = num(a, 'bore_mm');
        if (bore === undefined || !(bore < dia)) throw new Error(`An orifice recirc line needs bore_mm smaller than diameter_mm (${dia}).`);
        el = newOrifice(disch.uid, mid.uid, names(), dia);
        el.lossValue = bore;
        el.name = uniq(undefined, 'Recirc orifice');
      } else {
        const q = num(a, 'flow_lps');
        if (q === undefined) throw new Error('An fcv recirc line needs flow_lps.');
        el = newValve(disch.uid, mid.uid, names());
        el.diameterMm = dia;
        el.controlType = 'fcv';
        el.controlValue = q;
        el.name = uniq(undefined, 'Recirc FCV');
      }
      const pipe = newPipe(mid.uid, ret.uid, [...names(), el.name]);
      Object.assign(pipe, { diameterMm: dia, lengthM: len, lengthMode: 'manual', roughnessMm: ws.criteria.roughnessMm['commercial steel'] ?? 0.046 });
      p.nodes.push(mid);
      p.edges.push(el, pipe);
      keys.push(`node:${mid.uid}`, `edge:${el.uid}`, `edge:${pipe.uid}`);
      data = { orifice_or_fcv: el.name, return_pipe: pipe.name, returns_to: ret.name };
      break;
    }
    case 'set_pump_speed': {
      const pump = needEdge(str(a, 'pump')!, 'pump');
      pump.speedRatio = num(a, 'speed_ratio')!;
      keys.push(`edge:${pump.uid}`);
      data = { pump: pump.name, speed_ratio: pump.speedRatio, rpm: Math.round(pump.speedRatio * pump.ratedRpm) };
      break;
    }
    case 'set_impeller_trim': {
      const pump = needEdge(str(a, 'pump')!, 'pump');
      pump.impellerTrim = num(a, 'trim_ratio')!;
      keys.push(`edge:${pump.uid}`);
      data = { pump: pump.name, trim_ratio: pump.impellerTrim };
      break;
    }
    case 'add_target': {
      const t = buildTarget(p, a.target as Record<string, unknown>);
      d.targets.push(t);
      keys.push(`target:${t.id}`);
      data = { target_id: t.id };
      break;
    }
    case 'remove_target': {
      const tid = str(a, 'target_id')!;
      if (!d.targets.some((t) => t.id === tid)) throw new Error(`No target "${tid}". Targets: ${d.targets.map((t) => t.id).join(', ') || 'none'}.`);
      d.targets = d.targets.filter((t) => t.id !== tid);
      keys.push(`target:${tid}`);
      break;
    }
    case 'add_assumption': {
      const as: Assumption = { id: `a${newUid()}`, category: a.category as Assumption['category'], text: str(a, 'text')! };
      d.assumptions.push(as);
      data = { assumption_id: as.id };
      break;
    }
    default:
      throw new Error(`Tool "${name}" is not implemented.`);
  }
  const note: ChangeNote = { keys, tool: name, reason: str(a, 'reason')!, sideEffects: str(a, 'side_effects') };
  d.changes.push(note);
  placeUnplaced(ws, d);
  return ok({ ok: true, ...data, diff_items: diffDraft(d).length });
}

function buildTarget(p: HydraulicProject, t: Record<string, unknown>): Target {
  const id = newTargetId();
  const label = typeof t.label === 'string' && t.label.trim() ? t.label.trim() : undefined;
  const node = (): string => {
    const n = findNode(p, String(t.node ?? ''));
    if (!n) throw new Error(`Target needs an existing node; "${String(t.node ?? '')}" was not found.`);
    return n.uid;
  };
  const pump = (allowAll: boolean): string => {
    if (allowAll && t.pump === 'all') return 'all';
    const e = findEdge(p, String(t.pump ?? ''));
    if (!e || e.kind !== 'pump') throw new Error(`Target needs an existing pump; "${String(t.pump ?? '')}" was not found.`);
    return e.uid;
  };
  const n = (k: string): number | undefined => (typeof t[k] === 'number' ? (t[k] as number) : undefined);
  switch (t.type) {
    case 'flow':
      if (n('min_lps') === undefined) throw new Error('A flow target needs min_lps.');
      return { id, type: 'flow', nodeUid: node(), minLps: n('min_lps')!, label };
    case 'pressure':
      if (n('min_kpag') === undefined && n('max_kpag') === undefined) throw new Error('A pressure target needs min_kpag and/or max_kpag.');
      return { id, type: 'pressure', nodeUid: node(), minKPaG: n('min_kpag'), maxKPaG: n('max_kpag'), label };
    case 'velocity': {
      if (n('max_mps') === undefined) throw new Error('A velocity target needs max_mps.');
      const scope = String(t.pipe ?? 'all');
      const e = scope === 'all' ? undefined : findEdge(p, scope);
      if (scope !== 'all' && !e) throw new Error(`No pipe "${scope}" for the velocity target.`);
      return { id, type: 'velocity', scope: e ? e.uid : 'all', maxMps: n('max_mps')!, minMps: n('min_mps'), label };
    }
    case 'pumpRange':
      if (n('min_pct_bep') === undefined && n('max_pct_bep') === undefined && n('min_flow_lps') === undefined && t.within_curve !== true) throw new Error('A pumpRange target needs min_pct_bep, max_pct_bep, min_flow_lps or within_curve.');
      return { id, type: 'pumpRange', pumpUid: pump(false), minPctBep: n('min_pct_bep'), maxPctBep: n('max_pct_bep'), minFlowLps: n('min_flow_lps'), withinCurveData: t.within_curve === true ? true : undefined, label };
    case 'npsh':
      if (n('margin_m') === undefined) throw new Error('An npsh target needs margin_m.');
      return { id, type: 'npsh', pumpUid: pump(true), marginM: n('margin_m')!, label };
    default:
      throw new Error(`Unknown target type "${String(t.type)}".`);
  }
}

type FindN = typeof findNode;
type FindE = typeof findEdge;

function setProperty(ws: Workspace, d: Draft, ref: string, prop: string, val: number | string | boolean, fn: FindN, fe: FindE): string[] {
  void ws;
  const p = d.project;
  const need = (type: 'number' | 'string' | 'boolean', min?: number, max?: number, strictMin = false) => {
    if (typeof val !== type) throw new Error(`${prop} must be a ${type}.`);
    if (type === 'number') {
      const v = val as number;
      if (!Number.isFinite(v)) throw new Error(`${prop} must be a finite number.`);
      if (min !== undefined && (strictMin ? v <= min : v < min)) throw new Error(`${prop} must be ${strictMin ? '>' : '≥'} ${min}.`);
      if (max !== undefined && v > max) throw new Error(`${prop} must be ≤ ${max}.`);
    }
  };
  const taken = (name: string, self: string) => [...p.nodes.map((n) => [n.name, n.uid]), ...p.edges.map((e) => [e.name, e.uid])].some(([n, u]) => n === name && u !== self);
  if (ref === 'project') {
    switch (prop) {
      case 'temperatureC': need('number', -50, 400); p.temperatureC = val as number; break;
      case 'npshMarginM': need('number', 0); p.npshMarginM = val as number; break;
      case 'maxVelocityMps': need('number', 0); p.maxVelocityMps = val as number; break;
      case 'fluid': {
        need('string');
        if (!FLUID_LIBRARY.some((f) => f.id === val)) throw new Error(`Unknown fluid "${String(val)}". Options: ${FLUID_LIBRARY.map((f) => f.id).join(', ')}.`);
        p.fluid = { ...p.fluid, id: val as FluidUI['id'] };
        break;
      }
      default: throw new Error(`Unknown project property "${prop}". Use temperatureC, npshMarginM, maxVelocityMps or fluid.`);
    }
    return ['settings'];
  }
  const n = fn(p, ref);
  if (n) {
    switch (prop) {
      case 'name': need('string'); if (!(val as string).trim() || taken(val as string, n.uid)) throw new Error(`The name "${String(val)}" is empty or already used.`); n.name = (val as string).trim(); break;
      case 'elevationM': need('number'); n.elevationM = val as number; break;
      case 'levelM': need('number', 0); if (n.kind !== 'tank') throw new Error('levelM applies to tanks only.'); n.levelM = val as number; break;
      case 'pressureKPa': need('number', 0); if (n.kind !== 'tank') throw new Error('pressureKPa applies to tanks only.'); n.pressureKPa = val as number; break;
      case 'demandLps': need('number'); if (n.kind !== 'junction') throw new Error('demandLps applies to junctions only.'); n.demandLps = val as number; break;
      case 'x': need('number', 0); n.x = val as number; break;
      case 'y': need('number', 0); n.y = val as number; break;
      default: throw new Error(`Unknown node property "${prop}". Use name, elevationM, levelM, pressureKPa, demandLps, x or y.`);
    }
    return [`node:${n.uid}`];
  }
  const e = fe(p, ref);
  if (!e) throw new Error(`No component "${ref}". Use a node, pipe, valve, orifice or pump name, or "project".`);
  if (prop === 'name') { need('string'); if (!(val as string).trim() || taken(val as string, e.uid)) throw new Error(`The name "${String(val)}" is empty or already used.`); e.name = (val as string).trim(); return [`edge:${e.uid}`]; }
  if (e.kind === 'pipe') {
    switch (prop) {
      case 'lengthM': need('number', 0); e.lengthM = val as number; e.lengthMode = 'manual'; break;
      case 'lengthMode': if (val !== 'manual' && val !== 'canvas') throw new Error('lengthMode must be "manual" or "canvas".'); e.lengthMode = val; break;
      case 'diameterMm': need('number', 0, undefined, true); e.diameterMm = val as number; break;
      case 'roughnessMm': need('number', 0); e.roughnessMm = val as number; break;
      default: throw new Error(`Unknown pipe property "${prop}". Use name, lengthM, lengthMode, diameterMm or roughnessMm.`);
    }
  } else if (e.kind === 'valve') {
    switch (prop) {
      case 'diameterMm': need('number', 0, undefined, true); e.diameterMm = val as number; break;
      case 'lossType': if (!['K', 'Cv', 'Kv', 'orifice'].includes(String(val))) throw new Error('lossType must be K, Cv, Kv or orifice.'); e.lossType = val as ValveUI['lossType']; break;
      case 'lossValue': need('number', 0, undefined, e.lossType !== 'K'); if (e.lossType === 'orifice' && (val as number) >= e.diameterMm) throw new Error(`Orifice bore must be smaller than the diameter (${e.diameterMm} mm).`); e.lossValue = val as number; break;
      case 'orificeCd': need('number', 0.2, 1); e.orificeCd = val as number; break;
      case 'checkValve': need('boolean'); e.checkValve = val as boolean; break;
      case 'open': need('boolean'); e.open = val as boolean; break;
      case 'controlType': if (!['none', 'prv', 'psv', 'fcv'].includes(String(val))) throw new Error('controlType must be none, prv, psv or fcv.'); e.controlType = val as ValveUI['controlType']; break;
      case 'controlValue': need('number', 0); e.controlValue = val as number; break;
      default: throw new Error(`Unknown valve property "${prop}". Use name, diameterMm, lossType, lossValue, orificeCd, checkValve, open, controlType or controlValue.`);
    }
  } else {
    switch (prop) {
      case 'speedRatio': need('number', 0.2, 1.5); e.speedRatio = val as number; break;
      case 'ratedRpm': need('number', 100, 10000); e.ratedRpm = val as number; break;
      default: throw new Error(`Unknown pump property "${prop}". Use name, speedRatio or ratedRpm (use set_impeller_trim / swap_pump_curve for curves).`);
    }
  }
  return [`edge:${e.uid}`];
}

export { stateOf };
