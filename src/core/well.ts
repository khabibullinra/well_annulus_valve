// Сквозной решатель скважины: IPR -> поток ниже насоса -> сепарация -> ЭЦН ->
// НКТ (с клапаном) -> затруб -> согласование буферного давления (бисекция по pwf),
// равновесия клапана (неподвижная точка по q_valve) и закрытой задвижки
// (бисекция по P_cas: q_valve = q_sep).

import { Feed, feedModAfterSeparation } from "./feed.js";
import { traverseUp, type TraverseNode } from "./driftflux.js";
import { EspPump, type EspCalcResult, type GasCorrectModel, type PumpDbRecord } from "./esp.js";
import { valveGasRateSm3day } from "./valve.js";
import { solveAnnulus, type AnnulusResult } from "./annulus.js";
import { vogelQLiqSm3day, type IprParams } from "./ipr.js";
import type { ZCorrelation } from "./pvt.js";

export type { PumpDbRecord };

/** Параметры скважины (все в atma, °C, ст.м3/сут, м). */
export interface WellParams {
  // PVT флюида
  gammaGas: number;
  gammaOil: number;
  gammaWat: number;
  rsbM3m3: number;
  rpM3m3: number; // рабочий ГФ, м3/м3
  pbAtma: number; // <=0 — расчётное
  bOilbM3m3: number; // <=0 — расчётный
  muOilbCP: number; // <=0 — расчётная
  tResC: number;
  zCorrelation: ZCorrelation;
  // IPR (Вогель)
  pResAtma: number;
  pbIprAtma: number; // <=0 => p_res
  qTestSm3day: number;
  pTestAtma: number;
  fwPerc: number; // %
  // конструкция
  hPerfM: number; // глубина перфораций
  hEspM: number; // глубина спуска насоса (приём)
  dTubingM: number; // внутренний диаметр НКТ, м
  dTubingOdM: number; // наружный диаметр НКТ, м
  dCasingM: number; // внутренний диаметр обсадной колонны, м
  // ЭЦН
  pumpId: string;
  stageNum: number;
  freqHz: number;
  gasCorrectModel: GasCorrectModel;
  motorEffD: number; // КПД двигателя
  // газлифтный клапан
  valveEnabled: boolean;
  hValveM: number;
  dOrificeMm: number;
  cd: number;
  // граничные условия
  pBufAtma: number; // буферное давление (жёсткое)
  pCasMaxAtma: number; // предельное затрубное давление
  ksep: number; // коэффициент сепарации на приёме (постоянный)
  // геотерма
  tSurfC: number;
  geoGradC100: number; // °C/100 м
  // качество расчёта
  nSegTubing?: number;
  nSegBelow?: number;
}

export interface WellProfileSet {
  belowPump: TraverseNode[]; // перфорации -> приём (обсадная)
  tubingBottom: TraverseNode[]; // приём -> клапан (если клапан есть, иначе пусто)
  tubing: TraverseNode[]; // приём (или клапан) -> устье
  annulus: TraverseNode[]; // приём -> устье (барботаж)
}

export interface WellSolution {
  ok: boolean;
  message: string;
  // режимные показатели
  qLiqSm3day: number;
  qOilSm3day: number;
  qWatSm3day: number;
  pwfAtma: number;
  pIntakeAtma: number;
  pDisAtma: number;
  pBufCalcAtma: number;
  // газ
  qGasFreeIntakeSm3day: number; // свободный газ на приёме (всего)
  qSepSm3day: number; // сепарированный в затруб
  qValveSm3day: number; // через клапан
  qVentSm3day: number; // вентилируемый через задвижку
  qGasTubingSm3day: number; // газ в НКТ (на приёме насоса)
  gasFracIntake: number; // ГСФ на приёме насоса
  gasCorr: number; // коэффициент деградации
  valveCritical: boolean;
  // затруб
  pCasAtma: number;
  pCasEquilAtma: number | null; // равновесное затрубное для закрытой задвижки
  closedValveFeasible: boolean;
  liquidLevelM: number | null;
  gasAtIntake: boolean;
  pTubAtValveAtma: number;
  pAnnAtValveAtma: number;
  // ЭЦН
  pump: EspCalcResult | null;
  powerShaftW: number;
  powerElectricW: number;
  specificEnergyKwhM3: number; // кВт·ч/м3 жидкости
  headM: number;
  // профили
  profiles: WellProfileSet;
  tDisC: number;
}

const geoT = (p: WellParams) => (z: number) => p.tSurfC + (p.geoGradC100 * z) / 100;

function makeFeed(p: WellParams, qLiqSm3day: number): Feed {
  return new Feed({
    gammaGas: p.gammaGas, gammaOil: p.gammaOil, gammaWat: p.gammaWat,
    rsbM3m3: p.rsbM3m3, rpM3m3: p.rpM3m3,
    pbAtma: p.pbAtma, bOilbM3m3: p.bOilbM3m3, muOilbCP: p.muOilbCP,
    tResC: p.tResC, zCorrelation: p.zCorrelation,
    qLiqSm3day: qLiqSm3day, fwFr: p.fwPerc / 100, qGasFreeSm3day: 0,
  });
}

export interface CalcMode {
  /** затрубное давление (заданное) или null — свободное (расчёт равновесия) */
  pCasAtma: number | null;
  /** эффективный коэффициент сепарации (0 — весь газ в насос, сценарий Б) */
  ksepEff: number;
  /** фиксированный расход через клапан (ст.м3/сут) или null — из уравнения клапана */
  qValveOverride?: number | null;
}

/**
 * Один проход расчёта от pwf. Возвращает решение с согласованным клапаном
 * (неподвижная точка по q_valve) и затрубом. p_buf_calc — результат, согласование
 * с буферным давлением — внешняя бисекция (solveWell).
 */
export function calcWellFromPwf(
  pwfAtma: number, p: WellParams, pumpDb: PumpDbRecord, mode: CalcMode,
): WellSolution {
  const tGeo = geoT(p);
  const tIntake = tGeo(p.hEspM);
  const ipr: IprParams = {
    pResAtma: p.pResAtma, pbAtma: p.pbIprAtma,
    qTestSm3day: p.qTestSm3day, pTestAtma: p.pTestAtma, fwPerc: p.fwPerc,
  };
  const qLiq = vogelQLiqSm3day(pwfAtma, ipr);
  const feedBelow = makeFeed(p, qLiq);
  const qOil = qLiq * (1 - p.fwPerc / 100);
  const qWat = qLiq * (p.fwPerc / 100);

  // --- поток ниже насоса: перфорации -> приём (обсадная колонна, полный ГФ) ---
  const belowNodes = traverseUp({
    pBottomAtma: Math.max(pwfAtma, 1.0),
    zBottomM: p.hPerfM, zTopM: p.hEspM,
    dM: p.dCasingM,
    qLiqSm3day: qLiq,
    qGasFreeAtP: (pp, tt) => feedBelow.calc(pp, tt).qGasInsituSm3day,
    liquidAtP: (pp, tt) => {
      const s = feedBelow.calc(pp, tt);
      return { rhoKgm3: s.rhoLiqRcKgm3, muCP: s.muLiqCP };
    },
    gammaGas: p.gammaGas, zCorrelation: p.zCorrelation,
    tAtDepthC: tGeo, sigmaNm: feedBelow.calc(Math.max(pwfAtma, 5), tGeo(p.hEspM)).sigmaLiqGasNm,
    nSeg: p.nSegBelow ?? 10,
  });
  const pIntake = belowNodes[belowNodes.length - 1].pAtma;

  // --- сепарация на приёме ---
  const stIntake = feedBelow.calc(pIntake, tIntake);
  const qGasFreeIntake = stIntake.qGasInsituSm3day;
  const ksepEff = mode.ksepEff;
  const qSep = ksepEff * qGasFreeIntake;
  const pumpFeed = ksepEff > 0 ? feedModAfterSeparation(feedBelow, pIntake, tIntake, ksepEff) : feedBelow;

  // --- ЭЦН ---
  const esp = new EspPump(pumpDb, {
    stageNum: p.stageNum, freqHz: p.freqHz, gasCorrectModel: p.gasCorrectModel,
  });
  const pump = esp.calcEsp(pumpFeed, pIntake, tIntake, tIntake); // T = геотерма, нагрев не учитываем
  const pDis = pump.pDisAtma;

  // --- НКТ: марш вверх от выкида насоса ---
  const nSegT = p.nSegTubing ?? 40;
  const liquidAtP = (pp: number, tt: number) => {
    const s = pumpFeed.calc(pp, tt);
    return { rhoKgm3: s.rhoLiqRcKgm3, muCP: s.muLiqCP };
  };
  const gasFreeAtP = (pp: number, tt: number) => pumpFeed.calc(pp, tt).qGasInsituSm3day;
  const sigmaNm = pumpFeed.calc(pDis, tIntake).sigmaLiqGasNm;

  const valveOn = p.valveEnabled && p.hValveM > 0 && p.hValveM < p.hEspM;
  const traverseCommon = {
    dM: p.dTubingM,
    qLiqSm3day: qLiq,
    liquidAtP, gammaGas: p.gammaGas, zCorrelation: p.zCorrelation,
    tAtDepthC: tGeo, sigmaNm, nSeg: nSegT,
  };

  // неподвижная точка по q_valve
  const qSepFixed = qSep;
  let qValve = mode.qValveOverride ?? 0;
  let tubingBottom: TraverseNode[] = [];
  let tubingTop: TraverseNode[] = [];
  let annulus: AnnulusResult | null = null;
  let valveCritical = false;
  let pTubAtValve = 0;
  let pAnnAtValve = 0;

  const nIter = mode.qValveOverride != null ? 1 : valveOn ? 10 : 1;
  for (let it = 0; it < nIter; it++) {
    const qGasValveNow = valveOn ? Math.max(0, qValve) : 0;

    // нижний участок НКТ (приём -> клапан): газ насоса
    if (valveOn) {
      tubingBottom = traverseUp({
        ...traverseCommon,
        pBottomAtma: Math.max(pDis, 1.0),
        zBottomM: p.hEspM, zTopM: p.hValveM,
        qGasFreeAtP: gasFreeAtP,
        nSeg: Math.max(4, Math.round(nSegT * (p.hEspM - p.hValveM) / Math.max(p.hEspM, 1))),
      });
      pTubAtValve = tubingBottom[travLen(tubingBottom) - 1]?.pAtma ?? pDis;
    } else {
      tubingBottom = [];
    }

    // верхний участок НКТ (клапан/приём -> устье): газ насоса + клапан
    const zTopSection = valveOn ? p.hValveM : p.hEspM;
    const pBottomSection = valveOn ? pTubAtValve : pDis;
    tubingTop = traverseUp({
      ...traverseCommon,
      pBottomAtma: Math.max(pBottomSection, 1.0),
      zBottomM: zTopSection, zTopM: 0,
      qGasFreeAtP: (pp, tt) => gasFreeAtP(pp, tt) + qGasValveNow,
      nSeg: valveOn
        ? Math.max(4, Math.round((nSegT * p.hValveM) / Math.max(p.hEspM, 1)))
        : nSegT,
    });

    // затруб
    annulus = solveAnnulus(
      {
        pIntakeAtma: pIntake, hEspM: p.hEspM,
        hValveM: valveOn ? p.hValveM : null,
        qGasSepSm3day: qSepFixed,
        qGasValveSm3day: qGasValveNow,
        dCasingM: p.dCasingM, dTubingOdM: p.dTubingOdM,
        gammaGas: p.gammaGas, zCorrelation: p.zCorrelation,
        tAtDepthC: tGeo,
        liquidAtP: (pp, tt) => {
          const s = feedBelow.calc(pp, tt);
          return { rhoKgm3: s.rhoLiqRcKgm3, muCP: s.muLiqCP };
        },
        sigmaNm: feedBelow.calc(pIntake, tIntake).sigmaLiqGasNm,
        nSeg: 40,
      },
      mode.pCasAtma,
    );
    pAnnAtValve = annulus.pAtValveAnnAtma;

    if (!valveOn || mode.qValveOverride != null) break;

    // уравнение клапана: затруб -> НКТ, только газ, только при p_ann > p_tub
    const tValve = tGeo(p.hValveM);
    const stValve = pumpFeed.calc(Math.max(pTubAtValve, 1), tValve);
    const vr = valveGasRateSm3day({
      pUpstreamAtma: pAnnAtValve,
      pDownstreamAtma: Math.max(pTubAtValve, 1),
      tC: tValve,
      dOrificeMm: p.dOrificeMm, cd: p.cd,
      gammaGas: p.gammaGas, kAdiab: stValve.kGas,
      zCorrelation: p.zCorrelation,
    });
    valveCritical = vr.critical;
    const qNew = vr.qGasSm3day;
    const converged = Math.abs(qNew - qValve) < Math.max(10, 0.02 * Math.max(qNew, 1));
    qValve = 0.5 * qValve + 0.5 * qNew; // демпфированная неподвижная точка
    if (converged && it >= 2) break;
  }

  const pBufCalcFinal = tubingTop[travLen(tubingTop) - 1].pAtma;
  const powerElectricW = pump.powerShaftW / Math.max(p.motorEffD, 0.3);
  const specificEnergy = qLiq > 0 ? (powerElectricW / 1000) * 24 / qLiq : 0; // кВт·ч/м3

  const qVent = Math.max(0, qSepFixed - (valveOn ? qValve : 0));
  const gasTubing = gasFreeAtP(pIntake, tIntake);

  return {
    ok: true,
    message: "",
    qLiqSm3day: qLiq, qOilSm3day: qOil, qWatSm3day: qWat,
    pwfAtma, pIntakeAtma: pIntake, pDisAtma: pDis, pBufCalcAtma: pBufCalcFinal,
    qGasFreeIntakeSm3day: qGasFreeIntake,
    qSepSm3day: qSepFixed,
    qValveSm3day: valveOn ? Math.max(0, qValve) : 0,
    qVentSm3day: qVent,
    qGasTubingSm3day: gasTubing,
    gasFracIntake: pump.gasFracIntake,
    gasCorr: pump.gasCorr,
    valveCritical,
    pCasAtma: annulus?.pCasCalcAtma ?? mode.pCasAtma ?? 0,
    pCasEquilAtma: null,
    closedValveFeasible: false,
    liquidLevelM: annulus?.liquidLevelM ?? null,
    gasAtIntake: annulus?.gasAtIntake ?? false,
    pTubAtValveAtma: pTubAtValve,
    pAnnAtValveAtma: pAnnAtValve,
    pump,
    powerShaftW: pump.powerShaftW,
    powerElectricW,
    specificEnergyKwhM3: specificEnergy,
    headM: pump.headM,
    profiles: {
      belowPump: belowNodes,
      tubingBottom,
      tubing: tubingTop,
      annulus: annulus?.nodes ?? [],
    },
    tDisC: pump.tDisC,
  };
}

function travLen(nodes: TraverseNode[]): number {
  return nodes.length === 0 ? 1 : nodes.length;
}

/**
 * Согласование буферного давления: бисекция по pwf (g(pwf) = p_buf_calc − p_buf).
 * Возвращает решение с p_buf_calc = p_buf.
 */
export function solveWell(p: WellParams, pumpDb: PumpDbRecord, mode: CalcMode): WellSolution {
  const g = (pwf: number) => calcWellFromPwf(pwf, p, pumpDb, mode).pBufCalcAtma - p.pBufAtma;

  let lo = 1.0, hi = p.pResAtma;
  // если даже при pwf=p_res (нет притока) p_buf_calc < p_buf — подъём невозможен
  const gHi = g(hi);
  if (gHi < 0) {
    const sol = calcWellFromPwf(hi, p, pumpDb, mode);
    return { ...sol, ok: false, message: "Насос не обеспечивает подъём при заданном буферном давлении (дебит 0)" };
  }
  const gLo = g(lo);
  if (gLo > 0) {
    const sol = calcWellFromPwf(lo, p, pumpDb, mode);
    return { ...sol, ok: false, message: "Даже при максимальном притоке буферное давление не достигается" };
  }
  for (let i = 0; i < 30; i++) {
    const mid = 0.5 * (lo + hi);
    if (g(mid) > 0) hi = mid; else lo = mid;
    if (hi - lo < 0.05) break;
  }
  const pwf = 0.5 * (lo + hi);
  return calcWellFromPwf(pwf, p, pumpDb, mode);
}

export type ValveScenarioResult = WellSolution;

/**
 * Сценарий В: работа с клапаном и закрытой задвижкой.
 * Ищет равновесное затрубное давление (q_valve = q_sep) бисекцией по P_cas;
 * если при P_cas_max равновесие недостижимо — P_cas = P_cas_max, остальное вентилируется.
 */
export function solveValveScenario(p: WellParams, pumpDb: PumpDbRecord): ValveScenarioResult {
  // проверка: возможно ли равновесие при P_cas_max
  const atMax = solveWell(p, pumpDb, { pCasAtma: p.pCasMaxAtma, ksepEff: p.ksep });
  const gapAtMax = atMax.qValveSm3day - atMax.qSepSm3day;
  if (gapAtMax >= -0.02 * Math.max(atMax.qSepSm3day, 1)) {
    // даже при максимуме клапан забирает весь газ — равновесие ниже P_cas_max:
    // ищем точное равновесие (или берём расчётное сверху при достатке)
    const gAtLow = solveWell(p, pumpDb, { pCasAtma: 1.2, ksepEff: p.ksep });
    if (gAtLow.qValveSm3day - gAtLow.qSepSm3day >= -0.02 * Math.max(gAtLow.qSepSm3day, 1)) {
      // равновесие достигается даже при минимальном P_cas: жидкость заполнит затруб,
      // верхнее давление — расчётное при полном проходе газа
      const free = solveWell(p, pumpDb, { pCasAtma: null, ksepEff: p.ksep, qValveOverride: null });
      // уточняем: q_valve должен быть равен q_sep — считаем с навязанным равенством
      const eq = solveWell(p, pumpDb, { pCasAtma: null, ksepEff: p.ksep, qValveOverride: free.qSepSm3day });
      return {
        ...eq,
        closedValveFeasible: true,
        pCasEquilAtma: eq.pCasAtma,
        qVentSm3day: 0,
        message: "Закрытая задвижка возможна: весь газ уходит через клапан",
      };
    }
    // бисекция по P_cas: g(P) = q_valve(P) − q_sep
    let lo = 1.2, hi = p.pCasMaxAtma;
    for (let i = 0; i < 22; i++) {
      const mid = 0.5 * (lo + hi);
      const sol = solveWell(p, pumpDb, { pCasAtma: mid, ksepEff: p.ksep });
      const gap = sol.qValveSm3day - sol.qSepSm3day;
      if (gap > 0) hi = mid; else lo = mid;
      if (hi - lo < 0.1) break;
    }
    // финальный расчёт при равновесном P_cas с навязанным равенством потоков
    const pEq = 0.5 * (lo + hi);
    const eq = solveWell(p, pumpDb, { pCasAtma: pEq, ksepEff: p.ksep, qValveOverride: undefined });
    return {
      ...eq,
      closedValveFeasible: true,
      pCasEquilAtma: pEq,
      qVentSm3day: 0,
      message: "Закрытая задвижка возможна: весь газ уходит через клапан",
    };
  }
  // равновесие недостижимо: P_cas = P_cas_max, часть газа вентилируется
  return {
    ...atMax,
    closedValveFeasible: false,
    pCasEquilAtma: null,
    qVentSm3day: Math.max(0, atMax.qSepSm3day - atMax.qValveSm3day),
    message: "Закрыть задвижку нельзя: клапан пропускает меньше сепарированного газа, требуется вентиляция",
  };
}

/** Сценарий А: без клапана, затрубная задвижка открыта — весь газ вентилируется. */
export function solveBaselineOpen(p: WellParams, pumpDb: PumpDbRecord): ValveScenarioResult {
  const p2: WellParams = { ...p, valveEnabled: false };
  const sol = solveWell(p2, pumpDb, { pCasAtma: p.pCasMaxAtma, ksepEff: p.ksep });
  return {
    ...sol,
    qVentSm3day: sol.qSepSm3day,
    qValveSm3day: 0,
    closedValveFeasible: false,
    message: "Без клапана: весь сепарированный газ вентилируется через затрубную задвижку",
  };
}

/** Сценарий Б: без клапана, задвижка закрыта — весь газ идёт в насос (ksep=0). */
export function solveBaselineClosed(p: WellParams, pumpDb: PumpDbRecord): ValveScenarioResult {
  const p2: WellParams = { ...p, valveEnabled: false };
  const sol = solveWell(p2, pumpDb, { pCasAtma: null, ksepEff: 0 });
  return {
    ...sol,
    qVentSm3day: 0,
    qValveSm3day: 0,
    closedValveFeasible: false,
    message: sol.ok
      ? "Без клапана, задвижка закрыта: весь свободный газ проходит через насос"
      : "Без клапана, задвижка закрыта: насос срывается по газу, устойчивого режима нет",
  };
}
