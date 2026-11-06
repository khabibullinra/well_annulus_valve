// UI приложения: панель параметров, графики, сводка, ручной и автоматический режимы.

import pumpsData from "../data/pumps.json";
import { drawLineChart, type Series, type Marker } from "./charts.js";
import type { PumpDbRecord } from "../core/esp.js";
import { EspPump, polyfitDeg2 } from "../core/esp.js";
import {
  calcWellFromPwf, solveBaselineClosed, solveBaselineOpen, solveValveScenario,
  type WellParams, type WellSolution,
} from "../core/well.js";
import { buildIprCurve } from "../core/ipr.js";
import { sweepValve, type SweepCell, type SweepResult } from "../core/sweep.js";

const PUMPS = pumpsData as unknown as PumpDbRecord[];

// ---------------------------------------------------------------------------
// Схема входных параметров
// ---------------------------------------------------------------------------

interface NumField {
  key: keyof WellParams;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  def: number;
  group: string;
}

const NUM_FIELDS: NumField[] = [
  // Пласт / IPR
  { key: "pResAtma", label: "Пластовое давление", unit: "атм", min: 10, max: 600, step: 1, def: 200, group: "Пласт (IPR Вогель)" },
  { key: "qTestSm3day", label: "Дебит тестовой точки", unit: "м3/сут", min: 1, max: 2000, step: 1, def: 90, group: "Пласт (IPR Вогель)" },
  { key: "pTestAtma", label: "Рзаб тестовой точки", unit: "атм", min: 1, max: 600, step: 1, def: 150, group: "Пласт (IPR Вогель)" },
  { key: "fwPerc", label: "Обводнённость", unit: "%", min: 0, max: 100, step: 1, def: 30, group: "Пласт (IPR Вогель)" },
  { key: "pbIprAtma", label: "Давление насыщения (0=рпл)", unit: "атм", min: 0, max: 600, step: 1, def: 0, group: "Пласт (IPR Вогель)" },
  // PVT
  { key: "gammaOil", label: "Плотность нефти", unit: "г/см3", min: 0.7, max: 1.05, step: 0.005, def: 0.86, group: "PVT" },
  { key: "gammaGas", label: "Плотность газа", unit: "возд=1", min: 0.5, max: 1.2, step: 0.01, def: 0.7, group: "PVT" },
  { key: "gammaWat", label: "Плотность воды", unit: "г/см3", min: 0.95, max: 1.2, step: 0.005, def: 1.0, group: "PVT" },
  { key: "rsbM3m3", label: "Газосодержание Rs", unit: "м3/м3", min: 0, max: 400, step: 1, def: 80, group: "PVT" },
  { key: "rpM3m3", label: "Рабочий ГФ", unit: "м3/м3", min: 0, max: 400, step: 1, def: 80, group: "PVT" },
  { key: "pbAtma", label: "Давление насыщения (0=расч.)", unit: "атм", min: 0, max: 600, step: 1, def: 100, group: "PVT" },
  { key: "bOilbM3m3", label: "Bo при Pнас (0=расч.)", unit: "м3/м3", min: 0, max: 3, step: 0.01, def: 1.2, group: "PVT" },
  { key: "muOilbCP", label: "Вязкость при Pнас (0=расч.)", unit: "сП", min: 0, max: 500, step: 0.5, def: 1, group: "PVT" },
  { key: "tResC", label: "Пластовая температура", unit: "°C", min: 10, max: 200, step: 1, def: 90, group: "PVT" },
  // Конструкция
  { key: "hPerfM", label: "Глубина перфораций", unit: "м", min: 100, max: 5000, step: 10, def: 2500, group: "Конструкция" },
  { key: "hEspM", label: "Глубина спуска ЭЦН", unit: "м", min: 100, max: 4500, step: 10, def: 2000, group: "Конструкция" },
  { key: "dTubingM", label: "Внутр. диаметр НКТ", unit: "м", min: 0.02, max: 0.15, step: 0.001, def: 0.062, group: "Конструкция" },
  { key: "dTubingOdM", label: "Наружн. диаметр НКТ", unit: "м", min: 0.025, max: 0.16, step: 0.001, def: 0.073, group: "Конструкция" },
  { key: "dCasingM", label: "Внутр. диаметр обсадной", unit: "м", min: 0.08, max: 0.35, step: 0.001, def: 0.13, group: "Конструкция" },
  // ЭЦН
  { key: "stageNum", label: "Число ступеней", unit: "", min: 10, max: 800, step: 5, def: 250, group: "ЭЦН" },
  { key: "freqHz", label: "Частота", unit: "Гц", min: 30, max: 70, step: 1, def: 50, group: "ЭЦН" },
  { key: "motorEffD", label: "КПД двигателя", unit: "д.е.", min: 0.5, max: 0.98, step: 0.01, def: 0.85, group: "ЭЦН" },
  // Клапан
  { key: "hValveM", label: "Глубина клапана", unit: "м", min: 50, max: 4000, step: 10, def: 300, group: "Газлифтный клапан" },
  { key: "dOrificeMm", label: "Диаметр отверстия", unit: "мм", min: 0.5, max: 12, step: 0.5, def: 3, group: "Газлифтный клапан" },
  { key: "cd", label: "Коэффициент расхода Cd", unit: "", min: 0.5, max: 1, step: 0.01, def: 0.85, group: "Газлифтный клапан" },
  // Режим
  { key: "pBufAtma", label: "Буферное давление", unit: "атм", min: 1, max: 100, step: 1, def: 20, group: "Режим" },
  { key: "pCasMaxAtma", label: "Макс. затрубное давление", unit: "атм", min: 1, max: 200, step: 1, def: 40, group: "Режим" },
  { key: "ksep", label: "Коэфф. сепарации на приёме", unit: "д.е.", min: 0, max: 1, step: 0.05, def: 0.5, group: "Режим" },
  { key: "tSurfC", label: "Т устья (геотерма)", unit: "°C", min: -10, max: 60, step: 1, def: 5, group: "Режим" },
  { key: "geoGradC100", label: "Геотерм. градиент", unit: "°C/100м", min: 1, max: 6, step: 0.1, def: 3, group: "Режим" },
];

const GAS_MODELS = [
  { v: 1, label: "1 — стандартный ЭЦН (~25% ГСФ)" },
  { v: 2, label: "2 — gas handler (~50%)" },
  { v: 3, label: "3 — продвинутый gas handler (~75%)" },
  { v: 4, label: "4 — с газосепаратором (~40%)" },
  { v: 0, label: "0 — без деградации" },
];

function fieldId(key: string): string { return `inp_${key}`; }

function buildInputs(): void {
  const panel = document.getElementById("inputs-panel")!;
  const groups = new Map<string, NumField[]>();
  for (const f of NUM_FIELDS) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group)!.push(f);
  }
  let html = "";
  for (const [group, fields] of groups) {
    html += `<div class="group"><div class="group-title">${group}</div>`;
    for (const f of fields) {
      html += `
        <div class="field">
          <label for="${fieldId(f.key)}">${f.label}, ${f.unit}</label>
          <input type="number" id="${fieldId(f.key)}" min="${f.min}" max="${f.max}" step="${f.step}" value="${f.def}">
        </div>`;
    }
    html += "</div>";
  }
  // селекторы; насос по умолчанию — ближайший по номиналу к тестовому дебиту
  // (только насосы со стандартной частотой 50 Гц; нестандартные помечаем)
  const qTestDef = NUM_FIELDS.find((f) => f.key === "qTestSm3day")!.def;
  const defaultPumpIdx = PUMPS.reduce(
    (best, p, i) => {
      if (p.freqHz !== 50) return best;
      if (PUMPS[best].freqHz !== 50) return i;
      return Math.abs(p.rateNom - qTestDef) < Math.abs(PUMPS[best].rateNom - qTestDef) ? i : best;
    }, 0);
  html += `
    <div class="group"><div class="group-title">PVT (прочее)</div>
      <div class="field"><label for="inp_zcor">Z-фактор</label>
        <select id="inp_zcor">
          <option value="kareem" selected>Kareem (по умолч.)</option>
          <option value="dranchuk">Dranchuk-ABK</option>
          <option value="bb">Brill-Beggs</option>
        </select></div>
    </div>
    <div class="group"><div class="group-title">ЭЦН (прочее)</div>
      <div class="field"><label for="inp_pump">Насос</label>
        <select id="inp_pump">${PUMPS.map((p, i) => `<option value="${i}"${i === defaultPumpIdx ? " selected" : ""}>${p.id} (ном. ${p.rateNom} м3/сут@${p.freqHz}Гц)</option>`).join("")}</select></div>
      <div class="field"><label for="inp_gasmodel">Модель деградации по газу</label>
        <select id="inp_gasmodel">${GAS_MODELS.map((m) => `<option value="${m.v}"${m.v === 1 ? " selected" : ""}>${m.label}</option>`).join("")}</select></div>
      <button id="btn_auto_stages" class="btn small" type="button">Авто-ступени под условия</button>
    </div>
    <div class="group"><div class="group-title">Газлифтный клапан</div>
      <div class="field checkbox"><label><input type="checkbox" id="inp_valve_enabled" checked> Клапан установлен</label></div>
    </div>`;
  panel.innerHTML = html;

  document.getElementById("btn_auto_stages")?.addEventListener("click", autoStages);
}

function autoStages(): void {
  const p = readParams();
  const db = PUMPS[pumpIndex()];
  // требуемый напор: от приёма до устья с буферным давлением, ориентировочно
  const rhoMix = 850;
  const headReq = ((p.pResAtma * 0.6 - p.pBufAtma) * 101325) / (rhoMix * 9.81) * 1.15;
  const stages = EspPump.stagesForHead(db, Math.max(headReq, 100), p.freqHz);
  (document.getElementById(fieldId("stageNum")) as HTMLInputElement).value = String(stages);
  scheduleRecalc();
}

function pumpIndex(): number {
  return parseInt((document.getElementById("inp_pump") as HTMLSelectElement).value, 10) || 0;
}

function readParams(): WellParams {
  const get = (key: string): number => parseFloat((document.getElementById(fieldId(key)) as HTMLInputElement).value) || 0;
  const p = {} as unknown as Record<string, number | string | boolean>;
  for (const f of NUM_FIELDS) p[f.key as string] = get(f.key as string);
  p.zCorrelation = (document.getElementById("inp_zcor") as HTMLSelectElement).value;
  p.pumpId = PUMPS[pumpIndex()].id;
  p.gasCorrectModel = parseInt((document.getElementById("inp_gasmodel") as HTMLSelectElement).value, 10);
  p.valveEnabled = (document.getElementById("inp_valve_enabled") as HTMLInputElement).checked;
  // согласование глубин
  const hEsp = p.hEspM as number, hPerf = p.hPerfM as number;
  if (hEsp >= hPerf) p.hPerfM = hEsp + 50;
  if ((p.hValveM as number) >= hEsp - 50) p.hValveM = Math.max(50, hEsp - 100);
  return p as unknown as WellParams;
}

// ---------------------------------------------------------------------------
// Пересчёт и отрисовка
// ---------------------------------------------------------------------------

let lastSolution: WellSolution | null = null;
let lastBaselines: { open: WellSolution; closed: WellSolution } | null = null;
let lastParams: WellParams | null = null;
let lastDb: PumpDbRecord | null = null;
let valveChartCache: { xs: number[]; qValve: number[]; qVent: number[]; version: number } | null = null;
let paramVersion = 0;
let recalcTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRecalc(): void {
  if (recalcTimer) clearTimeout(recalcTimer);
  recalcTimer = setTimeout(recalc, 250);
}

function recalc(): void {
  const p = readParams();
  const db = PUMPS[pumpIndex()];
  lastParams = p;
  lastDb = db;
  paramVersion++;

  // основной сценарий В (клапан) и базы
  let v: WellSolution;
  try {
    v = p.valveEnabled ? solveValveScenario(p, db) : solveBaselineOpen({ ...p, valveEnabled: false }, db);
  } catch (e) {
    v = { ...emptySolution(), ok: false, message: `Ошибка расчёта: ${String(e)}` };
  }
  let open: WellSolution, closed: WellSolution;
  try {
    const pnv = { ...p, valveEnabled: false };
    open = solveBaselineOpen(pnv, db);
    closed = solveBaselineClosed(pnv, db);
  } catch {
    open = emptySolution(); closed = emptySolution();
  }
  lastSolution = v;
  lastBaselines = { open, closed };
  valveChartCache = null;
  nodalChartCache = null;
  (window as unknown as Record<string, unknown>).__dbg = { params: p, solution: v, open, closed };

  renderSummary(v, open, closed);
  drawActiveTab();
}

function emptySolution(): WellSolution {
  return {
    ok: false, message: "", qLiqSm3day: 0, qOilSm3day: 0, qWatSm3day: 0,
    pwfAtma: 0, pIntakeAtma: 0, pDisAtma: 0, pBufCalcAtma: 0,
    qGasFreeIntakeSm3day: 0, qSepSm3day: 0, qValveSm3day: 0, qVentSm3day: 0,
    qGasTubingSm3day: 0, gasFracIntake: 0, gasCorr: 1, valveCritical: false,
    pCasAtma: 0, pCasEquilAtma: null, closedValveFeasible: false,
    liquidLevelM: null, gasAtIntake: false, pTubAtValveAtma: 0, pAnnAtValveAtma: 0, pAnnAtLevelAtma: null,
    pump: null, powerShaftW: 0, powerElectricW: 0, specificEnergyKwhM3: 0, headM: 0,
    profiles: { belowPump: [], tubingBottom: [], tubing: [], annulus: [] }, tDisC: 0,
  };
}

const f1 = (x: number): string => (isFinite(x) ? x.toFixed(1) : "—");
const f0 = (x: number): string => (isFinite(x) ? x.toFixed(0) : "—");
const f2 = (x: number): string => (isFinite(x) ? x.toFixed(2) : "—");
const f3 = (x: number): string => (isFinite(x) ? x.toFixed(3) : "—");

function renderSummary(v: WellSolution, open: WellSolution, closed: WellSolution): void {
  const banner = document.getElementById("status-banner")!;
  if (!v.ok) {
    banner.className = "banner bad";
    banner.textContent = `⚠ ${v.message}`;
  } else if (v.closedValveFeasible) {
    banner.className = "banner good";
    banner.textContent = `✔ Закрытая задвижка возможна: весь сепарированный газ (${f0(v.qSepSm3day)} м3/сут) уходит через клапан. Равновесное P_затр = ${f1(v.pCasAtma)} атм ≤ P_max.`;
  } else {
    banner.className = "banner warn";
    banner.textContent = `✖ Закрыть задвижку нельзя при P_max = ${f1(v.pCasAtma)} атм: клапан пропускает ${f0(v.qValveSm3day)} из ${f0(v.qSepSm3day)} м3/сут — придётся вентилировать ${f0(v.qVentSm3day)} м3/сут.`;
  }

  const cmp = (a: number, b: number): string => {
    if (!isFinite(a) || !isFinite(b) || b === 0) return "—";
    const d = a - b;
    return `${d >= 0 ? "+" : ""}${f1(d)}`;
  };

  document.getElementById("summary-cards")!.innerHTML = `
    <div class="card"><div class="k">Дебит жидкости</div><div class="v">${f1(v.qLiqSm3day)} <span class="u">м3/сут</span></div>
      <div class="s">база А: ${f1(open.qLiqSm3day)} (${cmp(v.qLiqSm3day, open.qLiqSm3day)})</div></div>
    <div class="card"><div class="k">Дебит нефти</div><div class="v">${f1(v.qOilSm3day)} <span class="u">м3/сут</span></div>
      <div class="s">база А: ${f1(open.qOilSm3day)} (${cmp(v.qOilSm3day, open.qOilSm3day)})</div></div>
    <div class="card"><div class="k">Рзаб / Рприёма</div><div class="v">${f1(v.pwfAtma)} / ${f1(v.pIntakeAtma)} <span class="u">атм</span></div>
      <div class="s">выкид насоса: ${f1(v.pDisAtma)} атм</div></div>
    <div class="card"><div class="k">ГСФ на приёме</div><div class="v">${(v.gasFracIntake * 100).toFixed(1)} <span class="u">%</span></div>
      <div class="s">деградация напора ×${f2(v.gasCorr)}; база Б: ${(closed.gasFracIntake * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="k">Мощность ЭЦН</div><div class="v">${f1(v.powerShaftW / 1000)} <span class="u">кВт</span></div>
      <div class="s">эл. (с двигателем): ${f1(v.powerElectricW / 1000)} кВт</div></div>
    <div class="card"><div class="k">Удельная энергия</div><div class="v">${f3(v.specificEnergyKwhM3)} <span class="u">кВт·ч/м3</span></div>
      <div class="s">база А: ${f3(open.specificEnergyKwhM3)}</div></div>
    <div class="card"><div class="k">Газ: клапан / сеп / вент</div><div class="v">${f0(v.qValveSm3day)} / ${f0(v.qSepSm3day)} / ${f0(v.qVentSm3day)} <span class="u">м3/сут</span></div>
      <div class="s">${v.valveCritical ? "клапан — критический режим" : "клапан — докритический режим"}</div></div>
    <div class="card"><div class="k">P_затр расч. / устье затр.</div><div class="v">${f1(v.pCasAtma)} <span class="u">атм</span></div>
      <div class="s">уровень в затрубе: ${v.liquidLevelM != null ? f0(v.liquidLevelM) + " м" : "жидкость до устья"}${v.gasAtIntake ? " ⚠ газ у приёма" : ""}</div></div>
  `;
}

// ---------------------------------------------------------------------------
// Графики по вкладкам
// ---------------------------------------------------------------------------

function drawActiveTab(): void {
  const active = document.querySelector(".tab.active") as HTMLElement;
  if (!active) return;
  const id = active.dataset.tab!;
  const panels = { profiles: drawProfiles, nodal: drawNodal, pump: drawPump, valve: drawValve, sweep: null };
  const fn = panels[id as keyof typeof panels];
  if (fn) fn();
}

function drawProfiles(): void {
  if (!lastSolution || !lastParams) return;
  const v = lastSolution, p = lastParams;
  const prof = v.profiles;

  // давление: НКТ (верхний + нижний участки), затруб, ниже насоса
  const tubing = [...prof.tubingBottom, ...prof.tubing];
  const mkSeries = (nodes: typeof prof.tubing, color: string, label: string): Series => ({
    xs: nodes.map((n) => n.pAtma), ys: nodes.map((n) => n.zM), color, label,
  });
  const series: Series[] = [];
  if (tubing.length > 1) series.push(mkSeries(tubing, "#1565c0", "НКТ"));
  // затруб: две части — газовая шапка (барометрика, сплошная) и барботаж через жидкость (пунктир)
  if (prof.annulus.length > 1) {
    const lv = v.liquidLevelM;
    if (lv != null) {
      const gasPart = prof.annulus.filter((n) => n.zM <= lv + 1e-6);
      const liqPart = prof.annulus.filter((n) => n.zM >= lv - 1e-6);
      if (gasPart.length > 1) series.push(mkSeries(gasPart, "#2e7d32", "затруб: газовая шапка"));
      if (liqPart.length > 1) series.push({ ...mkSeries(liqPart, "#66bb6a", "затруб: барботаж"), dashed: true });
    } else {
      series.push(mkSeries(prof.annulus, "#2e7d32", "затруб (барботаж)"));
    }
  }
  if (prof.belowPump.length > 1) series.push(mkSeries(prof.belowPump, "#6a1b9a", "ниже насоса"));

  drawLineChart({
    canvas: document.getElementById("chart-p") as HTMLCanvasElement,
    xLabel: "Давление, атм", yLabel: "Глубина, м", series,
    yInverted: true, yMin: 0, yMax: p.hPerfM + 100,
    vlines: [
      ...(p.valveEnabled ? [{ x: v.pAnnAtValveAtma, label: "", color: "#999" }] : []),
    ],
    markers: [
      ...(p.valveEnabled ? [{ x: v.pAnnAtValveAtma, y: p.hValveM, color: "#e65100", label: `клапан ${f1(p.hValveM)} м` }] : []),
      { x: v.pIntakeAtma, y: p.hEspM, color: "#1565c0", label: `ЭЦН ${f0(p.hEspM)} м` },
      // уровень: точка лежит НА линии затруба — x = P на уровне (устьевое + вес шапки)
      ...(v.liquidLevelM != null
        ? [{
            x: v.pAnnAtLevelAtma ?? v.pCasAtma, y: v.liquidLevelM, color: "#2e7d32",
            label: `уровень ${f0(v.liquidLevelM)} м, P=${f1(v.pAnnAtLevelAtma ?? v.pCasAtma)} атм`,
          }]
        : []),
      // устьевое затрубное давление — верх газовой шапки, тоже на линии
      ...(v.profiles.annulus.length > 1
        ? [{ x: v.pCasAtma, y: 0, color: "#2e7d32", label: `P_затр ${f1(v.pCasAtma)} атм` }]
        : []),
    ],
  });

  // температура (геотерма по всему стволу)
  const zs: number[] = [], ts: number[] = [];
  for (let z = 0; z <= p.hPerfM; z += 50) { zs.push(z); ts.push(p.tSurfC + (p.geoGradC100 * z) / 100); }
  drawLineChart({
    canvas: document.getElementById("chart-t") as HTMLCanvasElement,
    xLabel: "Температура, °C", yLabel: "Глубина, м",
    series: [{ xs: ts, ys: zs, color: "#d84315", label: "T (геотерма)" }],
    yInverted: true, yMin: 0, yMax: p.hPerfM + 100,
    markers: [
      ...(p.valveEnabled ? [{ x: p.tSurfC + (p.geoGradC100 * p.hValveM) / 100, y: p.hValveM, color: "#e65100" }] : []),
      { x: p.tSurfC + (p.geoGradC100 * p.hEspM) / 100, y: p.hEspM, color: "#1565c0" },
    ],
  });

  // истинное газосодержание: НКТ, затруб (шапка + барботаж), ниже насоса
  const at = [...prof.tubingBottom, ...prof.tubing];
  const alphaSeries: Series[] = [];
  if (at.length > 1) alphaSeries.push({ xs: at.map((n) => n.alpha), ys: at.map((n) => n.zM), color: "#ef6c00", label: "НКТ" });
  if (prof.annulus.length > 1) {
    const lv = v.liquidLevelM;
    if (lv != null) {
      const gasPart = prof.annulus.filter((n) => n.zM <= lv + 1e-6);
      const liqPart = prof.annulus.filter((n) => n.zM >= lv - 1e-6);
      if (gasPart.length > 1) alphaSeries.push({ xs: gasPart.map((n) => n.alpha), ys: gasPart.map((n) => n.zM), color: "#2e7d32", label: "затруб: шапка (α=1)" });
      if (liqPart.length > 1) alphaSeries.push({ xs: liqPart.map((n) => n.alpha), ys: liqPart.map((n) => n.zM), color: "#66bb6a", label: "затруб: барботаж", dashed: true });
    } else {
      alphaSeries.push({ xs: prof.annulus.map((n) => n.alpha), ys: prof.annulus.map((n) => n.zM), color: "#2e7d32", label: "затруб (барботаж)" });
    }
  }
  if (prof.belowPump.length > 1) {
    alphaSeries.push({ xs: prof.belowPump.map((n) => n.alpha), ys: prof.belowPump.map((n) => n.zM), color: "#6a1b9a", label: "ниже насоса" });
  }
  if (alphaSeries.length > 0) {
    drawLineChart({
      canvas: document.getElementById("chart-alpha") as HTMLCanvasElement,
      xLabel: "Истинное газосодержание, д.е.", yLabel: "Глубина, м",
      series: alphaSeries,
      yInverted: true, yMin: 0, yMax: p.hPerfM + 100, xMin: 0,
    });
  }
}

export interface VlpResult { qs: number[]; pwfs: number[]; powersKW: number[] }

/**
 * VLP-кривая: pwf, требуемый для подъёма q при заданном p_buf; попутно электрическая
 * мощность ЭЦН в каждой точке. valveEnabled=false даёт базовую кривую без клапана.
 */
function computeVlp(p: WellParams, db: PumpDbRecord, frozenQValve: number | null, valveEnabled: boolean): VlpResult {
  const qs: number[] = [], pwfs: number[] = [], powersKW: number[] = [];
  const pRun: WellParams = valveEnabled ? p : { ...p, valveEnabled: false };
  const qMax = Math.max(p.qTestSm3day * 2, 50);
  const mode = {
    pCasAtma: valveEnabled && lastSolution?.closedValveFeasible ? lastSolution.pCasAtma : p.pCasMaxAtma,
    ksepEff: p.ksep,
    qValveOverride: frozenQValve,
  };
  for (let i = 1; i <= 12; i++) {
    const q = (qMax * i) / 12;
    let lo = 1, hi = pRun.pResAtma;
    const g = (pwf: number) => calcWellFromPwf(pwf, pRun, db, { ...mode, qLiqOverride: q }).pBufCalcAtma - pRun.pBufAtma;
    if (g(hi) < 0) continue; // не поднимает
    for (let k = 0; k < 18; k++) {
      const mid = 0.5 * (lo + hi);
      if (g(mid) > 0) hi = mid; else lo = mid;
      if (hi - lo < 0.1) break;
    }
    const pwf = 0.5 * (lo + hi);
    const sol = calcWellFromPwf(pwf, pRun, db, { ...mode, qLiqOverride: q });
    qs.push(q);
    pwfs.push(pwf);
    powersKW.push(sol.powerElectricW / 1000);
  }
  return { qs, pwfs, powersKW };
}

interface NodalCache { version: number; withValve: VlpResult; noValve: VlpResult }
let nodalChartCache: NodalCache | null = null;

function drawNodal(): void {
  if (!lastSolution || !lastParams || !lastDb || !lastBaselines) return;
  const v = lastSolution, p = lastParams, db = lastDb;
  const ipr = buildIprCurve({
    pResAtma: p.pResAtma, pbAtma: p.pbIprAtma, qTestSm3day: p.qTestSm3day,
    pTestAtma: p.pTestAtma, fwPerc: p.fwPerc,
  }, 60);
  // кэш двух кривых подъёма: пересчёт только при изменении параметров
  if (nodalChartCache === null || nodalChartCache.version !== paramVersion) {
    const withValve = p.valveEnabled
      ? computeVlp(p, db, v.qValveSm3day, true)
      : computeVlp(p, db, null, false);
    const noValve = computeVlp(p, db, null, false);
    nodalChartCache = { version: paramVersion, withValve, noValve };
  }
  const vlpV = nodalChartCache.withValve;
  const vlpN = nodalChartCache.noValve;

  const nodalSeries: Series[] = [
    { xs: ipr.map((q) => q.qSm3day), ys: ipr.map((q) => q.pwfAtma), color: "#2e7d32", label: "IPR (Вогель)" },
    {
      xs: vlpV.qs, ys: vlpV.pwfs, color: "#1565c0",
      label: p.valveEnabled ? "Подъём (с клапаном)" : "Подъём (VLP)",
    },
  ];
  const nodalMarkers: Marker[] = [];
  if (v.ok) {
    nodalMarkers.push({ x: v.qLiqSm3day, y: v.pwfAtma, color: "#e65100", label: "рабочая точка", labelDy: -12 });
  }
  if (p.valveEnabled) {
    nodalSeries.push({ xs: vlpN.qs, ys: vlpN.pwfs, color: "#546e7a", label: "Подъём (без клапана)", dashed: true });
    if (lastBaselines.open.ok && lastBaselines.open.qLiqSm3day > 0) {
      nodalMarkers.push({
        x: lastBaselines.open.qLiqSm3day, y: lastBaselines.open.pwfAtma,
        color: "#546e7a", label: "точка без клапана", labelDy: 18, labelSide: "left",
      });
    }
  }
  drawLineChart({
    canvas: document.getElementById("chart-nodal") as HTMLCanvasElement,
    xLabel: "Дебит жидкости, м3/сут", yLabel: "Забойное давление, атм",
    series: nodalSeries, markers: nodalMarkers,
  });

  // энергопотребление от дебита
  const powerSeries: Series[] = [
    {
      xs: vlpV.qs, ys: vlpV.powersKW, color: "#c62828",
      label: p.valveEnabled ? "С клапаном" : "Мощность",
    },
  ];
  const powerMarkers: Marker[] = [];
  if (v.ok && vlpV.qs.length > 0) {
    powerMarkers.push({ x: v.qLiqSm3day, y: v.powerElectricW / 1000, color: "#e65100", label: "рабочая точка", labelDy: -12 });
  }
  if (p.valveEnabled) {
    powerSeries.push({ xs: vlpN.qs, ys: vlpN.powersKW, color: "#546e7a", label: "Без клапана", dashed: true });
    if (lastBaselines.open.ok && lastBaselines.open.qLiqSm3day > 0) {
      powerMarkers.push({
        x: lastBaselines.open.qLiqSm3day, y: lastBaselines.open.powerElectricW / 1000,
        color: "#546e7a", label: "точка без клапана", labelDy: 18, labelSide: "left",
      });
    }
  }
  drawLineChart({
    canvas: document.getElementById("chart-power") as HTMLCanvasElement,
    xLabel: "Дебит жидкости, м3/сут", yLabel: "Эл. мощность, кВт",
    series: powerSeries, markers: powerMarkers,
  });
}

function drawPump(): void {
  if (!lastSolution || !lastParams || !lastDb || !lastSolution.pump) return;
  const v = lastSolution, p = lastParams, db = lastDb;
  const pumpRes = lastSolution.pump;
  const b = db.freqHz / p.freqHz;
  const qMax = (db.rateMax * p.freqHz) / db.freqHz;
  const qs: number[] = [], heads: number[] = [], headsGas: number[] = [], powers: number[] = [], effs: number[] = [];
  const stages = p.stageNum;
  const gc = v.gasCorr;
  const rhoMixRef = pumpRes.rhoMixIntakeKgm3 || 900;
  for (let i = 0; i <= 60; i++) {
    const q = (qMax * 1.02 * i) / 60;
    const h1 = curveAt(db.ratePoints, db.headPoints, q * b);
    const pw = curveAt(db.ratePoints, db.powerPoints, q * b);
    const ef = curveAt(db.ratePoints, db.effPoints, q * b);
    qs.push(q);
    heads.push(b ** -2 * stages * h1);
    headsGas.push(b ** -2 * stages * h1 * Math.max(gc, 0));
    powers.push(1000 * b ** -3 * stages * pw * rhoMixRef / 1000);
    effs.push(Math.max(0, ef));
  }
  const op = pumpRes;
  drawLineChart({
    canvas: document.getElementById("chart-pump-head") as HTMLCanvasElement,
    xLabel: "Расход смеси, м3/сут", yLabel: "Напор, м",
    series: [
      { xs: qs, ys: heads, color: "#1565c0", label: `напор ${stages} ступ. (вода)` },
      { xs: qs, ys: headsGas, color: "#8e24aa", label: `с деградацией ×${f2(gc)}`, dashed: true },
    ],
    markers: [{ x: op.qMixRcM3day, y: op.headM, color: "#e65100", label: "рабочая точка" }],
  });
  drawLineChart({
    canvas: document.getElementById("chart-pump-power") as HTMLCanvasElement,
    xLabel: "Расход смеси, м3/сут", yLabel: "Мощность, кВт",
    series: [{ xs: qs, ys: powers.map((w) => w / 1000), color: "#c62828", label: "мощность (вал)" }],
    markers: [{ x: op.qMixRcM3day, y: op.powerShaftW / 1000, color: "#e65100", label: "рабочая точка" }],
  });
  drawLineChart({
    canvas: document.getElementById("chart-pump-eff") as HTMLCanvasElement,
    xLabel: "Расход смеси, м3/сут", yLabel: "КПД, д.е.",
    series: [{ xs: qs, ys: effs, color: "#2e7d32", label: "КПД по кривой" }],
    markers: [{ x: op.qMixRcM3day, y: op.effD, color: "#e65100", label: `КПД факт. ${f2(op.effD)}` }],
  });
}

/** Оценка кривой насоса полиномом deg-2 (как в EspPump). */
const curveCacheUi = new Map<string, number[]>();
function curveAt(xs: number[], ys: number[], x: number): number {
  const key = xs.join(",") + "|" + ys.join(",");
  let c = curveCacheUi.get(key);
  if (!c) { c = polyfitDeg2(xs, ys); curveCacheUi.set(key, c); }
  return c[0] + c[1] * x + c[2] * x * x;
}

function drawValve(): void {
  if (!lastSolution || !lastParams || !lastDb) return;
  const v = lastSolution, p = lastParams, db = lastDb;

  // кривая q_valve(P_cas) при зафиксированном режиме скважины (pwf из решения)
  if (valveChartCache === null || valveChartCache.version !== paramVersion) {
    const xs: number[] = [], qValve: number[] = [], qVent: number[] = [];
    const pwfFrozen = v.ok ? v.pwfAtma : 100;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const pc = 2 + ((p.pCasMaxAtma - 2) * i) / (n - 1);
      try {
        const sol = calcWellFromPwf(pwfFrozen, p, db, { pCasAtma: pc, ksepEff: p.ksep });
        xs.push(pc);
        qValve.push(sol.qValveSm3day);
        qVent.push(Math.max(0, sol.qSepSm3day - sol.qValveSm3day));
      } catch { /* пропускаем точку */ }
    }
    valveChartCache = { xs, qValve, qVent, version: paramVersion };
  }
  const qc = valveChartCache;
  drawLineChart({
    canvas: document.getElementById("chart-valve") as HTMLCanvasElement,
    xLabel: "P_затр (устье затруба), атм", yLabel: "Расход газа, м3/сут",
    series: [
      { xs: qc.xs, ys: qc.qValve, color: "#1565c0", label: "через клапан" },
      { xs: qc.xs, ys: qc.qVent, color: "#c62828", label: "вентиляция (остаток)", dashed: true },
    ],
    hlines: [
      { y: v.qSepSm3day, label: `сепарированный ${f0(v.qSepSm3day)}`, color: "#2e7d32" },
    ],
    vlines: [
      { x: p.pCasMaxAtma, label: "P_max", color: "#e65100" },
      ...(v.pCasEquilAtma != null ? [{ x: v.pCasEquilAtma, label: "равновесие", color: "#2e7d32" }] : []),
    ],
    markers: v.ok && p.valveEnabled
      ? [{ x: v.pCasAtma, y: v.qValveSm3day, color: "#e65100", label: "текущая точка" }]
      : [],
  });

  // распределение давления вокруг клапана: P_затр и P_НКТ на глубине клапана
  document.getElementById("valve-detail")!.innerHTML = `
    <table class="kv">
      <tr><td>Глубина клапана</td><td>${f0(p.hValveM)} м</td><td>Диаметр отверстия</td><td>${f1(p.dOrificeMm)} мм (Cd=${f2(p.cd)})</td></tr>
      <tr><td>P_затр на клапане</td><td>${f1(v.pAnnAtValveAtma)} атм</td><td>P_НКТ на клапане</td><td>${f1(v.pTubAtValveAtma)} атм</td></tr>
      <tr><td>Перепад ΔP</td><td>${f1(v.pAnnAtValveAtma - v.pTubAtValveAtma)} атм</td><td>Режим</td><td>${v.valveCritical ? "критический" : "докритический"}</td></tr>
      <tr><td>Уровень жидкости в затрубе</td><td>${v.liquidLevelM != null ? f0(v.liquidLevelM) + " м" : "жидкость до устья"}</td>
          <td>Состояние клапана</td><td>${v.qValveSm3day > 1 ? "открыт, " + f0(v.qValveSm3day) + " м3/сут" : "закрыт"}</td></tr>
    </table>`;
}

// ---------------------------------------------------------------------------
// Sweep (автоматический поиск)
// ---------------------------------------------------------------------------

let sweepRunning = false;

async function runSweep(): Promise<void> {
  if (sweepRunning || !lastParams || !lastDb) return;
  sweepRunning = true;
  const p0 = readParams();
  const db = lastDb;

  const hvMin = parseFloat((document.getElementById("sw_hv_min") as HTMLInputElement).value);
  const hvMax = parseFloat((document.getElementById("sw_hv_max") as HTMLInputElement).value);
  const hvN = Math.max(2, parseInt((document.getElementById("sw_hv_n") as HTMLInputElement).value, 10));
  const dMin = parseFloat((document.getElementById("sw_d_min") as HTMLInputElement).value);
  const dMax = parseFloat((document.getElementById("sw_d_max") as HTMLInputElement).value);
  const dN = Math.max(2, parseInt((document.getElementById("sw_d_n") as HTMLInputElement).value, 10));

  const hValveList: number[] = [];
  for (let i = 0; i < hvN; i++) hValveList.push(hvMin + ((hvMax - hvMin) * i) / (hvN - 1));
  const dOrificeList: number[] = [];
  for (let i = 0; i < dN; i++) dOrificeList.push(+(dMin + ((dMax - dMin) * i) / (dN - 1)).toFixed(2));

  const progress = document.getElementById("sweep-progress")!;
  const bar = document.getElementById("sweep-bar")!;
  progress.style.display = "block";
  bar.style.width = "0%";

  // chunked выполнение: по 1 ячейке на кадр
  const cells: SweepCell[] = [];
  const total = hValveList.length * dOrificeList.length;
  let done = 0;
  const pSweep: WellParams = { ...p0, nSegTubing: 18, nSegBelow: 6 };
  const baselines = lastBaselines!;
  for (const hv of hValveList) {
    for (const d of dOrificeList) {
      const res = sweepValve(
        { ...pSweep, valveEnabled: true, hValveM: hv, dOrificeMm: d },
        db, [hv], [d], undefined, { open: baselines.open, closed: baselines.closed },
      );
      cells.push(...res.cells);
      done++;
      bar.style.width = `${((done / total) * 100).toFixed(0)}%`;
      bar.textContent = `${done}/${total}`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const result: SweepResult = {
    cells, hValveList, dOrificeList,
    baselineOpen: lastBaselines!.open,
    baselineClosed: lastBaselines!.closed,
    bestOil: null, bestEnergy: null,
  };
  const closedCells = cells.filter((c) => c.ok && c.closedValveFeasible && c.qLiqSm3day > 0);
  const working = closedCells.length > 0 ? closedCells : cells.filter((c) => c.ok && c.qLiqSm3day > 0);
  result.bestOil = working.length ? working.reduce((a, b) => (b.qOilSm3day > a.qOilSm3day ? b : a)) : null;
  result.bestEnergy = working.length ? working.reduce((a, b) => (b.specificEnergyKwhM3 < a.specificEnergyKwhM3 ? b : a)) : null;

  renderSweep(result);
  progress.style.display = "none";
  sweepRunning = false;
}

function renderSweep(res: SweepResult): void {
  const el = document.getElementById("sweep-results")!;
  const { hValveList, dOrificeList, cells } = res;
  const cellByKey = new Map<string, SweepCell>();
  for (const c of cells) cellByKey.set(`${c.hValveM}|${c.dOrificeMm}`, c);
  const maxQ = Math.max(...cells.map((c) => c.qOilSm3day), 1);

  const isBest = (c: SweepCell): boolean =>
    (res.bestOil !== null && c.hValveM === res.bestOil.hValveM && c.dOrificeMm === res.bestOil.dOrificeMm) ||
    (res.bestEnergy !== null && c.hValveM === res.bestEnergy.hValveM && c.dOrificeMm === res.bestEnergy.dOrificeMm);

  let html = `<table class="sweep"><tr><th>Глубина \\ Ø, мм</th>${dOrificeList.map((d) => `<th>${f1(d)}</th>`).join("")}</tr>`;
  for (const hv of hValveList) {
    html += `<tr><th>${f0(hv)} м</th>`;
    for (const d of dOrificeList) {
      const c = cellByKey.get(`${hv}|${d}`);
      if (!c) { html += "<td></td>"; continue; }
      const lightness = c.ok && c.qOilSm3day > 0 ? 92 - 40 * (c.qOilSm3day / maxQ) : 96;
      const cls = !c.ok ? "sweep-bad" : c.closedValveFeasible ? "sweep-ok" : "sweep-vent";
      const title = `q_н=${f1(c.qOilSm3day)} м3/сут; E=${f3(c.specificEnergyKwhM3)} кВт·ч/м3; вент=${f0(c.qVentSm3day)}; P_затр=${f1(c.pCasAtma)}`;
      html += `<td class="${cls} sweep-cell${isBest(c) ? " sweep-best" : ""}" style="background:hsl(120,55%,${lightness}%)"
        data-hv="${hv}" data-d="${d}" title="${title}">${c.ok ? f0(c.qOilSm3day) : "—"}</td>`;
    }
    html += "</tr>";
  }
  html += "</table>";
  html += `<div class="sweep-legend">
    <span class="lg lg-ok">зелёные — закрытие задвижки возможно</span>
    <span class="lg lg-vent">жёлтые — требуется вентиляция</span>
    <span class="lg lg-bad">серые — режим неустойчив</span>
    <span class="lg">★ — лучший по нефти / по энергии</span>
    <span class="lg">клик по ячейке — применить параметры</span></div>`;
  if (res.bestOil) {
    html += `<div class="sweep-best-info">Лучший по нефти: клапан ${f0(res.bestOil.hValveM)} м × Ø${f1(res.bestOil.dOrificeMm)} мм —
      q_нефти ${f1(res.bestOil.qOilSm3day)} м3/сут, энергия ${f3(res.bestOil.specificEnergyKwhM3)} кВт·ч/м3
      ${res.bestEnergy && res.bestEnergy !== res.bestOil
        ? `| Лучший по энергии: ${f0(res.bestEnergy.hValveM)} м × Ø${f1(res.bestEnergy.dOrificeMm)} мм — ${f3(res.bestEnergy.specificEnergyKwhM3)} кВт·ч/м3` : ""}
      | База А (вентиляция): q_нефти ${f1(res.baselineOpen.qOilSm3day)}, энергия ${f3(res.baselineOpen.specificEnergyKwhM3)} кВт·ч/м3</div>`;
  }
  el.innerHTML = html;

  el.querySelectorAll<HTMLTableCellElement>(".sweep-cell").forEach((td) => {
    td.addEventListener("click", () => {
      const hv = td.dataset.hv, d = td.dataset.d;
      if (!hv || !d) return;
      (document.getElementById(fieldId("hValveM")) as HTMLInputElement).value = hv;
      (document.getElementById(fieldId("dOrificeMm")) as HTMLInputElement).value = d;
      (document.getElementById("inp_valve_enabled") as HTMLInputElement).checked = true;
      scheduleRecalc();
      activateTab("profiles");
    });
  });
}

// ---------------------------------------------------------------------------
// Вкладки и инициализация
// ---------------------------------------------------------------------------

function activateTab(id: string): void {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === id);
  });
  document.querySelectorAll<HTMLElement>(".tab-panel").forEach((pn) => {
    pn.classList.toggle("active", pn.id === `panel-${id}`);
  });
  drawActiveTab();
}

function init(): void {
  buildInputs();
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    t.addEventListener("click", () => activateTab(t.dataset.tab!));
  });
  const panel = document.getElementById("inputs-panel")!;
  panel.addEventListener("input", scheduleRecalc);
  panel.addEventListener("change", scheduleRecalc);
  document.getElementById("btn_recalc")!.addEventListener("click", recalc);
  document.getElementById("btn_sweep_run")!.addEventListener("click", runSweep);
  recalc();
}

init();
