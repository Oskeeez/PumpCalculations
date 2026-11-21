# Build plan and status

Phases from the project review. AI work (the former Phase 4) was set aside on purpose.

## Done

**Phase 0: stabilise**
- GitHub Actions CI: type-check, unit tests, build, and browser tests.
- In-repo browser test suite (`npm run e2e`, Playwright) covering the workspace, drawing tools, zoom, images, pick, pump curves, valves, report and the 3D view.
- `npm audit` clean (transitive `uuid` overridden); dead CSS removed.
- `App.tsx` and `Canvas.tsx` split into hooks and components (`src/state/`, `useViewport`, `ZoomControls`, `canvasGeometry`, `TopBar`, `FluidBar`, `NetworkToolbar`).

**Phase 1: trust the numbers**
- EPANET cross-checks for pressure-reducing, pressure-sustaining and flow-control valves, throttle valves, check valves and single and parallel pumps.
- Fixed a solver crash on zero-resistance elements (a valve with K = 0, a zero-length pipe with no fittings).
- Robustness tests for degenerate and physical edge cases; grid benchmark (85, 421 and 1,985 pipes: 24, 92 and 677 ms).
- Heavy secondary calculations (speed sweep, scenario comparison) only run while their panel is visible.
- `docs/THEORY.md`: equations, sources, validation status and limits.

**Phase 2: engineering features**
- Pump standby (off) and variable-speed control holding a flow or a node pressure.
- Valve sizing (Cv, Kv) and orifice bore sizing; pipe pressure rating alert; Sch 80 and copper Type L size series.
- Printable report (print or save as PDF); Excel export gains Targets and Pump curve library sheets.

**Phase 3: workspace polish**
- Label level, grid and snap toggles; maximise any tile; find a node or pipe by name; help dialog (`?`); named layouts.
- Multi-select (shift-click, shift-drag box), group move, copy and paste, delete.

## Deferred

- **EPANET .inp import and export**: the largest and most useful remaining piece.
- **System-curve plot** against the pump curves.
- **Pressure-dependent demand** (changes the core solver; needs its own validation).
- **Crane TP-410 worked examples**: placeholders until the book's values are copied in with page references.
- **Large networks**: a background worker for solving models of more than about 1,000 pipes (about 0.7 s per solve at 2,000 pipes today).
- Touch-screen support for docking, and a keyboard-only way to dock tiles.
- **AI (Phase 4)**: real-model evaluation, prompt tuning, streaming, a key proxy for sharing.
- **Sharing and growth (Phase 5)**: shareable links, a project list, file-format migrations.
