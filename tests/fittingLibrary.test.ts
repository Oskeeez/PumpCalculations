import { beforeEach, describe, expect, it } from 'vitest';
import { addFittings, allFittings, FITTING_TEMPLATE_EXAMPLE, FITTING_TEMPLATE_HEADER, parseFittingSheet, removeFitting, resetFittingLibrary } from '../src/fittingLibrary';
import { FITTING_LIBRARY, fittingK } from '../src/fittings';

describe('fitting sheets', () => {
  it('reads the template', () => {
    const r = parseFittingSheet([FITTING_TEMPLATE_HEADER, ...FITTING_TEMPLATE_EXAMPLE]);
    expect(r.problems).toEqual([]);
    expect(r.fittings.map((f) => f.name)).toEqual(['90° elbow, cast, 3D radius', 'Knife gate valve, open', 'Plug valve, eccentric']);
    expect(r.fittings[0]).toMatchObject({ category: 'Company elbows', ld: 12, source: 'Supplier datasheet 2024' });
    expect(r.fittings[1]).toMatchObject({ k: 0.1 });
    expect(fittingK(r.fittings[0], 100)).toBeCloseTo(12 * 0.017, 10);
    expect(fittingK(r.fittings[1], 100)).toBe(0.1);
  });

  it('accepts other header wording and a missing category or source', () => {
    const r = parseFittingSheet([['Fitting', 'Loss coefficient K'], ['Strainer', 2.5]]);
    expect(r.fittings[0]).toMatchObject({ name: 'Strainer', category: 'Company', k: 2.5, source: 'Company data' });
  });

  it('skips bad rows and says why', () => {
    const r = parseFittingSheet([['Name', 'K', 'L/D'], ['', 1, ''], ['A', '', ''], ['B', -1, ''], ['C', 1, ''], ['C', 2, ''], ['D', '', 30]]);
    expect(r.fittings.map((f) => f.name)).toEqual(['C', 'D']);
    expect(r.problems.length).toBe(4);
    expect(parseFittingSheet([['Foo']]).problems[0]).toMatch(/Name/);
    expect(parseFittingSheet([['Name', 'Foo']]).problems[0]).toMatch(/K/);
  });
});

describe('fitting library store', () => {
  beforeEach(() => resetFittingLibrary());
  it('adds, replaces and removes company fittings and keeps the built-in ones', () => {
    const f = parseFittingSheet([FITTING_TEMPLATE_HEADER, ...FITTING_TEMPLATE_EXAMPLE]).fittings;
    addFittings(f);
    expect(allFittings().length).toBe(FITTING_LIBRARY.length + 3);
    addFittings(f);
    expect(allFittings().length).toBe(FITTING_LIBRARY.length + 3);
    removeFitting(f[0]);
    expect(allFittings().length).toBe(FITTING_LIBRARY.length + 2);
  });
});
