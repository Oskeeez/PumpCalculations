# Pipe Network Calculator

Client-side pipe network and pump hydraulic calculator (Vite + React + TypeScript, strict). SI units internally; the UI converts at the boundary (`src/model.ts`).

```
npm install
npm run dev        # UI
npm test           # solver, UI-model and Excel tests (Vitest)
npm run build
```

## Using it
Build the network on the canvas: place **tanks** (fixed-head boundaries) and **junctions** (elevation, demand), then connect them with **pipes** and **pumps**. Branches and loops are supported. Click anything to edit it; heads, pressures, flows, velocities, pump duty and NPSH update live on the canvas and in the tables. Drag nodes to rearrange, Delete removes the selection, Esc returns to the Select tool.

## Layout
- `src/solver/` – pure TypeScript solver library, no UI/React dependencies.
  - `network.ts` general node-based Newton-Raphson solver (sparse assembly, regularised derivative, chord start + line search)
  - `system.ts` network model (tanks, junctions, pipes, pumps) -> node pressures, pipe/pump results, NPSH, warnings
  - `series.ts` single-line operating point (Brent) kept as an independent cross-check of the network solver
  - friction / pipe / pump / fluid / polynomial / rootfinding primitives
- `src/model.ts` – UI project model (UI units) and conversion to the SI solver model.
- `src/components/`, `src/App.tsx`, `src/curveChart.ts` – canvas editor, property editors, results tables, pump curves.
- `src/excel/networkExport.ts` – ExcelJS export (Inputs, Node/Pipe/Pump results, Pump curve) with live formulas and audit residuals.
- `tests/` – `tests/excel.test.ts` re-evaluates every exported formula with HyperFormula and compares it to the solver; `tests/validation/epanet-net1.test.ts` runs the EPANET engine (epanet-js) on Net1 and compares; Crane TP-410 is still a placeholder.

## Notes
- Pipe elevation change comes from the node elevations. Heads are hydraulic grade z + p_gauge/(rho g).
- A pump acts as a check valve: reverse flow is blocked (held to ~1e-5 m3/s).
- Excel: junction heads, flows and friction factors are solver values (the network and Colebrook need iteration); residual columns re-check energy balance across each pipe, the pump curve against the head across the pump, the Colebrook equation, and continuity at each node. The chart is an embedded PNG (ExcelJS cannot create native charts).
