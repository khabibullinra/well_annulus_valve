// Blackoil feed — состояние флюида + расчёт всех свойств при P, T.
// Порт unfpy feed_calc_Standing / Feed.calc / feed_mod_after_separation.

import {
  atmaToMpa, cToK, clamp, CONVERT_ATMA_MPA, CONVERT_MPA_ATMA, mpaToAtma,
  R_UNIVERSAL, M_AIR,
} from "./units.js";
import {
  bGasM3m3, bWatM3m3, boStandingM3m3, coVB1MPa, cpOilJkgC, cpWatJkgC, dBoDrsStanding,
  gasHeatCapacityRatio, muDeadOilBeggsRobinsonCP, muGasCP, muOilVasquezBeggsCP,
  muSatOilBeggsRobinsonCP, muWatCP, pbStandingMPa, rhoGasRcKgm3, rhoOilRcKgm3, rhoWatRcKgm3,
  rsStandingM3m3, salinityPpmFromGamma, sigmaLiqGasNm, sigmaOilGasNm, sigmaWatGasNm,
  zGas, type ZCorrelation,
} from "./pvt.js";

export interface FluidParams {
  gammaGas: number; // относительная плотность газа (воздух=1)
  gammaOil: number; // относительная плотность нефти (вода=1)
  gammaWat: number; // относительная плотность воды (вода=1)
  rsbM3m3: number; // газосодержание при pb, м3/м3
  rpM3m3: number; // рабочий газовый фактор, м3/м3
  pbAtma: number; // давление насыщения пользователя, atma (<=0 — расчётное)
  bOilbM3m3: number; // Bo при pb (<=0 — расчётный)
  muOilbCP: number; // вязкость нефти при pb, сП (<=0 — расчётная)
  tResC: number; // пластовая температура, °C (для калибровки)
  zCorrelation: ZCorrelation;
  qLiqSm3day: number; // дебит жидкости (ст.у), м3/сут
  fwFr: number; // обводнённость объёмная, 0..1
  qGasFreeSm3day: number; // свободный газ не из растворённого, ст.м3/сут
}

/** Результат одного расчёта Feed.calc — все свойства потока при (p, t). */
export interface FeedState {
  pAtma: number;
  tC: number;
  rsM3m3: number;
  bOilM3m3: number;
  bGasM3m3: number;
  bWatM3m3: number;
  muOilCP: number;
  muGasCP: number;
  muWatCP: number;
  z: number;
  qOilRcM3day: number;
  qWatRcM3day: number;
  qGasRcM3day: number; // свободный газ в пластовых условиях
  qLiqRcM3day: number;
  qMixRcM3day: number;
  gasFractionD: number; // объёмная доля свободного газа в смеси
  fwRcFr: number; // доля воды в жидкости (пласт. усл.)
  muLiqCP: number;
  muMixCP: number;
  rhoOilRcKgm3: number;
  rhoWatRcKgm3: number;
  rhoGasRcKgm3: number;
  rhoLiqRcKgm3: number;
  rhoMixRcKgm3: number;
  sigmaOilGasNm: number;
  sigmaWatGasNm: number;
  sigmaLiqGasNm: number;
  co1MPa: number;
  muDeadOilCP: number;
  pbCalcAtma: number; // расчётное (скорректированное калибровкой) pb
  kGas: number; // показатель адиабаты
  cvGasJkgC: number;
  cpOilJkgC: number;
  cpWatJkgC: number;
  qGasInsituSm3day: number; // свободный газ, ст.м3/сут
}

export class Feed {
  params: FluidParams;

  constructor(params: FluidParams) {
    this.params = { ...params };
  }

  clone(): Feed {
    return new Feed(this.params);
  }

  /** Основной расчёт — порт feed_calc_Standing (unfpy/pvt/feed_njit.py). */
  calc(pAtmaIn: number, tC: number): FeedState {
    const p = this.params;
    let pAtma = pAtmaIn;
    if (pAtma < 1.0) pAtma = 1.0;

    const tK = cToK(tC);
    const pMPa = atmaToMpa(pAtma);

    const rsbCalc = Math.min(p.rsbM3m3, p.rpM3m3);
    const pbUserMPa = p.pbAtma * CONVERT_ATMA_MPA;
    const tResK = cToK(p.tResC);

    const z = zGas(tK, pMPa, p.gammaGas, p.zCorrelation);
    const bg = bGasM3m3(tK, pMPa, z);

    // Калибровочные коэффициенты по пользовательским pb, bob, muob (при t_res)
    let pFact = 1.0;
    if (pbUserMPa > 0) {
      pFact = pbStandingMPa(rsbCalc, p.gammaGas, tResK, p.gammaOil) / pbUserMPa;
    }
    let bFact = 1.0;
    if (p.bOilbM3m3 > 0) {
      bFact = (p.bOilbM3m3 - 1.0) / (boStandingM3m3(rsbCalc, p.gammaGas, tResK, p.gammaOil) - 1.0);
    }
    const muDeadCP = muDeadOilBeggsRobinsonCP(tK, p.gammaOil);
    let muFact = 1.0;
    if (p.muOilbCP > 0) {
      const muDeadRes = muDeadOilBeggsRobinsonCP(tResK, p.gammaOil);
      muFact = p.muOilbCP / muSatOilBeggsRobinsonCP(rsbCalc, muDeadRes);
    }

    // Свойства нефти выше/ниже pb
    const pbCorrMPa = pbStandingMPa(rsbCalc, p.gammaGas, tK, p.gammaOil);
    const pEffMPa = pMPa * pFact;

    let rs: number, bo: number, co1MPa: number, muOil: number;
    if (pEffMPa > pbCorrMPa) {
      rs = rsbCalc;
      const bobSat = bFact * (boStandingM3m3(rsbCalc, p.gammaGas, tK, p.gammaOil) - 1.0) + 1.0;
      co1MPa = coVB1MPa(rsbCalc, p.gammaGas, tK, p.gammaOil, pEffMPa);
      bo = bobSat * Math.exp(co1MPa * (pbCorrMPa - pEffMPa));
      const muSat = muSatOilBeggsRobinsonCP(rsbCalc, muDeadCP);
      muOil = muFact * muOilVasquezBeggsCP(muSat, pEffMPa, pbCorrMPa);
    } else {
      rs = rsStandingM3m3(pEffMPa, p.gammaGas, tK, p.gammaOil);
      const drsDp = (rsStandingM3m3(pEffMPa + 0.001, p.gammaGas, tK, p.gammaOil) - rs) / 0.001;
      const boSat = bFact * (boStandingM3m3(rs, p.gammaGas, tK, p.gammaOil) - 1.0) + 1.0;
      const dboDrs = bFact * dBoDrsStanding(rs, p.gammaGas, tK, p.gammaOil);
      co1MPa = (-1.0 / boSat) * (dboDrs * drsDp - bg * drsDp);
      bo = boSat;
      muOil = muFact * muSatOilBeggsRobinsonCP(rs, muDeadCP);
    }

    const muGas = muGasCP(tK, pMPa, z, p.gammaGas);

    const salPpm = salinityPpmFromGamma(p.gammaWat);
    const bw = bWatM3m3(pMPa, tK);
    const muWat = muWatCP(pMPa, tK, salPpm);

    const sigmaOil = sigmaOilGasNm(pMPa, tC, p.gammaOil);
    const sigmaWat = sigmaWatGasNm(pMPa);

    // Расходы в стандартных условиях
    const qOilSm = p.qLiqSm3day * (1.0 - p.fwFr);
    const qWatSm = p.qLiqSm3day * p.fwFr;
    let qGasInsitu = qOilSm * p.rpM3m3 + p.qGasFreeSm3day - rs * qOilSm;
    if (qGasInsitu < 0) qGasInsitu = 0;

    // Расходы в пластовых условиях
    const qOilRc = qOilSm * bo;
    const qWatRc = qWatSm * bw;
    const qGasRc = Math.max(0, qGasInsitu * bg);
    const qLiqRc = qOilRc + qWatRc;
    const qMixRc = qLiqRc + qGasRc;

    let gasFraction = 0, fwRc = 0, muLiq = 0, muMix = 0;
    if (qMixRc > 0) {
      gasFraction = qGasRc / qMixRc;
      if (qLiqRc > 0) {
        fwRc = qWatRc / qLiqRc;
        muLiq = muOil * (1.0 - fwRc) + muWat * fwRc;
        muMix = muLiq * (1.0 - gasFraction) + muGas * gasFraction;
      } else {
        muMix = muGas;
      }
    }

    const rhoOil = rhoOilRcKgm3(rs, p.gammaGas, p.gammaOil, bo);
    const rhoWat = rhoWatRcKgm3(pMPa, tK, salPpm);
    const rhoGas = rhoGasRcKgm3(p.gammaGas, bg);
    const rhoLiq = qLiqRc > 0 ? (qOilRc * rhoOil + qWatRc * rhoWat) / qLiqRc : 0;
    const rhoMix = qMixRc > 0 ? (qLiqRc * rhoLiq + qGasRc * rhoGas) / qMixRc : 0;

    const pbOutMPa = pFact !== 0 ? pbCorrMPa / pFact : pbCorrMPa;
    const pbCalcAtma = pbOutMPa * CONVERT_MPA_ATMA;

    const kGas = gasHeatCapacityRatio(p.gammaGas, tK);
    const mg = M_AIR * p.gammaGas;
    const cvGas = kGas > 1 ? (z * R_UNIVERSAL) / (mg * (kGas - 1.0)) : 0;

    const st: FeedState = {
      pAtma, tC,
      rsM3m3: rs, bOilM3m3: bo, bGasM3m3: bg, bWatM3m3: bw,
      muOilCP: muOil, muGasCP: muGas, muWatCP: muWat, z,
      qOilRcM3day: qOilRc, qWatRcM3day: qWatRc, qGasRcM3day: qGasRc,
      qLiqRcM3day: qLiqRc, qMixRcM3day: qMixRc,
      gasFractionD: gasFraction, fwRcFr: fwRc, muLiqCP: muLiq, muMixCP: muMix,
      rhoOilRcKgm3: rhoOil, rhoWatRcKgm3: rhoWat, rhoGasRcKgm3: rhoGas,
      rhoLiqRcKgm3: rhoLiq, rhoMixRcKgm3: rhoMix,
      sigmaOilGasNm: sigmaOil, sigmaWatGasNm: sigmaWat,
      sigmaLiqGasNm: sigmaLiqGasNm(sigmaOil, sigmaWat, p.fwFr),
      co1MPa, muDeadOilCP: muDeadCP, pbCalcAtma,
      kGas, cvGasJkgC: cvGas,
      cpOilJkgC: cpOilJkgC(tC, p.gammaOil), cpWatJkgC: cpWatJkgC(tK, salPpm),
      qGasInsituSm3day: qGasInsitu,
    };
    return st;
  }
}

/**
 * Модификация флюида после сепарации газа — порт feed_mod_after_separation
 * (unfpy/pvt/model.py). Отделяет долю ksep свободного газа; при снижении рабочего
 * ГФ ниже rsb пересчитывает калибровку pb/bob/muob по таблицам.
 */
export function feedModAfterSeparation(feedIn: Feed, pAtma: number, tC: number, ksep: number): Feed {
  if (ksep < 0 || ksep > 1) return feedIn.clone();

  const result = feedIn.clone();
  const st = result.calc(pAtma, tC);
  const rs = st.rsM3m3;
  const rp = result.params.rpM3m3;

  const rpNewWithKsep = rp - (rp - rs) * ksep;
  const rpNew = rs + (rp - rs) * (1.0 - ksep); // gas_goes_into_solution = 1

  result.params.qGasFreeSm3day *= 1.0 - ksep;

  if (rpNew < result.params.rsbM3m3) {
    const n = 10;
    const pbCalc = st.pbCalcAtma;
    const delta = (pbCalc - 1.0) / n;
    const rsPts: number[] = [], pbPts: number[] = [], boPts: number[] = [], muoPts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const pTab = 1.0 + delta * i;
      const s = result.calc(pTab, tC);
      rsPts.push(s.rsM3m3);
      pbPts.push(pTab);
      boPts.push(s.bOilM3m3);
      muoPts.push(s.muOilCP);
    }
    result.params.pbAtma = interpLinear(rpNew, rsPts, pbPts);
    result.params.bOilbM3m3 = interpLinear(rpNew, rsPts, boPts);
    result.params.muOilbCP = interpLinear(rpNew, rsPts, muoPts);
    result.params.rsbM3m3 = rpNew;
  }

  result.params.rpM3m3 = rpNewWithKsep;
  return result;
}

export function interpLinear(x: number, xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return ys[i - 1] + t * (ys[i] - ys[i - 1]);
    }
  }
  return ys[n - 1];
}

/** Газосодержание смеси при известной доле сепарации (быстрая оценка, unfpy Feed.gas_fraction_with_sep). */
export function gasFractionWithSep(st: FeedState, ksep: number): number {
  const qGas = st.qGasRcM3day * (1 - clamp(ksep, 0, 1));
  const denom = st.qLiqRcM3day + qGas;
  return denom > 0 ? qGas / denom : 0;
}

export { mpaToAtma };
