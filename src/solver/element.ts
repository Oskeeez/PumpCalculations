/**
 * A hydraulic element joining two nodes. Sign convention: Q > 0 flows from `from` to `to`.
 *
 *   headDrop(Q) = h_from - h_to   [m]
 *
 * where h is the hydraulic grade (piezometric head: p_gauge/(rho g) + z). Passive elements have
 * headDrop > 0 for Q > 0; pumps have headDrop = -H_pump (negative: they add head).
 * headDrop must be (weakly) increasing in Q for the network solver to be well-posed.
 */
export interface HydraulicElement {
  readonly kind: 'pipe' | 'pump' | 'valve';
  /** h_from - h_to [m] for flow Q [m^3/s] from -> to. */
  headDrop(flowM3s: number): number;
  /** d(headDrop)/dQ [m per m^3/s]. */
  dHeadDrop(flowM3s: number): number;
}
