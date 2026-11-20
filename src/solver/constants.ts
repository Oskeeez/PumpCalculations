/** Physical constants and solver-wide numerical settings. All SI. */

/** Standard gravity [m/s^2]. */
export const G = 9.80665;

/** Standard atmospheric pressure [Pa, absolute]. */
export const P_ATM = 101325;

/** Reynolds number below which flow is treated as fully laminar. */
export const RE_LAMINAR_MAX = 2300;

/** Reynolds number above which flow is treated as fully turbulent (Colebrook-White). */
export const RE_TURBULENT_MIN = 4000;

/** Lower clamp on pump efficiency from a fitted curve [-]; avoids division blow-up when extrapolating. */
export const MIN_PUMP_EFFICIENCY = 0.05;

/**
 * Check-valve stiffness for a pump at reverse flow [m of head per m^3/s].
 * Reverse flow through a pump is blocked by making the head requirement rise steeply.
 */
export const PUMP_CHECK_VALVE_STIFFNESS = 1e7;

/**
 * Floor on d(head drop)/dQ used when inverting elements to dQ/d(head) [m per m^3/s].
 * Regularises the quadratic-loss derivative that is zero at Q = 0.
 */
export const MIN_HEAD_SLOPE = 1e-3;
