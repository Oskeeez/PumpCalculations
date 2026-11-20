import { G, P_ATM } from './constants';
import type { Fluid } from './fluid';
import { NetworkError, solveNetwork, type Network, type NetworkSolveOptions } from './network';
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
import { tankHead } from './series';
import { createValveElement, valveEquivalentK, type ValveSpec } from './valve';

/**
 * General pipe-network model (SI): tanks and junctions joined by pipes and pumps in any topology
 * (branches, loops). Node elevations define pipe elevation change; heads are hydraulic grade
 * h = z + p_gauge/(rho g).
 */

export interface SysTank {
  kind: 'tank';
  id: string;
  /** Bottom / outlet elevation [m]. */
  elevationM: number;
  liquidLevelM: number;
  /** Absolute pressure above the liquid [Pa]. */
  surfacePressurePa: number;
}

export interface SysJunction {
  kind: 'junction';
  id: string;
  elevationM: number;
  /** External withdrawal [m^3/s]; negative = injection. */
  demandM3s: number;
}

export type SysNode = SysTank | SysJunction;

export interface SysPipe {
  kind: 'pipe';
  id: string;
  from: string;
  to: string;
  /** elevationChangeM is ignored: it is taken from the node elevations. */
  spec: PipeSpec;
}

export interface SysPump {
  kind: 'pump';
  id: string;
  from: string;
  to: string;
  model: PumpModel;
  speedRatio: number;
}

export interface SysValve {
  kind: 'valve';
  id: string;
  from: string;
  to: string;
  spec: ValveSpec;
}

export type SysEdge = SysPipe | SysPump | SysValve;

export interface SystemModel {
  fluid: Fluid;
  nodes: readonly SysNode[];
  edges: readonly SysEdge[];
}

export interface SystemOptions extends NetworkSolveOptions {
  /** Required NPSHa margin above NPSHr [m]. Default 0.5. */
  npshMarginM?: number;
}

export interface SystemNodeResult {
  id: string;
  kind: SysNode['kind'];
  elevationM: number;
  /** Hydraulic grade [m]. */
  headM: number;
  gaugePressurePa: number;
  absolutePressurePa: number;
  /** Net flow leaving the network at this node [m^3/s]: junction demand, or for a tank the net inflow it absorbs (negative when it supplies). */
  netOutflowM3s: number;
  warnings: string[];
}

export interface SystemPipeResult {
  id: string;
  from: string;
  to: string;
  /** Signed flow [m^3/s], positive from -> to. */
  flowM3s: number;
  flow: PipeFlowState;
  /** h_from - h_to [m]. */
  headDropM: number;
  warnings: string[];
}

export interface SystemPumpResult {
  id: string;
  from: string;
  to: string;
  flowM3s: number;
  /** h_to - h_from [m]. */
  headM: number;
  speedRatio: number;
  efficiency?: number;
  hydraulicPowerW: number;
  shaftPowerW?: number;
  suctionHeadM: number;
  suctionElevationM: number;
  suctionVelocity: number;
  npshaM: number;
  npshrM?: number;
  npshMarginM?: number;
  warnings: string[];
}

export interface SystemValveResult {
  id: string;
  from: string;
  to: string;
  flowM3s: number;
  /** h_from - h_to [m]. */
  headDropM: number;
  /** Pressure drop [Pa], rho g h. */
  pressureDropPa: number;
  velocity: number;
  /** Equivalent loss coefficient K referenced to the valve diameter. */
  equivalentK: number;
  status: 'open' | 'closed' | 'check-closed';
  warnings: string[];
}

export interface SystemResult {
  converged: boolean;
  iterations: number;
  residualM3s: number;
  message: string;
  nodes: SystemNodeResult[];
  pipes: SystemPipeResult[];
  pumps: SystemPumpResult[];
  valves: SystemValveResult[];
  warnings: string[];
}

/** Validate topology and build the generic network + element lookup. */
export function buildNetwork(m: SystemModel): Network {
  const ids = new Set<string>();
  for (const n of m.nodes) {
    if (!n.id.trim()) throw new NetworkError('A node has an empty name.');
    if (ids.has(n.id)) throw new NetworkError(`Duplicate node name "${n.id}".`);
    ids.add(n.id);
  }
  const eids = new Set<string>();
  for (const e of m.edges) {
    if (!e.id.trim()) throw new NetworkError('A pipe or pump has an empty name.');
    if (eids.has(e.id)) throw new NetworkError(`Duplicate pipe/pump name "${e.id}".`);
    eids.add(e.id);
    if (!ids.has(e.from) || !ids.has(e.to)) throw new NetworkError(`"${e.id}" is connected to a missing node.`);
    if (e.from === e.to) throw new NetworkError(`"${e.id}" connects a node to itself.`);
  }
  if (!m.nodes.some((n) => n.kind === 'tank')) throw new NetworkError('Add at least one tank (a fixed-head boundary).');
  const z = new Map(m.nodes.map((n) => [n.id, n.elevationM]));
  return {
    nodes: m.nodes.map((n) =>
      n.kind === 'tank'
        ? { id: n.id, fixedHeadM: tankHead(n, m.fluid) }
        : { id: n.id, demandM3s: n.demandM3s },
    ),
    // Closed valves carry no flow and are removed from the network.
    edges: m.edges
      .filter((e) => !(e.kind === 'valve' && !e.spec.open))
      .map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        element:
          e.kind === 'pipe'
            ? createPipeElement({ ...e.spec, elevationChangeM: (z.get(e.to) as number) - (z.get(e.from) as number) }, m.fluid)
            : e.kind === 'valve'
              ? createValveElement(e.spec)
              : createPumpElement(e.model, e.speedRatio),
      })),
  };
}

export function solveSystem(m: SystemModel, opts: SystemOptions = {}): SystemResult {
  const margin = opts.npshMarginM ?? 0.5;
  const rho = m.fluid.density;
  const net = buildNetwork(m);
  let sol;
  try {
    sol = solveNetwork(net, opts);
  } catch (err) {
    const closed = m.edges.filter((e) => e.kind === 'valve' && !e.spec.open).map((e) => e.id);
    if (err instanceof NetworkError && closed.length) throw new NetworkError(`${err.message} (closed valves: ${closed.join(', ')}).`);
    throw err;
  }
  const warnings: string[] = [];
  if (!sol.converged) warnings.push(`Solver did not converge: ${sol.message}`);

  const nodeById = new Map(m.nodes.map((n) => [n.id, n]));
  const netOut = new Map<string, number>(m.nodes.map((n) => [n.id, n.kind === 'junction' ? n.demandM3s : 0]));
  for (const e of m.edges) {
    const q = sol.flows[e.id] ?? 0;
    if (nodeById.get(e.from)?.kind === 'tank') netOut.set(e.from, (netOut.get(e.from) ?? 0) - q);
    if (nodeById.get(e.to)?.kind === 'tank') netOut.set(e.to, (netOut.get(e.to) ?? 0) + q);
  }

  const nodes: SystemNodeResult[] = m.nodes.map((n) => {
    const h = sol.heads[n.id];
    const gauge = (h - n.elevationM) * rho * G;
    const abs = gauge + P_ATM;
    const w: string[] = [];
    if (n.kind === 'junction') {
      if (abs < m.fluid.vaporPressure) w.push(`Node "${n.id}": pressure is below the vapour pressure; the liquid would flash or cavitate.`);
      else if (gauge < 0) w.push(`Node "${n.id}": sub-atmospheric pressure (${(gauge / 1000).toFixed(1)} kPa gauge).`);
    }
    return { id: n.id, kind: n.kind, elevationM: n.elevationM, headM: h, gaugePressurePa: gauge, absolutePressurePa: abs, netOutflowM3s: netOut.get(n.id) ?? 0, warnings: w };
  });
  const zOf = new Map(nodes.map((n) => [n.id, n.elevationM]));
  const hOf = new Map(nodes.map((n) => [n.id, n.headM]));

  const pipes: SystemPipeResult[] = [];
  const pumps: SystemPumpResult[] = [];
  const valves: SystemValveResult[] = [];
  for (const e of m.edges) {
    const q = sol.flows[e.id] ?? 0;
    const h1 = hOf.get(e.from) as number;
    const h2 = hOf.get(e.to) as number;
    if (e.kind === 'valve') {
      const w: string[] = [];
      let status: SystemValveResult['status'] = 'open';
      if (!e.spec.open) status = 'closed';
      else if (e.spec.checkValve && h2 - h1 > 1e-6 && q < 1e-6) {
        status = 'check-closed';
        w.push(`Valve "${e.id}": check valve is closed (downstream head exceeds upstream by ${(h2 - h1).toFixed(2)} m); no forward flow.`);
      }
      valves.push({
        id: e.id,
        from: e.from,
        to: e.to,
        flowM3s: q,
        headDropM: h1 - h2,
        pressureDropPa: (h1 - h2) * rho * G,
        velocity: Math.abs(q) / pipeArea(e.spec.diameterM),
        equivalentK: valveEquivalentK(e.spec),
        status,
        warnings: w,
      });
      continue;
    }
    if (e.kind === 'pipe') {
      const flow = pipeFlowState({ ...e.spec, elevationChangeM: 0 }, m.fluid, q);
      const w: string[] = [];
      if (flow.regime === 'transitional') w.push(`Pipe "${e.id}": transitional flow (Re = ${flow.reynolds.toFixed(0)}); friction factor is uncertain.`);
      pipes.push({ id: e.id, from: e.from, to: e.to, flowM3s: q, flow, headDropM: h1 - h2, warnings: w });
      continue;
    }
    // Pump. Suction velocity from the first pipe attached to the suction node.
    const attached = m.edges.find((x): x is SysPipe => x.kind === 'pipe' && (x.from === e.from || x.to === e.from));
    const vs = attached ? Math.abs(q) / pipeArea(attached.spec.innerDiameterM) : 0;
    const zs = zOf.get(e.from) as number;
    const npsha = h1 - zs + (P_ATM - m.fluid.vaporPressure) / (rho * G) + (vs * vs) / (2 * G);
    const head = h2 - h1;
    const forward = q > 1e-9;
    const eta = forward ? pumpEfficiency(e.model, q, e.speedRatio) : undefined;
    const npshr = forward ? pumpNpshr(e.model, q, e.speedRatio) : undefined;
    const w: string[] = [];
    if (!forward) {
      w.push(
        head > pumpShutoffHead(e.model, e.speedRatio)
          ? `Pump "${e.id}": no flow. The head across it (${head.toFixed(1)} m) exceeds its shutoff head, so the check valve is closed.`
          : `Pump "${e.id}": no forward flow.`,
      );
    } else {
      if (npshr !== undefined && npsha < npshr + margin) {
        w.push(`Pump "${e.id}": NPSHa (${npsha.toFixed(2)} m) is below NPSHr (${npshr.toFixed(2)} m) + ${margin} m margin: cavitation risk.`);
      }
      if (npsha <= 0) w.push(`Pump "${e.id}": NPSHa is not positive; the liquid would flash at the suction.`);
      if (q > e.model.headDataRange.maxFlowM3s * e.speedRatio * 1.0000001) w.push(`Pump "${e.id}": flow is beyond its head data (curve extrapolated).`);
    }
    pumps.push({
      id: e.id,
      from: e.from,
      to: e.to,
      flowM3s: q,
      headM: forward ? pumpHead(e.model, q, e.speedRatio) : head,
      speedRatio: e.speedRatio,
      efficiency: eta,
      hydraulicPowerW: forward ? hydraulicPower(rho, q, pumpHead(e.model, q, e.speedRatio)) : 0,
      shaftPowerW: forward && eta !== undefined ? shaftPower(rho, q, pumpHead(e.model, q, e.speedRatio), eta) : undefined,
      suctionHeadM: h1,
      suctionElevationM: zs,
      suctionVelocity: vs,
      npshaM: npsha,
      npshrM: npshr,
      npshMarginM: npshr !== undefined ? npsha - npshr : undefined,
      warnings: w,
    });
  }
  for (const r of [...nodes, ...pipes, ...pumps, ...valves]) warnings.push(...r.warnings);
  return { converged: sol.converged, iterations: sol.iterations, residualM3s: sol.residualM3s, message: sol.message, nodes, pipes, pumps, valves, warnings };
}
