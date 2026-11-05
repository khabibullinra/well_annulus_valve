// IPR по Вогелю, композитная модель — порт unfpy/reservoir/ipr.py (_vogel_q_liq_jit).
// Выше pb — Дарси, ниже — Вогель; вода — параллельная линейная ветвь.

/** Параметры IPR. pb <= 0 => pb = p_res. Тестовая точка (qTest, pTest) задаёт q_max. */
export interface IprParams {
  pResAtma: number;
  pbAtma: number; // <=0 => p_res
  qTestSm3day: number;
  pTestAtma: number;
  fwPerc: number; // обводнённость, % (0..100)
}

/**
 * Дебит жидкости при заданном забойном давлении, ст.м3/сут.
 * Порт _vogel_q_liq_jit.
 */
export function vogelQLiqSm3day(pWfAtma: number, ipr: IprParams): number {
  if (pWfAtma >= ipr.pResAtma) return 0;
  const pb = ipr.pbAtma > 0 ? ipr.pbAtma : ipr.pResAtma;
  const fw = ipr.fwPerc / 100.0;

  // q_max из тестовой точки
  let qOilMax = 0, qWatMax = 0, qMax: number;
  if (pb >= ipr.pResAtma) {
    // недонасыщенная тестовая точка -> масштабирование Вогеля
    const vogelTest = 1 - 0.2 * (ipr.pTestAtma / pb) - 0.8 * (ipr.pTestAtma / pb) ** 2;
    qOilMax = (ipr.qTestSm3day * (1 - fw)) / vogelTest;
    qWatMax = (ipr.qTestSm3day * fw) / (1 - ipr.pTestAtma / ipr.pResAtma);
    qMax = qOilMax + qWatMax;
  } else {
    // pb < p_res: Дарси в области выше pb
    const J = ipr.qTestSm3day / (ipr.pResAtma - ipr.pTestAtma);
    qMax = J * ipr.pResAtma;
  }

  let q: number;
  if (pWfAtma >= pb) {
    // линейный закон Дарси выше pb
    q = qMax * (1 - pWfAtma / ipr.pResAtma);
  } else if (pb >= ipr.pResAtma) {
    // чистый Вогель (насыщенный пласт)
    const qOil = qOilMax * (1 - 0.2 * (pWfAtma / pb) - 0.8 * (pWfAtma / pb) ** 2);
    const qWat = qWatMax * (1 - pWfAtma / ipr.pResAtma);
    q = qOil + qWat;
  } else {
    // композит: Дарси до pb + Вогель ниже
    const qAtPb = qMax * (1 - pb / ipr.pResAtma);
    const J = qMax / ipr.pResAtma;
    const qVogelMax = qAtPb + (J * pb) / 1.8;
    const qOil =
      qAtPb * (1 - fw) +
      (qVogelMax - qAtPb) * (1 - fw) * (1 - 0.2 * (pWfAtma / pb) - 0.8 * (pWfAtma / pb) ** 2);
    const qWat = qVogelMax * fw * (1 - pWfAtma / ipr.pResAtma);
    q = qOil + qWat;
  }
  return Math.max(0, q);
}

/** Забойное давление при заданном дебите — бисекция по p на [0, p_res]. */
export function vogelPwfAtma(qLiqSm3day: number, ipr: IprParams): number {
  if (qLiqSm3day <= 0) return ipr.pResAtma;
  let lo = 0, hi = ipr.pResAtma;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    const qMid = vogelQLiqSm3day(mid, ipr);
    if (Math.abs(qMid - qLiqSm3day) < 0.01) return mid;
    if (qMid > qLiqSm3day) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Кривая IPR: n точек pwf от 0 до p_res. */
export function buildIprCurve(ipr: IprParams, n = 50): { pwfAtma: number; qSm3day: number }[] {
  const pts: { pwfAtma: number; qSm3day: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const pwf = (ipr.pResAtma * i) / n;
    pts.push({ pwfAtma: pwf, qSm3day: vogelQLiqSm3day(pwf, ipr) });
  }
  return pts;
}
