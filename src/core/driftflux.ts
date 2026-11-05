// Drift-flux модель газожидкостного потока — порт sand_transport (index.html, ядро).
// Явная формула alpha = vsg/(C0*vm + vd) — БЕЗ итераций (см. AGENTS.md sand_transport
// §4.3: итерационный решатель дивергировал при высоком vsg).
// Для барботажа газа в неподвижной жидкости используется vsl = 0 (замыкание Harmathy).

import { G, M3DAY_TO_M3SEC } from "./units.js";
import { zGas } from "./pvt.js";

export type FlowRegime = "bubbly" | "slug" | "churn" | "annular" | "liquid";

export interface RegimeClosures {
  C0: number; // коэффициент распределения
  vd: number; // скорость дрейфа газа, м/с
}

/** Классификация режима по истинному газосодержанию и приведённой скорости газа (м/с). */
export function classifyRegime(alpha: number, vsg: number): FlowRegime {
  if (alpha < 0.25 && vsg < 0.9) return "bubbly";
  if (alpha < 0.55 && vsg < 4.0) return "slug";
  if (alpha < 0.78 && vsg < 9.0) return "churn";
  return "annular";
}

/** Замыкания drift-flux по режиму (порт regimeClosures, sand_transport). */
export function regimeClosures(regime: FlowRegime, dM: number, rhoL: number, rhoG: number, sigma: number): RegimeClosures {
  const dr = Math.max(rhoL - rhoG, 1);
  const vdHarmathy = 1.53 * ((G * sigma * dr) / (rhoL * rhoL)) ** 0.25;
  const vdTaylor = Math.sqrt((G * dM * dr) / rhoL);
  switch (regime) {
    case "bubbly": return { C0: 1.2, vd: vdHarmathy };
    case "slug": return { C0: 1.15, vd: 0.35 * vdTaylor };
    case "churn": return { C0: 1.08, vd: 0.22 * vdTaylor };
    case "annular": return { C0: 1.0, vd: 0.04 * vdTaylor };
    default: return { C0: 1.0, vd: 0 };
  }
}

export const clamp2 = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export interface DriftFluxResult {
  alpha: number; // истинное газосодержание, 0..0.95
  vl: number; // истинная скорость жидкости, м/с
  vg: number; // истинная скорость газа, м/с
  vm: number; // смесевая приведённая скорость, м/с
  C0: number;
  vd: number;
  regime: FlowRegime;
}

/**
 * Drift-flux замыкание: приведённые скорости (м/с) -> истинное газосодержание.
 * vsl = 0 даёт барботаж газа через неподвижную жидкость.
 */
export function driftFlux(vsl: number, vsg: number, dM: number, rhoL: number, rhoG: number, sigma: number): DriftFluxResult {
  const vm = vsl + vsg;
  if (vsg < 1e-9) {
    return { alpha: 0, vl: vsl, vg: 0, vm, C0: 1, vd: 0, regime: "liquid" };
  }
  // двухшаговая классификация: сначала по гомогенному alpha, затем уточнение
  let regime = classifyRegime(clamp2(vsg / Math.max(vm, 1e-9), 0, 1), vsg);
  let cl = regimeClosures(regime, dM, rhoL, rhoG, sigma);
  let alpha = clamp2(vsg / (cl.C0 * vm + cl.vd), 0, 0.95);
  regime = classifyRegime(alpha, vsg);
  cl = regimeClosures(regime, dM, rhoL, rhoG, sigma);
  alpha = clamp2(vsg / (cl.C0 * vm + cl.vd), 0, 0.95);
  const vl = vsl / Math.max(1 - alpha, 1e-6);
  const vg = vsg / Math.max(alpha, 1e-6);
  return { alpha, vl, vg, vm, C0: cl.C0, vd: cl.vd, regime };
}

/** Коэффициент гидравлического трения: ламинар 64/Re, турбулентный — Colebrook гладкая труба. */
export function frictionFactor(re: number): number {
  return re > 2300 ? (0.79 * Math.log(re) - 1.64) ** -2 : 64 / Math.max(re, 1);
}

export interface TraverseInput {
  /** давление на нижней границе участка, atma */
  pBottomAtma: number;
  /** длина участка (по вертикали), м; глубины: zBottom >= zTop */
  zBottomM: number;
  zTopM: number;
  /** внутренний диаметр канала, м */
  dM: number;
  /** скорость (0 => чистый барботаж/гидростатика) */
  qLiqSm3day: number; // жидкость ст.у (для барботажа игнорируется)
  /** объёмный расход газа как функция давления (ст.м3/сут) */
  qGasFreeSm3day: number;
  /** свойства жидкости (пласт. усл.) */
  rhoLiqKgm3: number;
  muLiqCP: number;
  /** газ: относительная плотность; PVT газа считается внутри по Z-фактору */
  gammaGas: number;
  /** температура, °C, как функция глубины (от поверхности) */
  tAtDepthC: (z: number) => number;
  /** Z-корреляция */
  zCorrelation: "bb" | "dranchuk" | "kareem";
  /** число сегментов */
  nSeg?: number;
}

export interface TraverseNode {
  zM: number; // глубина от поверхности, м
  pAtma: number;
  tC: number;
  alpha: number;
  vm: number; // м/с
  vsl: number;
  vsg: number;
  rhoMixKgm3: number;
  regime: FlowRegime;
  dpdzAtmaM: number;
}

/**
 * Марш давления от zBottom вверх до zTop (восходящий поток). Явный Эйлер по сегментам.
 * Градиент: гидростатика (alpha-взвешенная плотность) + трение Дарси-Вейсбаха
 * по смесевой скорости (порт computeProfile из sand_transport, без твёрдой фазы).
 */
export function traverseUp(inp: TraverseInput): TraverseNode[] {
  const nSeg = inp.nSeg ?? 100;
  const dz = (inp.zBottomM - inp.zTopM) / nSeg;
  const area = (Math.PI * inp.dM * inp.dM) / 4;
  const nodes: TraverseNode[] = [];

  let p = inp.pBottomAtma;
  let z = inp.zBottomM;
  const flowing = inp.qLiqSm3day > 0 || inp.qGasFreeSm3day > 0;

  for (let i = 0; i <= nSeg; i++) {
    const tC = inp.tAtDepthC(z);
    const tK = tC + 273.0;
    const pMPa = p * 0.101325;
    const zFac = zGas(tK, pMPa, inp.gammaGas, inp.zCorrelation);
    const bg = (0.00034722 * tK * zFac) / pMPa;
    const rhoGas = (inp.gammaGas * 1.2217) / bg;
    const qGasRc = inp.qGasFreeSm3day * bg;

    const vsl = flowing ? (inp.qLiqSm3day * M3DAY_TO_M3SEC) / area : 0;
    const vsg = flowing ? (qGasRc * M3DAY_TO_M3SEC) / area : 0;

    const df = driftFlux(vsl, vsg, inp.dM, inp.rhoLiqKgm3, rhoGas, 0.03);
    const rhoMix = df.alpha * rhoGas + (1 - df.alpha) * inp.rhoLiqKgm3;

    // градиент давления, Па/м
    const dpdzGrav = rhoMix * G;
    let dpdzFric = 0;
    if (flowing && df.vm > 1e-6) {
      const muMix = (1 - df.alpha) * inp.muLiqCP * 1e-3 + df.alpha * 1e-5; // Па·с, газ ~0.01 сП
      const re = Math.max(1, (rhoMix * df.vm * inp.dM) / Math.max(muMix, 1e-5));
      const f = frictionFactor(re);
      dpdzFric = (f * rhoMix * df.vm * df.vm) / (2 * inp.dM);
    }
    const dpdz = (dpdzGrav + dpdzFric) / 101325; // atma/м
    nodes.push({
      zM: z, pAtma: p, tC, alpha: df.alpha, vm: df.vm, vsl, vsg,
      rhoMixKgm3: rhoMix, regime: df.regime, dpdzAtmaM: dpdz,
    });

    // шаг вверх: давление падает
    p = Math.max(0.9, p - dpdz * dz);
    z -= dz;
  }
  return nodes;
}

/**
 * Обратный марш: давление на нижней границе участка по известному давлению сверху
 * (спуск по НКТ от устья вниз). Используется для построения VLP-профиля от устья.
 */
export function traverseDownFromTop(inp: Omit<TraverseInput, "pBottomAtma"> & { pTopAtma: number }): TraverseNode[] {
  // порядок узлов от верха к низу, интегрирование вниз
  const nSeg = inp.nSeg ?? 100;
  const dz = (inp.zBottomM - inp.zTopM) / nSeg;
  const area = (Math.PI * inp.dM * inp.dM) / 4;
  const nodes: TraverseNode[] = [];

  let p = inp.pTopAtma;
  let z = inp.zTopM;
  const flowing = inp.qLiqSm3day > 0 || inp.qGasFreeSm3day > 0;

  for (let i = 0; i <= nSeg; i++) {
    const tC = inp.tAtDepthC(z);
    const tK = tC + 273.0;
    const pMPa = p * 0.101325;
    const zFac = zGas(tK, pMPa, inp.gammaGas, inp.zCorrelation);
    const bg = (0.00034722 * tK * zFac) / pMPa;
    const rhoGas = (inp.gammaGas * 1.2217) / bg;
    const qGasRc = inp.qGasFreeSm3day * bg;

    const vsl = flowing ? (inp.qLiqSm3day * M3DAY_TO_M3SEC) / area : 0;
    const vsg = flowing ? (qGasRc * M3DAY_TO_M3SEC) / area : 0;

    const df = driftFlux(vsl, vsg, inp.dM, inp.rhoLiqKgm3, rhoGas, 0.03);
    const rhoMix = df.alpha * rhoGas + (1 - df.alpha) * inp.rhoLiqKgm3;

    const dpdzGrav = rhoMix * G;
    let dpdzFric = 0;
    if (flowing && df.vm > 1e-6) {
      const muMix = (1 - df.alpha) * inp.muLiqCP * 1e-3 + df.alpha * 1e-5;
      const re = Math.max(1, (rhoMix * df.vm * inp.dM) / Math.max(muMix, 1e-5));
      const f = frictionFactor(re);
      dpdzFric = (f * rhoMix * df.vm * df.vm) / (2 * inp.dM);
    }
    const dpdz = (dpdzGrav + dpdzFric) / 101325; // atma/м
    nodes.push({
      zM: z, pAtma: p, tC, alpha: df.alpha, vm: df.vm, vsl, vsg,
      rhoMixKgm3: rhoMix, regime: df.regime, dpdzAtmaM: dpdz,
    });

    p += dpdz * dz;
    z += dz;
  }
  return nodes;
}

/** Линейная интерполяция давления профиля на произвольной глубине (направление любое). */
export function pressureAtDepth(nodes: TraverseNode[], z: number): number {
  const n = nodes.length;
  if (n === 0) return NaN;
  const asc = nodes[0].zM < nodes[n - 1].zM; // true: снизу вверх (z растёт)
  let i0 = 0;
  if (asc) {
    if (z <= nodes[0].zM) return nodes[0].pAtma;
    if (z >= nodes[n - 1].zM) return nodes[n - 1].pAtma;
    while (i0 < n - 1 && nodes[i0 + 1].zM < z) i0++;
    const t = (z - nodes[i0].zM) / (nodes[i0 + 1].zM - nodes[i0].zM);
    return nodes[i0].pAtma + t * (nodes[i0 + 1].pAtma - nodes[i0].pAtma);
  }
  // сверху вниз (z убывает)
  if (z >= nodes[0].zM) return nodes[0].pAtma;
  if (z <= nodes[n - 1].zM) return nodes[n - 1].pAtma;
  while (i0 < n - 1 && nodes[i0 + 1].zM > z) i0++;
  const t = (nodes[i0].zM - z) / (nodes[i0].zM - nodes[i0 + 1].zM);
  return nodes[i0].pAtma + t * (nodes[i0 + 1].pAtma - nodes[i0].pAtma);
}
