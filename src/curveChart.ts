import type { CurvePoint } from './solver';

export interface ChartTheme {
  bg: string;
  fg: string;
  grid: string;
  pump: string;
  system: string;
  op: string;
}

export const SCREEN_THEME: ChartTheme = {
  bg: 'none',
  fg: 'var(--fg)',
  grid: 'var(--border)',
  pump: 'var(--pump)',
  system: 'var(--system)',
  op: 'var(--op)',
};

export const EXPORT_THEME: ChartTheme = { bg: '#ffffff', fg: '#222222', grid: '#dddddd', pump: '#1f6feb', system: '#d4561a', op: '#111111' };

function niceStep(range: number, target = 6): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

export interface ChartInput {
  curves: CurvePoint[];
  /** Operating point, or undefined when there is none. */
  op?: { flowM3s: number; headM: number };
}

export const CHART_W = 640;
export const CHART_H = 400;

/** Pump & system curve chart as an SVG string (flow in L/s, head in m). */
export function curveChartSvg({ curves, op }: ChartInput, t: ChartTheme): string {
  const W = CHART_W;
  const H = CHART_H;
  const m = { l: 62, r: 20, t: 20, b: 52 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const xMax = (curves[curves.length - 1]?.flowM3s ?? 0.001) * 1000;
  const shutoff = curves[0]?.pumpHeadM ?? 0;
  const sysMax = Math.max(...curves.map((c) => c.systemHeadM));
  const yMax = Math.max(1, Math.max(shutoff, curves[0]?.systemHeadM ?? 0) * 1.2, op ? op.headM * 1.3 : 0, Math.min(sysMax, shutoff * 1.5 || sysMax));
  const xs = niceStep(xMax);
  const ys = niceStep(yMax);
  const yTop = Math.ceil(yMax / ys) * ys;
  const X = (q: number) => m.l + (q / xMax) * pw;
  const Y = (h: number) => m.t + ph - (Math.max(-yTop * 0.2, Math.min(h, yTop * 1.2)) / yTop) * ph;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  parts.push(`<defs><clipPath id="plot"><rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/></clipPath></defs>`);
  for (let v = 0; v <= xMax + 1e-9; v += xs) {
    parts.push(`<line x1="${X(v)}" y1="${m.t}" x2="${X(v)}" y2="${m.t + ph}" stroke="${t.grid}"/>`);
    parts.push(`<text x="${X(v)}" y="${m.t + ph + 18}" text-anchor="middle" fill="${t.fg}">${+v.toPrecision(4)}</text>`);
  }
  for (let v = 0; v <= yTop + 1e-9; v += ys) {
    parts.push(`<line x1="${m.l}" y1="${Y(v)}" x2="${m.l + pw}" y2="${Y(v)}" stroke="${t.grid}"/>`);
    parts.push(`<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" fill="${t.fg}">${+v.toPrecision(4)}</text>`);
  }
  parts.push(`<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="${t.fg}"/>`);
  const line = (key: 'pumpHeadM' | 'systemHeadM') => curves.map((c) => `${X(c.flowM3s * 1000).toFixed(2)},${Y(c[key]).toFixed(2)}`).join(' ');
  parts.push(`<g clip-path="url(#plot)"><polyline points="${line('pumpHeadM')}" fill="none" stroke="${t.pump}" stroke-width="2.5"/>`);
  parts.push(`<polyline points="${line('systemHeadM')}" fill="none" stroke="${t.system}" stroke-width="2.5"/></g>`);
  if (op) {
    const cx = X(op.flowM3s * 1000);
    const cy = Y(op.headM);
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${m.t + ph}" stroke="${t.op}" stroke-dasharray="4 3"/>`);
    parts.push(`<line x1="${m.l}" y1="${cy}" x2="${cx}" y2="${cy}" stroke="${t.op}" stroke-dasharray="4 3"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="6" fill="${t.op}" stroke="${t.bg === 'none' ? 'var(--bg)' : t.bg}" stroke-width="2"/>`);
    const anchor = cx > W * 0.65 ? 'end' : 'start';
    const dx = anchor === 'end' ? -10 : 10;
    parts.push(`<text x="${cx + dx}" y="${cy - 10}" text-anchor="${anchor}" fill="${t.fg}" font-weight="600">${(op.flowM3s * 1000).toFixed(2)} L/s, ${op.headM.toFixed(2)} m</text>`);
  }
  parts.push(`<text x="${m.l + pw / 2}" y="${H - 10}" text-anchor="middle" fill="${t.fg}">Flow Q [L/s]</text>`);
  parts.push(`<text transform="translate(16 ${m.t + ph / 2}) rotate(-90)" text-anchor="middle" fill="${t.fg}">Head H [m]</text>`);
  const lx = m.l + 12;
  parts.push(`<line x1="${lx}" y1="${m.t + 14}" x2="${lx + 24}" y2="${m.t + 14}" stroke="${t.pump}" stroke-width="2.5"/><text x="${lx + 30}" y="${m.t + 18}" fill="${t.fg}">Pump curve</text>`);
  parts.push(`<line x1="${lx}" y1="${m.t + 34}" x2="${lx + 24}" y2="${m.t + 34}" stroke="${t.system}" stroke-width="2.5"/><text x="${lx + 30}" y="${m.t + 38}" fill="${t.fg}">System curve</text>`);
  parts.push('</svg>');
  return parts.join('');
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
