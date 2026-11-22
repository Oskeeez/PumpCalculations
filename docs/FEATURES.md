# Component and library plan

Based on AFT Fathom's junction list, its Fittings & Losses library (about 400 items, CSV import) and its Pipe Material library (import from file).

## Decided: build now

| Feature | Decision |
|---|---|
| Elbow | Junction with two pipes. Style (standard, long radius, mitre), angle typed or taken from the drawing. Loss from Crane TP-410 equivalent lengths, scaled by angle. |
| Tee | Junction with three pipes. Run and branch found from the drawing, or chosen. Run K 20 fT, branch K 60 fT (Crane). |
| Wye | Tee with a branch angle. Branch loss reduced as the angle falls. Approximation, not vendor data. |
| Cross | Four pipes, equal loss per leg. Approximation. |
| Reducer / expander | Junction between two pipes of different diameter. Sudden or gradual (cone angle). Crane loss, referenced to the smaller pipe. |
| Valve types | Gate, globe, angle, ball, butterfly, plug, swing / lift / tilting-disc / stop check. K from Crane L/D and the valve size. |
| Fittings library | Grouped drop-down, K from L/D and the pipe size, each entry with its source. Company fittings import from Excel. Checked against Crane TP-410 in `tests/validation/crane-fittings.test.ts`. |
| Own loss values | Any junction can use typed or company-list loss values instead of the calculated ones. |
| Pipe size library | Built-in series plus company series imported from Excel or CSV. Template download. |
| Standard sizing | Smallest standard size from the chosen series that meets a velocity limit or head-loss limit at the solved flow. |

## Added after the first plan

| Feature | Notes |
|---|---|
| Hazen–Williams | Project option, C per pipe, agrees with EPANET |
| EPANET `.inp` | Import and export, including emitters; the route from Fathom |
| PCF import | CAD piping component files with 3D geometry |
| System curve, HGL profile | On the pump chart, and a profile panel |
| Calculation record | Title block, revisions, sign-off, fingerprint, full input listing |
| Fixed-pressure node, sprinkler outlet, relief valve | Boundary components |
| Validation pack | Ten cases, runs in the app, printable report |
| FluidFlow files | Not possible directly (closed format). Needs a sample of FluidFlow's Excel export to build an importer for it |

## Not yet

Area-change and general components with user-defined curves, heat exchangers, spray discharge, weirs, venturis, jet pumps, three-way valves, Darby 3-K, GIS and CAD import, friction data sets by pipe age, transient analysis. Each needs data or a model this app does not have yet.

## Accuracy

Tee, wye and cross losses depend on the flow split. This app applies one constant loss per leg chosen so that run-to-run and run-to-branch flows match the Crane values. Real losses move with the split. Treat them as screening values.
