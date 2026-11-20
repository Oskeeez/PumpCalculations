# Pipe Network Calculator

Steady-state pipe network and pump calculator. Runs entirely in the browser (Vite, React, TypeScript, three.js).

```
npm install
npm run dev
npm test
npm run build
```

## Features
- Canvas editor: tanks, junctions, pipes, valves (fixed, PRV, PSV, FCV, check) and pumps. Drag from node to node to connect. Branches and loops.
- Node heights (z) and tank fluid heights. Pipe lengths can come from the canvas distance (3D, using the canvas scale and node heights).
- Canvas scale (calibrate from two points), canvas size, image underlays.
- 3D view: XYZ position of every node and element, tank fluid heights, velocity colouring, image plane, coordinate tables.
- Fluids: water, seawater, ethylene and propylene glycol, custom.
- Pump curves at several speeds (affinity laws), scenario comparison, SI and US units.
- Save and open as JSON, autosave, undo and redo, Excel export.

## Layout
- `src/solver/` solver library, no UI dependencies: node-based Newton-Raphson network solver, network model, valves, regulators, fluids, pumps, friction.
- `src/model.ts` project model, unit boundary, save and load.
- `src/geometry.ts` canvas scale, world coordinates, pipe length from the canvas.
- `src/scene3d.ts` 3D scene description. `src/components/View3D.tsx` renderer.
- `src/analysis.ts` speed sweeps and scenario comparison.
- `src/excel/networkExport.ts` Excel export with live formulas and check columns.
- `tests/` unit tests. `tests/excel.test.ts` recalculates every exported formula with HyperFormula. `tests/validation/epanet-net1.test.ts` compares the solver with the EPANET engine on Net1. Crane TP-410 validation is a placeholder.

## Notes
- Units change the display only. The project stores canonical values. Excel sheets are always SI.
- Glycol and seawater vapour pressure is an ideal-solution estimate.
- Pumps block reverse flow.
