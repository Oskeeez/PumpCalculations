# Pump & Pipe Hydraulic Calculator

Client-side pump/pipe hydraulic calculator (Vite + React + TypeScript, strict). SI units internally; the UI converts at the boundary (`src/model.ts`).

```
npm install
npm run dev        # UI
npm test           # solver + Excel tests (Vitest)
npm run build
```

## Layout
- `src/solver/` – pure TypeScript solver library, no UI/React dependencies (friction, pipe, pump, fluid, node-based Newton network solver, single-line operating point + NPSH).
- `src/model.ts` – UI project model (UI units) and conversion to the SI solver model.
- `src/components/`, `src/App.tsx`, `src/curveChart.ts` – UI: chain diagram, editors, results, pump/system curve chart.
- `src/excel/export.ts` – ExcelJS export (Inputs, Pipe results, Pump results, Pump curve) with live formulas.
- `tests/` – unit tests; `tests/excel.test.ts` re-evaluates every exported formula with HyperFormula and compares it to the solver; `tests/validation/` holds Crane TP-410 / EPANET placeholders.

## Scope notes
- The UI edits a single chain: source tank → pipes/pumps in order → destination tank. The solver itself handles branched and looped networks (tested), but the UI does not expose them yet.
- Excel: friction factor and operating flow are solver values (Colebrook needs iteration); a check column and a residual cell verify them. The chart is an embedded PNG (ExcelJS cannot create native charts).
