import { describe, expect, it } from 'vitest';
import { buildReportHtml, issueState, modelFingerprint } from '../src/report';
import { compute, defaultProject, type ProjectUI } from '../src/model';
import { makeUnits } from '../src/units';

describe('calculation record', () => {
  const p = defaultProject();
  it('the fingerprint follows the hydraulic model only', () => {
    const a = modelFingerprint(p);
    expect(a).toMatch(/^[0-9A-F]{16}$/);
    expect(modelFingerprint({ ...p, calcRecord: { title: 'x', calcNo: '', project: '', client: '', notes: '', revisions: [] } })).toBe(a);
    const changed = { ...p, nodes: p.nodes.map((n, i) => (i === 0 ? { ...n, elevationM: n.elevationM + 0.01 } : n)) };
    expect(modelFingerprint(changed)).not.toBe(a);
  });

  it('knows whether the model matches the last issued revision', () => {
    expect(issueState(p).kind).toBe('draft');
    const issued: ProjectUI = { ...p, calcRecord: { title: 'T', calcNo: 'C-1', project: 'P', client: 'K', notes: '', revisions: [{ rev: 'A', date: '2026-01-01', description: 'First issue', preparedBy: 'AB', checkedBy: 'CD', approvedBy: 'EF', fingerprint: modelFingerprint(p) }] } };
    expect(issueState(issued)).toEqual({ kind: 'issued', rev: 'A' });
    const edited = { ...issued, maxVelocityMps: 2.5 };
    expect(issueState(edited)).toEqual({ kind: 'changed', rev: 'A' });
  });

  it('the report has the title block, the revisions, the basis and every input', () => {
    const issued: ProjectUI = { ...p, calcRecord: { title: 'Cooling water', calcNo: 'CALC-042', project: 'Plant 3', client: 'Acme', notes: 'Note text', revisions: [{ rev: 'A', date: '2026-01-01', description: 'First issue', preparedBy: 'AB', checkedBy: 'CD', approvedBy: 'EF', fingerprint: modelFingerprint(p) }] } };
    const html = buildReportHtml({ project: issued, computed: compute(issued), targets: [], units: makeUnits('si') });
    for (const t of ['Cooling water', 'CALC-042', 'Plant 3', 'Acme', 'First issue', 'As issued at revision A', 'Basis of calculation', 'Colebrook-White', 'Input data: nodes', 'Input data: pipes', modelFingerprint(p)]) expect(html).toContain(t);
    for (const e of p.edges) expect(html).toContain(e.name);
    const hw = buildReportHtml({ project: { ...issued, frictionMethod: 'hw' }, computed: compute({ ...issued, frictionMethod: 'hw' }), targets: [], units: makeUnits('si') });
    expect(hw).toContain('Hazen-Williams C');
    expect(hw).toContain('Changed since revision A');
  });
});
