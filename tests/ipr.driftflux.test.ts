// Sanity-тесты IPR (Вогель) и drift-flux.

import { describe, expect, it } from "vitest";
import { buildIprCurve, vogelPwfAtma, vogelQLiqSm3day } from "../src/core/ipr.js";
import { classifyRegime, driftFlux, frictionFactor, pressureAtDepth, traverseUp } from "../src/core/driftflux.js";

const saturated: Parameters<typeof vogelQLiqSm3day>[1] = {
  pResAtma: 200, pbAtma: 0, qTestSm3day: 100, pTestAtma: 150, fwPerc: 0,
};

describe("IPR Вогель", () => {
  it("нулевая добыча при pwf >= p_res", () => {
    expect(vogelQLiqSm3day(200, saturated)).toBe(0);
    expect(vogelQLiqSm3day(220, saturated)).toBe(0);
  });

  it("монотонность по pwf", () => {
    let prev = Infinity;
    for (let pwf = 0; pwf <= 200; pwf += 10) {
      const q = vogelQLiqSm3day(pwf, saturated);
      expect(q).lessThanOrEqual(prev + 1e-9);
      prev = q;
    }
  });

  it("чистый Вогель: q_max при pwf->0 соответствует формуле", () => {
    // pb = p_res: q(0) = qOilMax = q_test / vogel(p_test/pb)
    const q0 = vogelQLiqSm3day(0, saturated);
    const vt = 1 - 0.2 * (150 / 200) - 0.8 * (150 / 200) ** 2;
    expect(q0).toBeCloseTo(100 / vt, 1);
  });

  it("тестовая точка воспроизводится", () => {
    const pwf = vogelPwfAtma(100, saturated);
    expect(pwf).toBeCloseTo(150, 1);
  });

  it("композит (pb < p_res): граничные значения и разрыв на pb (особенность формулы unfpy)", () => {
    const ipr = { pResAtma: 250, pbAtma: 150, qTestSm3day: 80, pTestAtma: 200, fwPerc: 20 };
    const curve = buildIprCurve(ipr, 100);
    // q(p_res) = 0
    expect(curve[curve.length - 1].qSm3day).toBeCloseTo(0, 6);
    // дебит растёт при снижении pwf от pb до 0
    expect(vogelQLiqSm3day(0, ipr)).toBeGreaterThan(vogelQLiqSm3day(100, ipr));
    expect(vogelQLiqSm3day(100, ipr)).toBeGreaterThan(vogelQLiqSm3day(140, ipr));
    // положительный дебит ниже p_res
    expect(vogelQLiqSm3day(50, ipr)).toBeGreaterThan(0);
  });
});

describe("Drift-flux замыкания", () => {
  it("нет газа -> alpha = 0, режим жидкость", () => {
    const r = driftFlux(0.5, 0, 0.062, 850, 20, 0.03);
    expect(r.alpha).toBe(0);
    expect(r.regime).toBe("liquid");
  });

  it("alpha растёт с vsg и ограничена 0.95", () => {
    let prev = -1;
    for (const vsg of [0.01, 0.05, 0.1, 0.5, 1, 2, 5]) {
      const r = driftFlux(0.3, vsg, 0.062, 850, 30, 0.03);
      expect(r.alpha).toBeGreaterThan(prev);
      expect(r.alpha).lessThanOrEqual(0.95);
      prev = r.alpha;
    }
    // при высоком vsg — насыщение на клампе
    const rHi = driftFlux(0.3, 20, 0.062, 850, 30, 0.03);
    expect(rHi.alpha).toBeCloseTo(0.95, 10);
  });

  it("барботаж (vsl=0): alpha мала, газ поднимается со скоростью дрейфа", () => {
    const r = driftFlux(0, 0.002, 0.15, 1000, 15, 0.06);
    expect(r.alpha).toBeGreaterThan(0);
    expect(r.alpha).toBeLessThan(0.25);
    // vg = vsg/alpha >= vd (Harmathy ~0.2-0.3 м/с в воде)
    expect(r.vg).toBeGreaterThan(0.15);
  });

  it("классификация режимов по alpha/vsg", () => {
    expect(classifyRegime(0.1, 0.3)).toBe("bubbly");
    expect(classifyRegime(0.4, 2)).toBe("slug");
    expect(classifyRegime(0.6, 6)).toBe("churn");
    expect(classifyRegime(0.9, 20)).toBe("annular");
  });

  it("коэффициент трения: 64/Re в ламинаре, падает в турбулентном", () => {
    expect(frictionFactor(1000)).toBeCloseTo(64 / 1000, 12);
    expect(frictionFactor(1e5)).toBeLessThan(frictionFactor(1e4));
  });
});

describe("Марш давления (traverseUp)", () => {
  const tGeo = (z: number) => 5 + (3 * z) / 100;

  it("давление падает вверх, верх ниже низа", () => {
    const nodes = traverseUp({
      pBottomAtma: 100,
      zBottomM: 1500,
      zTopM: 0,
      dM: 0.062,
      qLiqSm3day: 80,
      qGasFreeSm3day: 1000,
      rhoLiqKgm3: 900,
      muLiqCP: 2,
      gammaGas: 0.7,
      tAtDepthC: tGeo,
      zCorrelation: "kareem",
      nSeg: 50,
    });
    expect(nodes.length).toBe(51);
    expect(nodes[nodes.length - 1].pAtma).toBeLessThan(100);
    // монотонность: массив от забоя к устью, давление падает к устью
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i].pAtma).toBeLessThanOrEqual(nodes[i - 1].pAtma);
    }
  });

  it("барботаж: без потока чистая гидростатика жидкости с пузырьками", () => {
    const nodes = traverseUp({
      pBottomAtma: 100,
      zBottomM: 1000,
      zTopM: 0,
      dM: 0.15,
      qLiqSm3day: 0,
      qGasFreeSm3day: 2000,
      rhoLiqKgm3: 1000,
      muLiqCP: 1,
      gammaGas: 0.7,
      tAtDepthC: tGeo,
      zCorrelation: "kareem",
      nSeg: 50,
    });
    // перепад давления меньше чисто жидкой гидростатики из-за пузырьков
    const dp = nodes[nodes.length - 1] === undefined ? 0 : nodes[nodes.length - 1].pAtma;
    expect(100 - dp).toBeGreaterThan(0);
    expect(100 - dp).toBeLessThan(1000 * 1000 * 9.80665 / 101325); // < чистой жидкости
  });

  it("интерполяция давления по профилю", () => {
    const nodes = traverseUp({
      pBottomAtma: 100, zBottomM: 1000, zTopM: 0, dM: 0.062,
      qLiqSm3day: 50, qGasFreeSm3day: 0, rhoLiqKgm3: 1000, muLiqCP: 1,
      gammaGas: 0.7, tAtDepthC: tGeo, zCorrelation: "kareem", nSeg: 100,
    });
    const p500 = pressureAtDepth(nodes, 500);
    expect(p500).toBeGreaterThan(nodes[nodes.length - 1].pAtma); // выше верха, но ниже низа
    expect(p500).toBeLessThan(100);
  });
});
