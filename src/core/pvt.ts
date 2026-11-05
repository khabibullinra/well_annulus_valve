// PVT-корреляции blackoil — порт unfpy (unfpy/pvt/correlations/*).
// Все функции — чистая скалярная математика, внутренние единицы МПа / K.

import { CONVERT_M3M3_SCFBBL, RHO_AIR_SC } from "./units.js";

// ---------------------------------------------------------------------------
// Нефть: Standing 1977, Beggs-Robinson 1974, Vasquez-Beggs 1980
// ---------------------------------------------------------------------------

export function pbStandingMPa(rsbM3m3: number, gammaGas: number, tK: number, gammaOil: number): number {
  const MIN_RSB = 1.8;
  const rsbOld = rsbM3m3;
  const rsb = rsbM3m3 < MIN_RSB ? MIN_RSB : rsbM3m3;
  const yg = 1.225 + 0.001648 * tK - 1.769 / gammaOil;
  let pb = 0.5197 * (rsb / gammaGas) ** 0.83 * 10 ** yg;
  if (rsbOld < MIN_RSB) pb = (pb - 0.1013) * rsbOld / MIN_RSB + 0.1013;
  return pb;
}

export function rsStandingM3m3(pMPa: number, gammaGas: number, tK: number, gammaOil: number): number {
  const yg = 1.225 + 0.001648 * tK - 1.769 / gammaOil;
  return gammaGas * ((1.92 * pMPa) / 10 ** yg) ** 1.204;
}

export function boStandingM3m3(rsM3m3: number, gammaGas: number, tK: number, gammaOil: number): number {
  const f = 5.615 * rsM3m3 * (gammaGas / gammaOil) ** 0.5 + 2.25 * tK - 575;
  return 0.972 + 0.000147 * f ** 1.175;
}

export function dBoDrsStanding(rsM3m3: number, gammaGas: number, tK: number, gammaOil: number): number {
  const alpha = 5.615 * (gammaGas / gammaOil) ** 0.5;
  const f = alpha * rsM3m3 + 2.25 * tK - 575.0;
  return 0.000147 * 1.175 * f ** 0.175 * alpha;
}

export function coVB1MPa(
  rsM3m3: number, gammaGas: number, tK: number, gammaOil: number, pMPa: number,
): number {
  return (28.1 * rsM3m3 + 30.6 * tK - 1180.0 * gammaGas + 1784.0 / gammaOil - 10910.0) / (100000.0 * pMPa);
}

export function muDeadOilBeggsRobinsonCP(tK: number, gammaOil: number): number {
  const tF = tK * 9.0 / 5.0 - 459.67;
  const x = tF ** -1.163 * Math.exp(13.108 - 6.591 / gammaOil);
  return 10.0 ** x - 1.0;
}

export function muSatOilBeggsRobinsonCP(rsM3m3: number, muDead: number): number {
  const rsScfBbl = rsM3m3 * CONVERT_M3M3_SCFBBL;
  const a = 10.715 * (rsScfBbl + 100.0) ** -0.515;
  const b = 5.44 * (rsScfBbl + 150.0) ** -0.338;
  return a * muDead ** b;
}

export function muOilVasquezBeggsCP(muSat: number, pMPa: number, pbMPa: number): number {
  const m = 957.0 * pMPa ** 1.187 * Math.exp(-11.513 - 0.01302 * pMPa);
  return muSat * (pMPa / pbMPa) ** m;
}

// ---------------------------------------------------------------------------
// Газ: псевдокритические параметры, Z-фактор (BB / Dranchuk-ABK / Kareem),
// FVF, вязкость Lee-Gonzalez
// ---------------------------------------------------------------------------

export const pseudoPressureStandingMPa = (gammaGas: number): number =>
  4.6 + 0.1 * gammaGas - 0.258 * gammaGas ** 2;

export const pseudoTemperatureStandingK = (gammaGas: number): number =>
  93.3 + 180 * gammaGas - 6.94 * gammaGas ** 2;

export const pseudoPressureSimpleMPa = (gammaGas: number): number => 4.9 - 0.4 * gammaGas;
export const pseudoTemperatureSimpleK = (gammaGas: number): number => 95 + 171 * gammaGas;

export function zFactorBB(Tpr: number, Ppr: number): number {
  const a = 1.39 * (Tpr - 0.92) ** 0.5 - 0.36 * Tpr - 0.101;
  const b =
    Ppr * (0.62 - 0.23 * Tpr) +
    Ppr ** 2 * (0.006 / (Tpr - 0.86) - 0.037) +
    (0.32 * Ppr ** 6) / Math.exp(20.723 * (Tpr - 1));
  const c = 0.132 - (0.32 * Math.log(Tpr)) / Math.log(10);
  const d = Math.exp(0.715 - 1.128 * Tpr + 0.42 * Tpr ** 2);
  return a + (1 - a) * Math.exp(-b) + c * Ppr ** d;
}

function dranchukResidual(Tpr: number, Ppr: number, z: number): number {
  const a1 = 0.3265, a2 = -1.07, a3 = -0.5339, a4 = 0.01569, a5 = -0.05165;
  const a6 = 0.5475, a7 = -0.7361, a8 = 0.1844, a9 = 0.1056, a10 = 0.6134, a11 = 0.721;
  const rhoR = (0.27 * Ppr) / (z * Tpr);
  return (
    -z +
    (a1 + a2 / Tpr + a3 / Tpr ** 3 + a4 / Tpr ** 4 + a5 / Tpr ** 5) * rhoR +
    (a6 + a7 / Tpr + a8 / Tpr ** 2) * rhoR ** 2 -
    a9 * (a7 / Tpr + a8 / Tpr ** 2) * rhoR ** 5 +
    (a10 * (1 + a11 * rhoR ** 2) * rhoR ** 2) / Tpr ** 3 * Math.exp(-a11 * rhoR ** 2) +
    1.0
  );
}

export function zFactorDranchuk(Tpr: number, Ppr: number): number {
  let zLow = 0.1, zHi = 5.0, zMid = 0.5 * (zLow + zHi);
  for (let i = 0; i < 200; i++) {
    zMid = 0.5 * (zLow + zHi);
    if (dranchukResidual(Tpr, Ppr, zLow) * dranchukResidual(Tpr, Ppr, zMid) < 0) zHi = zMid;
    else zLow = zMid;
    if (Math.abs(zLow - zHi) < 1e-6) break;
  }
  return zMid > 4.99 ? zFactorBB(Tpr, Ppr) : zMid;
}

const KAREEM_A = [
  0.0,
  0.317842, 0.382216, -7.768354, 14.290531, 0.000002, -0.004693, 0.096254, 0.16672,
  0.96691, 0.063069, -1.966847, 21.0581, -27.0246, 16.23, 207.783, -488.161, 176.29,
  1.88453, 3.05921,
];

export function zFactorKareem(Tpr: number, Ppr: number): number {
  const a = KAREEM_A;
  const t = 1.0 / Tpr;
  const t2 = t ** 2;
  const t3 = t ** 3;
  const AA = (a[1] * t * Math.exp(a[2] * (1 - t) ** 2) * Ppr) ** 2;
  const bb = a[3] * t + a[4] * t2 + a[5] * t ** 6 * Ppr ** 6;
  const CC = a[9] + a[8] * t * Ppr + a[7] * t2 * Ppr ** 2 + a[6] * t3 * Ppr ** 3;
  const dd = a[10] * t * Math.exp(a[11] * (1 - t) ** 2);
  const EE = a[12] * t + a[13] * t2 + a[14] * t3;
  const FF = a[15] * t + a[16] * t2 + a[17] * t3;
  const gg = a[18] + a[19] * t;
  const DPpr = dd * Ppr;
  const y = DPpr / ((1 + AA) / CC - (AA * bb) / CC ** 3);
  const y2 = y ** 2;
  return (DPpr * (1 + y + y2 - y ** 3)) / (DPpr + EE * y2 - FF * y ** gg) / (1 - y) ** 3;
}

export type ZCorrelation = "bb" | "dranchuk" | "kareem";

export function zGas(tK: number, pMPa: number, gammaGas: number, zCor: ZCorrelation = "kareem"): number {
  if (zCor === "dranchuk") {
    return zFactorDranchuk(tK / pseudoTemperatureStandingK(gammaGas), pMPa / pseudoPressureStandingMPa(gammaGas));
  }
  if (zCor === "kareem") {
    return zFactorKareem(tK / pseudoTemperatureStandingK(gammaGas), pMPa / pseudoPressureStandingMPa(gammaGas));
  }
  return zFactorBB(tK / pseudoTemperatureSimpleK(gammaGas), pMPa / pseudoPressureSimpleMPa(gammaGas));
}

export const bGasM3m3 = (tK: number, pMPa: number, z: number): number => (0.00034722 * tK * z) / pMPa;

export function muGasCP(tK: number, pMPa: number, z: number, gammaGas: number): number {
  const r = 1.8 * tK;
  const mwg = 28.966 * gammaGas;
  const gd = (pMPa * mwg) / (z * tK * 8.31);
  const a = ((9.379 + 0.01607 * mwg) * r ** 1.5) / (209.2 + 19.26 * mwg + r);
  const b = 3.448 + 986.4 / r + 0.01009 * mwg;
  const c = 2.447 - 0.2224 * b;
  return 0.0001 * a * Math.exp(b * gd ** c);
}

export const gasHeatCapacityRatio = (gammaGas: number, tK: number): number => {
  const a = 0.000286;
  return (1.6 - 0.44 * gammaGas + 0.097 * gammaGas ** 2) * (1 + 0.0385 * gammaGas - a * tK);
};

// ---------------------------------------------------------------------------
// Вода (McCain 1990, PetroWiki)
// ---------------------------------------------------------------------------

export function muWatCP(pMPa: number, tK: number, salinityPpm: number): number {
  const wpTDS = salinityPpm / 10000.0;
  const tF = 1.8 * tK - 460.0;
  const a = 109.574 - 8.40564 * wpTDS + 0.313314 * wpTDS ** 2 + 0.00872213 * wpTDS ** 3;
  const b =
    -1.12166 + 0.0263951 * wpTDS - 0.000679461 * wpTDS ** 2 - 5.47119e-5 * wpTDS ** 3 + 1.55586e-6 * wpTDS ** 4;
  const psi = pMPa * 145.04;
  return a * tF ** b * (0.9994 + 4.0295e-5 * psi + 3.1062e-9 * psi ** 2);
}

export function bWatM3m3(pMPa: number, tK: number): number {
  const f = 1.8 * tK - 460.0;
  const psi = pMPa * 145.04;
  const dvwp = -1.95301e-9 * psi * f - 1.72834e-13 * psi ** 2 * f - 3.58922e-7 * psi - 2.25341e-10 * psi ** 2;
  const dvwt = -1.0001e-2 + 1.33391e-4 * f + 5.50654e-7 * f ** 2;
  return (1.0 + dvwp) * (1.0 + dvwt);
}

export const rhoWatScKgm3 = (salinityPpm: number): number => {
  const wpTDS = salinityPpm / 10000.0;
  return 0.0160185 * (62.368 + 0.438603 * wpTDS + 0.00160074 * wpTDS ** 2) * 1000.0;
};

export const salinityFromRhoPpm = (rhoSc: number): number => {
  const bwsc = rhoSc / 1000.0;
  const inner = (624.711071129603 * bwsc) / 0.0160185 - 20192.9595437054;
  return (inner ** 0.5 - 137.000074965329) * 10000.0;
};

export const salinityPpmFromGamma = (gammaWat: number): number => salinityFromRhoPpm(gammaWat * 1000.0);

export function gwrM3m3(pMPa: number, tK: number, salinityPpm: number): number {
  const f = 1.8 * tK - 460.0;
  const psi = pMPa * 145.04;
  const wpTDS = salinityPpm / 10000.0;
  const a = 8.15839 - 0.0612265 * f + 1.91663e-4 * f ** 2 - 2.1654e-7 * f ** 3;
  const b = 1.01021e-2 - 7.44241e-5 * f + 3.05553e-7 * f ** 2 - 2.94883e-10 * f ** 3;
  const c = (-9.02505 + 0.130237 * f - 8.53425e-4 * f ** 2 + 2.34122e-6 * f ** 3 - 2.37049e-9 * f ** 4) * 1e-7;
  const rswws = (a + b * psi + c * psi ** 2) * 0.1781;
  return rswws * 10 ** (-0.0840655 * wpTDS * f ** -0.285854);
}

export const rhoWatRcKgm3 = (pMPa: number, tK: number, salinityPpm: number): number =>
  rhoWatScKgm3(salinityPpm) / bWatM3m3(pMPa, tK);

export function cpWatJkgC(tK: number, salinityPpm: number): number {
  const tC = tK - 273.15;
  let cp = 4218.0 - 1.0674 * tC + 0.02833 * tC ** 2 - 2.425e-4 * tC ** 3 + 6.824e-7 * tC ** 4;
  cp *= 1.0 - 0.00347 * (salinityPpm / 10000.0);
  return cp;
}

// ---------------------------------------------------------------------------
// Поверхностное натяжение (Baker-Sverdloff, Overriding)
// ---------------------------------------------------------------------------

export function sigmaOilGasNm(pMPa: number, tC: number, gammaOil: number): number {
  const oilApi = 141.5 / gammaOil - 131.5;
  const tF = tC * 1.8 + 32.0;
  const pPsia = pMPa * 145.04;
  const st68 = 39.0 - 0.2571 * oilApi;
  const st100 = 37.5 - 0.2571 * oilApi;
  let sto: number;
  if (tF < 68.0) {
    sto = st68;
  } else {
    const tst = Math.min(tF, 100.0);
    sto = (st68 - ((tst - 68.0) * (st68 - st100)) / 32.0) * 2.71828182845904 ** (-0.00086306 * pPsia);
  }
  return Math.max(sto, 0.0) / 1000.0;
}

export const sigmaWatGasNm = (pMPa: number): number => 10 ** -(1.19 + 0.01 * pMPa);

export const sigmaLiqGasNm = (sigmaOilGas: number, sigmaWatGas: number, fw: number): number =>
  sigmaWatGas * fw + sigmaOilGas * (1.0 - fw);

// ---------------------------------------------------------------------------
// Плотность нефти (массовый баланс Standing) — в feed используется RHO_AIR_SC
// ---------------------------------------------------------------------------

export const rhoOilRcKgm3 = (rsM3m3: number, gammaGas: number, gammaOil: number, boM3m3: number): number =>
  (1000.0 * gammaOil + RHO_AIR_SC * gammaGas * rsM3m3) / boM3m3;

export const rhoGasRcKgm3 = (gammaGas: number, bGas: number): number => (gammaGas * RHO_AIR_SC) / bGas;

// Теплоёмкость нефти (unfpy Feed.calc)
export const cpOilJkgC = (tC: number, gammaOil: number): number =>
  ((0.002 * tC - 1.429) * gammaOil + 0.00267 * tC + 3.49) * 1000.0;
