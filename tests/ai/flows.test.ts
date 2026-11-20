import { describe, expect, it } from 'vitest';
import { analyse, compareAll, rank, verdict } from '../../src/ai/compare';
import { DEFAULT_CRITERIA } from '../../src/ai/criteria';
import { mergeDraft } from '../../src/ai/drafts';
import { buildConcepts, chatTurn, diagnose, generateFromDescription, parseConcepts, proposeConcepts } from '../../src/ai/flows';
import { AnthropicProvider, MockProvider, text, toolCalls, type LlmRequest } from '../../src/ai/llm';
import { blankProject, compute, defaultProject } from '../../src/model';

const R = 'because';
/** draft_id from the most recent create_draft result in this conversation. */
const draftIdIn = (req: LlmRequest): string => {
  for (const m of [...req.messages].reverse())
    for (const b of m.content)
      if (b.type === 'tool_result' && b.content.includes('draft_id')) return (JSON.parse(b.content) as { draft_id: string }).draft_id;
  throw new Error('no draft id yet');
};

describe('generate from a description (mock LLM)', () => {
  it('builds a draft with assumptions and targets, never touches main, and the result is solver-checked', async () => {
    const main = blankProject();
    const steps = [
      () => toolCalls({ name: 'create_draft', input: { name: 'Booster', rationale: 'Tank to far tap via one pump', start: 'empty' } }),
      (req: LlmRequest) => {
        const d = draftIdIn(req);
        return toolCalls(
          { name: 'add_component', input: { draft_id: d, kind: 'tank', name: 'Supply', elevation_m: 0, level_m: 3, reason: R } },
          { name: 'add_component', input: { draft_id: d, kind: 'junction', name: 'Tap', elevation_m: 6, demand_lps: 3, reason: R } },
          { name: 'add_component', input: { draft_id: d, kind: 'junction', name: 'Pump out', elevation_m: 0, reason: R } },
        );
      },
      (req: LlmRequest) => {
        const d = draftIdIn(req);
        return toolCalls(
          { name: 'connect', input: { draft_id: d, kind: 'pump', from: 'Supply', to: 'Pump out', bep_flow_lps: 4, bep_head_m: 25, reason: R } },
          { name: 'connect', input: { draft_id: d, kind: 'pipe', from: 'Pump out', to: 'Tap', diameter_mm: 52.5, length_m: 40, material: 'Commercial / welded steel', reason: R } },
          { name: 'add_target', input: { draft_id: d, target: { type: 'pressure', node: 'Tap', min_kpag: 50 }, reason: R } },
          { name: 'add_assumption', input: { draft_id: d, category: 'roughness', text: 'Commercial steel 0.046 mm', reason: R } },
        );
      },
      (req: LlmRequest) => toolCalls({ name: 'solve_draft', input: { draft_id: draftIdIn(req) } }),
      () => text('Built a one-pump system.'),
    ];
    const llm = new MockProvider((_r, i) => steps[i](_r));
    const res = await generateFromDescription({ provider: llm, main, drafts: [], criteria: DEFAULT_CRITERIA }, 'Tank to a tap 6 m up, 3 L/s, 50 kPa');
    expect(res.created).toHaveLength(1);
    const d = res.created[0];
    expect(d.assumptions).toHaveLength(1);
    expect(d.targets).toHaveLength(1);
    expect(d.project.nodes.every((n) => Number.isFinite(n.x) && n.x > 0)).toBe(true);
    const X = (n: string) => d.project.nodes.find((q) => q.name === n)!.x;
    expect(X('Supply')).toBeLessThan(X('Pump out'));
    expect(X('Pump out')).toBeLessThan(X('Tap'));
    expect(main.nodes).toHaveLength(0);
    const col = analyse(d.id, d.name, d.rationale, 'open', d.project, d.targets, DEFAULT_CRITERIA);
    expect(col.solved).toBe(true);
    expect(col.pumps[0].pctBep).toBeGreaterThan(50);
    expect(res.log.filter((l) => l.kind === 'tool' || l.kind === 'solve').length).toBeGreaterThanOrEqual(8);
    expect(res.usage.solves).toBe(1);
    // accept all
    const merged = mergeDraft(main, d, 'all').project;
    expect(merged.nodes).toHaveLength(3);
    expect(merged.targets).toHaveLength(1);
    expect(merged.assumptions).toHaveLength(1);
    expect(compute(merged).error).toBeUndefined();
  });

  it('a model error is returned to the model and the loop continues; turn limits stop a runaway model', async () => {
    const llm = new MockProvider((req, i) => {
      if (i === 0) return toolCalls({ name: 'create_draft', input: { name: 'X', rationale: 'y' } });
      if (i === 1) return toolCalls({ name: 'resize_pipe', input: { draft_id: draftIdIn(req), pipe: 'Missing', diameter_mm: 80, reason: R } });
      return toolCalls({ name: 'get_network_summary', input: {} }); // never stops
    });
    const res = await generateFromDescription({ provider: llm, main: defaultProject(), drafts: [], criteria: DEFAULT_CRITERIA, limits: { maxTurns: 5 } }, 'whatever');
    expect(res.stoppedBy).toBe('turn-limit');
    expect(res.log.some((l) => l.ok === false && /No pipe\/valve\/pump "Missing"/.test(String(l.output)))).toBe(true);
    expect(res.log.some((l) => l.kind === 'limit')).toBe(true);
  });
});

describe('diagnosis and ideas', () => {
  it('diagnoses failing targets with exact numbers from the solver', () => {
    const main = defaultProject();
    const j3 = main.nodes.find((n) => n.name === 'J3')!;
    const gauge = compute(main).result!.nodes.find((n) => n.id === 'J3')!.gaugePressurePa / 1000;
    const d = diagnose({ ...main, targets: [{ id: 'p', type: 'pressure', nodeUid: j3.uid, minKPaG: gauge + 80 }] }, DEFAULT_CRITERIA);
    expect(d.failing).toBe(1);
    expect(d.text).toMatch(/fails by 80 kPa/);
    expect(d.text).toMatch(/Pump 1:/);
    expect(diagnose({ ...main, edges: [] }, DEFAULT_CRITERIA).solved).toBe(false);
    expect(diagnose(main, DEFAULT_CRITERIA).text).toMatch(/No targets/);
  });

  it('parses a JSON idea list out of a chatty reply and rejects junk', () => {
    const c = parseConcepts('Sure!\n[{"title":"Bigger main","reasoning":"less friction"},{"title":"Trim","reasoning":"save energy"},{"bad":1}]\nDone', 4);
    expect(c.map((x) => x.title)).toEqual(['Bigger main', 'Trim']);
    expect(() => parseConcepts('no list here', 4)).toThrow(/list of ideas/);
    expect(() => parseConcepts('[1,2]', 4)).toThrow(/no usable ideas/);
    expect(() => parseConcepts('[{"title": oops}]', 4)).toThrow(/format/);
  });

  it('solve every way: one draft per concept, built concurrently, ranked by solver results, main unchanged', async () => {
    const main = defaultProject();
    const j3 = main.nodes.find((n) => n.name === 'J3')!;
    const gauge = compute(main).result!.nodes.find((n) => n.id === 'J3')!.gaugePressurePa / 1000;
    const withTargets = { ...main, targets: [{ id: 'p', type: 'pressure' as const, nodeUid: j3.uid, minKPaG: gauge - 5 }] };
    // concept A raises a trim-reduced pump back (fixes nothing: stays passing as main already passes), concept B starves the line
    const llm = new MockProvider((req, i) => {
      const first = JSON.stringify(req.messages[0]);
      if (!req.tools.length) return text('[{"title":"Bigger pipe","reasoning":"less friction"},{"title":"Throttle line","reasoning":"test"}]');
      const isA = first.includes('Bigger pipe');
      const sawDraft = req.messages.some((m) => m.content.some((b) => b.type === 'tool_result' && b.content.includes('draft_id')));
      const edited = req.messages.length > 4;
      if (!sawDraft) return toolCalls({ name: 'create_draft', input: { name: isA ? 'Bigger pipe' : 'Throttle line', rationale: isA ? 'less friction' : 'test' } });
      if (!edited) return isA
        ? toolCalls({ name: 'resize_pipe', input: { draft_id: draftIdIn(req), pipe: 'Pipe B', diameter_mm: 150, reason: R } })
        : toolCalls({ name: 'resize_pipe', input: { draft_id: draftIdIn(req), pipe: 'Pipe B', diameter_mm: 20, reason: R, side_effects: 'big loss' } });
      if (req.messages.length <= 6) return toolCalls({ name: 'solve_draft', input: { draft_id: draftIdIn(req) } });
      void i;
      return text('done');
    });
    const ctx = { provider: llm, main: withTargets, drafts: [], criteria: DEFAULT_CRITERIA };
    const diag = diagnose(withTargets, DEFAULT_CRITERIA);
    const { concepts } = await proposeConcepts(ctx, diag);
    expect(concepts).toHaveLength(2);
    const res = await buildConcepts(ctx, concepts, diag);
    expect(res.created).toHaveLength(2);
    expect(new Set(res.created.map((d) => d.runId)).size).toBe(1); // siblings
    expect(withTargets.edges.find((e) => e.name === 'Pipe B')).toMatchObject({ diameterMm: 100 });
    const cols = compareAll(withTargets, res.created, DEFAULT_CRITERIA);
    expect(cols).toHaveLength(3);
    const ranked = rank(cols.slice(1));
    expect(ranked[0].name).toBe('Bigger pipe');
    expect(ranked[1].allPass).toBe(false);
    expect(verdict(cols)).toMatch(/1 of 2 draft/);
  });

  it('says plainly when no draft passes and never calls a failing draft a pass', () => {
    const main = defaultProject();
    const j2 = main.nodes.find((n) => n.name === 'J2')!;
    const m = { ...main, targets: [{ id: 'p', type: 'pressure' as const, nodeUid: j2.uid, minKPaG: 5000 }] };
    const cols = compareAll(m, [], DEFAULT_CRITERIA);
    const fake = { ...cols[0], status: 'open' as const, name: 'D1', id: 'd1' };
    expect(fake.allPass).toBe(false);
    expect(verdict([fake])).toMatch(/No draft meets every target.*infeasible/s);
  });
});

describe('chat', () => {
  it('edit requests go to a draft, main is never changed, and direct main edits are refused', async () => {
    const main = defaultProject();
    const llm = new MockProvider((req, i) => {
      if (i === 0) return toolCalls({ name: 'resize_pipe', input: { draft_id: 'main', pipe: 'Pipe A', diameter_mm: 150, reason: R } });
      if (i === 1) return toolCalls({ name: 'create_draft', input: { name: 'Bypass', rationale: 'user asked' } });
      if (i === 2) return toolCalls({ name: 'insert_inline_element', input: { draft_id: draftIdIn(req), pipe: 'Pipe B', element: 'check_valve', reason: R } });
      return text('Added a check valve in a draft.');
    });
    const res = await chatTurn({ provider: llm, main, drafts: [], criteria: DEFAULT_CRITERIA }, [], 'add a check valve on Pipe B');
    expect(res.created).toHaveLength(1);
    expect(res.log.find((l) => l.name === 'resize_pipe')?.ok).toBe(false);
    expect(main.edges.find((e) => e.name === 'Pipe A')).toMatchObject({ diameterMm: 100 });
    expect(res.history.length).toBeGreaterThan(4);
    expect(res.text).toMatch(/draft/);
  });
});

describe('Anthropic provider', () => {
  it('sends the key, version and tool schemas, and maps API errors to readable messages', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'm', fetchFn });
    const r = await p.complete({ system: 's', messages: [], tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }], maxTokens: 10 });
    expect(r.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(seen!.url).toBe('https://api.anthropic.com/v1/messages');
    const h = seen!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-test');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(seen!.init.body as string).tools[0].name).toBe('t');
    const bad = new AnthropicProvider({ apiKey: 'k', model: 'm', fetchFn: (async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })) as unknown as typeof fetch });
    await expect(bad.complete({ system: '', messages: [], tools: [], maxTokens: 1 })).rejects.toThrow(/401.*invalid x-api-key.*Check your API key/);
    await expect(new AnthropicProvider({ apiKey: ' ', model: 'm' }).complete({ system: '', messages: [], tools: [], maxTokens: 1 })).rejects.toThrow(/No API key/);
  });
});
