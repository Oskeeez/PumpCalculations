import ExcelJS from 'exceljs';
import type { PumpCurveData } from '../model';
import { G, P_ATM, pumpHead, tankHead, type SystemModel, type SystemResult } from '../solver';

export interface NetworkExportInput {
  model: SystemModel;
  result: SystemResult;
  npshMarginM: number;
  pumpCurves: PumpCurveData[];
  /** PNG of the pump curve chart, base64 (no data: prefix). ExcelJS cannot author native charts. */
  chartPngBase64?: string;
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
  const pm = wb.addWorksheet('Pump results');
  const pc = wb.addWorksheet('Pump curve');

  const pipes = model.edges.flatMap((e) => (e.kind === 'pipe' ? [e] : []));
  const pumps = model.edges.flatMap((e) => (e.kind === 'pump' ? [e] : []));

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
    pr.getCell(row, 11).value = {
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
