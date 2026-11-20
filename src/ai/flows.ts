/** The user-facing AI flows: generate from a description, diagnose, ideas-first, solve-every-way and chat. */
import { compute, type ProjectUI } from '../model';
import { runAgent } from './agent';
import { analyse } from './compare';
import type { DesignCriteria } from './criteria';
import { newRunId } from './drafts';
import type { LlmMessage, LlmProvider } from './llm';
import { BUILD_CONCEPT_PROMPT, GENERATE_PROMPT, IDEAS_PROMPT, systemPrompt } from './prompts';
import { finalizeLayout, newWorkspace, solveProject, TOOL_DEFS, type LogEntry, type RunLimits, type Workspace } from './tools';
import type { Draft } from './types';

export interface FlowContext {
  provider: LlmProvider;
  main: ProjectUI;
  drafts: Draft[];
  criteria: DesignCriteria;
  limits?: Partial<RunLimits>;
  signal?: AbortSignal;
  /** Called whenever drafts change (live canvas updates) and for progress text. */
  onDrafts?: (drafts: Draft[]) => void;
  onProgress?: (text: string) => void;
}

export interface FlowResult {
  /** All drafts after the run (existing ones included). */
  drafts: Draft[];
  /** The drafts this run created. */
  created: Draft[];
  text: string;
  log: LogEntry[];
  usage: Workspace['usage'];
  stoppedBy: string;
}

function mkWs(ctx: FlowContext, source: Draft['source'], limits?: Partial<RunLimits>): Workspace {
  const ws = newWorkspace(ctx.main, ctx.drafts, ctx.criteria, { source, runId: newRunId(), limits: { ...ctx.limits, ...limits } });
  ws.onChange = () => ctx.onDrafts?.(JSON.parse(JSON.stringify(ws.drafts)) as Draft[]);
  return ws;
}

function finish(ctx: FlowContext, ws: Workspace, text: string, stoppedBy: string, before: Set<string>): FlowResult {
  finalizeLayout(ws);
  ctx.onDrafts?.(JSON.parse(JSON.stringify(ws.drafts)) as Draft[]);
  return { drafts: ws.drafts, created: ws.drafts.filter((d) => !before.has(d.id)), text, log: ws.log, usage: ws.usage, stoppedBy };
}

const summaryOfMain = (p: ProjectUI) => (p.nodes.length ? `${p.nodes.length} nodes and ${p.edges.length} components` : 'empty (no nodes yet)');

// ------------------------------------------------------------------ generate
export async function generateFromDescription(ctx: FlowContext, description: string): Promise<FlowResult> {
  const ws = mkWs(ctx, 'generate');
  const before = new Set(ws.drafts.map((d) => d.id));
  const r = await runAgent({ provider: ctx.provider, ws, system: systemPrompt(ctx.criteria), user: GENERATE_PROMPT(description, summaryOfMain(ctx.main)), signal: ctx.signal, onText: ctx.onProgress });
  return finish(ctx, ws, r.text, r.stoppedBy, before);
}

// ----------------------------------------------------------------- diagnosis
export interface Diagnosis {
  text: string;
  lines: string[];
  failing: number;
  solved: boolean;
}

/** Deterministic diagnosis of main from solver output, so the numbers are exact. */
export function diagnose(main: ProjectUI, criteria: DesignCriteria): Diagnosis {
  const col = analyse('main', 'main', '', 'main', main, main.targets ?? [], criteria);
  const lines: string[] = [];
  if (!col.solved) {
    return { text: `The current model does not solve: ${col.error ?? 'unknown error'}.`, lines: [col.error ?? 'does not solve'], failing: 0, solved: false };
  }
  const failing = col.statuses.filter((s) => !s.pass);
  if (!main.targets?.length) lines.push('No targets are set, so there is nothing to pass or fail. Add targets in the Targets panel for a real diagnosis.');
  for (const s of failing) lines.push(`${s.label} fails by ${s.shortfall.toFixed(s.unit === 'kPa' ? 0 : 2)} ${s.unit}: ${s.text}.`);
  const c = compute(main);
  for (const p of col.pumps) {
    const edge = c.model?.edges.find((e) => e.kind === 'pump' && e.id === p.name);
    const runout = edge && edge.kind === 'pump' ? edge.model.headDataRange.maxFlowM3s * edge.speedRatio * 1000 : undefined;
    const bits = [`${p.flowLps.toFixed(1)} L/s at ${p.headM.toFixed(1)} m`];
    if (p.pctBep !== undefined) bits.push(`${p.pctBep.toFixed(0)} % of BEP`);
    if (runout && p.flowLps > 0.9 * runout) bits.push('near runout');
    if (p.pctBep !== undefined && p.pctBep < criteria.pump.minFlowPctBep) bits.push('below minimum-flow guideline');
    lines.push(`${p.name}: ${bits.join(', ')}.`);
  }
  if (col.headBurnedM > 0.5) lines.push(`${col.headBurnedM.toFixed(1)} m of head is burned across valves/orifices (${col.burnedBy.slice(0, 3).map((b) => `${b.name} ${b.headM.toFixed(1)} m`).join(', ')}).`);
  for (const w of col.warnings.slice(0, 6)) lines.push(`Warning: ${w.text}`);
  for (const f of col.feasibility) lines.push(`Feasibility: ${f}`);
  if (!lines.length) lines.push('All targets pass and no warnings.');
  return { text: lines.join('\n'), lines, failing: failing.length, solved: true };
}

// -------------------------------------------------------------------- ideas
export interface Concept {
  title: string;
  reasoning: string;
}

/** Pull the first JSON array out of a model reply and validate it. */
export function parseConcepts(reply: string, max: number): Concept[] {
  const a = reply.indexOf('[');
  const b = reply.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('The AI did not return a list of ideas. Try again.');
  let arr: unknown;
  try {
    arr = JSON.parse(reply.slice(a, b + 1));
  } catch {
    throw new Error('The AI returned ideas in a format the app could not read. Try again.');
  }
  if (!Array.isArray(arr)) throw new Error('The AI did not return a list of ideas. Try again.');
  const out = arr
    .filter((x): x is { title: string; reasoning: string } => !!x && typeof (x as Concept).title === 'string' && typeof (x as Concept).reasoning === 'string' && (x as Concept).title.trim() !== '')
    .map((x) => ({ title: x.title.trim().slice(0, 80), reasoning: x.reasoning.trim().slice(0, 300) }))
    .slice(0, max);
  if (!out.length) throw new Error('The AI returned no usable ideas. Try again.');
  return out;
}

export async function proposeConcepts(ctx: FlowContext, diagnosis: Diagnosis, n = 4): Promise<{ concepts: Concept[]; log: LogEntry[] }> {
  const ws = mkWs(ctx, 'solve', { maxTurns: 1, maxToolCalls: 0 });
  const res = await ctx.provider.complete({ system: systemPrompt(ctx.criteria), messages: [{ role: 'user', content: [{ type: 'text', text: IDEAS_PROMPT(diagnosis.text, n) }] }], tools: [], maxTokens: 1500 }, ctx.signal);
  const reply = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
  ws.log.push({ t: new Date().toISOString(), kind: 'llm', note: `ideas: ${reply.slice(0, 400)}`, ok: true });
  return { concepts: parseConcepts(reply, n), log: ws.log };
}

/** Build one draft per concept. With several concepts they run concurrently; the solver stays the single source of results. */
export async function buildConcepts(ctx: FlowContext, concepts: Concept[], diagnosis: Diagnosis): Promise<FlowResult> {
  const per = { maxToolCalls: (ctx.limits?.maxToolCalls ?? 80) * concepts.length, maxSolves: (ctx.limits?.maxSolves ?? 30) * concepts.length, maxDrafts: concepts.length + 1 };
  const ws = mkWs(ctx, 'solve', per);
  const before = new Set(ws.drafts.map((d) => d.id));
  const texts: string[] = [];
  const results = await Promise.all(
    concepts.map(async (c) => {
      const r = await runAgent({ provider: ctx.provider, ws, system: systemPrompt(ctx.criteria), user: BUILD_CONCEPT_PROMPT(c.title, c.reasoning, diagnosis.text), signal: ctx.signal });
      texts.push(`${c.title}: ${r.text}`);
      return r;
    }),
  );
  const stopped = results.find((r) => r.stoppedBy !== 'done')?.stoppedBy ?? 'done';
  return finish(ctx, ws, texts.join('\n\n'), stopped, before);
}

// --------------------------------------------------------------------- chat
export interface ChatResult extends FlowResult {
  history: LlmMessage[];
}

/** One chat turn. Edit requests are made in a draft (the model must create or reuse one); main is never changed. */
export async function chatTurn(ctx: FlowContext, history: LlmMessage[], message: string, activeDraftId?: string): Promise<ChatResult> {
  const ws = mkWs(ctx, 'chat');
  const before = new Set(ws.drafts.map((d) => d.id));
  const active = ws.drafts.find((d) => d.id === activeDraftId && d.status === 'open');
  const note = active ? `The user is looking at draft "${active.name}" (id ${active.id}). Edit requests apply to that draft unless they say otherwise.` : 'No draft is selected. For any edit request, create_draft first (start "copy_main").';
  const r = await runAgent({ provider: ctx.provider, ws, system: systemPrompt(ctx.criteria), history, user: `${note}\n\n${message}`, signal: ctx.signal, onText: ctx.onProgress });
  const out = finish(ctx, ws, r.text, r.stoppedBy, before);
  return { ...out, history: r.messages };
}

export { solveProject, TOOL_DEFS };
