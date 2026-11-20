export interface ChartTheme {
  bg: string;
  fg: string;
  grid: string;
}

export const SCREEN_THEME: ChartTheme = { bg: 'none', fg: 'var(--fg)', grid: 'var(--border)' };
export const EXPORT_THEME: ChartTheme = { bg: '#ffffff', fg: '#222222', grid: '#dddddd' };

/** Colours that read on both light and dark backgrounds. */
export const PALETTE = ['#2f81f7', '#e8743b', '#3fb950', '#a371f7', '#d29922', '#f778ba'];

export interface ChartSeries {
  name: string;
  /** flow [L/s], head [m] */
  pts: { q: number; h: number }[];
  op?: { q: number; h: number };
}

export const CHART_W = 640;
export const CHART_H = 400;

function niceStep(range: number, target = 6): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

/** Pump head-flow curves with their operating points, as an SVG string. */
export function pumpChartSvg(series: ChartSeries[], t: ChartTheme): string {
  const W = CHART_W;
  const H = CHART_H;
  const m = { l: 62, r: 20, t: 20, b: 52 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const xMax = Math.max(1e-6, ...series.map((s) => s.pts[s.pts.length - 1]?.q ?? 0));
  const yRaw = Math.max(1, ...series.flatMap((s) => [s.pts[0]?.h ?? 0, s.op?.h ?? 0]));
  const ys = niceStep(yRaw * 1.1);
  const yTop = Math.ceil((yRaw * 1.1) / ys) * ys;
  const xs = niceStep(xMax);
  const X = (q: number) => m.l + (q / xMax) * pw;
  const Y = (h: number) => m.t + ph - (Math.max(-yTop * 0.1, Math.min(h, yTop * 1.1)) / yTop) * ph;
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">`);
  o.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  o.push(`<defs><clipPath id="plot"><rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/></clipPath></defs>`);
  for (let v = 0; v <= xMax + 1e-9; v += xs) {
    o.push(`<line x1="${X(v)}" y1="${m.t}" x2="${X(v)}" y2="${m.t + ph}" stroke="${t.grid}"/>`);
    o.push(`<text x="${X(v)}" y="${m.t + ph + 18}" text-anchor="middle" fill="${t.fg}">${+v.toPrecision(4)}</text>`);
  }
  for (let v = 0; v <= yTop + 1e-9; v += ys) {
    o.push(`<line x1="${m.l}" y1="${Y(v)}" x2="${m.l + pw}" y2="${Y(v)}" stroke="${t.grid}"/>`);
    o.push(`<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" fill="${t.fg}">${+v.toPrecision(4)}</text>`);
  }
  o.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="${t.fg}"/>`);
  series.forEach((s, i) => {
    const c = PALETTE[i % PALETTE.length];
    o.push(`<g clip-path="url(#plot)"><polyline points="${s.pts.map((p) => `${X(p.q).toFixed(2)},${Y(p.h).toFixed(2)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2.5"/></g>`);
    if (s.op) {
      const cx = X(s.op.q);
      const cy = Y(s.op.h);
      o.push(`<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${m.t + ph}" stroke="${c}" stroke-dasharray="4 3"/>`);
      o.push(`<circle cx="${cx}" cy="${cy}" r="6" fill="${c}" stroke="${t.bg === 'none' ? 'var(--panel)' : t.bg}" stroke-width="2"/>`);
      const anchor = cx > W * 0.65 ? 'end' : 'start';
      o.push(`<text x="${cx + (anchor === 'end' ? -10 : 10)}" y="${cy - 10}" text-anchor="${anchor}" fill="${t.fg}" font-weight="600">${s.op.q.toFixed(2)} L/s, ${s.op.h.toFixed(2)} m</text>`);
    }
    const ly = m.t + 14 + i * 18;
    o.push(`<line x1="${m.l + 12}" y1="${ly}" x2="${m.l + 36}" y2="${ly}" stroke="${c}" stroke-width="2.5"/><text x="${m.l + 42}" y="${ly + 4}" fill="${t.fg}">${s.name.replace(/[<&>]/g, '')}</text>`);
  });
  o.push(`<text x="${m.l + pw / 2}" y="${H - 10}" text-anchor="middle" fill="${t.fg}">Flow Q [L/s]</text>`);
  o.push(`<text transform="translate(16 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" fill="${t.fg}">Pump head H [m]</text>`);
  o.push('</svg>');
  return o.join('');
}

/** Rasterise an SVG string to a PNG (base64, no prefix). Browser only. */
export async function svgToPngBase64(svg: string, scale = 2): Promise<string | undefined> {
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('chart render failed'));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = CHART_W * scale;
    canvas.height = CHART_H * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  } catch {
    return undefined;
  }
}
