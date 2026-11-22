import { beforeEach, describe, expect, it } from 'vitest';
import { addSeries, allPipeSeries, findSeries, parsePipeSheet, removeSeries, resetPipeLibrary, setStandardSeries, smallestStandardSize, standardSeriesId, TEMPLATE_EXAMPLE, TEMPLATE_HEADER } from '../src/pipeLibrary';

describe('pipe size sheets', () => {
  it('reads the template layout into series', () => {
    const r = parsePipeSheet([TEMPLATE_HEADER, ...TEMPLATE_EXAMPLE]);
    expect(r.problems).toEqual([]);
    expect(r.series.map((s) => s.label)).toEqual(['Company PE100 PN10', 'Company steel']);
    const pe = r.series[0];
    expect(pe.sizes.map((s) => s.nps)).toEqual(['DN50', 'DN63', 'DN90']);
    expect(pe.sizes[0]).toMatchObject({ idMm: 44, odMm: 50, roughnessMm: 0.0015, ratingKPaG: 1000 });
    expect(r.series[1].sizes[0].roughnessMm).toBe(0.046);
  });

  it('works out the inside diameter from outside diameter and wall, and reads inches', () => {
    const a = parsePipeSheet([['Nominal', 'Outside diameter (mm)', 'Wall (mm)'], ['DN25', 33.4, 3.4]]);
    expect(a.series[0].sizes[0].idMm).toBeCloseTo(26.6, 6);
    expect(a.series[0].label).toBe('Imported pipe sizes');
    const b = parsePipeSheet([['Series', 'NPS', 'ID (in)'], ['X', '2"', 2]]);
    expect(b.series[0].sizes[0].idMm).toBeCloseTo(50.8, 6);
  });

  it('converts pressure rating units', () => {
    const r = parsePipeSheet([['Nominal', 'ID (mm)', 'Rating (bar)'], ['A', 50, 10]]);
    expect(r.series[0].sizes[0].ratingKPaG).toBe(1000);
  });

  it('skips bad rows and says why', () => {
    const r = parsePipeSheet([['Series', 'Nominal size', 'Inside diameter (mm)'], ['S', '', 50], ['S', 'A', 'abc'], ['S', 'B', 60], ['S', 'B', 70], ['', '', '']]);
    expect(r.series[0].sizes.map((s) => s.nps)).toEqual(['B']);
    expect(r.problems.length).toBe(3);
    expect(parsePipeSheet([['Foo', 'Bar']]).problems[0]).toMatch(/Nominal size/);
    expect(parsePipeSheet([['Nominal size', 'Foo']]).problems[0]).toMatch(/Inside diameter/);
  });
});

describe('library store', () => {
  beforeEach(() => resetPipeLibrary());
  it('adds, replaces and removes company series, keeping the built-in ones', () => {
    const base = allPipeSeries().length;
    const s = parsePipeSheet([TEMPLATE_HEADER, ...TEMPLATE_EXAMPLE]).series;
    addSeries(s);
    expect(allPipeSeries().length).toBe(base + 2);
    addSeries(s);
    expect(allPipeSeries().length).toBe(base + 2);
    const id = s[0].id;
    setStandardSeries(id);
    expect(standardSeriesId()).toBe(id);
    expect(findSeries(id).label).toBe('Company PE100 PN10');
    removeSeries(id);
    expect(standardSeriesId()).toBe('sch40');
    expect(allPipeSeries().length).toBe(base + 1);
  });
});

describe('standard sizing', () => {
  const series = { id: 's', label: 's', sizes: [{ nps: 'A', idMm: 25 }, { nps: 'B', idMm: 50 }, { nps: 'C', idMm: 100 }] };
  it('picks the smallest size under the limits', () => {
    const hl = (id: number) => 100 / id;
    expect(smallestStandardSize(series, 5, { maxVelocityMps: 3 }, hl)?.size.nps).toBe('B'); // 25 mm gives 10 m/s, 50 mm gives 2.5 m/s
    expect(smallestStandardSize(series, 5, { maxVelocityMps: 3, maxHeadLossPer100m: 1.5 }, hl)?.size.nps).toBe('C');
    expect(smallestStandardSize(series, 500, { maxVelocityMps: 3 }, hl)).toBeUndefined();
  });
});
