// Модель затрубного (межтрубного) пространства: неподвижная жидкость с барботажом
// газа от приёма насоса, газовая шапка сверху, уровень жидкости.
// Барботаж — drift-flux при vsl=0 (замыкание Harmathy). Сепарированный газ поднимается
// от приёма; часть уходит в газлифтный клапан (ниже уровня), остаток — в шапку/вентиляцию.

import { G } from "./units.js";
import { driftFlux, gasColumnDown, type TraverseNode } from "./driftflux.js";
import { zGas } from "./pvt.js";

export interface AnnulusInput {
  pIntakeAtma: number; // давление на приёме насоса (низ затруба)
  hEspM: number; // глубина приёма насоса
  hValveM: number | null; // глубина газлифтного клапана (null — клапана нет)
  qGasSepSm3day: number; // сепарированный газ, поступающий в затруб (ст.м3/сут)
  qGasValveSm3day: number; // газ, уходящий в клапан на глубине hValve (ст.м3/сут)
  dCasingM: number; // внутренний диаметр обсадной колонны, м
  dTubingOdM: number; // наружный диаметр НКТ, м
  gammaGas: number;
  zCorrelation: "bb" | "dranchuk" | "kareem";
  tAtDepthC: (z: number) => number;
  /** свойства жидкости затруба (нефть+вода) */
  liquidAtP: (pAtma: number, tC: number) => { rhoKgm3: number; muCP: number };
  sigmaNm?: number;
  nSeg?: number;
}

export interface AnnulusResult {
  pCasCalcAtma: number; // давление вверху затруба (расчётное равновесие шапки)
  liquidLevelM: number | null; // глубина уровня жидкости (null — затруб заполнен жидкостью)
  gasAtIntake: boolean; // уровень опустился к приёму — газ идёт в приём
  nodes: TraverseNode[]; // профиль затруба (от устья вниз или снизу вверх)
  pAtValveAnnAtma: number; // давление в затрубе на глубине клапана
}

/** Площадь кольцевого сечения затруба, м2. */
export function annulusAreaM2(dCasingM: number, dTubingOdM: number): number {
  return (Math.PI / 4) * (dCasingM ** 2 - dTubingOdM ** 2);
}

/**
 * Марш от приёма вверх по затрубу с барботажом. Поток газа по глубине:
 * ниже клапана — весь сепарированный, выше клапана — остаток (если клапан погружён).
 * Возвращает профиль и давление сверху (жидкость заполняет затруб до устья).
 */
function marchUp(inp: AnnulusInput, qValve: number): { nodes: TraverseNode[]; pTopAtma: number } {
  const hValve = inp.hValveM;
  return traverseUpN(inp, (z) => {
    // поток газа на глубине z (движется вверх): ниже клапана весь, выше — остаток
    if (hValve === null) return inp.qGasSepSm3day;
    return z > hValve ? inp.qGasSepSm3day : Math.max(0, inp.qGasSepSm3day - qValve);
  });
}

function traverseUpN(
  inp: AnnulusInput,
  gasFluxAtZ: (z: number) => number,
): { nodes: TraverseNode[]; pTopAtma: number } {
  // локальный аналог traverseUp, но поток газа зависит от глубины (клапан забирает газ)
  const nSeg = inp.nSeg ?? 60;
  const area = annulusAreaM2(inp.dCasingM, inp.dTubingOdM);
  const sigma = inp.sigmaNm ?? 0.03;
  const nodes: TraverseNode[] = [];
  let p = inp.pIntakeAtma;
  let z = inp.hEspM;
  const dz = inp.hEspM / nSeg;

  for (let i = 0; i <= nSeg; i++) {
    const tC = inp.tAtDepthC(z);
    const liq = inp.liquidAtP(p, tC);
    const qGasSt = Math.max(0, gasFluxAtZ(z));
    const tK = tC + 273.0;
    const pMPa = p * 0.101325;
    const zFac = zGas(tK, pMPa, inp.gammaGas, inp.zCorrelation);
    const bg = (0.00034722 * tK * zFac) / pMPa;
    const rhoGas = (inp.gammaGas * 1.2217) / bg;
    const qGasRc = qGasSt * bg;
    const vsg = (qGasRc * (1 / 86400)) / area;
    const df = driftFlux(0, vsg, Math.max(inp.dCasingM - inp.dTubingOdM, 0.01), liq.rhoKgm3, rhoGas, sigma);
    const rhoMix = df.alpha * rhoGas + (1 - df.alpha) * liq.rhoKgm3;
    const dpdz = (rhoMix * G) / 101325; // трения нет — жидкость неподвижна
    nodes.push({ zM: z, pAtma: p, tC, alpha: df.alpha, vm: 0, vsl: 0, vsg, rhoMixKgm3: rhoMix, regime: df.regime, dpdzAtmaM: dpdz });
    p = Math.max(0.9, p - dpdz * dz);
    z -= dz;
  }
  return { nodes, pTopAtma: nodes[nodes.length - 1].pAtma };
}

/**
 * Решение затруба.
 *  - pCasGivenAtma === null: жидкость заполняет затруб, верхнее давление — расчётное
 *    (равновесие закрытой задвижки: весь газ уходит в клапан или копится).
 *  - pCasGivenAtma задано: ищется уровень жидкости (бисекция) из согласования
 *    давления на приёме.
 */
export function solveAnnulus(inp: AnnulusInput, pCasGivenAtma: number | null): AnnulusResult {
  const qValve = inp.qGasValveSm3day;
  const valveSubmergedPossible = inp.hValveM !== null && inp.hValveM < inp.hEspM;

  if (pCasGivenAtma === null) {
    const up = marchUp(inp, qValve);
    const pAtValve = valveSubmergedPossible
      ? interpPressure(up.nodes, inp.hValveM!)
      : up.pTopAtma;
    return {
      pCasCalcAtma: up.pTopAtma,
      liquidLevelM: null,
      gasAtIntake: false,
      nodes: up.nodes,
      pAtValveAnnAtma: pAtValve,
    };
  }

  // Заданное верхнее давление: ищем уровень жидкости.
  // p_intake_calc(level): уровень глубже -> колонна легче -> давление ниже.
  const gasCol = (hLl: number) =>
    gasColumnDown(pCasGivenAtma, 0, hLl, inp.gammaGas, inp.zCorrelation, inp.tAtDepthC, 10);

  // жидкостный марш вниз от уровня до глубины hTo (по умолчанию — приём насоса);
  // возвращает давление на глубине hTo
  const marchDownFromLevel = (hLl: number, hToIn?: number): number => {
    const nSeg = inp.nSeg ?? 60;
    const area = annulusAreaM2(inp.dCasingM, inp.dTubingOdM);
    const sigma = inp.sigmaNm ?? 0.03;
    let p = gasCol(hLl);
    const hFrom = hLl, hTo = Math.min(hToIn ?? inp.hEspM, inp.hEspM);
    if (hTo <= hFrom) return p;
    const n = Math.max(2, Math.round((nSeg * (hTo - hFrom)) / Math.max(inp.hEspM, 1)));
    const dz = (hTo - hFrom) / n;
    let z = hFrom;
    for (let i = 0; i < n; i++) {
      const zMid = z + dz / 2;
      const tC = inp.tAtDepthC(zMid);
      const liq = inp.liquidAtP(p, tC);
      const qGasSt = valveSubmergedPossible
        ? (zMid > inp.hValveM! ? inp.qGasSepSm3day : Math.max(0, inp.qGasSepSm3day - qValve))
        : inp.qGasSepSm3day;
      const tK = tC + 273.0;
      const pMPa = p * 0.101325;
      const zFac = zGas(tK, pMPa, inp.gammaGas, inp.zCorrelation);
      const bg = (0.00034722 * tK * zFac) / pMPa;
      const rhoGas = (inp.gammaGas * 1.2217) / bg;
      const vsg = ((qGasSt * bg) * (1 / 86400)) / area;
      const df = driftFlux(0, vsg, Math.max(inp.dCasingM - inp.dTubingOdM, 0.01), liq.rhoKgm3, rhoGas, sigma);
      const rhoMix = df.alpha * rhoGas + (1 - df.alpha) * liq.rhoKgm3;
      p += (rhoMix * G * dz) / 101325;
      z += dz;
    }
    return p;
  };

  // граничные случаи: marchDownFromLevel(0) = заданное P_cas + полный жидкостный столб
  const pFullLiquid = marchDownFromLevel(0);
  if (pFullLiquid <= inp.pIntakeAtma) {
    // даже полный столб жидкости не даёт давления приёма — шапки нет, верхнее давление выше заданного
    const up = marchUp(inp, qValve);
    const pAtValve = valveSubmergedPossible ? interpPressure(up.nodes, inp.hValveM!) : up.pTopAtma;
    return {
      pCasCalcAtma: up.pTopAtma,
      liquidLevelM: null,
      gasAtIntake: false,
      nodes: up.nodes,
      pAtValveAnnAtma: pAtValve,
    };
  }

  const pAllGas = gasCol(inp.hEspM);
  if (pAllGas >= inp.pIntakeAtma) {
    // даже газовая колонна тяжелей приёма — уровень у приёма, газ в насос
    return {
      pCasCalcAtma: pCasGivenAtma,
      liquidLevelM: inp.hEspM,
      gasAtIntake: true,
      nodes: [],
      pAtValveAnnAtma: gasCol(inp.hValveM ?? inp.hEspM),
    };
  }

  // бисекция по глубине уровня (с ранним выходом по точности давления)
  let lo = 0, hi = inp.hEspM; // f(lo)=pFull-pIntake>0, f(hi)=pAllGas-pIntake<0
  const tolP = 0.005 * Math.max(inp.pIntakeAtma, 1);
  for (let i = 0; i < 30; i++) {
    const mid = 0.5 * (lo + hi);
    const pMid = marchDownFromLevel(mid);
    if (Math.abs(pMid - inp.pIntakeAtma) < tolP) { lo = hi = mid; break; }
    if (pMid > inp.pIntakeAtma) lo = mid;
    else hi = mid;
    if (hi - lo < 0.05) break;
  }
  const hLl = 0.5 * (lo + hi);
  // давление на клапане: если клапан погружён (уровень выше клапана) — марш
  // от уровня вниз ДО КЛАПАНА; иначе клапан в газовой шапке — вес газовой колонны
  const pAtValve =
    valveSubmergedPossible && hLl < inp.hValveM!
      ? marchDownFromLevel(hLl, inp.hValveM!)
      : gasCol(inp.hValveM ?? 0);
  return {
    pCasCalcAtma: pCasGivenAtma,
    liquidLevelM: hLl,
    gasAtIntake: false,
    nodes: [],
    pAtValveAnnAtma: pAtValve,
  };
}

function interpPressure(nodes: TraverseNode[], z: number): number {
  // профиль снизу вверх (z убывает по массиву)
  if (nodes.length === 0) return NaN;
  if (z >= nodes[0].zM) return nodes[0].pAtma;
  if (z <= nodes[nodes.length - 1].zM) return nodes[nodes.length - 1].pAtma;
  for (let i = 1; i < nodes.length; i++) {
    if (z >= nodes[i].zM) {
      const t = (nodes[i - 1].zM - z) / (nodes[i - 1].zM - nodes[i].zM);
      return nodes[i - 1].pAtma + t * (nodes[i].pAtma - nodes[i - 1].pAtma);
    }
  }
  return nodes[nodes.length - 1].pAtma;
}
