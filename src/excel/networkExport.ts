import ExcelJS from 'exceljs';
import type { PumpCurveData, PumpCurveEntry } from '../model';
import type { TargetStatus } from '../ai/types';
import type { Comparison, SpeedSweep } from '../analysis';
import { G, P_ATM, pumpHead, tankHead, type SystemModel, type SystemResult } from '../solver';

export interface NetworkExportInput {
  model: SystemModel;
  result: SystemResult;
  npshMarginM: number;
  pumpCurves: PumpCurveData[];
  /** PNG of the pump curve chart, base64 (no data: prefix). ExcelJS cannot author native charts. */
  chartPngBase64?: string;
  /** Optional pump speed analysis (adds a "Speed analysis" sheet). */
  speedSweep?: SpeedSweep;
  /** PNG of the speed-analysis chart. */
  speedChartPngBase64?: string;
  /** Optional scenario comparison (adds a "Scenario comparison" sheet). Values are canonical SI-style units. */
  comparison?: Comparison;
  /** Optional design targets with their pass/fail from the solver (adds a "Targets" sheet). */
  targets?: TargetStatus[];
  /** Optional pump curve library (adds a "Pump curve library" sheet). */
  curveLibrary?: PumpCurveEntry[];
  /** Notes from variable-speed control, e.g. a target that could not be reached. */
  controlNotes?: string[];
}

type Cell = number | string | { formula: string; result?: number | string };

const colLetter = (n: number): string => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};
const BOLD = { bold: true } as const;
const NOTE = { italic: true, color: { argb: 'FF666666' } } as const;

/**
 * Network workbook. Inputs are static values. Per-element calculations (head from tank data, pressures,
 * pipe area / velocity / Re / losses, pump head / efficiency / power / NPSH, node continuity, pump curve)
 * are live formulas referencing the Inputs sheet.
 * Solver outputs written as values: junction heads, flows, and Darcy friction factors (Colebrook needs
 * iteration). Residual columns re-check them: pipe loss vs head difference, pump curve vs head
 * difference, Colebrook residual, and node continuity.
 */
export async function buildNetworkWorkbook(x: NetworkExportInput): Promise<ExcelJS.Workbook> {
  const { model, result } = x;
  const rho = model.fluid.density;
  const mu = model.fluid.dynamicViscosity;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pipe network calculator';
  wb.calcProperties = { fullCalcOnLoad: true };
  const inp = wb.addWorksheet('Inputs');
  const nr = wb.addWorksheet('Node results');
  const pr = wb.addWorksheet('Pipe results');
  const vr = wb.addWorksheet('Valve results');
  const pm = wb.addWorksheet('Pump results');
  const pc = wb.addWorksheet('Pump curve');

  const pipes = model.edges.flatMap((e) => (e.kind === 'pipe' ? [e] : []));
  const pumps = model.edges.flatMap((e) => (e.kind === 'pump' ? [e] : []));
  const valves = model.edges.flatMap((e) => (e.kind === 'valve' ? [e] : []));

  // ------------------------------------------------------------ Inputs
  let r = 1;
  inp.getCell('A1').value = 'Inputs (SI units)';
  inp.getCell('A1').font = { bold: true, size: 14 };
  const section = (t: string) => {
    r += 2;
    inp.getCell(r, 1).value = t;
    inp.getCell(r, 1).font = BOLD;
  };
  const put = (label: string, value: Cell, unit = ''): number => {
    r += 1;
    inp.getCell(r, 1).value = label;
    inp.getCell(r, 2).value = value;
    inp.getCell(r, 3).value = unit;
    return r;
  };
  const I = (row: number) => `Inputs!$B$${row}`;
  const header = (sheet: ExcelJS.Worksheet, row: number, labels: string[]) =>
    labels.forEach((h, i) => {
      sheet.getCell(row, i + 1).value = h;
      sheet.getCell(row, i + 1).font = BOLD;
    });

  section('Fluid');
  put('Fluid', model.fluid.name);
  put('Temperature', model.fluid.temperatureC, 'degC');
  const rRho = put('Density rho', rho, 'kg/m3');
  const rMu = put('Dynamic viscosity mu', mu, 'Pa.s');
  const rPv = put('Vapour pressure p_v', model.fluid.vaporPressure, 'Pa abs');
  const rG = put('Gravity g', G, 'm/s2');
  const rAtm = put('Atmospheric pressure', P_ATM, 'Pa');
  const rMargin = put('NPSH margin required above NPSHr', x.npshMarginM, 'm');

  section('Nodes');
  r += 1;
  header(inp, r, ['Name', 'Type', 'Elevation z [m]', 'Liquid level [m]', 'Surface pressure [Pa abs]', 'Demand [m3/s]', 'Fixed head h [m]']);
  const nodeInRow = new Map<string, number>();
  for (const n of model.nodes) {
    r += 1;
    nodeInRow.set(n.id, r);
    inp.getCell(r, 1).value = n.id;
    inp.getCell(r, 2).value = n.kind;
    inp.getCell(r, 3).value = n.elevationM;
    if (n.kind === 'tank') {
      inp.getCell(r, 4).value = n.liquidLevelM;
      inp.getCell(r, 5).value = n.surfacePressurePa;
      inp.getCell(r, 7).value = { formula: `C${r}+D${r}+(E${r}-${I(rAtm)})/(${I(rRho)}*${I(rG)})`, result: tankHead(n, model.fluid) };
    } else {
      inp.getCell(r, 6).value = n.demandM3s;
      inp.getCell(r, 7).value = 'free (solved)';
    }
  }

  section('Pipes');
  r += 1;
  header(inp, r, ['Name', 'From', 'To', 'Length L [m]', 'Inner diameter D [m]', 'Roughness eps [m]', 'Sum K [-]', 'Fitting K values ->']);
  const pipeInRow = new Map<string, number>();
  for (const p of pipes) {
    r += 1;
    pipeInRow.set(p.id, r);
    const s = p.spec;
    [p.id, p.from, p.to, s.lengthM, s.innerDiameterM, s.roughnessM].forEach((v, i) => (inp.getCell(r, i + 1).value = v));
    s.fittingsK.forEach((k, i) => (inp.getCell(r, 8 + i).value = k));
    inp.getCell(r, 7).value = s.fittingsK.length ? { formula: `SUM(H${r}:${colLetter(7 + s.fittingsK.length)}${r})`, result: s.fittingsK.reduce((a, b) => a + b, 0) } : 0;
  }

  section('Valves');
  r += 1;
  header(inp, r, ['Name', 'From', 'To', 'Diameter D [m]', 'Loss type', 'Coefficient (K, Cv or Kv)', 'Check valve', 'Open', 'Function', 'Set pressure [Pa gauge] / set flow [m3/s]']);
  const valveInRow = new Map<string, number>();
  for (const v of valves) {
    r += 1;
    valveInRow.set(v.id, r);
    const l = v.spec.loss;
    [v.id, v.from, v.to, v.spec.diameterM, l.type, l.type === 'K' ? l.k : l.type === 'Cv' ? l.cv : l.kv, v.spec.checkValve ? 'yes' : 'no', v.spec.open ? 'yes' : 'no', v.spec.control ? v.spec.control.type.toUpperCase() : 'fixed', v.spec.control ? (v.spec.control.type === 'fcv' ? v.spec.control.flowM3s : v.spec.control.setpointPa) : ''].forEach((x, i) => (inp.getCell(r, i + 1).value = x));
  }

  section('Pumps (fitted quadratics at rated speed, Q in m3/s)');
  r += 1;
  header(inp, r, ['Name', 'From (suction)', 'To (discharge)', 'H a0', 'H a1', 'H a2', 'eta a0', 'eta a1', 'eta a2', 'NPSHr a0', 'NPSHr a1', 'NPSHr a2', 'Speed ratio']);
  const pumpInRow = new Map<string, number>();
  for (const p of pumps) {
    r += 1;
    pumpInRow.set(p.id, r);
    [p.id, p.from, p.to, p.model.head.a0, p.model.head.a1, p.model.head.a2].forEach((v, i) => (inp.getCell(r, i + 1).value = v));
    if (p.model.efficiency) [p.model.efficiency.a0, p.model.efficiency.a1, p.model.efficiency.a2].forEach((v, i) => (inp.getCell(r, 7 + i).value = v));
    if (p.model.npshr) [p.model.npshr.a0, p.model.npshr.a1, p.model.npshr.a2].forEach((v, i) => (inp.getCell(r, 10 + i).value = v));
    inp.getCell(r, 13).value = p.speedRatio;
  }
  inp.getColumn(1).width = 44;
  for (let c = 2; c <= 13; c++) inp.getColumn(c).width = 18;

  // ------------------------------------------------------------ Row maps for cross-sheet refs
  const nodeRow = new Map(model.nodes.map((n, i) => [n.id, 4 + i]));
  const pipeRow = new Map(pipes.map((p, i) => [p.id, 4 + i]));
  const pumpRow = new Map(pumps.map((p, i) => [p.id, 4 + i]));
  const valveRow = new Map(valves.map((p, i) => [p.id, 4 + i]));
  const lastValve = 3 + valves.length;
  const NH = (id: string) => `'Node results'!$C$${nodeRow.get(id)}`;
  const NZ = (id: string) => `'Node results'!$B$${nodeRow.get(id)}`;
  const lastPipe = 3 + pipes.length;
  const lastPump = 3 + pumps.length;

  // ------------------------------------------------------------ Node results
  nr.getCell('A1').value = 'Node results';
  nr.getCell('A1').font = { bold: true, size: 14 };
  header(nr, 3, ['Node', 'Elevation z [m]', 'Head h [m]', 'Gauge pressure [kPa]', 'Absolute pressure [kPa]', 'Net inflow from pipes/pumps [m3/s]', 'External demand [m3/s]', 'Continuity residual (junctions, ~0)']);
  for (const n of result.nodes) {
    const row = nodeRow.get(n.id) as number;
    const ir = nodeInRow.get(n.id) as number;
    const src = model.nodes.find((q) => q.id === n.id)!;
    nr.getCell(row, 1).value = n.id;
    nr.getCell(row, 2).value = { formula: `Inputs!$C$${ir}`, result: n.elevationM };
    nr.getCell(row, 3).value = src.kind === 'tank' ? { formula: `Inputs!$G$${ir}`, result: n.headM } : n.headM;
    nr.getCell(row, 4).value = { formula: `(C${row}-B${row})*${I(rRho)}*${I(rG)}/1000`, result: n.gaugePressurePa / 1000 };
    nr.getCell(row, 5).value = { formula: `D${row}+${I(rAtm)}/1000`, result: n.absolutePressurePa / 1000 };
    const terms: string[] = [];
    if (pipes.length) terms.push(`SUMIF('Pipe results'!$C$4:$C$${lastPipe},A${row},'Pipe results'!$D$4:$D$${lastPipe})-SUMIF('Pipe results'!$B$4:$B$${lastPipe},A${row},'Pipe results'!$D$4:$D$${lastPipe})`);
    if (pumps.length) terms.push(`SUMIF('Pump results'!$C$4:$C$${lastPump},A${row},'Pump results'!$D$4:$D$${lastPump})-SUMIF('Pump results'!$B$4:$B$${lastPump},A${row},'Pump results'!$D$4:$D$${lastPump})`);
    if (valves.length) terms.push(`SUMIF('Valve results'!$C$4:$C$${lastValve},A${row},'Valve results'!$D$4:$D$${lastValve})-SUMIF('Valve results'!$B$4:$B$${lastValve},A${row},'Valve results'!$D$4:$D$${lastValve})`);
    // net inflow from edges: for a junction equals the demand, for a tank it is what the tank absorbs
    const inflow = src.kind === 'junction' ? src.demandM3s : n.netOutflowM3s;
    nr.getCell(row, 6).value = terms.length ? { formula: terms.join('+'), result: inflow } : 0;
    if (src.kind === 'junction') {
      nr.getCell(row, 7).value = { formula: `Inputs!$F$${ir}`, result: src.demandM3s };
      nr.getCell(row, 8).value = { formula: `F${row}-G${row}`, result: 0 };
    } else {
      nr.getCell(row, 7).value = 'tank';
      nr.getCell(row, 8).value = 'n/a';
    }
  }
  nr.getCell(5 + result.nodes.length, 1).value = 'Tank heads are formulas from the tank data; junction heads are solver values. Continuity: inflow from pipes/pumps equals the demand.';
  nr.getCell(5 + result.nodes.length, 1).font = NOTE;
  nr.getColumn(1).width = 26;
  for (let c = 2; c <= 8; c++) nr.getColumn(c).width = 24;

  // ------------------------------------------------------------ Pipe results
  pr.getCell('A1').value = 'Pipe results';
  pr.getCell('A1').font = { bold: true, size: 14 };
  header(pr, 3, ['Pipe', 'From', 'To', 'Flow Q [m3/s] (solver, + = from->to)', 'Head difference h_from - h_to [m]', 'Area A [m2]', 'Velocity v [m/s]', 'Reynolds Re', 'Regime', 'Friction factor f', 'Colebrook residual (turbulent, ~0)', 'Friction loss h_f [m]', 'Minor loss h_m [m]', 'Total loss [m]', 'Residual: loss - head difference (~0)']);
  for (const p of result.pipes) {
    const row = pipeRow.get(p.id) as number;
    const ir = pipeInRow.get(p.id) as number;
    const D = `Inputs!$E$${ir}`;
    const st = p.flow;
    const sgn = Math.sign(p.flowM3s);
    const area = (Math.PI / 4) * (model.edges.find((e) => e.id === p.id && e.kind === 'pipe') as { spec: { innerDiameterM: number } }).spec.innerDiameterM ** 2;
    pr.getCell(row, 1).value = p.id;
    pr.getCell(row, 2).value = p.from;
    pr.getCell(row, 3).value = p.to;
    pr.getCell(row, 4).value = p.flowM3s;
    pr.getCell(row, 5).value = { formula: `${NH(p.from)}-${NH(p.to)}`, result: p.headDropM };
    pr.getCell(row, 6).value = { formula: `PI()*${D}^2/4`, result: area };
    pr.getCell(row, 7).value = { formula: `ABS(D${row})/F${row}`, result: st.velocity };
    pr.getCell(row, 8).value = { formula: `${I(rRho)}*G${row}*${D}/${I(rMu)}`, result: st.reynolds };
    pr.getCell(row, 9).value = { formula: `IF(H${row}=0,"zero",IF(H${row}<2300,"laminar",IF(H${row}<4000,"transitional","turbulent")))`, result: st.regime };
    pr.getCell(row, 10).value = st.regime === 'laminar' ? { formula: `IF(H${row}>0,64/H${row},0)`, result: st.frictionFactor } : Number.isFinite(st.frictionFactor) ? st.frictionFactor : 0;
    if (spec(model, p.id).hazenC !== undefined) pr.getCell(row, 11).value = 'n/a (Hazen-Williams)';
    else pr.getCell(row, 11).value = {
      formula: `IF(H${row}>=4000,1/SQRT(J${row})+2*LOG10(Inputs!$F$${ir}/${D}/3.7+2.51/(H${row}*SQRT(J${row}))),"n/a")`,
      result: st.reynolds >= 4000 ? 1 / Math.sqrt(st.frictionFactor) + 2 * Math.log10(spec(model, p.id).roughnessM / spec(model, p.id).innerDiameterM / 3.7 + 2.51 / (st.reynolds * Math.sqrt(st.frictionFactor))) : 'n/a',
    };
    pr.getCell(row, 12).value = { formula: `SIGN(D${row})*J${row}*Inputs!$D$${ir}/${D}*G${row}^2/(2*${I(rG)})`, result: sgn * st.frictionHeadLoss };
    pr.getCell(row, 13).value = { formula: `SIGN(D${row})*Inputs!$G$${ir}*G${row}^2/(2*${I(rG)})`, result: sgn * st.minorHeadLoss };
    pr.getCell(row, 14).value = { formula: `L${row}+M${row}`, result: sgn * st.totalHeadLoss };
    pr.getCell(row, 15).value = { formula: `N${row}-E${row}`, result: sgn * st.totalHeadLoss - p.headDropM };
  }
  pr.getCell(5 + pipes.length, 1).value = "Friction factor f is the solver's Colebrook-White value (iterative); the residual column evaluates the Colebrook equation with it. The last column checks the energy balance across each pipe.";
  pr.getCell(5 + pipes.length, 1).font = NOTE;
  pr.getColumn(1).width = 22;
  for (let c = 2; c <= 15; c++) pr.getColumn(c).width = 20;

  // ------------------------------------------------------------ Valve results
  vr.getCell('A1').value = 'Valve results';
  vr.getCell('A1').font = { bold: true, size: 14 };
  header(vr, 3, ['Valve', 'From', 'To', 'Flow Q [m3/s] (solver, + = from->to)', 'Head difference h_from - h_to [m]', 'Status', 'Area A [m2]', 'Velocity v [m/s]', 'Equivalent K [-]', 'Head drop from K [m]', 'Residual: K-based drop - head difference (~0)', 'Pressure drop [kPa]']);
  for (const v of result.valves) {
    const row = valveRow.get(v.id) as number;
    const ir = valveInRow.get(v.id) as number;
    const src = valves.find((q) => q.id === v.id)!;
    const l = src.spec.loss;
    const D = `Inputs!$D$${ir}`;
    const area = (Math.PI / 4) * src.spec.diameterM ** 2;
    const sgn = Math.sign(v.flowM3s);
    vr.getCell(row, 1).value = v.id;
    vr.getCell(row, 2).value = v.from;
    vr.getCell(row, 3).value = v.to;
    vr.getCell(row, 4).value = v.flowM3s;
    vr.getCell(row, 5).value = { formula: `${NH(v.from)}-${NH(v.to)}`, result: v.headDropM };
    vr.getCell(row, 6).value = v.status;
    vr.getCell(row, 7).value = { formula: `PI()*${D}^2/4`, result: area };
    vr.getCell(row, 8).value = { formula: `ABS(D${row})/G${row}`, result: v.velocity };
    const kFormula =
      l.type === 'K'
        ? `Inputs!$F$${ir}`
        : l.type === 'Cv'
          ? `6894.757*2*G${row}^2/(999*(Inputs!$F$${ir}*0.0000630901964)^2)`
          : `100000*2*G${row}^2/(999*(Inputs!$F$${ir}/3600)^2)`;
    vr.getCell(row, 9).value = { formula: kFormula, result: v.equivalentK };
    const comparable = v.status === 'open' && !(src.spec.checkValve && v.flowM3s < 0);
    vr.getCell(row, 10).value = comparable ? { formula: `SIGN(D${row})*I${row}*H${row}^2/(2*${I(rG)})`, result: sgn * v.equivalentK * (v.velocity ** 2) / (2 * G) } : 'n/a';
    vr.getCell(row, 11).value = comparable ? { formula: `J${row}-E${row}`, result: sgn * v.equivalentK * (v.velocity ** 2) / (2 * G) - v.headDropM } : 'n/a';
    vr.getCell(row, 12).value = { formula: `E${row}*${I(rRho)}*${I(rG)}/1000`, result: v.pressureDropPa / 1000 };
  }
  vr.getCell(5 + valves.length, 1).value = 'Closed valves are removed from the network (zero flow). Cv/Kv are converted to an equivalent K; the residual column checks the energy balance across each open valve.';
  vr.getCell(5 + valves.length, 1).font = NOTE;
  vr.getColumn(1).width = 22;
  for (let c = 2; c <= 12; c++) vr.getColumn(c).width = 22;

  // ------------------------------------------------------------ Pump results
  pm.getCell('A1').value = 'Pump results';
  pm.getCell('A1').font = { bold: true, size: 14 };
  header(pm, 3, ['Pump', 'From (suction)', 'To (discharge)', 'Flow Q [m3/s] (solver)', 'Speed ratio r', 'Head across pump h_to - h_from [m]', 'Head from pump curve [m]', 'Residual: curve - head across (~0)', 'Efficiency eta', 'Hydraulic power [W]', 'Shaft power [kW]', 'Suction head h_s [m]', 'Suction elevation z_s [m]', 'Suction velocity v_s [m/s]', 'NPSHa [m]', 'NPSHr [m]', 'Margin NPSHa-NPSHr [m]', 'Status']);
  for (const p of result.pumps) {
    const row = pumpRow.get(p.id) as number;
    const ir = pumpInRow.get(p.id) as number;
    const src = pumps.find((q) => q.id === p.id)!;
    const forward = p.flowM3s > 1e-9;
    const attached = pipes.find((q) => q.from === p.from || q.to === p.from);
    pm.getCell(row, 1).value = p.id;
    pm.getCell(row, 2).value = p.from;
    pm.getCell(row, 3).value = p.to;
    pm.getCell(row, 4).value = p.flowM3s;
    pm.getCell(row, 5).value = { formula: `Inputs!$M$${ir}`, result: p.speedRatio };
    const across = (result.nodes.find((n) => n.id === p.to)!.headM) - (result.nodes.find((n) => n.id === p.from)!.headM);
    pm.getCell(row, 6).value = { formula: `${NH(p.to)}-${NH(p.from)}`, result: across };
    pm.getCell(row, 12).value = { formula: NH(p.from), result: p.suctionHeadM };
    pm.getCell(row, 13).value = { formula: NZ(p.from), result: p.suctionElevationM };
    pm.getCell(row, 14).value = attached ? { formula: `ABS(D${row})/(PI()*Inputs!$E$${pipeInRow.get(attached.id)}^2/4)`, result: p.suctionVelocity } : 0;
    pm.getCell(row, 15).value = {
      formula: `(L${row}-M${row})+(${I(rAtm)}-${I(rPv)})/(${I(rRho)}*${I(rG)})+N${row}^2/(2*${I(rG)})`,
      result: p.npshaM,
    };
    if (forward) {
      pm.getCell(row, 7).value = { formula: `Inputs!$D$${ir}*E${row}^2+Inputs!$E$${ir}*E${row}*D${row}+Inputs!$F$${ir}*D${row}^2`, result: p.headM };
      pm.getCell(row, 8).value = { formula: `G${row}-F${row}`, result: p.headM - across };
      pm.getCell(row, 10).value = { formula: `${I(rRho)}*${I(rG)}*D${row}*G${row}`, result: p.hydraulicPowerW };
      if (src.model.efficiency && p.efficiency !== undefined) {
        pm.getCell(row, 9).value = { formula: `MIN(1,MAX(0.05,Inputs!$G$${ir}+Inputs!$H$${ir}*(D${row}/E${row})+Inputs!$I$${ir}*(D${row}/E${row})^2))`, result: p.efficiency };
        pm.getCell(row, 11).value = { formula: `J${row}/I${row}/1000`, result: (p.shaftPowerW ?? 0) / 1000 };
      } else {
        pm.getCell(row, 9).value = 'n/a';
        pm.getCell(row, 11).value = 'n/a';
      }
      if (src.model.npshr && p.npshrM !== undefined) {
        pm.getCell(row, 16).value = { formula: `MAX(0,E${row}^2*(Inputs!$J$${ir}+Inputs!$K$${ir}*(D${row}/E${row})+Inputs!$L$${ir}*(D${row}/E${row})^2))`, result: p.npshrM };
        pm.getCell(row, 17).value = { formula: `O${row}-P${row}`, result: p.npshaM - p.npshrM };
        pm.getCell(row, 18).value = { formula: `IF(O${row}<P${row}+${I(rMargin)},"CAVITATION RISK","OK")`, result: p.npshaM < p.npshrM + x.npshMarginM ? 'CAVITATION RISK' : 'OK' };
      } else {
        ['n/a', 'n/a', 'n/a'].forEach((v, i) => (pm.getCell(row, 16 + i).value = v));
      }
    } else {
      pm.getCell(row, 7).value = 'no forward flow (check valve closed)';
      [8, 9, 10, 11, 16, 17, 18].forEach((c) => (pm.getCell(row, c).value = 'n/a'));
    }
  }
  pm.getColumn(1).width = 22;
  for (let c = 2; c <= 18; c++) pm.getColumn(c).width = 22;

  // ------------------------------------------------------------ Pump curve
  pc.getCell('A1').value = 'Pump curves';
  pc.getCell('A1').font = { bold: true, size: 14 };
  pc.getCell('A2').value = x.pumpCurves.map((c) => (c.op ? `${c.name}: ${c.op.q.toFixed(3)} L/s at ${c.op.h.toFixed(2)} m` : `${c.name}: no flow`)).join('   |   ');
  header(pc, 3, ['Q [L/s]', 'Q [m3/s]', ...pumps.map((p) => `${p.id} head [m] (formula)`)]);
  const qMaxLps = Math.max(1, ...x.pumpCurves.map((c) => c.pts[c.pts.length - 1]?.q ?? 0));
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const row = 4 + i;
    const qL = (qMaxLps * i) / N;
    pc.getCell(row, 1).value = qL;
    pc.getCell(row, 2).value = { formula: `A${row}/1000`, result: qL / 1000 };
    pumps.forEach((p, k) => {
      const ir = pumpInRow.get(p.id);
      pc.getCell(row, 3 + k).value = {
        formula: `Inputs!$D$${ir}*Inputs!$M$${ir}^2+Inputs!$E$${ir}*Inputs!$M$${ir}*B${row}+Inputs!$F$${ir}*B${row}^2`,
        result: pumpHead(p.model, qL / 1000, p.speedRatio),
      };
    });
  }
  for (let c = 1; c <= 2 + pumps.length; c++) pc.getColumn(c).width = 24;
  if (x.chartPngBase64) {
    const id = wb.addImage({ base64: x.chartPngBase64, extension: 'png' });
    pc.addImage(id, { tl: { col: 3 + pumps.length, row: 2 }, ext: { width: 720, height: 450 } });
  }
  // ------------------------------------------------------------ Speed analysis
  const sw = x.speedSweep;
  const swPump = sw ? pumps.find((p) => p.id === sw.pump) : undefined;
  if (sw && swPump) {
    const sa = wb.addWorksheet('Speed analysis');
    const ir = pumpInRow.get(swPump.id) as number;
    const okRows = sw.rows.filter((q) => !q.error && q.flowLps !== undefined);
    sa.getCell('A1').value = `Pump speed analysis: ${swPump.id}`;
    sa.getCell('A1').font = { bold: true, size: 14 };
    sa.getCell('A2').value = 'Each row is a full network solution with the pump at that speed (flow, head, tank supply are solver values). Curves follow the affinity laws H = a0 r^2 + a1 r Q + a2 Q^2; the check column recomputes the head from the pump curve at the solved flow.';
    sa.getCell('A2').font = NOTE;
    header(sa, 4, ['Speed ratio r', 'Speed [rpm]', 'Flow Q [L/s]', 'Head H [m]', 'Efficiency', 'Shaft power [kW]', 'NPSH margin [m]', 'Tank supply [L/s]', 'Curve check: H(Q, r) - H [m] (~0)', 'Warnings']);
    okRows.forEach((q, i) => {
      const row = 5 + i;
      sa.getCell(row, 1).value = q.speedRatio;
      sa.getCell(row, 2).value = q.rpm;
      sa.getCell(row, 3).value = q.flowLps as number;
      sa.getCell(row, 4).value = q.headM as number;
      sa.getCell(row, 5).value = q.efficiency ?? 'n/a';
      sa.getCell(row, 6).value = q.shaftKw ?? 'n/a';
      sa.getCell(row, 7).value = q.npshMarginM ?? 'n/a';
      sa.getCell(row, 8).value = q.systemSupplyLps ?? 'n/a';
      sa.getCell(row, 9).value = {
        formula: `Inputs!$D$${ir}*A${row}^2+Inputs!$E$${ir}*A${row}*(C${row}/1000)+Inputs!$F$${ir}*(C${row}/1000)^2-D${row}`,
        result: pumpHead(swPump.model, (q.flowLps as number) / 1000, q.speedRatio) - (q.headM as number),
      };
      sa.getCell(row, 10).value = q.warnings;
    });
    const tHdr = 5 + okRows.length + 2;
    sa.getCell(tHdr - 1, 1).value = 'Pump head curves at each speed (live formulas)';
    sa.getCell(tHdr - 1, 1).font = BOLD;
    sa.getCell(tHdr, 1).value = 'Q [L/s]';
    sa.getCell(tHdr, 1).font = BOLD;
    okRows.forEach((q, k) => {
      sa.getCell(tHdr, 2 + k).value = q.speedRatio;
      sa.getCell(tHdr, 2 + k).numFmt = '0.0%';
      sa.getCell(tHdr, 2 + k).font = BOLD;
    });
    const qEnd = Math.max(1, ...sw.series.map((s) => s.pts[s.pts.length - 1]?.q ?? 0));
    for (let i = 0; i <= 40; i++) {
      const row = tHdr + 1 + i;
      const qL = (qEnd * i) / 40;
      sa.getCell(row, 1).value = qL;
      okRows.forEach((q, k) => {
        const c = colLetter(2 + k);
        sa.getCell(row, 2 + k).value = {
          formula: `Inputs!$D$${ir}*${c}$${tHdr}^2+Inputs!$E$${ir}*${c}$${tHdr}*($A${row}/1000)+Inputs!$F$${ir}*($A${row}/1000)^2`,
          result: pumpHead(swPump.model, qL / 1000, q.speedRatio),
        };
      });
    }
    for (let c = 1; c <= 10; c++) sa.getColumn(c).width = 22;
    if (x.speedChartPngBase64) {
      const id = wb.addImage({ base64: x.speedChartPngBase64, extension: 'png' });
      sa.addImage(id, { tl: { col: 11, row: 2 }, ext: { width: 720, height: 450 } });
    }
  }

  // ------------------------------------------------------------ Scenario comparison
  const cmp = x.comparison;
  if (cmp && cmp.columns.length > 1) {
    const sc = wb.addWorksheet('Scenario comparison');
    const UNIT: Record<string, string> = { flow: 'L/s', head: 'm', pressure: 'kPa (gauge)', power: 'kW', velocity: 'm/s', text: '', count: '' };
    sc.getCell('A1').value = 'Scenario comparison';
    sc.getCell('A1').font = { bold: true, size: 14 };
    sc.getCell('A2').value = 'Solver values for each saved scenario (column C = the current network). Delta columns are live formulas against the current network.';
    sc.getCell('A2').font = NOTE;
    const nC = cmp.columns.length;
    header(sc, 3, ['Item', 'Unit', ...cmp.columns, ...cmp.columns.slice(1).map((c) => `${c}: change vs current`)]);
    let row = 3;
    for (const sec of cmp.sections) {
      row += 1;
      sc.getCell(row, 1).value = sec.title;
      sc.getCell(row, 1).font = BOLD;
      for (const rw of sec.rows) {
        row += 1;
        sc.getCell(row, 1).value = rw.label;
        sc.getCell(row, 2).value = UNIT[rw.qty] ?? '';
        rw.values.forEach((v, i) => (sc.getCell(row, 3 + i).value = v === undefined ? '–' : v));
        if (rw.qty !== 'text') {
          for (let i = 1; i < nC; i++) {
            const base = rw.values[0];
            const v = rw.values[i];
            if (typeof base === 'number' && typeof v === 'number') {
              sc.getCell(row, 2 + nC + i).value = { formula: `${colLetter(3 + i)}${row}-C${row}`, result: v - base };
            }
          }
        }
      }
    }
    sc.getColumn(1).width = 40;
    for (let c = 2; c <= 2 + 2 * nC; c++) sc.getColumn(c).width = 22;
  }

  // ------------------------------------------------------------ Targets
  if (x.targets && x.targets.length) {
    const ts = wb.addWorksheet('Targets');
    ts.getCell('A1').value = 'Design targets';
    ts.getCell('A1').font = { bold: true, size: 14 };
    ts.getCell('A2').value = 'Pass or fail is worked out by the solver for the network as exported. Pressures are gauge.';
    ts.getCell('A2').font = NOTE;
    header(ts, 3, ['Target', 'Result', 'Actual vs required', 'Shortfall', 'Unit']);
    x.targets.forEach((t, i) => {
      const row = 4 + i;
      ts.getCell(row, 1).value = t.label;
      ts.getCell(row, 2).value = t.pass ? 'PASS' : 'FAIL';
      ts.getCell(row, 2).font = { bold: true, color: { argb: t.pass ? 'FF17612F' : 'FF9B1C14' } };
      ts.getCell(row, 3).value = t.text;
      ts.getCell(row, 4).value = t.pass ? 0 : Math.round(t.shortfall * 1000) / 1000;
      ts.getCell(row, 5).value = t.unit;
    });
    ts.getColumn(1).width = 40;
    ts.getColumn(2).width = 10;
    ts.getColumn(3).width = 52;
    ts.getColumn(4).width = 12;
    ts.getColumn(5).width = 10;
  }

  // ------------------------------------------------------------ Pump curve library
  if (x.curveLibrary && x.curveLibrary.length) {
    const cl = wb.addWorksheet('Pump curve library');
    cl.getCell('A1').value = 'Pump curve library (flow L/s, head m, efficiency %, NPSHr m)';
    cl.getCell('A1').font = { bold: true, size: 14 };
    let row = 2;
    for (const c of x.curveLibrary) {
      row += 2;
      cl.getCell(row, 1).value = c.name;
      cl.getCell(row, 1).font = BOLD;
      cl.getCell(row, 3).value = `Rated speed ${c.ratedRpm} rpm`;
      cl.getCell(row, 3).font = NOTE;
      row += 1;
      header(cl, row, ['Flow [L/s]', 'Head [m]', 'Efficiency [%]', 'NPSHr [m]']);
      const flows = [...new Set([...c.head.map((p) => p.q), ...c.efficiency.map((p) => p.q), ...c.npshr.map((p) => p.q)])].sort((a, b) => a - b);
      for (const q of flows) {
        row += 1;
        cl.getCell(row, 1).value = q;
        const h = c.head.find((p) => p.q === q);
        const e = c.efficiency.find((p) => p.q === q);
        const n = c.npshr.find((p) => p.q === q);
        if (h) cl.getCell(row, 2).value = h.h;
        if (e) cl.getCell(row, 3).value = e.eta;
        if (n) cl.getCell(row, 4).value = n.h;
      }
    }
    for (let i = 1; i <= 4; i++) cl.getColumn(i).width = 18;
  }

  // ------------------------------------------------------------ control notes on the inputs sheet
  if (x.controlNotes && x.controlNotes.length) {
    section('Pump speed control notes');
    for (const n of x.controlNotes) {
      r += 1;
      inp.getCell(r, 1).value = n;
    }
  }
  return wb;
}

function spec(model: SystemModel, id: string) {
  const e = model.edges.find((q) => q.id === id && q.kind === 'pipe');
  if (!e || e.kind !== 'pipe') throw new Error(`pipe ${id} not found`);
  return e.spec;
}

export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
