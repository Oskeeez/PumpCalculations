# Validation

The validation pack (`src/validation/cases.ts`) builds each network through the same project model a user would, solves it, and compares the answer with an independent reference. It runs in the app (**Validation** panel → **Run validation**, then **Print / save as PDF** for a dated report with the software build), and in the test suite (`tests/validation/pack.test.ts`), which also re-checks the recorded EPANET numbers against the EPANET 2.2 engine.

| Case | What | Reference | Allowed difference |
|---|---|---|---|
| V1 | Single pipe between two tanks, turbulent | Darcy–Weisbach + Colebrook–White solved separately by bisection | 0.01 % on flow |
| V2 | Laminar pipe | Hagen–Poiseuille, exact | 0.01 % |
| V3 | Three-reservoir problem | Junction head by bisection on continuity, separate pipe model | 1 mm head, 0.1 % flow |
| V4 | Two pipes in parallel | Each pipe solved separately for the common head | 0.2 % |
| V5 | Pump operating point | Pump curve and system curve intersected by bisection | 0.1 % flow, 10 mm head |
| V6 | EPANET Net1 (loops, pump, tank, Hazen–Williams) | EPANET 2.2 engine | 0.05 ft head |
| V7 | Sprinkler outlet | Q = K √p, and an EPANET emitter | 0.1 %, 1 % against EPANET (different friction formula) |
| V8 | Fitting losses | Crane TP-410 Appendix A (K = n fT) | exact |
| V9 | Orifice plate | ISO 5167-2 pressure-loss relation | exact |
| V10 | Fixed-pressure node and NPSH available | Hand calculation | 1 µm head, 10 mm NPSHa |

Other checks in the test suite: EPANET valve cases (PRV, PSV, FCV, TCV, check valves, parallel pumps), the EPANET `.inp` import and export (Net1 and a round trip), the Crane fitting tables (`crane-fittings.test.ts`), the Excel export recalculated by an independent formula engine, and robustness cases (zero-length pipes, K = 0 and K = 1e9 valves, empty tanks, dead-ended pumps).

## Limits of this validation

- The hand-method references share the fluid properties (water at 20 °C) with the app; the fluid correlations are checked separately.
- The Crane values were transcribed from public reproductions of the tables, not from the printed book. Check them against your own copy.
- No case comes from a textbook worked example with a page reference yet; the Crane TP-410 worked examples are still placeholders in `tests/validation/external-validation.test.ts`.
- No comparison with AFT Fathom or FluidFlow output has been made. Adding a few of your own past calculations from those tools as cases is the best next step.
