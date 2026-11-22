# Theory and limits

What the calculator solves, the equations it uses, where they come from, and what it does **not** model. Everything here describes the code in `src/solver/`, which is plain TypeScript in SI units with no UI dependencies. The app shows and accepts other units, but stores and solves in SI.

## What it solves

**Steady-state, single-phase, incompressible liquid flow** in a network of tanks, junctions, pipes, valves and pumps, including branches and loops. Given tank levels, junction demands and equipment settings it finds every node head, every flow and every pump duty point.

It does **not** model: transients or water hammer, gases or two-phase flow, slurries or non-Newtonian fluids, heat transfer, tank filling or draining over time (a tank is a fixed level), or pressure-dependent demand (a demand is a fixed withdrawal).

## Unknowns and equations

The unknowns are the heads `h_i` at the junctions. Tanks are fixed-head nodes. Continuity at every free junction:

```
sum(Q in) - sum(Q out) - q_i = 0        (q_i = demand, positive = withdrawal)
```

Each element (pipe, valve, pump) is a curve `h_from - h_to = headDrop(Q)`, inverted to give its flow. The network is solved by Newton–Raphson on the node heads with a sparse linear solve and a backtracking line search; the first iterations use a linear-theory (chord) step, which is robust far from the answer. Element inversion uses Brent's method. Convergence is on the largest node flow imbalance (default 1e-11 m³/s). The derivative of a quadratic loss is zero at zero flow, so it is floored (`MIN_HEAD_SLOPE`) to keep the system well conditioned.

Heads are hydraulic grade (m of the flowing liquid). Gauge pressure at a node is `rho g (h - z)`.

## Fluids

Water uses fitted correlations valid 0 to 100 °C: Kell (1975) density, a Vogel equation for viscosity, and the Antoine equation for vapour pressure. Ethylene glycol 30 and 50 % (by mass), propylene glycol 30 and 50 % (by volume) and seawater (35 g/kg) use published tables, interpolated linearly in density and in ln(viscosity); asking for a temperature outside the table is an error, not an extrapolation. Vapour pressure of the glycol mixtures and seawater is estimated as pure-water vapour pressure times a Raoult's-law water fraction (an ideal-solution approximation). That is adequate for NPSH screening but not for designs close to vapour pressure. A custom fluid takes density, viscosity and vapour pressure as given and does not vary with temperature.

## Pipes

Darcy–Weisbach: `h_f = f (L / D) v^2 / 2g`, plus minor losses `h_m = (sum K) v^2 / 2g`.

| Reynolds number | Friction factor |
|---|---|
| Re < 2300 | `f = 64 / Re`, written in the Hagen–Poiseuille form so it stays finite and linear as flow tends to zero |
| 2300 to 4000 | a smooth (cubic smoothstep) blend of the laminar and Colebrook values, so head loss stays continuous and increasing. The result is flagged "transitional": the friction factor is uncertain there |
| Re ≥ 4000 | Colebrook–White, solved by Newton iteration on `1/sqrt(f)` from a Swamee–Jain starting point |

**Hazen–Williams** can be chosen instead of Darcy–Weisbach for the whole project (common for water and fire-protection work). Friction loss is then `h_f = k L Q^1.852 / (C^1.852 D^4.871)`, with k = 10.67 (EPANET's 4.727 in feet and cfs, converted exactly), so results agree with EPANET; roughness is ignored and each pipe has a C value. Hazen–Williams is empirical: it is valid for water at ordinary temperatures and turbulent flow only, and ignores viscosity. Fitting losses are unchanged.

Pipe length is either typed or taken from the canvas: the straight-line 3D distance between the end nodes using the canvas scale and the node elevations. A real pipe is longer than the straight line where it bends, so use a typed length when the route is known.

Fitting K values in the library are typical numbers for fully turbulent flow. They vary with size and manufacturer; they are not vendor data.

A pipe with exactly zero length and no fittings has no resistance at all and is solved with a tiny coefficient (K = 1e-4) so the flow stays determined. Any pipe with any resistance is untouched.

## Valves

A fixed-resistance valve has `h = R Q |Q|`, with R from one of:

- **K**: `R = K / (2 g A^2)`, referenced to the valve diameter.
- **Cv** (US gpm at 1 psi drop): `R = 6894.757 / (rho_ref g (Cv x 6.309e-5)^2)`.
- **Kv** (m³/h at 1 bar drop): `R = 1e5 / (rho_ref g (Kv / 3600)^2)`.

The Cv and Kv forms use a reference density of 999 kg/m³ (the definition is for water), so they give the same head loss for any liquid. A valve entered with exactly K = 0 is solved with K = 1e-4.

**Check valve**: reverse flow is blocked by a very stiff resistance (K = 1e12), not by an exact zero. Leakage against tens of metres of reverse head is below 0.02 L/s, which is negligible; the closed state is reported as a warning.

**Orifice plate** (square-edged, in a full pipe, ISO 5167-2 relations). With `beta = d / D` and discharge coefficient `Cd` (default 0.61):

```
K_measured  = (1 - beta^4) / (Cd^2 beta^4)                               referenced to pipe velocity
K_permanent = K_measured x (sqrt(1 - beta^4 (1 - Cd^2)) - Cd beta^2)
                         / (sqrt(1 - beta^4 (1 - Cd^2)) + Cd beta^2)
```

The pump has to overcome the **permanent** loss, which is smaller than the pressure difference a flow meter reads across the plate. Cd really depends on Reynolds number, beta and the pressure-tap arrangement; 0.61 is the usual high-Reynolds-number value, so treat results as estimates, not as a meter sizing.

**Regulating valves**, handled by an active-set loop that tries each regulator open, active and closed until the states agree:

- *PRV (pressure-reducing)*: when upstream pressure is higher than the setting, holds the downstream node at the set pressure; otherwise it is an ordinary open valve.
- *PSV (pressure-sustaining)*: holds the upstream node at the set pressure by throttling.
- *FCV (flow-control)*: passes the set flow when the network would pass more, otherwise open.
- All three block reverse flow. A regulator cannot regulate the head of a tank; it then acts as an open valve (and says so).

## Pumps

A pump is fitted at rated speed with a least-squares quadratic through the head points: `H(Q) = a0 + a1 Q + a2 Q^2`. Efficiency and NPSH required (if at least two points are given) are fitted the same way. The fit error is shown. Three or more head points are recommended; the app warns if the pump runs past the end of the head data (the curve is then extrapolated).

**Affinity laws** for speed ratio `r = N / N_rated`: `H(Q, r) = r^2 H1(Q / r)`, `eta(Q, r) = eta1(Q / r)`, `NPSHr(Q, r) = r^2 NPSHr1(Q / r)`.

**Impeller trim** `t = D / D_full` scales the data before fitting: `Q ∝ t`, `H ∝ t^2`, `NPSHr` head ∝ `t^2`, efficiency unchanged. Trim and speed are separate; efficiency is not corrected for the loss that real trimming causes.

**Best-efficiency point** is the maximum of the fitted efficiency curve over the head-data flow range, scaled by speed ratio. "Percent of BEP" is the operating flow divided by it.

**Reverse flow** is blocked by the same kind of stiff resistance as a check valve. A pump whose shutoff head is below the static lift simply gives no flow.

**NPSH available**: `NPSHa = h_suction - z_suction + (p_atm - p_v) / (rho g) + v_s^2 / 2g`, with `h_suction` the hydraulic grade at the suction node (gauge) and `v_s` the velocity in the suction pipe. A warning appears when `NPSHa < NPSHr + margin` (margin set in the top bar, default 0.5 m).

**Power**: hydraulic `rho g Q H`; shaft = hydraulic / efficiency (when efficiency data exist).

**Switching a pump off** (standby) removes it from the network, like a closed valve: it carries nothing, the result says "switched off", and other pumps take over.

**Variable-speed control**: instead of typing a speed ratio, a pump can hold a flow through itself, or the gauge pressure at a chosen node. The solver is not changed; a wrapper searches the speed ratio between a slowest and fastest limit with Brent's method, re-solving the whole network each time (the held quantity rises with speed). The speed it finds is shown. If the target is out of reach, the pump runs at the limit that gets closest and a note says so; this is not an error. With several controlled pumps each is adjusted in turn until the speeds stop changing. A speed sweep ignores the control so that every speed is really tried. Control finds a steady-state operating point: it does not model the drive's response over time.

## Sizing helpers

- **Control valve**: `Cv = Q[gpm] / sqrt(dP[psi] / SG)` and `Kv = Q[m3/h] / sqrt(dP[bar] / SG)`, with `SG = rho / 999`. This is the flow coefficient needed fully open; it does not size for travel, noise or cavitation limits.
- **Orifice plate**: solves `K_permanent(beta) = dP / (rho v^2 / 2)` for beta by Brent's method at the design flow, where `v` is the velocity in the pipe, and reports the bore, the bore velocity and the larger differential pressure a flow meter would read across the plate. It reports when no plate can give the requested drop, and warns when beta is outside 0.2 to 0.75 or the bore velocity exceeds 12 m/s.

## Junction fittings, valve types and pipe sizes

`src/fittings.ts`. Losses use Crane TP-410 (Appendix A, pp. A-26 to A-29): K = n x fT, with fT the fully turbulent friction factor for the pipe size (0.027 at 1/2 in down to 0.012 at 18 in and over). Standard elbows are 30 fT (90°), 16 fT (45°) and 50 fT (180° return bend). Flanged or butt-welded 90° bends depend on r/D (20 fT at 1, 14 fT at 1.5, 12 fT at 2 and 3, rising to 50 fT at 20), and bends over 90° use Crane's multi-bend formula. Mitre bends run from 8 fT at 30° to 60 fT at 90°. A **tee** is 20 fT through the run and 60 fT into the branch. A **wye** branch loses less as the angle falls; that part is a smooth fit chosen here, not published data. A **cross** is 30 fT per pipe, also an estimate. A **reducer / expander** uses Crane's contraction and enlargement formulas, referred to the smaller pipe's velocity, with a cone angle (180 = sudden).

The solver has no loss at a node, so a junction's loss is added to the connected pipes as a fitting K. For a tee it is split so that run to run and run to branch both come out at the Crane values. The loss is constant, so it does not change with the flow split; treat tee, wye and cross losses as screening values. Turn and branch angles can be taken from how the pipes are drawn or typed. Any junction can instead use **your own loss values**, for example from a maker's datasheet or the company fittings list.

Valve types (gate 8, globe 340, angle 150, ball 3, plug 18, swing check 100, lift check 600, stop-check 400, foot valve 420 or 75 hinged; butterfly 45 / 35 / 25 and tilting-disc check 40 / 30 / 20 by size band) set K from n x fT and the valve size. The pipe fitting list is grouped, gives K for the pipe it is added to, and shows each entry's source.

**Checking.** `tests/validation/crane-fittings.test.ts` checks every fT band and the K for each elbow, bend, tee, valve, entrance and exit, and the contraction and enlargement formulas, against the Crane TP-410 values. The values were transcribed from public reproductions of Crane's tables, not from the printed book: check them against your own copy.

**Company fittings.** An Excel or CSV file (template provided) with a name and either a fixed K or an L/D, an optional category, and a source. L/D entries scale with the pipe size the same way as the built-in ones. Rows with problems are skipped and reported.

Pipe sizes: the built-in lists are Sch 40, Sch 80 and copper Type L. A company list can be imported from an Excel or CSV file (a template can be downloaded). It needs a nominal size and an inside diameter, or outside diameter and wall. Roughness and pressure rating are optional and are copied to the pipe when that size is chosen. "Standard size" picks the smallest size in a list that meets a velocity limit and, if set, a head loss per 100 m limit at the solved flow.

## EPANET files

`src/epanet.ts`. **Open…** reads an EPANET `.inp` file: junctions and [DEMANDS], reservoirs, tanks (at their initial level), pipes (closed pipes become closed valves; check-valve pipes become the pipe plus a check valve), pumps with head curves, PRV, PSV, FCV and TCV valves, [STATUS], [CURVES], [COORDINATES], and the units and head-loss formula. EPANET's one-point and three-point pump curves are rebuilt on EPANET's own curve shape before fitting. PRV and PSV settings in metres are converted with water at 20 °C. Patterns, controls, rules, quality and energy are ignored, and the app lists what it ignored. Constant-power pumps, PBV and GPV valves and Chezy-Manning roughness are not supported and are reported.

**Export .inp** writes the network in L/s, m and mm. Fitting losses, including junction fittings, become pipe minor losses; tanks become reservoirs; check valves become short check-valve pipes; pump curves are written as points along the fitted curve. Tested: Net1 read from its `.inp` matches the EPANET engine to 0.05 ft; the example project written out and solved by EPANET agrees within 0.3 m (EPANET uses Swamee-Jain, this app Colebrook-White); export then import gives the same heads within 0.02 m.

## Solve for me (no AI)

`src/autosolve.ts` keeps every component and changes only what you allow (pipe diameters from a standard series, pump speed, impeller trim, throttle valve resistance, orifice bore, PRV/PSV/FCV settings, tank levels) until the targets pass. It is a deterministic search that uses the real solver: it tries each allowed change, keeps those that reduce the remaining shortfall, then pulls every change back to the smallest that still passes. Flow, pressure and velocity targets get a safety margin (default 3 %). Velocity limit and NPSH margin are protected where they hold now. A locked node freezes everything attached to it; a locked pipe, valve or pump is not changed. The result is a preview with the changes listed; applying it is a single undo step. It is a bounded search, not a proof: when it cannot meet a target it says so and reports the closest result. The number of network solutions tried is capped (default 1,500).

## Design alerts

Velocity above the limit set in the top bar (0 = off) is flagged on pipes and valves. A pipe can carry an optional pressure rating (entered by you; the app has no pressure-class data): an alert is raised when the solved pressure at either end exceeds it. Warnings are also raised for sub-atmospheric pressure, pressure below vapour pressure, a closed check valve, transitional flow, a pump with no forward flow and a pump beyond its curve data.

## How it is checked

- Hand calculations and published values for friction factors (Moody chart points), orifice coefficients, Cv/Kv conversions, affinity laws and pump operating points.
- EPANET 2.2 cross-checks (`tests/validation/`): Net1 with Hazen–Williams (heads within 1.3e-5 ft) and with Darcy–Weisbach; and a second set covering pressure-reducing, pressure-sustaining and flow-control valves, a throttle valve, check valves (blocking and passing) and single and parallel pumps. Pipes in EPANET use the Swamee–Jain formula and here Colebrook–White, so flows agree to about 1 % at normal velocities and the tests allow for that.
- Round-trip of the Excel export: every formula in the exported workbook is recalculated with an independent engine and compared with the solver.
- Robustness tests for degenerate inputs (zero-length pipes, K = 0 and K = 1e9 valves, empty tanks, dead-ended pumps, isolated sections).
- A grid benchmark (about 85 pipes in 24 ms, 420 pipes in 92 ms, 2,000 pipes in about 0.7 s on a laptop-class machine).

**Not yet validated against published textbook worked examples**: the Crane TP-410 examples are placeholders in `tests/validation/external-validation.test.ts`, because the exact worked values need to be copied from the book with their page references. Until then, treat agreement with Crane as unproven.

## Using the results

This is an engineering aid, not a certified design tool. Check the inputs (especially roughness, fitting K values and pump curves), compare against vendor data, and have a competent engineer review any design before it is built.
