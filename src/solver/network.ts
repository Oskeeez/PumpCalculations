import { MIN_HEAD_SLOPE } from './constants';
import type { HydraulicElement } from './element';
import { brent } from './rootfinding';

/**
 * General node-based Newton-Raphson network solver (single phase, steady state).
 *
 * Unknowns: heads h_i at free nodes. Residual (continuity):
 *   F_i = sum(Q_in) - sum(Q_out) - q_i = 0,   q_i = external demand (withdrawal) at node i.
 * Each edge flow is the inverse of its element curve:  headDrop(Q) = h_from - h_to.
 * Jacobian (symmetric, negative definite):  J = -L,  L_ii = sum g_e,  L_ij = -g_e,
 *   g_e = dQ/d(dh) = 1 / max(d headDrop/dQ, MIN_HEAD_SLOPE)     <- regularised
 * Newton step:  L dh = F.  A backtracking line search on ||F||^2 damps the step.
 */

export interface NetworkNode {
  id: string;
  /** If set, the node is a fixed-head boundary (tank / reservoir) [m]. */
  fixedHeadM?: number;
  /** External demand withdrawn at a free node [m^3/s] (default 0). */
  demandM3s?: number;
}

export interface NetworkEdge {
  id: string;
  from: string;
  to: string;
  element: HydraulicElement;
}

export interface Network {
  nodes: readonly NetworkNode[];
  edges: readonly NetworkEdge[];
}

export interface NetworkSolveOptions {
  /** Convergence tolerance on max |F_i| [m^3/s]. */
  flowTolM3s?: number;
  maxIterations?: number;
  /** Number of initial chord (linear-theory) iterations before switching to Newton. Default 8. */
  chordIterations?: number;
  /** Initial head guess for free nodes [m]; default is the mean fixed head. */
  initialHeadM?: number;
}

export interface NetworkSolution {
  converged: boolean;
  iterations: number;
  /** max |F_i| at the returned solution [m^3/s]. */
  residualM3s: number;
  heads: Record<string, number>;
  /** Edge flows [m^3/s], positive from -> to. */
  flows: Record<string, number>;
  message: string;
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Solve the sparse symmetric positive-definite system A x = b, with A given as row maps. */
export function solveSparseSpd(rows: Map<number, number>[], b: number[]): number[] {
  const n = rows.length;
  const diag0 = rows.map((r, i) => r.get(i) ?? 0);
  const rhs = [...b];
  for (let k = 0; k < n; k++) {
    const rowK = rows[k];
    const pivot = rowK.get(k) ?? 0;
    if (!(pivot > 1e-13 * diag0[k]) || !(pivot > 0)) {
      throw new NetworkError('Singular system: part of the network has no path to a fixed-head node');
    }
    // Symmetric structure: the columns j > k present in row k are exactly the rows needing update.
    for (const i of rowK.keys()) {
      if (i <= k) continue;
      const rowI = rows[i];
      const f = (rowI.get(k) ?? 0) / pivot;
      if (f === 0) continue;
      for (const [j, v] of rowK) {
        if (j < k) continue;
        rowI.set(j, (rowI.get(j) ?? 0) - f * v);
      }
      rowI.delete(k);
      rhs[i] -= f * rhs[k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = rhs[i];
    for (const [j, v] of rows[i]) if (j > i) s -= v * x[j];
    x[i] = s / (rows[i].get(i) as number);
  }
  return x;
}

/** Invert headDrop(Q) = dh for Q using a bracket expansion followed by Brent's method. */
export function flowForHeadDrop(element: HydraulicElement, dh: number, qGuess = 0): number {
  const r = (q: number) => element.headDrop(q) - dh;
  const s = Math.max(Math.abs(qGuess), 1e-6);
  let lo = -s;
  let hi = s;
  for (let i = 0; r(hi) < 0; i++) {
    hi *= 2;
    if (i > 80) throw new NetworkError('Could not bracket forward flow for an element (head drop never reached)');
  }
  for (let i = 0; r(lo) > 0; i++) {
    lo *= 2;
    if (i > 80) throw new NetworkError('Could not bracket reverse flow for an element');
  }
  return brent(r, lo, hi, 1e-18, 200);
}

interface Evaluation {
  flows: number[];
  /** Tangent conductance dQ/d(dh), regularised. */
  conductance: number[];
  /** Chord conductance Q/dh (linear-theory step), equals the tangent where undefined. */
  chord: number[];
  residual: number[]; // per free node
}

export function solveNetwork(net: Network, opts: NetworkSolveOptions = {}): NetworkSolution {
  const tol = opts.flowTolM3s ?? 1e-11;
  const maxIter = opts.maxIterations ?? 100;
  const picardIters = opts.chordIterations ?? 8;

  const ids = new Map<string, number>();
  net.nodes.forEach((n, i) => {
    if (ids.has(n.id)) throw new NetworkError(`Duplicate node id "${n.id}"`);
    ids.set(n.id, i);
  });
  const fixedIdx = net.nodes.map((n, i) => (n.fixedHeadM !== undefined ? i : -1)).filter((i) => i >= 0);
  if (fixedIdx.length === 0) throw new NetworkError('Network needs at least one fixed-head node');

  const edgeEnds = net.edges.map((e) => {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (a === undefined || b === undefined) throw new NetworkError(`Edge "${e.id}" references an unknown node`);
    return [a, b] as const;
  });

  // Connectivity: every free node must reach a fixed node.
  const adj: number[][] = net.nodes.map(() => []);
  edgeEnds.forEach(([a, b]) => {
    adj[a].push(b);
    adj[b].push(a);
  });
  const seen = new Set<number>(fixedIdx);
  const stack = [...fixedIdx];
  while (stack.length) {
    for (const nb of adj[stack.pop() as number]) if (!seen.has(nb)) (seen.add(nb), stack.push(nb));
  }
  const orphan = net.nodes.findIndex((_, i) => !seen.has(i));
  if (orphan >= 0) throw new NetworkError(`Node "${net.nodes[orphan].id}" is not connected to a fixed-head node`);

  // Free-node numbering.
  const freeOf = new Array<number>(net.nodes.length).fill(-1);
  let nFree = 0;
  net.nodes.forEach((n, i) => {
    if (n.fixedHeadM === undefined) freeOf[i] = nFree++;
  });

  const meanFixed = fixedIdx.reduce((s, i) => s + (net.nodes[i].fixedHeadM as number), 0) / fixedIdx.length;
  const h = net.nodes.map((n) => n.fixedHeadM ?? opts.initialHeadM ?? meanFixed);
  const qPrev = new Array<number>(net.edges.length).fill(0);

  const evaluate = (head: number[]): Evaluation => {
    const flows = net.edges.map((e, k) => {
      const [a, b] = edgeEnds[k];
      const q = flowForHeadDrop(e.element, head[a] - head[b], qPrev[k]);
      return q;
    });
    const conductance = net.edges.map((e, k) => 1 / Math.max(e.element.dHeadDrop(flows[k]), MIN_HEAD_SLOPE));
    // Chord (secant-through-origin) conductance Q/dh for pipes; tangent elsewhere or when dh ~ 0.
    const chord = net.edges.map((e, k) => {
      const [a, b] = edgeEnds[k];
      const dh = head[a] - head[b];
      return e.element.kind === 'pipe' && Math.abs(dh) > 1e-9 && flows[k] * dh > 0 ? Math.max(flows[k] / dh, conductance[k]) : conductance[k];
    });
    const residual = new Array<number>(nFree).fill(0);
    net.nodes.forEach((n, i) => {
      if (freeOf[i] >= 0) residual[freeOf[i]] -= n.demandM3s ?? 0;
    });
    edgeEnds.forEach(([a, b], k) => {
      if (freeOf[a] >= 0) residual[freeOf[a]] -= flows[k];
      if (freeOf[b] >= 0) residual[freeOf[b]] += flows[k];
    });
    return { flows, conductance, chord, residual };
  };

  const maxAbs = (v: number[]) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  const sumSq = (v: number[]) => v.reduce((s, x) => s + x * x, 0);

  let ev = evaluate(h);
  ev.flows.forEach((q, k) => (qPrev[k] = q));
  let iterations = 0;
  let message = '';
  let converged = nFree === 0 || maxAbs(ev.residual) <= tol;

  while (!converged && iterations < maxIter) {
    iterations++;
    // The first few iterations use chord (linear-theory) conductances. Newton on a square-root-like
    // pipe law can flip-flop across the root when far from it; the chord step lands on it exactly for a
    // single such pipe and is robust globally. Newton then finishes with quadratic convergence.
    const useChord = iterations <= picardIters;
    // Assemble A = -J (symmetric positive definite) in sparse row maps.
    const rows: Map<number, number>[] = Array.from({ length: nFree }, () => new Map<number, number>());
    edgeEnds.forEach(([a, b], k) => {
      const g = useChord ? ev.chord[k] : ev.conductance[k];
      const ia = freeOf[a];
      const ib = freeOf[b];
      if (ia >= 0) rows[ia].set(ia, (rows[ia].get(ia) ?? 0) + g);
      if (ib >= 0) rows[ib].set(ib, (rows[ib].get(ib) ?? 0) + g);
      if (ia >= 0 && ib >= 0) {
        rows[ia].set(ib, (rows[ia].get(ib) ?? 0) - g);
        rows[ib].set(ia, (rows[ib].get(ia) ?? 0) - g);
      }
    });
    const dh = solveSparseSpd(rows, ev.residual); // A dh = F

    // Backtracking line search on ||F||^2.
    const f0 = sumSq(ev.residual);
    let alpha = 1;
    let trial: Evaluation | undefined;
    let hTrial = h;
    for (let ls = 0; ls < 30; ls++) {
      hTrial = h.map((x, i) => (freeOf[i] >= 0 ? x + alpha * dh[freeOf[i]] : x));
      trial = evaluate(hTrial);
      if (useChord || sumSq(trial.residual) <= (1 - 1e-4 * alpha) * f0) break;
      alpha *= 0.5;
    }
    if (!trial) throw new NetworkError('Line search failed to evaluate');
    for (let i = 0; i < h.length; i++) h[i] = hTrial[i];
    ev = trial;
    ev.flows.forEach((q, k) => (qPrev[k] = q));
    converged = maxAbs(ev.residual) <= tol;
    if (!converged && alpha < 1e-8) {
      message = 'Line search stalled';
      break;
    }
  }

  const residual = maxAbs(ev.residual);
  if (!message) message = converged ? `Converged in ${iterations} iterations` : `Not converged after ${iterations} iterations`;
  return {
    converged,
    iterations,
    residualM3s: residual,
    heads: Object.fromEntries(net.nodes.map((n, i) => [n.id, h[i]])),
    flows: Object.fromEntries(net.edges.map((e, k) => [e.id, ev.flows[k]])),
    message,
  };
}
