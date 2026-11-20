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
  status: 'open' | 'active' | 'closed' | 'check-closed';
  /** Regulation mode, if the valve is a PRV, PSV or FCV. */
  mode?: 'prv' | 'psv' | 'fcv';
  /** Effective K at the operating point: h * 2g / v^2 (differs from equivalentK when a regulator is active). */
  effectiveK: number;
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


export interface BuildMods {
  /** Edge ids to leave out (closed valves, valves replaced by boundary conditions). */
  removed?: ReadonlySet<string>;
  /** Junctions held at a fixed head [m] (the controlled node of an active PRV / PSV). */
  fixedHeads?: ReadonlyMap<string, number>;
  /** Extra withdrawal at nodes [m^3/s]; negative = injection. */
  extraDemand?: ReadonlyMap<string, number>;
}

/** Validate topology and build the generic network. Closed valves are removed. */
export function buildNetwork(m: SystemModel, mods: BuildMods = {}): Network {
  const ids = new Set<string>();
  for (const n of m.nodes) {
    if (!n.id.trim()) throw new NetworkError('A node has an empty name.');
    if (ids.has(n.id)) throw new NetworkError(`Duplicate node name "${n.id}".`);
    ids.add(n.id);
  }
  const eids = new Set<string>();
  for (const e of m.edges) {
    if (!e.id.trim()) throw new NetworkError('A pipe, valve or pump has an empty name.');
    if (eids.has(e.id)) throw new NetworkError(`Duplicate pipe/valve/pump name "${e.id}".`);
    eids.add(e.id);
    if (!ids.has(e.from) || !ids.has(e.to)) throw new NetworkError(`"${e.id}" is connected to a missing node.`);
    if (e.from === e.to) throw new NetworkError(`"${e.id}" connects a node to itself.`);
  }
  if (!m.nodes.some((n) => n.kind === 'tank')) throw new NetworkError('Add at least one tank (a fixed-head boundary).');
  const z = new Map(m.nodes.map((n) => [n.id, n.elevationM]));
  const removed = mods.removed ?? new Set<string>();
  return {
    nodes: m.nodes.map((n) => {
      if (n.kind === 'tank') return { id: n.id, fixedHeadM: tankHead(n, m.fluid) };
      const fixed = mods.fixedHeads?.get(n.id);
      if (fixed !== undefined) return { id: n.id, fixedHeadM: fixed };
      return { id: n.id, demandM3s: n.demandM3s + (mods.extraDemand?.get(n.id) ?? 0) };
    }),
    edges: m.edges
      .filter((e) => !removed.has(e.id) && !(e.kind === 'valve' && !e.spec.open))
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

type RegStatus = 'open' | 'active' | 'closed';

interface Solved {
  sol: ReturnType<typeof solveNetwork>;
  /** Flow through every active regulator [m^3/s]. */
  activeQ: Map<string, number>;
}

const TOL_H = 1e-6; // m

/**
 * Solve the network with the regulators in the given states.
 *  - open: the valve is an ordinary resistance (fully open)
 *  - closed: removed
 *  - active PRV: downstream node held at the set head; the flow through it is found by fixed-point iteration
 *  - active PSV: upstream node held at the set head; likewise
 *  - active FCV: passes exactly the set flow (a withdrawal at `from` and an injection at `to`)
 */
function solveStates(m: SystemModel, opts: SystemOptions, regs: SysValve[], status: Map<string, RegStatus>, heads: Map<string, number>, guess: Map<string, number>): Solved {
  const removed = new Set<string>();
  const fixedHeads = new Map<string, number>();
  const base = new Map<string, number>(); // nodes -> base demand, for the continuity bookkeeping
  for (const n of m.nodes) base.set(n.id, n.kind === 'junction' ? n.demandM3s : 0);
  const active: SysValve[] = [];
  for (const v of regs) {
    const s = status.get(v.id);
    if (s === 'closed') removed.add(v.id);
    if (s === 'active') {
      removed.add(v.id);
      active.push(v);
      const c = v.spec.control as NonNullable<ValveSpec['control']>;
      if (c.type === 'prv') fixedHeads.set(v.to, heads.get(v.id) as number);
      if (c.type === 'psv') fixedHeads.set(v.from, heads.get(v.id) as number);
    }
  }
  const D = new Map<string, number>();
  for (const v of active) {
    const c = v.spec.control as NonNullable<ValveSpec['control']>;
    D.set(v.id, c.type === 'fcv' ? c.flowM3s : (guess.get(v.id) ?? 0));
  }
  const needsIteration = active.some((v) => v.spec.control?.type !== 'fcv');
  let sol: Solved['sol'] | undefined;
  for (let k = 0; k < 200; k++) {
    const extra = new Map<string, number>();
    const add = (id: string, q: number) => extra.set(id, (extra.get(id) ?? 0) + q);
    for (const v of active) {
      const q = D.get(v.id) as number;
      add(v.from, q); // withdrawn from the upstream node
      add(v.to, -q); // injected at the downstream node
    }
    // A node held at fixed head ignores its own demand, so the flow the valve must pass comes from continuity there.
    const net = buildNetwork(m, { removed, fixedHeads, extraDemand: extra });
    sol = solveNetwork(net, opts);
    if (!needsIteration) break;
    let err = 0;
    for (const v of active) {
      const c = v.spec.control as NonNullable<ValveSpec['control']>;
      if (c.type === 'fcv') continue;
      const held = c.type === 'prv' ? v.to : v.from;
      let outflow = 0;
      for (const e of net.edges) {
        const q = sol.flows[e.id];
        if (e.from === held) outflow += q;
        if (e.to === held) outflow -= q;
      }
      const demandHeld = (base.get(held) ?? 0) + ((extra.get(held) ?? 0) - (c.type === 'prv' ? -(D.get(v.id) as number) : (D.get(v.id) as number)));
      // PRV: held node `to` receives Q_v from the valve:  Q_v = outflow + demand (net draw of the rest of the network)
      // PSV: held node `from` sends Q_v into the valve:   Q_v = -(outflow + demand)
      const draw = outflow + demandHeld;
      const qNew = c.type === 'prv' ? draw : -draw;
      const cur = D.get(v.id) as number;
      err = Math.max(err, Math.abs(qNew - cur));
      D.set(v.id, cur + 0.8 * (qNew - cur));
    }
    if (err < 1e-11) break;
  }
  return { sol: sol as Solved['sol'], activeQ: D };
}

export function solveSystem(m: SystemModel, opts: SystemOptions = {}): SystemResult {
  const margin = opts.npshMarginM ?? 0.5;
  const rho = m.fluid.density;
  buildNetwork(m); // validates the topology up front
  const zNode = new Map(m.nodes.map((n) => [n.id, n.elevationM]));
  const isTank = new Set(m.nodes.filter((n) => n.kind === 'tank').map((n) => n.id));
  const regs = m.edges.filter((e): e is SysValve => e.kind === 'valve' && e.spec.open && e.spec.control !== undefined);
  const setHead = (v: SysValve): number => {
    const c = v.spec.control as NonNullable<ValveSpec['control']>;
    if (c.type === 'fcv') return NaN;
    const node = c.type === 'prv' ? v.to : v.from;
    return (zNode.get(node) as number) + c.setpointPa / (rho * G);
  };
  const openLoss = (v: SysValve, q: number) => createValveElement({ ...v.spec, checkValve: false, control: undefined }).headDrop(q);

  const status = new Map<string, RegStatus>(regs.map((v) => [v.id, 'open']));
  const heads = new Map<string, number>(regs.map((v) => [v.id, setHead(v)]));
  const warnings: string[] = [];
  let guess = new Map<string, number>();
  let solved: Solved | undefined;
  const closedHint = () => m.edges.filter((e) => e.kind === 'valve' && (!e.spec.open || status.get(e.id) === 'closed')).map((e) => e.id);
  const solveOnce = () => {
    try {
      return solveStates(m, opts, regs, status, heads, guess);
    } catch (err) {
      const closed = closedHint();
      if (err instanceof NetworkError && closed.length) throw new NetworkError(`${err.message} (closed valves: ${closed.join(', ')}).`);
      throw err;
    }
  };

  let settled = regs.length === 0;
  for (let outer = 0; outer < 40; outer++) {
    solved = solveOnce();
    guess = solved.activeQ;
    if (regs.length === 0) break;
    const h = (id: string) => solved!.sol.heads[id];
    let changed = false;
    for (const v of regs) {
      const c = v.spec.control as NonNullable<ValveSpec['control']>;
      const st = status.get(v.id) as RegStatus;
      const set = setHead(v);
      const q = st === 'active' ? (solved.activeQ.get(v.id) as number) : (solved.sol.flows[v.id] ?? 0);
      const hFrom = h(v.from);
      const hTo = h(v.to);
      let next: RegStatus = st;
      const controlled = c.type === 'prv' ? v.to : c.type === 'psv' ? v.from : '';
      const cannot = c.type !== 'fcv' && isTank.has(controlled); // a tank's head cannot be regulated
      if (st === 'open') {
        if (c.type !== 'fcv' && q < -1e-9) next = 'closed';
        else if (cannot) next = 'open';
        else if (c.type === 'prv' && hTo > set + TOL_H) next = 'active';
        else if (c.type === 'psv' && hFrom < set - TOL_H) next = 'active';
        else if (c.type === 'fcv' && q > c.flowM3s * (1 + 1e-9) + 1e-12) next = 'active';
      } else if (st === 'active') {
        if (c.type !== 'fcv' && q < -1e-9) next = 'closed';
        else if (c.type === 'prv' && hFrom - set < openLoss(v, Math.max(q, 0)) - TOL_H) next = 'open';
        else if (c.type === 'psv' && set - hTo < openLoss(v, Math.max(q, 0)) - TOL_H) next = 'open';
        else if (c.type === 'fcv' && hFrom - hTo < openLoss(v, c.flowM3s) - TOL_H) next = 'open';
      } else if (hFrom - hTo > TOL_H && !(c.type === 'prv' && hTo >= set - TOL_H)) {
        // Closed (reverse flow was blocked): try again once forward flow is possible. A PRV additionally stays
        // closed while the downstream head is above its set head (e.g. an unregulated bypass overfeeds that side).
        next = 'open';
      }
      if (next !== st) {
        status.set(v.id, next);
        changed = true;
      }
    }
    if (!changed) {
      settled = true;
      break;
    }
  }
  if (!settled) warnings.push('Regulating valve states did not settle; results may be approximate.');
  const { sol, activeQ } = solved as Solved;
  if (!sol.converged) warnings.push(`Solver did not converge: ${sol.message}`);
  const flowOf = (id: string): number => sol.flows[id] ?? activeQ.get(id) ?? 0;

  const nodeById = new Map(m.nodes.map((n) => [n.id, n]));
  const netOut = new Map<string, number>(m.nodes.map((n) => [n.id, n.kind === 'junction' ? n.demandM3s : 0]));
  for (const e of m.edges) {
    const q = flowOf(e.id);
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
    const q = flowOf(e.id);
    const h1 = hOf.get(e.from) as number;
    const h2 = hOf.get(e.to) as number;
    if (e.kind === 'valve') {
      const w: string[] = [];
      const regStatus = status.get(e.id);
      let st: SystemValveResult['status'] = 'open';
      if (!e.spec.open || regStatus === 'closed') st = 'closed';
      else if (regStatus === 'active') st = 'active';
      else if (e.spec.checkValve && h2 - h1 > 1e-6 && q < 1e-6) st = 'check-closed';
      const c = e.spec.control;
      if (regStatus === 'closed') w.push(`Valve "${e.id}": regulating valve is closed (reverse flow is blocked).`);
      if (st === 'check-closed') w.push(`Valve "${e.id}": check valve is closed (downstream head exceeds upstream by ${(h2 - h1).toFixed(2)} m); no forward flow.`);
      if (c && c.type !== 'fcv' && isTank.has(c.type === 'prv' ? e.to : e.from)) w.push(`Valve "${e.id}": cannot regulate the head of a tank; it acts as an open valve.`);
      const v = Math.abs(q) / pipeArea(e.spec.diameterM);
      valves.push({
        id: e.id,
        from: e.from,
        to: e.to,
        flowM3s: q,
        headDropM: h1 - h2,
        pressureDropPa: (h1 - h2) * rho * G,
        velocity: v,
        equivalentK: valveEquivalentK(e.spec),
        effectiveK: v > 1e-9 ? ((h1 - h2) * 2 * G) / (v * v) : valveEquivalentK(e.spec),
        status: st,
        mode: c?.type,
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
