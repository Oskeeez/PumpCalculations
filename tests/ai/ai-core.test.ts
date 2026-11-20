import { describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA, mergeCriteria } from '../../src/ai/criteria';
import { createDraft, diffDraft, estimateCost, mergeDraft } from '../../src/ai/drafts';
import { allPass, evaluateTargets, feasibilityNotes } from '../../src/ai/targets';
import { executeTool, finalizeLayout, newWorkspace } from '../../src/ai/tools';
import { validate, type Schema } from '../../src/ai/schema';
import type { Target } from '../../src/ai/types';
import { compute, defaultProject, parseProject, serializeProject, type ProjectUI } from '../../src/model';
import { designWarnings } from '../../src/ai/warnings';

const ws0 = (main: ProjectUI = defaultProject()) => newWorkspace(main, [], DEFAULT_CRITERIA, { source: 'chat', runId: 'r1' });
const node = (p: ProjectUI, name: string) => p.nodes.find((n) => n.name === name)!;
const R = { reason: 'test' };

describe('schema validation', () => {
  it('rejects unknown params, wrong types, ranges and missing required fields', () => {
    const s = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'number', minimum: 1 }, b: { type: 'string', enum: ['x', 'y'] } } } as Schema;
    expect(validate(s, { a: 2, b: 'x' })).toBeUndefined();
    expect(validate(s, {})).toMatch(/a is required/);
    expect(validate(s, { a: 0 })).toMatch(/≥ 1/);
    expect(validate(s, { a: 2, b: 'z' })).toMatch(/one of x, y/);
    expect(validate(s, { a: 2, c: 1 })).toMatch(/not a known parameter/);
    expect(validate(s, { a: 'q' })).toMatch(/must be number/);
  });
});

describe('targets', () => {
  const p = defaultProject();
  const c = compute(p);
  it('evaluates pressure, flow, velocity and npsh targets with exact shortfall', () => {
    const j3 = node(p, 'J3');
    const gauge = c.result!.nodes.find((n) => n.id === 'J3')!.gaugePressurePa / 1000;
    const targets: Target[] = [
      { id: 't1', type: 'pressure', nodeUid: j3.uid, minKPaG: gauge + 50 },
      { id: 't2', type: 'pressure', nodeUid: j3.uid, minKPaG: gauge - 50 },
      { id: 't3', type: 'flow', nodeUid: j3.uid, minLps: 6 },
      { id: 't4', type: 'flow', nodeUid: j3.uid, minLps: 7 },
      { id: 't5', type: 'velocity', scope: 'all', maxMps: 0.01 },
      { id: 't6', type: 'npsh', pumpUid: 'all', marginM: 0.1 },
    ];
    const s = evaluateTargets(p, targets, c);
    expect(s[0].pass).toBe(false);
    expect(s[0].shortfall).toBeCloseTo(50, 3);
    expect(s[1].pass).toBe(true);
    expect(s[2].pass).toBe(true);
    expect(s[3].pass).toBe(false);
    expect(s[3].shortfall).toBeCloseTo(1, 6);
    expect(s[4].pass).toBe(false);
    expect(allPass(s)).toBe(false);
  });
  it('fails every target with the solver message when the network does not solve', () => {
    const bad = { ...p, edges: [] };
    const s = evaluateTargets(bad, [{ id: 'x', type: 'npsh', pumpUid: 'all', marginM: 1 }], compute(bad));
    expect(s[0].pass).toBe(false);
    expect(s[0].text.length).toBeGreaterThan(5);
  });
  it('flags a pressure target above supply head plus pump shutoff as infeasible', () => {
    const j2 = node(p, 'J2');
    const notes = feasibilityNotes(p, [{ id: 'x', type: 'pressure', nodeUid: j2.uid, minKPaG: 5000 }], c);
    expect(notes[0]).toMatch(/Infeasible/);
    expect(feasibilityNotes(p, [{ id: 'x', type: 'pressure', nodeUid: j2.uid, minKPaG: 10 }], c)).toHaveLength(0);
  });
  it('checks pump operating range against BEP', () => {
    const pump = p.edges.find((e) => e.kind === 'pump')!;
    const s = evaluateTargets(p, [{ id: 'r', type: 'pumpRange', pumpUid: pump.uid, minPctBep: 500 }], c);
    expect(s[0].pass).toBe(false);
    expect(s[0].unit).toBe('% BEP');
  });
});

describe('drafts, diff and merge', () => {
  it('a draft starts identical to main (empty diff) and edits show as modified', () => {
    const main = defaultProject();
    const w = ws0(main);
    const created = executeTool(w, 'create_draft', { name: 'A', rationale: 'test' });
    expect(created.ok).toBe(true);
    const d = w.drafts[0];
    expect(diffDraft(d)).toHaveLength(0);
    const r = executeTool(w, 'resize_pipe', { draft_id: d.id, pipe: 'Pipe A', diameter_mm: 150, ...R, reason: 'velocity' });
    expect(r.ok).toBe(true);
    const diff = diffDraft(d);
    expect(diff).toHaveLength(1);
    expect(diff[0].kind).toBe('modified');
    expect(diff[0].details[0]).toMatch(/diameterMm: 100 → 150/);
    expect(diff[0].reasons).toEqual(['velocity']);
    // main untouched
    expect(main.edges.find((e) => e.name === 'Pipe A')).toMatchObject({ diameterMm: 100 });
  });

  it('merges all, or only the accepted items, onto main', () => {
    const main = defaultProject();
    const w = ws0(main);
    executeTool(w, 'create_draft', { name: 'A', rationale: 't' });
    const d = w.drafts[0];
    executeTool(w, 'resize_pipe', { draft_id: d.id, pipe: 'Pipe A', diameter_mm: 150, ...R });
    executeTool(w, 'resize_pipe', { draft_id: d.id, pipe: 'Pipe B', diameter_mm: 80, ...R });
    executeTool(w, 'insert_inline_element', { draft_id: d.id, pipe: 'Pipe A', element: 'orifice', bore_mm: 50, ...R });
    const items = diffDraft(d);
    expect(items.map((i) => i.kind).sort()).toEqual(['added', 'added', 'added', 'added', 'modified', 'modified']);
    const all = mergeDraft(main, d, 'all').project;
    expect(all.edges).toHaveLength(main.edges.length + 2);
    expect(compute(all).error).toBeUndefined();
    const onlyB = items.find((i) => i.label.startsWith('Pipe B'))!;
    const part = mergeDraft(main, d, new Set([onlyB.key])).project;
    expect(part.edges).toHaveLength(main.edges.length);
    expect(part.edges.find((e) => e.name === 'Pipe B')).toMatchObject({ diameterMm: 80 });
    expect(part.edges.find((e) => e.name === 'Pipe A')).toMatchObject({ diameterMm: 100 });
    // accepting an added component without its nodes pulls the nodes in
    const orifice = items.find((i) => i.kind === 'added' && i.label.includes('orifice'))!;
    const m2 = mergeDraft(main, d, new Set([orifice.key]));
    expect(m2.notes.join(' ')).toMatch(/also added/);
    expect(m2.project.nodes.length).toBeGreaterThan(main.nodes.length);
  });

  it('removal of a node removes its components when merged', () => {
    const main = defaultProject();
    const w = ws0(main);
    executeTool(w, 'create_draft', { name: 'A', rationale: 't' });
    const d = w.drafts[0];
    executeTool(w, 'remove_component', { draft_id: d.id, id: 'Tank C', ...R });
    const merged = mergeDraft(main, d, 'all').project;
    expect(merged.nodes.find((n) => n.name === 'Tank C')).toBeUndefined();
    expect(merged.edges.find((e) => e.name === 'To Tank C')).toBeUndefined();
  });

  it('merges targets and assumptions, and a project with drafts round-trips through save and load', () => {
    const main = defaultProject();
    const w = ws0(main);
    executeTool(w, 'create_draft', { name: 'A', rationale: 't' });
    const d = w.drafts[0];
    const t = executeTool(w, 'add_target', { draft_id: d.id, target: { type: 'pressure', node: 'J3', min_kpag: 100 }, ...R });
    expect(t.ok).toBe(true);
    executeTool(w, 'add_assumption', { draft_id: d.id, category: 'roughness', text: 'Commercial steel, 0.046 mm', ...R });
    const merged = mergeDraft(main, d, 'all').project;
    expect(merged.targets).toHaveLength(1);
    expect(merged.assumptions).toHaveLength(1);
    const saved = { ...merged, drafts: w.drafts };
    const back = parseProject(serializeProject(saved));
    expect(back.targets).toEqual(merged.targets);
    expect(back.drafts).toHaveLength(1);
    expect(back.drafts![0].changes.length).toBe(d.changes.length);
  });

  it('old project files without AI fields still load', () => {
    const back = parseProject(serializeProject(defaultProject()));
    expect(back.targets).toBeUndefined();
    expect(back.drafts).toBeUndefined();
  });
});

describe('tool validation (no LLM)', () => {
  const setup = () => {
    const w = ws0();
    executeTool(w, 'create_draft', { name: 'A', rationale: 't' });
    return { w, id: w.drafts[0].id };
  };

  it('refuses to edit main and unknown drafts', () => {
    const { w } = setup();
    expect(executeTool(w, 'resize_pipe', { draft_id: 'main', pipe: 'Pipe A', diameter_mm: 50, ...R })).toMatchObject({ ok: false, error: expect.stringMatching(/main model cannot be edited/) });
    expect(executeTool(w, 'resize_pipe', { draft_id: 'dnope', pipe: 'Pipe A', diameter_mm: 50, ...R }).error).toMatch(/Unknown draft/);
  });

  it('requires a reason and rejects unknown parameters and bad numbers with readable errors', () => {
    const { w, id } = setup();
    expect(executeTool(w, 'resize_pipe', { draft_id: id, pipe: 'Pipe A', diameter_mm: 50 }).error).toMatch(/reason is required/);
    expect(executeTool(w, 'resize_pipe', { draft_id: id, pipe: 'Pipe A', diameter_mm: -5, ...R }).error).toMatch(/≥ 1/);
    expect(executeTool(w, 'resize_pipe', { draft_id: id, pipe: 'Pipe A', diameter: 50, ...R }).error).toMatch(/not a known parameter/);
    expect(executeTool(w, 'resize_pipe', { draft_id: id, pipe: 'Nope', diameter_mm: 50, ...R }).error).toMatch(/No pipe\/valve\/pump "Nope"/);
    expect(executeTool(w, 'resize_pipe', { draft_id: id, pipe: 'Pipe A', nominal: '99"', ...R }).error).toMatch(/Unknown nominal/);
    expect(executeTool(w, 'nope', {}).error).toMatch(/Unknown tool/);
  });

  it('validates connect: endpoints, pipe sizing, orifice bore and pump curve', () => {
    const { w, id } = setup();
    expect(executeTool(w, 'connect', { draft_id: id, kind: 'pipe', from: 'J1', to: 'J1', diameter_mm: 100, length_m: 10, ...R }).error).toMatch(/itself/);
    expect(executeTool(w, 'connect', { draft_id: id, kind: 'pipe', from: 'J1', to: 'Ghost', diameter_mm: 100, length_m: 10, ...R }).error).toMatch(/No node "Ghost"/);
    expect(executeTool(w, 'connect', { draft_id: id, kind: 'pipe', from: 'J1', to: 'J2', ...R }).error).toMatch(/diameter_mm and length_m/);
    expect(executeTool(w, 'connect', { draft_id: id, kind: 'orifice', from: 'J1', to: 'J2', bore_mm: 120, diameter_mm: 100, ...R }).error).toMatch(/smaller than the pipe/);
    expect(executeTool(w, 'connect', { draft_id: id, kind: 'pump', from: 'J1', to: 'J2', ...R }).error).toMatch(/needs a curve/);
    expect(executeTool(w, 'connect', { draft_id: id, kind: 'pipe', from: 'J1', to: 'J2', diameter_mm: 100, length_m: 10, material: 'unobtainium', ...R }).error).toMatch(/Unknown material/);
    const okc = executeTool(w, 'connect', { draft_id: id, kind: 'pipe', from: 'J1', to: 'J3', diameter_mm: 100, length_m: 10, material: 'PVC / PE / plastic', ...R });
    expect(okc.ok).toBe(true);
  });

  it('set_property enforces per-kind whitelists and ranges', () => {
    const { w, id } = setup();
    expect(executeTool(w, 'set_property', { draft_id: id, id: 'J1', property: 'levelM', value: 2, ...R }).error).toMatch(/tanks only/);
    expect(executeTool(w, 'set_property', { draft_id: id, id: 'Pipe A', property: 'diameterMm', value: 0, ...R }).error).toMatch(/> 0/);
    expect(executeTool(w, 'set_property', { draft_id: id, id: 'Pipe A', property: 'colour', value: 1, ...R }).error).toMatch(/Unknown pipe property/);
    expect(executeTool(w, 'set_property', { draft_id: id, id: 'Pipe A', property: 'name', value: 'Pipe B', ...R }).error).toMatch(/already used/);
    expect(executeTool(w, 'set_property', { draft_id: id, id: 'project', property: 'fluid', value: 'lava', ...R }).error).toMatch(/Unknown fluid/);
    expect(executeTool(w, 'set_property', { draft_id: id, id: 'project', property: 'temperatureC', value: 45, ...R }).ok).toBe(true);
    expect(executeTool(w, 'set_property', { draft_id: id, id: 'J2', property: 'demandLps', value: 5, ...R }).ok).toBe(true);
  });

  it('adds nodes without coordinates and places them next to what they connect to', () => {
    const w = ws0();
    executeTool(w, 'create_draft', { name: 'N', rationale: 't', start: 'empty' });
    const id = w.drafts[0].id;
    expect(executeTool(w, 'add_component', { draft_id: id, kind: 'tank', name: 'T', elevation_m: 0, level_m: 3, ...R }).ok).toBe(true);
    expect(executeTool(w, 'add_component', { draft_id: id, kind: 'junction', name: 'U', elevation_m: 5, demand_lps: 2, ...R }).ok).toBe(true);
    expect(executeTool(w, 'add_component', { draft_id: id, kind: 'junction', name: 'U', elevation_m: 5, ...R }).error).toMatch(/already used/);
    expect(executeTool(w, 'connect', { draft_id: id, kind: 'pump', from: 'T', to: 'U', bep_flow_lps: 4, bep_head_m: 12, ...R }).ok).toBe(true);
    finalizeLayout(w);
    const d = w.drafts[0].project;
    expect(d.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(Math.hypot(d.nodes[0].x - d.nodes[1].x, d.nodes[0].y - d.nodes[1].y)).toBeGreaterThan(50);
    expect(d.nodes.find((n) => n.name === 'T')!.x).toBeLessThan(d.nodes.find((n) => n.name === 'U')!.x); // laid out along the flow, tank first
    const s = executeTool(w, 'solve_draft', { draft_id: id });
    expect(s.ok).toBe(true);
    expect((s.data as { solved: boolean }).solved).toBe(true);
  });

  it('recirculation line, impeller trim and speed change the solved duty; orifice noise is warned', () => {
    const { w, id } = setup();
    const before = (executeTool(w, 'solve_draft', { draft_id: id }).data as { pumps: { flow_lps: number }[] }).pumps[0].flow_lps;
    expect(executeTool(w, 'add_recirc_line', { draft_id: id, pump: 'Pump 1', kind: 'orifice', bore_mm: 25, diameter_mm: 50, ...R }).ok).toBe(true);
    const after = (executeTool(w, 'solve_draft', { draft_id: id }).data as { pumps: { flow_lps: number }[] }).pumps[0].flow_lps;
    expect(after).toBeGreaterThan(before); // recirc adds flow through the pump
    expect(executeTool(w, 'set_impeller_trim', { draft_id: id, pump: 'Pump 1', trim_ratio: 0.8, ...R }).ok).toBe(true);
    const trimmed = (executeTool(w, 'solve_draft', { draft_id: id }).data as { pumps: { flow_lps: number }[] }).pumps[0].flow_lps;
    expect(trimmed).toBeLessThan(after);
    expect(executeTool(w, 'set_pump_speed', { draft_id: id, pump: 'Pump 1', speed_ratio: 2, ...R }).error).toMatch(/≤ 1.5/);
    // tiny orifice in the main line: high bore velocity warning
    executeTool(w, 'insert_inline_element', { draft_id: id, pipe: 'Pipe A', element: 'orifice', bore_mm: 20, ...R });
    const d = w.drafts[0];
    const warns = designWarnings(d.project, compute(d.project), DEFAULT_CRITERIA);
    expect(warns.some((x) => x.kind === 'orifice-noise')).toBe(true);
  });

  it('enforces tool-call, solve and draft limits', () => {
    const w = newWorkspace(defaultProject(), [], DEFAULT_CRITERIA, { source: 'chat', runId: 'r', limits: { maxToolCalls: 5, maxSolves: 1, maxDrafts: 1 } });
    expect(executeTool(w, 'create_draft', { name: 'A', rationale: 't' }).ok).toBe(true);
    expect(executeTool(w, 'create_draft', { name: 'B', rationale: 't' }).error).toMatch(/Draft limit/);
    expect(executeTool(w, 'solve_draft', { draft_id: w.drafts[0].id }).ok).toBe(true);
    expect(executeTool(w, 'solve_draft', { draft_id: w.drafts[0].id }).error).toMatch(/Solve limit/);
    expect(executeTool(w, 'get_network_summary', {}).ok).toBe(true);
    expect(executeTool(w, 'get_network_summary', {}).error).toMatch(/Tool-call limit/);
    expect(w.log.some((l) => l.kind === 'limit')).toBe(true);
    expect(w.log.length).toBeGreaterThanOrEqual(5);
  });

  it('read tools return compact data and never mutate', () => {
    const { w, id } = setup();
    const sum = executeTool(w, 'get_network_summary', { draft_id: id });
    expect(sum.ok).toBe(true);
    const comp = executeTool(w, 'get_component', { id: 'Pump 1' });
    expect(JSON.stringify(comp.data)).toMatch(/pct_bep/);
    expect(executeTool(w, 'get_branch', { node_id: 'J1', depth: 1 }).ok).toBe(true);
    expect(executeTool(w, 'get_solver_results', { scope: 'nodes' }).ok).toBe(true);
    expect(executeTool(w, 'get_targets_status', {}).ok).toBe(true);
    const cat = executeTool(w, 'list_catalog', { type: 'pumps', filters: { duty_flow_lps: 10, duty_head_m: 30 } });
    expect((cat.data as unknown[]).length).toBe(3);
    expect(executeTool(w, 'list_catalog', { type: 'pumps' }).error).toMatch(/duty_flow_lps/);
    expect(diffDraft(w.drafts[0])).toHaveLength(0);
  });
});

describe('misc', () => {
  it('estimates a rough cost that rises with pipe size', () => {
    const p = defaultProject();
    const c = compute(p);
    const base = estimateCost(p, c, DEFAULT_CRITERIA).total;
    const big = { ...p, edges: p.edges.map((e) => (e.kind === 'pipe' ? { ...e, diameterMm: e.diameterMm * 2 } : e)) };
    expect(estimateCost(big, compute(big), DEFAULT_CRITERIA).total).toBeGreaterThan(base);
  });
  it('merges partial design criteria over the defaults and rejects unknown sections', () => {
    expect(mergeCriteria({ velocity: { generalMax: 2 } }).velocity).toEqual({ ...DEFAULT_CRITERIA.velocity, generalMax: 2 });
    expect(() => mergeCriteria({ nope: 1 })).toThrow(/Unknown/);
  });
  it('createDraft keeps main fluid and settings when starting empty', () => {
    const main = defaultProject();
    const d = createDraft(main, { name: 'x', rationale: '', source: 'generate', start: 'empty' });
    expect(d.project.nodes).toHaveLength(0);
    expect(d.project.fluid).toEqual(main.fluid);
  });
});
