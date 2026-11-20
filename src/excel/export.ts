import ExcelJS from 'exceljs';
import type { CurvePoint, OperatingPoint, SeriesAnalysis, SeriesPump, SeriesSystem } from '../solver';
import { G, P_ATM } from '../solver';

export interface ExportInput {
  system: SeriesSystem;
  op: OperatingPoint;
  analysis: SeriesAnalysis;
  curves: CurvePoint[];
  npshMarginM: number;
  /** PNG of the pump/system curve chart, base64 (no data: prefix). ExcelJS cannot author native charts. */
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
 * Build the workbook. Inputs are static values; per-element calculations (area, velocity, Re, head
 * losses, pump head/power/NPSH, curve points) are live formulas that reference the Inputs sheet.
 * The Darcy friction factor and the operating flow are solver outputs (Colebrook-White needs iteration;
 * a check column evaluates the Colebrook residual, and a residual cell checks H_pump - H_sys).
 */
export async function buildWorkbook(x: ExportInput): Promise<ExcelJS.Workbook> {
  const { system, op, analysis, curves } = x;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pump calculator';
  wb.calcProperties = { fullCalcOnLoad: true };
  const inp = wb.addWorksheet('Inputs');
  const pr = wb.addWorksheet('Pipe results');
  const pm = wb.addWorksheet('Pump results');
  const pc = wb.addWorksheet('Pump curve');

  const rho = system.fluid.density;
  const mu = system.fluid.dynamicViscosity;

  // ---------------------------------------------------------------- Inputs
  let r = 1;
  inp.getCell('A1').value = 'Inputs (SI units)';
  inp.getCell('A1').font = { bold: true, size: 14 };
  const section = (title: string) => {
    r += 2;
    inp.getCell(r, 1).value = title;
    inp.getCell(r, 1).font = BOLD;
  };
  /** Write "label | value | unit" on the next row, return the row number. */
  const put = (label: string, value: Cell, unit = ''): number => {
    r += 1;
    inp.getCell(r, 1).value = label;
    inp.getCell(r, 2).value = value;
    inp.getCell(r, 3).value = unit;
    return r;
  };
  const I = (row: number) => `Inputs!$B$${row}`;

  section('Fluid');
  const rT = put('Temperature', system.fluid.temperatureC, 'degC');
  const rRho = put('Density rho', rho, 'kg/m3');
  const rMu = put('Dynamic viscosity mu', mu, 'Pa.s');
  const rPv = put('Vapour pressure p_v', system.fluid.vaporPressure, 'Pa abs');
  const rG = put('Gravity g', G, 'm/s2');
  const rAtm = put('Atmospheric pressure', P_ATM, 'Pa');
  void rT;

  const srcHead = system.source.elevationM + system.source.liquidLevelM + (system.source.surfacePressurePa - P_ATM) / (rho * G);
  const dstHead = system.destination.elevationM + system.destination.liquidLevelM + (system.destination.surfacePressurePa - P_ATM) / (rho * G);
  section('Source tank');
  const rZs = put('Bottom / outlet elevation', system.source.elevationM, 'm');
  const rLs = put('Liquid level', system.source.liquidLevelM, 'm');
  const rPs = put('Pressure above liquid', system.source.surfacePressurePa, 'Pa abs');
  const rHs = put(
    'Surface head h = z + level + (p - p_atm)/(rho g)',
    { formula: `${I(rZs)}+${I(rLs)}+(${I(rPs)}-${I(rAtm)})/(${I(rRho)}*${I(rG)})`, result: srcHead },
    'm',
  );
  section('Destination tank');
  const rZd = put('Bottom / outlet elevation', system.destination.elevationM, 'm');
  const rLd = put('Liquid level', system.destination.liquidLevelM, 'm');
  const rPd = put('Pressure above liquid', system.destination.surfacePressurePa, 'Pa abs');
  const rHd = put(
    'Surface head h = z + level + (p - p_atm)/(rho g)',
    { formula: `${I(rZd)}+${I(rLd)}+(${I(rPd)}-${I(rAtm)})/(${I(rRho)}*${I(rG)})`, result: dstHead },
    'm',
  );
  section('System');
  const rStatic = put('Static head H_static = h_dest - h_source', { formula: `${I(rHd)}-${I(rHs)}`, result: dstHead - srcHead }, 'm');
  const rMargin = put('NPSH margin required above NPSHr', x.npshMarginM, 'm');

  // Pipes table
  section('Pipes (in flow order)');
  r += 1;
  ['ID', 'Length L [m]', 'Inner diameter D [m]', 'Roughness eps [m]', 'Elevation change [m]', 'Sum K [-]', 'Fitting K values ->'].forEach((h, i) => {
    inp.getCell(r, i + 1).value = h;
    inp.getCell(r, i + 1).font = BOLD;
  });
  const pipeInRow: number[] = [];
  const pipes = system.elements.flatMap((e, idx) => (e.kind === 'pipe' ? [{ e, idx }] : []));
  for (const { e } of pipes) {
    r += 1;
    pipeInRow.push(r);
    const s = e.spec;
    inp.getCell(r, 1).value = e.id;
    inp.getCell(r, 2).value = s.lengthM;
    inp.getCell(r, 3).value = s.innerDiameterM;
    inp.getCell(r, 4).value = s.roughnessM;
    inp.getCell(r, 5).value = s.elevationChangeM;
    s.fittingsK.forEach((k, i) => (inp.getCell(r, 8 + i).value = k));
    inp.getCell(r, 6).value =
      s.fittingsK.length > 0
        ? { formula: `SUM(H${r}:${colLetter(7 + s.fittingsK.length)}${r})`, result: s.fittingsK.reduce((a, b) => a + b, 0) }
        : 0;
  }

  // Pumps table
  section('Pumps (fitted quadratics, rated speed: H = a0 + a1 Q + a2 Q^2, Q in m3/s)');
  r += 1;
  ['ID', 'H a0', 'H a1', 'H a2', 'eta a0', 'eta a1', 'eta a2', 'NPSHr a0', 'NPSHr a1', 'NPSHr a2', 'Speed ratio N2/N1'].forEach((h, i) => {
    inp.getCell(r, i + 1).value = h;
    inp.getCell(r, i + 1).font = BOLD;
  });
  const pumps = system.elements.flatMap((e) => (e.kind === 'pump' ? [e] : []));
  const pumpInRow: number[] = [];
  for (const p of pumps) {
    r += 1;
    pumpInRow.push(r);
    inp.getCell(r, 1).value = p.id;
    [p.model.head.a0, p.model.head.a1, p.model.head.a2].forEach((v, i) => (inp.getCell(r, 2 + i).value = v));
    if (p.model.efficiency) [p.model.efficiency.a0, p.model.efficiency.a1, p.model.efficiency.a2].forEach((v, i) => (inp.getCell(r, 5 + i).value = v));
    if (p.model.npshr) [p.model.npshr.a0, p.model.npshr.a1, p.model.npshr.a2].forEach((v, i) => (inp.getCell(r, 8 + i).value = v));
    inp.getCell(r, 11).value = p.speedRatio;
  }
  inp.getColumn(1).width = 46;
  inp.getColumn(2).width = 16;
  inp.getColumn(3).width = 20;
  for (let c = 4; c <= 11; c++) inp.getColumn(c).width = 16;

  // ---------------------------------------------------------------- Pipe results
  pr.getCell('A1').value = 'Pipe results at the operating point';
  pr.getCell('A1').font = { bold: true, size: 14 };
  const prHead = ['ID', 'Flow Q [m3/s]', 'Area A [m2]', 'Velocity v [m/s]', 'Reynolds Re', 'Regime', 'Friction factor f', 'Colebrook residual (turbulent, ~0)', 'Friction loss h_f [m]', 'Minor loss h_m [m]', 'Total loss [m]'];
  prHead.forEach((h, i) => {
    pr.getCell(3, i + 1).value = h;
    pr.getCell(3, i + 1).font = BOLD;
  });
  const pipeResRow: number[] = [];
  pipes.forEach(({ e }, i) => {
    const row = 4 + i;
    pipeResRow.push(row);
    const ir = pipeInRow[i];
    const st = analysis.pipes[i].flow;
    const D = `Inputs!$C$${ir}`;
    pr.getCell(row, 1).value = e.id;
    pr.getCell(row, 2).value = { formula: `'Pump results'!$B$4`, result: analysis.flowM3s };
    pr.getCell(row, 3).value = { formula: `PI()*${D}^2/4`, result: (Math.PI / 4) * e.spec.innerDiameterM ** 2 };
    pr.getCell(row, 4).value = { formula: `B${row}/C${row}`, result: st.velocity };
    pr.getCell(row, 5).value = { formula: `${I(rRho)}*D${row}*${D}/${I(rMu)}`, result: st.reynolds };
    pr.getCell(row, 6).value = { formula: `IF(E${row}<2300,"laminar",IF(E${row}<4000,"transitional","turbulent"))`, result: st.regime };
    // f: live 64/Re when laminar at export time, otherwise the solver's Colebrook-White value
    pr.getCell(row, 7).value = st.regime === 'laminar' ? { formula: `64/E${row}`, result: st.frictionFactor } : st.frictionFactor;
    pr.getCell(row, 8).value = {
      formula: `IF(E${row}>=4000,1/SQRT(G${row})+2*LOG10(Inputs!$D$${ir}/${D}/3.7+2.51/(E${row}*SQRT(G${row}))),"n/a")`,
      result: st.reynolds >= 4000 ? 0 : 'n/a',
    };
    pr.getCell(row, 9).value = { formula: `G${row}*Inputs!$B$${ir}/${D}*D${row}^2/(2*${I(rG)})`, result: st.frictionHeadLoss };
    pr.getCell(row, 10).value = { formula: `Inputs!$F$${ir}*D${row}^2/(2*${I(rG)})`, result: st.minorHeadLoss };
    pr.getCell(row, 11).value = { formula: `I${row}+J${row}`, result: st.totalHeadLoss };
  });
  const prTotal = 4 + pipes.length;
  pr.getCell(prTotal, 1).value = 'Total';
  pr.getCell(prTotal, 1).font = BOLD;
  if (pipes.length > 0) {
    (['I', 'J', 'K'] as const).forEach((c, i) => {
      pr.getCell(prTotal, 9 + i).value = {
        formula: `SUM(${c}4:${c}${prTotal - 1})`,
        result: [analysis.totalFrictionLossM, analysis.totalMinorLossM, analysis.totalFrictionLossM + analysis.totalMinorLossM][i],
      };
    });
  }
  pr.getCell(prTotal + 2, 1).value =
    'Friction factor f is the solver\'s Colebrook-White value (needs iteration); the residual column evaluates the Colebrook equation with it and should be ~0.';
  pr.getCell(prTotal + 2, 1).font = NOTE;
  pr.getColumn(1).width = 22;
  for (let c = 2; c <= 11; c++) pr.getColumn(c).width = 20;

  // ---------------------------------------------------------------- Pump results
  pm.getCell('A1').value = 'Pump results';
  pm.getCell('A1').font = { bold: true, size: 14 };
  pm.getCell('A3').value = 'Operating point';
  pm.getCell('A3').font = BOLD;
  const pumpFirstRow = 14;
  const pumpRows = pumps.map((_, i) => pumpFirstRow + i);
  const totalLoss = analysis.totalFrictionLossM + analysis.totalMinorLossM;
  const staticHead = dstHead - srcHead;
  const pumpHeadSum = analysis.pumps.reduce((s, p) => s + p.headM, 0);
  pm.getCell('A4').value = 'Flow Q [m3/s] (solver root find of H_pump = H_system)';
  pm.getCell('B4').value = analysis.flowM3s;
  pm.getCell('A5').value = 'Flow Q [L/s]';
  pm.getCell('B5').value = { formula: 'B4*1000', result: analysis.flowM3s * 1000 };
  pm.getCell('A6').value = 'Static head [m]';
  pm.getCell('B6').value = { formula: I(rStatic), result: staticHead };
  pm.getCell('A7').value = 'Pipe losses, sum h_f + h_m [m]';
  pm.getCell('B7').value = pipes.length ? { formula: `'Pipe results'!K${prTotal}`, result: totalLoss } : 0;
  pm.getCell('A8').value = 'System head H_sys = H_static + losses [m]';
  pm.getCell('B8').value = { formula: 'B6+B7', result: staticHead + totalLoss };
  pm.getCell('A9').value = 'Total pump head H_pump [m]';
  pm.getCell('B9').value = pumps.length ? { formula: `SUM(D${pumpRows[0]}:D${pumpRows[pumpRows.length - 1]})`, result: pumpHeadSum } : 0;
  pm.getCell('A10').value = 'Residual H_pump - H_sys [m] (should be ~0)';
  pm.getCell('B10').value = { formula: 'B9-B8', result: pumpHeadSum - staticHead - totalLoss };
  pm.getCell('A11').value = op.message;
  pm.getCell('A11').font = NOTE;

  const pmHead = ['Pump', 'Flow Q [m3/s]', 'Speed ratio r', 'Head H [m]', 'Efficiency eta', 'Hydraulic power [W]', 'Shaft power [kW]', 'Suction head h_s [m]', 'Suction elevation z_s [m]', 'Suction velocity v_s [m/s]', 'NPSHa [m]', 'NPSHr [m]', 'Margin NPSHa-NPSHr [m]', 'Status'];
  pmHead.forEach((h, i) => {
    pm.getCell(13, i + 1).value = h;
    pm.getCell(13, i + 1).font = BOLD;
  });
  // Walk the chain to find what is upstream of each pump.
  let pumpIdx = 0;
  let pipeIdx = 0;
  const upPipes: number[] = [];
  const upPumps: number[] = [];
  system.elements.forEach((el) => {
    if (el.kind === 'pipe') {
      upPipes.push(pipeIdx++);
      return;
    }
    const k = pumpIdx++;
    const row = pumpRows[k];
    const ir = pumpInRow[k];
    const res = analysis.pumps[k];
    const p: SeriesPump = el;
    const hs = `${I(rHs)}${upPipes.map((i) => `-'Pipe results'!K${pipeResRow[i]}`).join('')}${upPumps.map((j) => `+D${pumpRows[j]}`).join('')}`;
    const zs = `${I(rZs)}${upPipes.map((i) => `+Inputs!$E$${pipeInRow[i]}`).join('')}`;
    const lastPipe = upPipes.length ? upPipes[upPipes.length - 1] : undefined;
    pm.getCell(row, 1).value = p.id;
    pm.getCell(row, 2).value = { formula: '$B$4', result: analysis.flowM3s };
    pm.getCell(row, 3).value = { formula: `Inputs!$K$${ir}`, result: p.speedRatio };
    pm.getCell(row, 4).value = {
      formula: `Inputs!$B$${ir}*C${row}^2+Inputs!$C$${ir}*C${row}*B${row}+Inputs!$D$${ir}*B${row}^2`,
      result: res.headM,
    };
    if (p.model.efficiency && res.efficiency !== undefined) {
      pm.getCell(row, 5).value = {
        formula: `MIN(1,MAX(0.05,Inputs!$E$${ir}+Inputs!$F$${ir}*(B${row}/C${row})+Inputs!$G$${ir}*(B${row}/C${row})^2))`,
        result: res.efficiency,
      };
      pm.getCell(row, 7).value = { formula: `F${row}/E${row}/1000`, result: (res.shaftPowerW ?? 0) / 1000 };
    } else {
      pm.getCell(row, 5).value = 'n/a';
      pm.getCell(row, 7).value = 'n/a';
    }
    pm.getCell(row, 6).value = { formula: `${I(rRho)}*${I(rG)}*B${row}*D${row}`, result: res.hydraulicPowerW };
    pm.getCell(row, 8).value = { formula: hs, result: res.suctionHeadM };
    pm.getCell(row, 9).value = { formula: zs, result: res.suctionElevationM };
    pm.getCell(row, 10).value = lastPipe !== undefined ? { formula: `'Pipe results'!D${pipeResRow[lastPipe]}`, result: res.suctionVelocity } : 0;
    pm.getCell(row, 11).value = {
      formula: `(H${row}-I${row})+(${I(rAtm)}-${I(rPv)})/(${I(rRho)}*${I(rG)})+J${row}^2/(2*${I(rG)})`,
      result: res.npshaM,
    };
    if (p.model.npshr && res.npshrM !== undefined) {
      pm.getCell(row, 12).value = {
        formula: `MAX(0,C${row}^2*(Inputs!$H$${ir}+Inputs!$I$${ir}*(B${row}/C${row})+Inputs!$J$${ir}*(B${row}/C${row})^2))`,
        result: res.npshrM,
      };
      pm.getCell(row, 13).value = { formula: `K${row}-L${row}`, result: res.npshaM - res.npshrM };
      pm.getCell(row, 14).value = {
        formula: `IF(K${row}<L${row}+${I(rMargin)},"CAVITATION RISK","OK")`,
        result: res.npshaM < res.npshrM + x.npshMarginM ? 'CAVITATION RISK' : 'OK',
      };
    } else {
      pm.getCell(row, 12).value = 'n/a';
      pm.getCell(row, 13).value = 'n/a';
      pm.getCell(row, 14).value = 'n/a';
    }
    upPumps.push(k);
  });
  pm.getColumn(1).width = 54;
  for (let c = 2; c <= 14; c++) pm.getColumn(c).width = 20;

  // ---------------------------------------------------------------- Pump curve
  pc.getCell('A1').value = 'Pump curve and system curve';
  pc.getCell('A1').font = { bold: true, size: 14 };
  pc.getCell('A2').value = `Operating point: Q = ${(analysis.flowM3s * 1000).toFixed(3)} L/s, H = ${pumpHeadSum.toFixed(3)} m`;
  ['Q [L/s]', 'Q [m3/s]', 'Pump head [m] (formula)', 'System head [m] (solver)', 'Pump - system [m]'].forEach((h, i) => {
    pc.getCell(3, i + 1).value = h;
    pc.getCell(3, i + 1).font = BOLD;
  });
  curves.forEach((c, i) => {
    const row = 4 + i;
    pc.getCell(row, 1).value = c.flowM3s * 1000;
    pc.getCell(row, 2).value = { formula: `A${row}/1000`, result: c.flowM3s };
    const terms = pumps.map((_, k) => {
      const ir = pumpInRow[k];
      return `(Inputs!$B$${ir}*Inputs!$K$${ir}^2+Inputs!$C$${ir}*Inputs!$K$${ir}*B${row}+Inputs!$D$${ir}*B${row}^2)`;
    });
    pc.getCell(row, 3).value = terms.length ? { formula: terms.join('+'), result: c.pumpHeadM } : 0;
    pc.getCell(row, 4).value = c.systemHeadM;
    pc.getCell(row, 5).value = { formula: `C${row}-D${row}`, result: c.pumpHeadM - c.systemHeadM };
  });
  pc.getCell(5 + curves.length, 1).value =
    'System head includes Colebrook-White friction at each flow (iterative), so it is a solver value; pump head is a live formula.';
  pc.getCell(5 + curves.length, 1).font = NOTE;
  for (let c = 1; c <= 5; c++) pc.getColumn(c).width = 24;
  if (x.chartPngBase64) {
    const id = wb.addImage({ base64: x.chartPngBase64, extension: 'png' });
    pc.addImage(id, { tl: { col: 6, row: 2 }, ext: { width: 720, height: 450 } });
  }
  return wb;
}

export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
