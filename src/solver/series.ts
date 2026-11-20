import { G, P_ATM } from './constants';
import type { Fluid } from './fluid';
import type { Network, NetworkEdge, NetworkNode } from './network';
import { createPipeElement, pipeArea, pipeFlowState, type PipeFlowState, type PipeSpec } from './pipe';
import {
  createPumpElement,
  hydraulicPower,
  pumpEfficiency,
  pumpHead,
  pumpNpshr,
  pumpShutoffHead,
  shaftPower,
  type PumpModel,
} from './pump';
import { brent } from './rootfinding';

/**
 * Single-line (series chain) system: source tank -> [pipes and pumps in order] -> destination tank.
 * Solved by a robust 1-D root find of H_pump(Q) = H_system(Q); it can also be converted to a general
 * Network (`toNetwork`) so the node-based solver can be cross-checked against it.
 */

export interface Tank {
  /** Elevation of the tank bottom / outlet [m]. */
  elevationM: number;
  /** Liquid depth above the bottom [m]. Free surface elevation = elevationM + liquidLevelM. */
  liquidLevelM: number;
  /** Absolute pressure above the liquid [Pa]. Default atmospheric. */
  surfacePressurePa: number;
}

export interface SeriesPipe {
  kind: 'pipe';
  id: string;
  spec: PipeSpec;
}

export interface SeriesPump {
  kind: 'pump';
  id: string;
  model: PumpModel;
  /** Speed ratio N2/N1 (1 = rated). */
  speedRatio: number;
  /** Suction pipe diameter for the velocity head in NPSHa [m]; defaults to the upstream pipe. */
  suctionDiameterM?: number;
}

export type SeriesElement = SeriesPipe | SeriesPump;

export interface SeriesSystem {
  fluid: Fluid;
  source: Tank;
  destination: Tank;
  elements: readonly SeriesElement[];
}

export interface AnalysisOptions {
  /** Required NPSHa margin above NPSHr [m]. Default 0.5. */
  npshMarginM?: number;
}

/** Free-surface total head of a tank, h = z_surface + (p - p_atm)/(rho g) [m] (gauge basis). */
export function tankHead(tank: Tank, fluid: Fluid): number {
  return tank.elevationM + tank.liquidLevelM + (tank.surfacePressurePa - P_ATM) / (fluid.density * G);
}

/** H_static = h_dest - h_source [m]. */
export function staticHead(sys: SeriesSystem): number {
  return tankHead(sys.destination, sys.fluid) - tankHead(sys.source, sys.fluid);
}

/** Sum of pipe friction + minor losses at flow Q [m]. */
export function pipeLossTotal(sys: SeriesSystem, flowM3s: number): number {
  let s = 0;
  for (const el of sys.elements) if (el.kind === 'pipe') s += pipeFlowState(el.spec, sys.fluid, flowM3s).totalHeadLoss;
  return s;
}

/** H_sys(Q) = H_static + sum(h_f + h_m) [m]. */
export function systemHead(sys: SeriesSystem, flowM3s: number): number {
  return staticHead(sys) + pipeLossTotal(sys, flowM3s);
}

/** Total head added by all pumps in the chain at flow Q [m]. */
export function pumpTotalHead(sys: SeriesSystem, flowM3s: number): number {
  let s = 0;
  for (const el of sys.elements) if (el.kind === 'pump') s += pumpHead(el.model, flowM3s, el.speedRatio);
  return s;
}

/** Total pump shutoff head [m]. */
function shutoffTotal(sys: SeriesSystem): number {
  let s = 0;
  for (const el of sys.elements) if (el.kind === 'pump') s += pumpShutoffHead(el.model, el.speedRatio);
  return s;
}

export type OperatingPointStatus = 'ok' | 'no-flow' | 'no-intersection';

export interface OperatingPoint {
  status: OperatingPointStatus;
  /** Flow [m^3/s]; 0 when there is no flow. */
  flowM3s: number;
  /** Total pump head = system head at the operating point [m]. */
  headM: number;
  message: string;
  warnings: string[];
}

/** Largest flow in any pump's head data (scale for the search), or a fallback. */
function searchScale(sys: SeriesSystem): number {
  let m = 0;
  for (const el of sys.elements) if (el.kind === 'pump') m = Math.max(m, el.model.headDataRange.maxFlowM3s * el.speedRatio);
  return m > 0 ? m : 1e-2;
}

/**
 * Find the operating point: smallest Q >= 0 with H_pump(Q) = H_sys(Q).
 * Scans for the first sign change of g(Q) = H_pump - H_sys, then refines with Brent's method.
 */
export function findOperatingPoint(sys: SeriesSystem): OperatingPoint {
  const g = (q: number) => pumpTotalHead(sys, q) - systemHead(sys, q);
  const warnings: string[] = [];
  const g0 = g(0);
  if (g0 <= 0) {
    const hasPump = sys.elements.some((e) => e.kind === 'pump');
    const msg = hasPump
      ? `No flow: pump shutoff head (${shutoffTotal(sys).toFixed(2)} m) does not exceed the static head (${staticHead(sys).toFixed(2)} m).`
      : `No flow: no driving head (static head ${staticHead(sys).toFixed(2)} m, no pump).`;
    return { status: g0 === 0 ? 'no-flow' : 'no-intersection', flowM3s: 0, headM: shutoffTotal(sys), message: msg, warnings };
  }

  const N = 400;
  let qHi = 2 * searchScale(sys);
  for (let expand = 0; expand < 14; expand++) {
    let prevQ = 0;
    let prevG = g0;
    let bracket: [number, number] | undefined;
    let crossings = 0;
    for (let i = 1; i <= N; i++) {
      const q = (qHi * i) / N;
      const gq = g(q);
      if (prevG > 0 && gq <= 0) {
        crossings++;
        bracket ??= [prevQ, q];
      } else if (prevG <= 0 && gq > 0) {
        crossings++;
      }
      prevQ = q;
      prevG = gq;
    }
    if (bracket) {
      const q = brent(g, bracket[0], bracket[1]);
      if (crossings > 1) warnings.push('Pump and system curves intersect more than once; the lowest-flow point is reported.');
      const range = sys.elements.filter((e): e is SeriesPump => e.kind === 'pump');
      for (const p of range) {
        const lim = p.model.headDataRange.maxFlowM3s * p.speedRatio;
        if (q > lim * 1.0000001) warnings.push(`Operating flow exceeds the data range of pump "${p.id}" (curve is extrapolated).`);
      }
      return { status: 'ok', flowM3s: q, headM: pumpTotalHead(sys, q), message: 'Operating point found.', warnings };
    }
    qHi *= 2;
  }
  return {
    status: 'no-intersection',
    flowM3s: 0,
    headM: shutoffTotal(sys),
    message: 'No intersection found: the pump curve stays above the system curve over the searched flow range.',
    warnings,
  };
}

export interface PipeResult {
  id: string;
  flow: PipeFlowState;
}

export interface PumpResult {
  id: string;
  flowM3s: number;
  /** Head added by this pump [m]. */
  headM: number;
  speedRatio: number;
  efficiency?: number;
  hydraulicPowerW: number;
  shaftPowerW?: number;
  /** NPSH available at the suction [m]. */
  npshaM: number;
  npshrM?: number;
  /** NPSHa - NPSHr [m]. */
  npshMarginM?: number;
  /** Suction total pressure terms, for the report. */
  suctionHeadM: number;
  suctionElevationM: number;
  suctionVelocity: number;
  warnings: string[];
}

export interface NodeState {
  label: string;
  /** Hydraulic grade h = z + p_gauge/(rho g) [m]. */
  headM: number;
  elevationM: number;
}

export interface SeriesAnalysis {
  flowM3s: number;
  pipes: PipeResult[];
  pumps: PumpResult[];
  /** Hydraulic grade along the chain, one entry per node between elements. */
  nodes: NodeState[];
  totalFrictionLossM: number;
  totalMinorLossM: number;
  warnings: string[];
}

/** Evaluate every element at a given flow, walking the chain from the source tank. */
export function analyzeSeries(sys: SeriesSystem, flowM3s: number, opts: AnalysisOptions = {}): SeriesAnalysis {
  const margin = opts.npshMarginM ?? 0.5;
  const rho = sys.fluid.density;
  let h = tankHead(sys.source, sys.fluid);
  let z = sys.source.elevationM;
  let lastPipeDiameter: number | undefined;
  let lastPipeVelocity = 0;
  const nodes: NodeState[] = [{ label: 'source', headM: h, elevationM: z }];
  const pipes: PipeResult[] = [];
  const pumps: PumpResult[] = [];
  const warnings: string[] = [];
  let hf = 0;
  let hm = 0;

  for (const el of sys.elements) {
    if (el.kind === 'pipe') {
      const st = pipeFlowState(el.spec, sys.fluid, flowM3s);
      pipes.push({ id: el.id, flow: st });
      if (st.regime === 'transitional') warnings.push(`Pipe "${el.id}" is in the transitional flow regime (Re = ${st.reynolds.toFixed(0)}); friction factor is uncertain.`);
      h -= st.totalHeadLoss;
      z += el.spec.elevationChangeM;
      hf += st.frictionHeadLoss;
      hm += st.minorHeadLoss;
      lastPipeDiameter = el.spec.innerDiameterM;
      lastPipeVelocity = st.velocity;
      nodes.push({ label: `after ${el.id}`, headM: h, elevationM: z });
    } else {
      const dia = el.suctionDiameterM ?? lastPipeDiameter;
      const vs = el.suctionDiameterM ? flowM3s / pipeArea(el.suctionDiameterM) : dia ? lastPipeVelocity : 0;
      // NPSHa = (p_s - p_v)/(rho g) + v_s^2/2g,  with p_s/(rho g) = (h_s - z_s) + p_atm/(rho g)
      const npsha = (h - z) + (P_ATM - sys.fluid.vaporPressure) / (rho * G) + (vs * vs) / (2 * G);
      const head = pumpHead(el.model, flowM3s, el.speedRatio);
      const eta = pumpEfficiency(el.model, flowM3s, el.speedRatio);
      const npshr = pumpNpshr(el.model, flowM3s, el.speedRatio);
      const pw: string[] = [];
      if (npshr !== undefined && npsha < npshr + margin) {
        pw.push(`NPSHa (${npsha.toFixed(2)} m) is below NPSHr (${npshr.toFixed(2)} m) + ${margin} m margin: risk of cavitation.`);
      }
      if (npsha <= 0) pw.push('NPSHa is not positive: the liquid would flash at the suction.');
      if (flowM3s > el.model.headDataRange.maxFlowM3s * el.speedRatio * 1.0000001) pw.push('Flow is beyond the pump head data (extrapolated).');
      pumps.push({
        id: el.id,
        flowM3s,
        headM: head,
        speedRatio: el.speedRatio,
        efficiency: eta,
        hydraulicPowerW: hydraulicPower(rho, flowM3s, head),
        shaftPowerW: eta !== undefined ? shaftPower(rho, flowM3s, head, eta) : undefined,
        npshaM: npsha,
        npshrM: npshr,
        npshMarginM: npshr !== undefined ? npsha - npshr : undefined,
        suctionHeadM: h,
        suctionElevationM: z,
        suctionVelocity: vs,
        warnings: pw,
      });
      warnings.push(...pw.map((w) => `Pump "${el.id}": ${w}`));
      h += head;
      nodes.push({ label: `after ${el.id}`, headM: h, elevationM: z });
    }
  }
  return { flowM3s, pipes, pumps, nodes, totalFrictionLossM: hf, totalMinorLossM: hm, warnings };
}

export interface CurvePoint {
  flowM3s: number;
  pumpHeadM: number;
  systemHeadM: number;
}

/** Sample the pump and system curves on [0, qMax] for plotting. */
export function sampleCurves(sys: SeriesSystem, qMaxM3s: number, n = 60): CurvePoint[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const q = (qMaxM3s * i) / n;
    return { flowM3s: q, pumpHeadM: pumpTotalHead(sys, q), systemHeadM: systemHead(sys, q) };
  });
}

/** Convert the chain to a general network so the node-based solver can solve the same system. */
export function toNetwork(sys: SeriesSystem): Network {
  const nodes: NetworkNode[] = [{ id: 'source', fixedHeadM: tankHead(sys.source, sys.fluid) }];
  const edges: NetworkEdge[] = [];
  let prev = 'source';
  sys.elements.forEach((el, i) => {
    const last = i === sys.elements.length - 1;
    const next = last ? 'destination' : `n${i + 1}`;
    if (last) nodes.push({ id: next, fixedHeadM: tankHead(sys.destination, sys.fluid) });
    else nodes.push({ id: next });
    const element = el.kind === 'pipe' ? createPipeElement(el.spec, sys.fluid) : createPumpElement(el.model, el.speedRatio);
    edges.push({ id: el.id, from: prev, to: next, element });
    prev = next;
  });
  return { nodes, edges };
}
