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
  /** давление в затрубе НА глубине уровня жидкости (P_затр устья + вес газовой шапки) */
  pAtLevelAnnAtma: number | null;
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
 *    давления на приёме. Профиль двухчастный:
 *    * верх — газовая шапка по барометрической формуле (вес газовой колонны);
 *    * низ — барботаж газа через столб неподвижной жидкости (drift-flux, vsl=0).
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
      nodes: [...up.nodes].reverse(), // сверху вниз для единообразия графиков
      pAtValveAnnAtma: pAtValve,
      pAtLevelAnnAtma: null,
    };
  }

  // Заданное верхнее давление: ищем уровень жидкости.
  // p_intake_calc(level): уровень глубже -> колонна легче -> давление ниже.
  const gasCol = (hLl: number) =>
    gasColumnDown(pCasGivenAtma, 0, hLl, inp.gammaGas, inp.zCorrelation, inp.tAtDepthC, 10);

  // --- узлы газовой шапки (барометрическая формула) ---
  const gasNode = (z: number, p: number): TraverseNode => {
    const tC = inp.tAtDepthC(z);
    const tK = tC + 273.0;
    const pMPa = Math.max(p, 0.9) * 0.101325;
    const zFac = zGas(tK, pMPa, inp.gammaGas, inp.zCorrelation);
    const bg = (0.00034722 * tK * zFac) / pMPa;
    const rhoGas = (inp.gammaGas * 1.2217) / bg;
    return {
      zM: z, pAtma: p, tC, alpha: 1, vm: 0, vsl: 0, vsg: 0,
      rhoMixKgm3: rhoGas, regime: "annular", dpdzAtmaM: (rhoGas * G) / 101325,
    };
  };
  const gasCapNodes = (hBottom: number, nSeg = 20): TraverseNode[] => {
    const out: TraverseNode[] = [];
    if (hBottom <= 1e-9) return out;
    const dz = hBottom / nSeg;
    let p = pCasGivenAtma;
    out.push(gasNode(0, p));
    for (let i = 0; i < nSeg; i++) {
      const zMid = dz * (i + 0.5);
      const tK = inp.tAtDepthC(zMid) + 273.0;
      const pMPa = Math.max(p, 0.9) * 0.101325;
      const zFac = zGas(tK, pMPa, inp.gammaGas, inp.zCorrelation);
      const bg = (0.00034722 * tK * zFac) / pMPa;
      const rhoGas = (inp.gammaGas * 1.2217) / bg;
      p += (rhoGas * G * dz) / 101325;
      out.push(gasNode(dz * (i + 1), p));
    }
    return out;
  };

  // --- узлы барботажа в жидкостном столбе (drift-flux при vsl=0) ---
  const area = annulusAreaM2(inp.dCasingM, inp.dTubingOdM);
  const sigma = inp.sigmaNm ?? 0.03;
  const liquidNode = (z: number, p: number): TraverseNode => {
    const tC = inp.tAtDepthC(z);
    const liq = inp.liquidAtP(p, tC);
    const qGasSt = valveSubmergedPossible
      ? (z > inp.hValveM! ? inp.qGasSepSm3day : Math.max(0, inp.qGasSepSm3day - qValve))
      : inp.qGasSepSm3day;
    const tK = tC + 273.0;
    const pMPa = Math.max(p, 0.9) * 0.101325;
    const zFac = zGas(tK, pMPa, inp.gammaGas, inp.zCorrelation);
    const bg = (0.00034722 * tK * zFac) / pMPa;
    const rhoGas = (inp.gammaGas * 1.2217) / bg;
    const vsg = ((qGasSt * bg) * (1 / 86400)) / area;
    const df = driftFlux(0, vsg, Math.max(inp.dCasingM - inp.dTubingOdM, 0.01), liq.rhoKgm3, rhoGas, sigma);
    const rhoMix = df.alpha * rhoGas + (1 - df.alpha) * liq.rhoKgm3;
    return {
      zM: z, pAtma: p, tC, alpha: df.alpha, vm: 0, vsl: 0, vsg,
      rhoMixKgm3: rhoMix, regime: df.regime, dpdzAtmaM: (rhoMix * G) / 101325,
    };
  };

  // жидкостный марш вниз от уровня до приёма насоса с записью узлов профиля
  const marchDownFromLevel = (hLl: number): TraverseNode[] => {
    const nSeg = inp.nSeg ?? 60;
    let p = gasCol(hLl);
    const hFrom = hLl, hTo = inp.hEspM;
    const out: TraverseNode[] = [liquidNode(hFrom, p)];
    if (hTo <= hFrom) return out;
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
      const pMPa = Math.max(p, 0.9) * 0.101325;
      const zFac = zGas(tK, pMPa, inp.gammaGas, inp.zCorrelation);
      const bg = (0.00034722 * tK * zFac) / pMPa;
      const rhoGas = (inp.gammaGas * 1.2217) / bg;
      const vsg = ((qGasSt * bg) * (1 / 86400)) / area;
      const df = driftFlux(0, vsg, Math.max(inp.dCasingM - inp.dTubingOdM, 0.01), liq.rhoKgm3, rhoGas, sigma);
      const rhoMix = df.alpha * rhoGas + (1 - df.alpha) * liq.rhoKgm3;
      p += (rhoMix * G * dz) / 101325;
      z += dz;
      out.push(liquidNode(z, p));
    }
    return out;
  };

  // давление на приёме при заданном уровне (без записи узлов — для бисекции)
  const marchDownP = (hLl: number): number => {
    const nSeg = inp.nSeg ?? 60;
    let p = gasCol(hLl);
    const hFrom = hLl, hTo = inp.hEspM;
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
      const pMPa = Math.max(p, 0.9) * 0.101325;
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

  const pFullLiquidP = marchDownP(0);
  if (pFullLiquidP <= inp.pIntakeAtma) {
    // даже полный столб жидкости не даёт давления приёма — шапки нет, верхнее давление выше заданного
    const up = marchUp(inp, qValve);
    const pAtValve = valveSubmergedPossible ? interpPressure(up.nodes, inp.hValveM!) : up.pTopAtma;
    return {
      pCasCalcAtma: up.pTopAtma,
      liquidLevelM: null,
      gasAtIntake: false,
      nodes: [...up.nodes].reverse(),
      pAtValveAnnAtma: pAtValve,
      pAtLevelAnnAtma: null,
    };
  }

  const pAllGas = gasCol(inp.hEspM);
  if (pAllGas >= inp.pIntakeAtma) {
    // даже газовая колонна тяжелей приёма — уровень у приёма, газ в насос:
    // весь ствол затруба — газовая шапка
    const nodesAllGas = gasCapNodes(inp.hEspM, 20);
    return {
      pCasCalcAtma: pCasGivenAtma,
      liquidLevelM: inp.hEspM,
      gasAtIntake: true,
      nodes: nodesAllGas,
      pAtValveAnnAtma: interpPressure(nodesAllGas, inp.hValveM ?? inp.hEspM),
      pAtLevelAnnAtma: interpPressure(nodesAllGas, inp.hEspM),
    };
  }

  // бисекция по глубине уровня (с ранним выходом по точности давления)
  let lo = 0, hi = inp.hEspM; // f(lo)=pFull-pIntake>0, f(hi)=pAllGas-pIntake<0
  const tolP = 0.005 * Math.max(inp.pIntakeAtma, 1);
  for (let i = 0; i < 30; i++) {
    const mid = 0.5 * (lo + hi);
    const pMid = marchDownP(mid);
    if (Math.abs(pMid - inp.pIntakeAtma) < tolP) { lo = hi = mid; break; }
    if (pMid > inp.pIntakeAtma) lo = mid;
    else hi = mid;
    if (hi - lo < 0.05) break;
  }
  const hLl = 0.5 * (lo + hi);

  // профиль: шапка (барометрика) 0..hLl + барботаж hLl..приём
  const capNodes = gasCapNodes(hLl, 20);
  const liquidNodes = marchDownFromLevel(hLl);
  const nodes = [...capNodes, ...liquidNodes.slice(1)];
  if (nodes.length > 0) {
    // нижний узел стыкуем с давлением приёма (та же физическая точка, что в НКТ-профиле)
    nodes[nodes.length - 1].pAtma = inp.pIntakeAtma;
  }
  const pAtValve = interpPressure(nodes, inp.hValveM ?? 0);
  // давление НА уровне = низ газовой шапки (барометрика P_затр + вес газового столба)
  const pAtLevel = interpPressure(nodes, hLl);
  return {
    pCasCalcAtma: pCasGivenAtma,
    liquidLevelM: hLl,
    gasAtIntake: false,
    nodes,
    pAtValveAnnAtma: pAtValve,
    pAtLevelAnnAtma: pAtLevel,
  };
}

function interpPressure(nodes: TraverseNode[], z: number): number {
  // направление массива любое (z растёт или убывает)
  const n = nodes.length;
  if (n === 0) return NaN;
  const asc = nodes[0].zM < nodes[n - 1].zM;
  if (asc) {
    if (z <= nodes[0].zM) return nodes[0].pAtma;
    if (z >= nodes[n - 1].zM) return nodes[n - 1].pAtma;
    for (let i = 1; i < n; i++) {
      if (z <= nodes[i].zM) {
        const t = (z - nodes[i - 1].zM) / (nodes[i].zM - nodes[i - 1].zM);
        return nodes[i - 1].pAtma + t * (nodes[i].pAtma - nodes[i - 1].pAtma);
      }
    }
    return nodes[n - 1].pAtma;
  }
  if (z >= nodes[0].zM) return nodes[0].pAtma;
  if (z <= nodes[n - 1].zM) return nodes[n - 1].pAtma;
  for (let i = 1; i < n; i++) {
    if (z >= nodes[i].zM) {
      const t = (nodes[i - 1].zM - z) / (nodes[i - 1].zM - nodes[i].zM);
      return nodes[i - 1].pAtma + t * (nodes[i].pAtma - nodes[i - 1].pAtma);
    }
  }
  return nodes[n - 1].pAtma;
}
