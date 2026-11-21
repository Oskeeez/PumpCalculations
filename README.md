# Pipe Network Calculator

Steady-state pipe network and pump calculator. Runs entirely in the browser (Vite, React, TypeScript, three.js).

```
npm install
npm run dev
npm test
npm run build
npm run e2e      # browser tests (Playwright; first run: npx playwright install chromium)
```

## Features
- Canvas editor: tanks, junctions, pipes, valves (fixed, PRV, PSV, FCV, check) and pumps. Drag from node to node to connect. Branches and loops.
- Node heights (z) and tank fluid heights. Pipe lengths can come from the canvas distance (3D, using the canvas scale and node heights).
- Canvas scale (calibrate from two points), canvas size, image underlays.
- 3D view: XYZ position of every node and element, tank fluid heights, velocity colouring, image plane, coordinate tables.
- Fluids: water, seawater, ethylene and propylene glycol, custom.
- Pump curves at several speeds (affinity laws), scenario comparison, SI and US units.
- Save and open as JSON, autosave, undo and redo, Excel export.

## Documentation
- [`docs/THEORY.md`](docs/THEORY.md): the equations used, where they come from, how the solver is checked, and what it does not model.

## Workspace and pump curves
- The page never scrolls. Everything lives in resizable **tiles**: drag a tab by its title to another tile's edge to dock it beside, or to the middle to add it as a tab. Drag the bars between tiles to resize (double-click to even out). The **Panels** menu shows or hides each panel, **Layout** has ready-made arrangements, and your layout is remembered.
- **Pump curves** panel: a library of reusable curves. Type points in a table, paste a table from a datasheet or Excel, open a CSV, or generate a generic curve from a best-efficiency point. Pick a curve for each pump in its Properties (or "Use for pump" in the library). Editing a curve updates every pump using it.

## AI design assistant
Optional. Uses your own Anthropic API key (AI assistant tab → settings; stored in this browser only, sent only to api.anthropic.com). The solver stays the source of truth: the model can only call validated tools, edits go into **drafts** (copies), and every pass/fail is computed by the solver, never by the model.
- **Targets** (Network tab): required flow, residual pressure window, velocity limits, pump range (% of BEP, runout), NPSH margin. Saved in the project file.
- **Generate**: describe a system, get a draft with its assumptions; accept all or item by item from the diff (green added, orange changed, pink removed).
- **Solve with AI**: deterministic diagnosis, then *ideas first* (you pick) or *solve every way* (all variants built as sibling drafts). Drafts tab: one tab per draft plus a comparison (target pass/fail, pump duty vs BEP, head burned across valves/orifices, rough cost, warnings).
- **Pick** merges a draft into main; siblings stay as read-only reference. **Chat** edits also go to a draft.
- Caps on tool calls, solver runs, turns and drafts per run; every tool call, solver run and model turn is logged (downloadable JSON).
- Design criteria (velocity limits, roughness, pump window, orifice limits, cost rates) are editable JSON. The shipped values are generic placeholders, and catalogue pumps are generic curves, not vendor data.
- Code: `src/ai/` (types, targets, drafts, tools, flows, llm). `LlmProvider` is the swap point for another vendor. Tests mock the model.

## Layout
- `src/solver/` solver library, no UI dependencies: node-based Newton-Raphson network solver, network model, valves, regulators, fluids, pumps, friction.
- `src/model.ts` project model, unit boundary, save and load.
- `src/ai/` AI design layer (see above).
- `src/geometry.ts` canvas scale, world coordinates, pipe length from the canvas.
- `src/scene3d.ts` 3D scene description. `src/components/View3D.tsx` renderer.
- `src/analysis.ts` speed sweeps and scenario comparison.
- `src/excel/networkExport.ts` Excel export with live formulas and check columns.
- `tests/` unit tests. `tests/excel.test.ts` recalculates every exported formula with HyperFormula. `tests/validation/epanet-net1.test.ts` compares the solver with the EPANET engine on Net1. Crane TP-410 validation is a placeholder.

## Notes
- Units change the display only. The project stores canonical values. Excel sheets are always SI.
- Glycol and seawater vapour pressure is an ideal-solution estimate.
- Pumps block reverse flow.
