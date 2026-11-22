import { brent } from './rootfinding';
import { solveSystem, type SystemModel, type SystemOptions, type SystemResult } from './system';

/**
 * Variable-speed pump control: find the speed ratio at which a pump holds a flow, or holds the gauge pressure at a node.
 * The solver itself never changes a speed; this wraps it, searching the speed with Brent's method between a minimum and maximum.
 */
export interface SpeedControl {
  /** Pump id (its name). */
  pumpId: string;
  target: { kind: 'flow'; m3s: number } | { kind: 'pressure'; nodeId: string; pa: number };
  minRatio: number;
  maxRatio: number;
}

export interface ControlledSolution {
  /** The model with the controlled pumps at their solved speeds. */
  model: SystemModel;
  result: SystemResult;
  /** Solved speed ratio of each controlled pump, by pump id. */
  speeds: Map<string, number>;
  /** Plain-language notes, e.g. a target that cannot be reached even at the speed limit. */
  notes: string[];
}

const withSpeed = (m: SystemModel, id: string, ratio: number): SystemModel => ({ ...m, edges: m.edges.map((e) => (e.kind === 'pump' && e.id === id ? { ...e, speedRatio: ratio } : e)) });

/**
 * Solve with the given pumps under speed control. A target that is out of reach is not an error: the pump runs at the speed limit
 * that gets closest and a note says so. With several controlled pumps each is adjusted in turn until the speeds stop changing.
 */
export function solveWithSpeedControl(m: SystemModel, controls: SpeedControl[], opts: SystemOptions = {}): ControlledSolution {
  for (const c of controls) {
    if (!(c.minRatio > 0) || !(c.maxRatio > c.minRatio)) throw new RangeError(`Pump "${c.pumpId}": speed limits must satisfy 0 < minimum < maximum.`);
    if (!m.edges.some((e) => e.kind === 'pump' && e.id === c.pumpId)) throw new RangeError(`Pump "${c.pumpId}" is not in the model.`);
  }
  let model = m;
  const speeds = new Map<string, number>(controls.map((c) => [c.pumpId, (m.edges.find((e) => e.kind === 'pump' && e.id === c.pumpId) as { speedRatio: number }).speedRatio]));
  const notes = new Map<string, string>();

  for (let sweep = 0; sweep < (controls.length > 1 ? 8 : 1); sweep++) {
    let change = 0;
    for (const c of controls) {
      const cache = new Map<number, number>();
      // error = what the pump achieves minus what was asked for; it rises with speed
      const err = (ratio: number): number => {
        const hit = cache.get(ratio);
        if (hit !== undefined) return hit;
        const r = solveSystem(withSpeed(model, c.pumpId, ratio), opts);
        const got = c.target.kind === 'flow' ? (r.pumps.find((p) => p.id === c.pumpId)?.flowM3s ?? 0) : (r.nodes.find((n) => n.id === (c.target as { nodeId: string }).nodeId)?.gaugePressurePa ?? Number.NaN);
        const e = got - (c.target.kind === 'flow' ? c.target.m3s : c.target.pa);
        if (!Number.isFinite(e)) throw new RangeError(`Pump "${c.pumpId}": the control node "${(c.target as { nodeId: string }).nodeId}" is not in the model.`);
        cache.set(ratio, e);
        return e;
      };
      let ratio: number;
      const unit = c.target.kind === 'flow' ? 'L/s' : 'kPa';
      const scale = c.target.kind === 'flow' ? 1000 : 1 / 1000;
      const asked = (c.target.kind === 'flow' ? c.target.m3s : c.target.pa) * scale;
      if (err(c.maxRatio) < 0) {
        ratio = c.maxRatio;
        notes.set(c.pumpId, `Pump "${c.pumpId}" is at its maximum speed (${(c.maxRatio * 100).toFixed(0)} %) and still cannot reach ${asked.toFixed(1)} ${unit}${c.target.kind === 'pressure' ? ` at "${c.target.nodeId}"` : ''}.`);
      } else if (err(c.minRatio) > 0) {
        ratio = c.minRatio;
        notes.set(c.pumpId, `Pump "${c.pumpId}" is at its minimum speed (${(c.minRatio * 100).toFixed(0)} %) and the ${c.target.kind === 'flow' ? 'flow' : 'pressure'} is still above ${asked.toFixed(1)} ${unit}${c.target.kind === 'pressure' ? ` at "${c.target.nodeId}"` : ''}.`);
      } else {
        ratio = brent(err, c.minRatio, c.maxRatio, 1e-7, 60);
        notes.delete(c.pumpId);
      }
      change = Math.max(change, Math.abs(ratio - (speeds.get(c.pumpId) as number)));
      speeds.set(c.pumpId, ratio);
      model = withSpeed(model, c.pumpId, ratio);
    }
    if (change < 1e-6) break;
  }
  return { model, result: solveSystem(model, opts), speeds, notes: [...notes.values()] };
}
