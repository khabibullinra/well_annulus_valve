// Модель ЭЦН — порт unfpy/esp/pump.py + pump_njit.py.
// Кривые head/power/eff vs rate из БД (pumps.json), полиномиальная интерполяция
// deg-2 (наименьшие квадраты, как np.polyfit), affinity laws по частоте,
// вязкостная коррекция (SPE-метод), деградация напора от свободного газа
// (квадратичные модели 0-4 по газосодержанию, пересчёт по ступеням).

import type { Feed, FeedState } from "./feed.js";

// ---------------------------------------------------------------------------
// Полиномиальная интерполяция по МНК (аналог np.polyfit + np.polyval)
// ---------------------------------------------------------------------------

/** МНК-подбор полинома степени <= 2; возвращает коэффициенты [a0, a1, a2...] (p(x)=a0+a1*x+a2*x^2). */
export function polyfitDeg2(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  // нормальные уравнения для степени 2
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    s0 += 1; s1 += x; s2 += x * x; s3 += x ** 3; s4 += x ** 4;
    t0 += y; t1 += x * y; t2 += x * x * y;
  }
  // решаем 3x3 [s0 s1 s2; s1 s2 s3; s2 s3 s4] * [a0 a1 a2] = [t0 t1 t2]
  const m = [
    [s0, s1, s2, t0],
    [s1, s2, s3, t1],
    [s2, s3, s4, t2],
  ];
  // Гаусс с частичным выбором
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    if (Math.abs(d) < 1e-300) continue;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / d;
      for (let c = col; c <= 3; c++) m[r][c] -= f * m[col][c];
    }
  }
  const a0 = m[0][3] / (m[0][0] || 1);
  const a1 = m[1][3] / (m[1][1] || 1);
  const a2 = m[2][3] / (m[2][2] || 1);
  return [a0, a1, a2];
}

const polyval = (c: number[], x: number): number => c[0] + c[1] * x + (c[2] ?? 0) * x * x;

/** Кэш коэффициентов кривых по ключу. */
const curveCache = new Map<string, number[]>();
function crv(key: string, xs: number[], ys: number[], x: number): number {
  if (xs.length < 2) return ys[0] ?? 0;
  let c = curveCache.get(key);
  if (!c) {
    c = polyfitDeg2(xs, ys);
    curveCache.set(key, c);
  }
  return polyval(c, x);
}

// ---------------------------------------------------------------------------
// Газовая деградация (порт gas_correction_factor)
// ---------------------------------------------------------------------------

export type GasCorrectModel = 0 | 1 | 2 | 3 | 4;

/**
 * Коэффициент газовой деградации напора по объёмной доле газа.
 * 0 — без коррекции; 1 — стандартный ЭЦН (~25% GVF); 2 — gas handler (~50%);
 * 3 — продвинутый gas handler (~75%); 4 — с газосепаратором (~40%).
 */
export function gasCorrectionFactor(model: GasCorrectModel, gasFrac: number): number {
  let b = gasFrac;
  if (b < 0) b = 0;
  else if (b > 0.999) b = 0.999;
  switch (model) {
    case 0: return 1.0;
    case 1: return -9.0 * b * b + 0.6 * b + 1.0;
    case 2: return -2.0 * b * b + 0.05 * b + 1.0;
    case 3: return -1.4 * b * b + 0.15 * b + 1.0;
    case 4: return -4.0 * b * b + 0.2 * b + 1.0;
    default: return 1.0;
  }
}

// ---------------------------------------------------------------------------
// Вязкостная коррекция (SPE метод, порт _calc_correct_visc)
// ---------------------------------------------------------------------------

const CONVERT_M3DAY_GPM = 0.00441849719;
const CONVERT_M_FT = 3.28084;

export interface ViscCorrection { cq: number; cp: number; ce: number; ch: (qMix: number) => number }

function linearInterpExtrapolate(pts: { x: number; y: number }[], x: number): number {
  if (pts.length === 0) return 0;
  if (pts.length === 1) return pts[0].y;
  if (x <= pts[0].x) {
    const [p0, p1] = [pts[0], pts[1]];
    return p0.y + ((x - p0.x) / (p1.x - p0.x)) * (p1.y - p0.y);
  }
  if (x >= pts[pts.length - 1].x) {
    const p0 = pts[pts.length - 2], p1 = pts[pts.length - 1];
    return p1.y + ((x - p1.x) / (p1.x - p0.x)) * (p1.y - p0.y);
  }
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const p0 = pts[i - 1], p1 = pts[i];
      return p0.y + ((x - p0.x) / (p1.x - p0.x)) * (p1.y - p0.y);
    }
  }
  return pts[pts.length - 1].y;
}

export function viscCorrection(
  nuCSt: number, hBepFt: number, qBepGpm: number, rateNom: number,
): ViscCorrection {
  const noCorr: ViscCorrection = { cq: 1, cp: 1, ce: 1, ch: () => 1 };
  if (nuCSt < 5 || qBepGpm <= 0 || hBepFt <= 0) return noCorr;

  const gamma = -7.5946 + 6.6504 * Math.log(hBepFt) + 12.8429 * Math.log(qBepGpm);
  const qStar = Math.exp((39.5276 + 26.5606 * Math.log(nuCSt) - gamma) / 51.6565);
  let cq = 1.0 - 4.0327e-3 * qStar - 1.724e-4 * qStar * qStar;
  if (cq < 0) return noCorr;
  const ce = 1.0 - 3.3075e-2 * qStar + 2.8875e-4 * qStar * qStar;
  const cp = ce > 0 ? 1.0 / ce : 1.0;

  const qNom = rateNom * cq;
  const h1_0 = 1 - 7.00763e-3 * qStar - 1.41e-5 * qStar ** 2;
  const h0_8 = 1 - 4.4726e-3 * qStar - 4.18e-5 * qStar ** 2;
  const h0_6 = 1 - 3.68e-3 * qStar - 4.36e-5 * qStar ** 2;
  const h1_2 = 1 - 9.01e-3 * qStar + 1.31e-5 * qStar ** 2;

  let pts = [
    { x: qNom * 0.6, y: h0_6 },
    { x: qNom * 0.8, y: h0_8 },
    { x: qNom, y: h1_0 },
    { x: qNom * 1.2, y: h1_2 },
  ].sort((a, b) => a.x - b.x);
  const h0 = linearInterpExtrapolate(pts, 0);
  pts = [{ x: 0, y: h0 < 0 ? h0_6 : h0 }, ...pts];

  return { cq, cp, ce, ch: (qMix: number) => linearInterpExtrapolate(pts, qMix) };
}

// ---------------------------------------------------------------------------
// Насос
// ---------------------------------------------------------------------------

export interface PumpDbRecord {
  id: string;
  rateNom: number;
  rateMax: number;
  freqHz: number;
  dOdMm: number | null;
  ratePoints: number[];
  headPoints: number[];
  powerPoints: number[];
  effPoints: number[];
}

export interface EspCalcResult {
  pIntakeAtma: number;
  pDisAtma: number;
  tIntakeC: number;
  tDisC: number;
  headM: number; // суммарный напор, м
  powerFluidW: number; // гидравлическая мощность, Вт
  powerShaftW: number; // мощность на валу, Вт
  effD: number; // КПД
  gasFracIntake: number;
  gasCorr: number;
  qMixRcM3day: number; // смесь через насос (пласт. усл.), м3/сут
}

export interface EspOptions {
  stageNum: number;
  freqHz: number;
  gasCorrectModel: GasCorrectModel;
  calibrHead?: number;
  calibrRate?: number;
  calibrPower?: number;
  correctVisc?: boolean;
}

export class EspPump {
  db: PumpDbRecord;
  opts: Required<EspOptions>;

  constructor(db: PumpDbRecord, opts: EspOptions) {
    this.db = db;
    this.opts = {
      calibrHead: 1, calibrRate: 1, calibrPower: 1, correctVisc: true,
      ...opts,
    };
  }

  private key(suffix: string): string {
    return `${this.db.id}|${suffix}`;
  }

  /** Напор ступени по affinity laws (порт _calc_head_nominal_m). */
  private calcHeadNominal(qM3day: number, stageNum: number): number {
    const b = this.db.freqHz / this.opts.freqHz;
    const qAdj = b * qM3day;
    const h1 = crv(this.key("head"), this.db.ratePoints, this.db.headPoints, qAdj);
    return b ** -2 * stageNum * h1;
  }

  /** Напор при расходе с вязкостной коррекцией (порт get_head_m). */
  headM(qM3day: number, stageNum: number, vc: ViscCorrection): number {
    if (qM3day < 0) return 0;
    const qCalc = qM3day / vc.cq;
    const maxQ = (this.db.rateMax * this.opts.freqHz) / this.db.freqHz;
    let head: number;
    if (qCalc < maxQ) {
      head = this.calcHeadNominal(qCalc, stageNum);
    } else {
      // линейная экстраполяция за пределами кривой (отрицательный напор)
      const h95 = this.calcHeadNominal(maxQ * 0.95, stageNum);
      head = -h95 * ((qCalc - maxQ) / (maxQ * 0.05));
    }
    return head * vc.ch(qM3day);
  }

  /** Мощность на валу, Вт (порт get_power_W; БД в кВт/ступень при воде 1000 кг/м3). */
  powerW(qM3day: number, stageNum: number, vc: ViscCorrection): number {
    if (qM3day < 0) return 0;
    const maxQ = (this.db.rateMax * this.opts.freqHz) / this.db.freqHz * vc.cq;
    const q = Math.min(qM3day, maxQ);
    const qAdj = q / vc.cq;
    const b = this.db.freqHz / this.opts.freqHz;
    const power = 1000 * b ** -3 * stageNum * crv(this.key("power"), this.db.ratePoints, this.db.powerPoints, b * qAdj);
    return Math.max(0, power * vc.cp);
  }

  /** КПД по кривой с вязкостной коррекцией. */
  effCurve(qM3day: number, vc: ViscCorrection): number {
    const maxQ = (this.db.rateMax * this.opts.freqHz) / this.db.freqHz * vc.cq;
    if (qM3day < 0 || qM3day > maxQ) return 0;
    const qAdj = qM3day / vc.cq;
    const b = this.db.freqHz / this.opts.freqHz;
    const eff = crv(this.key("eff"), this.db.ratePoints, this.db.effPoints, b * qAdj);
    return Math.max(0, eff * vc.ce);
  }

  /** Вязкостная коррекция для текущей точки. */
  viscCorr(nuCSt: number): ViscCorrection {
    if (!this.opts.correctVisc || nuCSt <= 0) return { cq: 1, cp: 1, ce: 1, ch: () => 1 };
    const qBepGpm = this.db.rateNom * CONVERT_M3DAY_GPM;
    const hBepFt = this.calcHeadNominal(this.db.rateNom, 1) * CONVERT_M_FT;
    return viscCorrection(nuCSt, hBepFt, qBepGpm, this.db.rateNom);
  }

  /**
   * Расчёт ЭЦН по ступеням от приёма вверх (порт calc_ESP, T = геотерма фиксируется
   * вызывающим кодом — нагрев не учитывается по требованию).
   */
  calcEsp(feed: Feed, pIntakeAtma: number, tIntakeC: number, tDisC: number): EspCalcResult {
    const o = this.opts;
    const pSt0 = Math.max(pIntakeAtma, 1.0);
    let pSt = pSt0;
    let headTotal = 0;
    let powFluidTot = 0;
    let powEspTot = 0;
    let gasCorr = 1.0;
    let gasFracIntake = 0;
    let qMixRc = 0;

    let st: FeedState = feed.calc(pSt, tIntakeC);
    gasFracIntake = st.gasFractionD;
    gasCorr = gasCorrectionFactor(o.gasCorrectModel, gasFracIntake);
    qMixRc = st.qMixRcM3day;

    const dNst = 1; // по одной ступени — точно по газосодержанию
    let n = 0;
    let dPAvg = 0;
    while (n < o.stageNum) {
      const nSt = (o.stageNum - n) >= dNst ? dNst : 1;
      if (pSt + dPAvg < 1) { pSt = 0.9; break; }

      st = feed.calc(pSt + dPAvg, tIntakeC + (tDisC - tIntakeC) * (n / Math.max(o.stageNum, 1)));
      gasCorr = gasCorrectionFactor(o.gasCorrectModel, st.gasFractionD);
      qMixRc = st.qMixRcM3day;

      const qMixDegr = st.qMixRcM3day / Math.max(o.calibrRate, 0.01);
      const rhoMix = st.rhoMixRcKgm3;
      const nuMixCSt = rhoMix > 0 ? st.muMixCP / (rhoMix / 1000.0) : 1.0;
      const vc = this.viscCorr(nuMixCSt);

      let headMix = this.headM(qMixDegr, nSt, vc) * o.calibrHead;
      if (gasCorr > 0) headMix *= gasCorr;
      else headMix = 20 * gasCorr; // насос не выдаёт напор (срыв по газу)

      headTotal += headMix;
      const dPStage = (rhoMix * 9.81 * headMix) / 101325.0;
      pSt += dPStage;
      dPAvg = dPStage / 2;

      if (dPStage > 0) {
        const powFluid = (st.qMixRcM3day / 86400) * dPStage * 101325;
        powFluidTot += powFluid;
        const powEsp = this.powerW(qMixDegr, nSt, vc) * (rhoMix / 1000.0) * o.calibrPower;
        powEspTot += powEsp;
      }
      n += nSt;
    }

    return {
      pIntakeAtma: pSt0,
      pDisAtma: pSt,
      tIntakeC,
      tDisC,
      headM: headTotal,
      powerFluidW: powFluidTot,
      powerShaftW: powEspTot,
      effD: powEspTot > 0 ? powFluidTot / powEspTot : 0,
      gasFracIntake,
      gasCorr,
      qMixRcM3day: qMixRc,
    };
  }

  /** Число ступеней под требуемый напор (по напору одной ступени в номинальной точке). */
  static stagesForHead(db: PumpDbRecord, headRequiredM: number, freqHz: number): number {
    const b = db.freqHz / freqHz;
    const h1 = crv(`${db.id}|head`, db.ratePoints, db.headPoints, b * db.rateNom);
    const h1Adj = b ** -2 * h1;
    if (h1Adj <= 0.01) return 100;
    return Math.max(10, Math.round(headRequiredM / h1Adj));
  }
}
