# Pipe Network Calculator

Client-side pipe network and pump hydraulic calculator (Vite + React + TypeScript, strict). SI units internally; the UI converts at the boundary (`src/model.ts`).

```
npm install
npm run dev        # UI
npm test           # solver, UI-model, Excel and EPANET validation tests (Vitest)
npm run build
```

## Using it
Build the network on the canvas: place **tanks** (fixed-head boundaries) and **junctions** (elevation, demand), then connect them with **pipes**, **valves** and **pumps**. Branches and loops are supported. Click anything to edit it; heads, pressures, flows, velocities, pump duty and NPSH update live on the canvas and in the tables.

- **Fluids:** water, seawater, ethylene glycol 30/50 %, propylene glycol 30/50 %, or a custom fluid (published data, interpolated; see `src/solver/fluidLibrary.ts` for sources and ranges).
- **Valves:** loss by K, Cv or Kv; optional check valve; open/closed (a closed valve is removed from the network).
- **Pipe library:** material roughness presets, Schedule 40 nominal sizes, standard fitting K values (typical values, verify for your design).
- **Design alerts:** velocity limit, plus automatic warnings for sub-atmospheric / below-vapour node pressure, NPSH shortfall, closed check valves and pumps beyond their curve data.
- **Project files:** Save / Open as `.json`, autosave in the browser, undo / redo (Ctrl+Z, Ctrl+Shift+Z), Excel export.
- Drag nodes to rearrange; Delete removes the selection; Esc returns to Select.

## Layout
- `src/solver/` – pure TypeScript solver library, no UI/React dependencies.
  - `network.ts` general node-based Newton-Raphson solver (sparse assembly, regularised derivative, chord start + line search)
  - `system.ts` network model (tanks, junctions, pipes, valves, pumps) -> node pressures, element results, NPSH, warnings
  - `valve.ts`, `fluidLibrary.ts`, `series.ts` (single-line operating point, kept as an independent cross-check)
  - friction / pipe / pump / fluid / polynomial / rootfinding primitives
- `src/model.ts` – UI project model (UI units), conversion to SI, save/load validation.
- `src/library.ts` – materials, pipe sizes, fitting presets.  `src/history.ts` – undo/redo.
- `src/components/`, `src/App.tsx`, `src/curveChart.ts` – canvas editor, property editors, results tables, pump curves.
- `src/excel/networkExport.ts` – ExcelJS export (Inputs, Node/Pipe/Valve/Pump results, Pump curve) with live formulas and audit residuals.
- `tests/` – `tests/excel.test.ts` re-evaluates every exported formula with HyperFormula; `tests/validation/epanet-net1.test.ts` runs the EPANET engine (epanet-js) on Net1; Crane TP-410 is still a placeholder.

## Notes
- Pipe elevation change comes from the node elevations. Heads are hydraulic grade z + p_gauge/(rho g).
- A pump acts as a check valve: reverse flow is blocked (held to ~1e-5 m3/s).
- Glycol and seawater vapour pressure is an ideal-solution estimate (water vapour pressure times a Raoult fraction), fine for NPSH screening only.
- Excel: junction heads, flows and friction factors are solver values; residual columns re-check energy balance across each pipe/valve, the pump curve, the Colebrook equation and node continuity. The chart is an embedded PNG (ExcelJS cannot create native charts).

## Added in this version
- **US / SI toggle:** display and entry units only (ft, in, gpm, psi, °F, hp ...). The project stores canonical values, so files and results never depend on the choice. Excel sheets are always SI.
- **Regulating valves:** pressure-reducing (PRV), pressure-sustaining (PSV) and flow-control (FCV), solved by an active-set loop in `solveSystem`. A PRV closes when an unregulated bypass overfeeds its downstream side.
- **Pump speed analysis:** affinity-law curves at several speeds with the system operating point at each (full network solve per speed).
- **Scenarios:** save snapshots of the whole network, compare them side by side (deltas against the current network); stored in the project file and exported to Excel.
