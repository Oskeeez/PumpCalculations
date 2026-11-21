import { describe, expect, it } from 'vitest';
import { evaluateTargets } from '../src/ai/targets';
import { compute, defaultProject } from '../src/model';
import { buildReportHtml } from '../src/report';
import { makeUnits } from '../src/units';

const html = (p = defaultProject(), system: 'si' | 'us' = 'si') => {
  const c = compute(p);
  return buildReportHtml({ project: p, computed: c, targets: evaluateTargets(p, p.targets ?? [], c), units: makeUnits(system), date: new Date('2026-03-04T10:00:00Z'), buildId: 'abc1234' });
};

describe('printable report', () => {
  it('has the main sections and the numbers from the solver', () => {
    const h = html();
    for (const s of ['Pipe network report', 'Summary', 'Pumps', 'Nodes', 'Pipes', 'Valves']) expect(h).toContain(s);
    expect(h).toContain('2026-03-04');
    expect(h).toContain('build abc1234');
    expect(h).toContain('Supply tank');
    expect(h).toContain('32.01 L/s'); // the example network's pump flow, as in the Results table
  });

  it('lists alerts only when there are some', () => {
    expect(html()).not.toContain('Alerts and warnings');
    const h = html({ ...defaultProject(), maxVelocityMps: 0.1 });
    expect(h).toContain('Alerts and warnings');
    expect(h).toContain('exceeds the 0.1 m/s limit');
  });

  it('shows targets with PASS / FAIL, and omits the section when there are none', () => {
    const p = defaultProject();
    expect(html(p)).not.toContain('Design targets');
    const j3 = p.nodes.find((n) => n.name === 'J3')!;
    const h = html({ ...p, targets: [{ id: 't1', type: 'pressure', nodeUid: j3.uid, minKPaG: 10 }, { id: 't2', type: 'pressure', nodeUid: j3.uid, minKPaG: 99999 }] });
    expect(h).toContain('Design targets');
    expect(h).toContain('class="pass">PASS');
    expect(h).toContain('class="fail">FAIL');
  });

  it('escapes names so a pipe called <script> cannot inject markup', () => {
    const p = defaultProject();
    const evil = { ...p, nodes: p.nodes.map((n) => (n.name === 'J2' ? { ...n, name: '<img src=x onerror=alert(1)>' } : n)) };
    const h = html(evil);
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('uses the chosen unit system', () => {
    expect(html(defaultProject(), 'us')).toMatch(/gpm/);
    expect(html(defaultProject(), 'us')).not.toContain('32.01 L/s');
  });

  it('explains an unsolvable network instead of printing blank tables', () => {
    const p = defaultProject();
    const h = html({ ...p, edges: [] });
    expect(h).toContain('could not be solved');
    expect(h).not.toContain('<table');
  });
});
