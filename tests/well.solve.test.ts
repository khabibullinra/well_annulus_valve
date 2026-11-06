// Тесты сквозного решателя: базовые сценарии, клапан, физическая согласованность.

import { describe, expect, it } from "vitest";
import pumps from "../src/data/pumps.json";
import {
  calcWellFromPwf, solveBaselineClosed, solveBaselineOpen, solveValveScenario,
  type WellParams,
} from "../src/core/well.js";
import type { PumpDbRecord } from "../src/core/esp.js";
import { valveGasRateSm3day } from "../src/core/valve.js";
import { solveAnnulus } from "../src/core/annulus.js";
import { Feed, feedModAfterSeparation } from "../src/core/feed.js";

const db = pumps.find((x) => x.id === "ЭЦН5-80") as unknown as PumpDbRecord;

const base: WellParams = {
  gammaGas: 0.7, gammaOil: 0.86, gammaWat: 1.0,
  rsbM3m3: 80, rpM3m3: 80, pbAtma: 0, bOilbM3m3: 0, muOilbCP: 0,
  tResC: 90, zCorrelation: "kareem",
  pResAtma: 200, pbIprAtma: 0, qTestSm3day: 90, pTestAtma: 150, fwPerc: 30,
  hPerfM: 2500, hEspM: 2000, dTubingM: 0.062, dTubingOdM: 0.073, dCasingM: 0.13,
  pumpId: "ЭЦН5-80", stageNum: 250, freqHz: 50, gasCorrectModel: 1, motorEffD: 0.85,
  valveEnabled: true, hValveM: 1200, dOrificeMm: 2, cd: 0.85,
  pBufAtma: 20, pCasMaxAtma: 40, ksep: 0.5,
  tSurfC: 5, geoGradC100: 3,
};

describe("Сценарий А: без клапана, задвижка открыта", () => {
  it("сходится и физически согласован", () => {
    const a = solveBaselineOpen(base, db);
    expect(a.ok).toBe(true);
    // давление падает от пласта к устью
    expect(a.pwfAtma).toBeLessThan(base.pResAtma);
    expect(a.pIntakeAtma).toBeLessThan(a.pwfAtma);
    expect(a.pBufCalcAtma).toBeCloseTo(base.pBufAtma, 1);
    // сепарированный газ весь вентилируется
    expect(a.qVentSm3day).toBeCloseTo(a.qSepSm3day, 3);
    expect(a.qSepSm3day).toBeGreaterThan(0);
    // положительный дебит
    expect(a.qLiqSm3day).toBeGreaterThan(0);
    // мощность положительна
    expect(a.powerShaftW).toBeGreaterThan(0);
  });
});

describe("Клапан: уравнение дросселя", () => {
  it("критический режим: расход не зависит от противодавления", () => {
    const tC = 40;
    const r1 = valveGasRateSm3day({
      pUpstreamAtma: 60, pDownstreamAtma: 20, tC, dOrificeMm: 2, cd: 0.85,
      gammaGas: 0.7, kAdiab: 1.25, zCorrelation: "kareem",
    });
    const r2 = valveGasRateSm3day({
      pUpstreamAtma: 60, pDownstreamAtma: 5, tC, dOrificeMm: 2, cd: 0.85,
      gammaGas: 0.7, kAdiab: 1.25, zCorrelation: "kareem",
    });
    expect(r1.critical).toBe(true);
    expect(r2.critical).toBe(true);
    expect(r1.qGasSm3day).toBeCloseTo(r2.qGasSm3day, 3);
    expect(r1.qGasSm3day).toBeGreaterThan(0);
  });

  it("докритический: расход растёт с перепадом", () => {
    const mk = (pDown: number) => valveGasRateSm3day({
      pUpstreamAtma: 30, pDownstreamAtma: pDown, tC: 40, dOrificeMm: 3, cd: 0.85,
      gammaGas: 0.7, kAdiab: 1.25, zCorrelation: "kareem",
    });
    const r18 = mk(18), r25 = mk(25);
    expect(r18.critical).toBe(false);
    expect(r18.qGasSm3day).toBeGreaterThan(r25.qGasSm3day);
    expect(mk(30).qGasSm3day).toBe(0); // нет перепада — нет потока
  });

  it("расход растёт с диаметром и с давлением вверх по потоку", () => {
    const q = (d: number, p: number) => valveGasRateSm3day({
      pUpstreamAtma: p, pDownstreamAtma: 10, tC: 40, dOrificeMm: d, cd: 0.85,
      gammaGas: 0.7, kAdiab: 1.25, zCorrelation: "kareem",
    }).qGasSm3day;
    expect(q(4, 60)).toBeCloseTo(4 * q(2, 60), 1); // A ~ d^2 в критике
    expect(q(2, 90)).toBeGreaterThan(q(2, 60));
  });
});

describe("Сепарация: модификация флюида", () => {
  it("свободный газ в насос уменьшается, ГСФ падает", () => {
    const feed = new Feed({
      gammaGas: 0.7, gammaOil: 0.86, gammaWat: 1.0,
      rsbM3m3: 80, rpM3m3: 80, pbAtma: 0, bOilbM3m3: 0, muOilbCP: 0,
      tResC: 90, zCorrelation: "kareem",
      qLiqSm3day: 80, fwFr: 0.3, qGasFreeSm3day: 0,
    });
    const pIntake = 60, tIntake = 65;
    const st0 = feed.calc(pIntake, tIntake);
    const ksep = 0.5;
    const mod = feedModAfterSeparation(feed, pIntake, tIntake, ksep);
    const st1 = mod.calc(pIntake, tIntake);
    // рабочий ГФ снижен, свободный газ уменьшен (не менее чем вдвое —
    // калибровка может дополнительно удержать газ в растворе)
    expect(mod.params.rpM3m3).toBeLessThan(feed.params.rpM3m3);
    expect(st1.qGasInsituSm3day).toBeLessThan(st0.qGasInsituSm3day * (1 - ksep) + 1e-6);
    expect(st1.gasFractionD).toBeLessThan(st0.gasFractionD);
    expect(st1.gasFractionD).toBeGreaterThan(0);
  });
});

describe("Затруб: барботаж и уровень", () => {
  const tGeo = (z: number) => 5 + (3 * z) / 100;
  const liquid = () => ({ rhoKgm3: 950, muCP: 2 });

  it("жидкость заполнена: верхнее давление расчётное, барботаж снижает плотность", () => {
    const r = solveAnnulus({
      pIntakeAtma: 100, hEspM: 1500, hValveM: null,
      qGasSepSm3day: 3000, qGasValveSm3day: 0,
      dCasingM: 0.13, dTubingOdM: 0.073, gammaGas: 0.7, zCorrelation: "kareem",
      tAtDepthC: tGeo, liquidAtP: liquid, nSeg: 40,
    }, null);
    const dp = 100 - r.pCasCalcAtma;
    expect(dp).toBeGreaterThan(0);
    // меньше чисто жидкого столба (1500 м × 950 кг/м3 ≈ 138 атм)
    expect(dp).toBeLessThan((1500 * 950 * 9.80665) / 101325);
  });

  it("заданное верхнее давление: уровень находится между устьем и приёмом", () => {
    const r = solveAnnulus({
      pIntakeAtma: 100, hEspM: 1500, hValveM: 1000,
      qGasSepSm3day: 3000, qGasValveSm3day: 1500,
      dCasingM: 0.13, dTubingOdM: 0.073, gammaGas: 0.7, zCorrelation: "kareem",
      tAtDepthC: tGeo, liquidAtP: liquid, nSeg: 40,
    }, 30);
    expect(r.liquidLevelM).not.toBeNull();
    expect(r.liquidLevelM!).toBeGreaterThan(0);
    expect(r.liquidLevelM!).toBeLessThan(1500);
    // при уровне выше клапана давление на клапане больше верхнего
    expect(r.pAtValveAnnAtma).toBeGreaterThan(30);
  });

  it("профиль затруба двухчастный: барометрическая шапка + барботаж, стык на уровне", () => {
    const r = solveAnnulus({
      pIntakeAtma: 100, hEspM: 1500, hValveM: 1000,
      qGasSepSm3day: 3000, qGasValveSm3day: 1500,
      dCasingM: 0.13, dTubingOdM: 0.073, gammaGas: 0.7, zCorrelation: "kareem",
      tAtDepthC: tGeo, liquidAtP: liquid, nSeg: 40,
    }, 30);
    // профиль построен, идёт сверху вниз от устья до приёма
    expect(r.nodes.length).toBeGreaterThan(5);
    expect(r.nodes[0].zM).toBe(0);
    expect(r.nodes[0].pAtma).toBeCloseTo(30, 3); // устье = заданное P_затр
    const last = r.nodes[r.nodes.length - 1];
    expect(last.zM).toBeGreaterThan(1499);
    expect(last.pAtma).toBeCloseTo(100, 1); // низ стыкуется с приёмом
    // монотонный рост давления с глубиной
    for (let i = 1; i < r.nodes.length; i++) {
      expect(r.nodes[i].pAtma).toBeGreaterThanOrEqual(r.nodes[i - 1].pAtma - 1e-9);
      expect(r.nodes[i].zM).toBeGreaterThanOrEqual(r.nodes[i - 1].zM - 1e-9);
    }
    // выше уровня — газ (alpha ≈ 1), ниже — жидкость с пузырьками (alpha < 1)
    const lv = r.liquidLevelM!;
    const gasNodes = r.nodes.filter((n) => n.zM < lv - 1e-6);
    const liqNodes = r.nodes.filter((n) => n.zM > lv + 1);
    expect(gasNodes.length).toBeGreaterThan(0);
    expect(liqNodes.length).toBeGreaterThan(0);
    for (const n of gasNodes) expect(n.alpha).toBeGreaterThan(0.99);
    for (const n of liqNodes) expect(n.alpha).toBeLessThan(0.9);
    // излом на уровне: градиент газа много меньше градиента жидкости
    const pAtLv = r.nodes.find((n) => Math.abs(n.zM - lv) < 1e-6)!.pAtma;
    expect(pAtLv).toBeGreaterThan(30);
    expect(100 - pAtLv).toBeGreaterThan((pAtLv - 30) * 2); // жидкий столб весомей газового
    // давление НА уровне учётывает барометрику шапки: pAtLevel > P_затр устья,
    // и совпадает с узлом стыка
    expect(r.pAtLevelAnnAtma).not.toBeNull();
    expect(r.pAtLevelAnnAtma!).toBeCloseTo(pAtLv, 1);
    expect(r.pAtLevelAnnAtma!).toBeGreaterThan(30 + 0.5); // вес газового столба > 0.5 атм на ~км
  });
});

describe("Сценарий В: клапан", () => {
  it("сходится; при достаточном отверстии возможна закрытая задвижка", () => {
    const v = solveValveScenario({ ...base, dOrificeMm: 6 }, db);
    expect(v.ok).toBe(true);
    expect(v.qLiqSm3day).toBeGreaterThan(0);
    expect(v.qSepSm3day).toBeGreaterThan(0);
    if (v.closedValveFeasible) {
      expect(v.qVentSm3day).toBeCloseTo(0, 3);
      expect(v.qValveSm3day).toBeGreaterThan(0);
      expect(v.pCasAtma).toBeLessThanOrEqual(base.pCasMaxAtma + 1e-6);
    } else {
      expect(v.qVentSm3day).toBeGreaterThan(0);
      expect(v.pCasAtma).toBeCloseTo(base.pCasMaxAtma, 1);
    }
  }, 30000);

  it("больше отверстие и/или выше клапан -> больше пропускная способность", () => {
    // при фиксированном P_cas пропускная способность растёт с диаметром
    const q = (d: number) =>
      calcWellFromPwf(130, { ...base, hValveM: 300, dOrificeMm: d }, db, { pCasAtma: 40, ksepEff: base.ksep }).qValveSm3day;
    expect(q(4)).toBeGreaterThan(q(2));
    expect(q(2)).toBeGreaterThanOrEqual(q(1));
  }, 30000);

  it("глубокий клапан не открывается (P_cas_max мало), мелкий — открывается", () => {
    // клапан на 1100 м: p_НКТ ~100 атм, p_затр на клапане ~44 — закрыт
    const deep = solveValveScenario({ ...base, hValveM: 1100, dOrificeMm: 4 }, db);
    expect(deep.qValveSm3day).toBe(0);
    expect(deep.closedValveFeasible).toBe(false);
    expect(deep.qVentSm3day).toBeCloseTo(deep.qSepSm3day, 0);
    // клапан на 300 м: p_НКТ ~30-38 атм < p_затр — открыт, закрытие задвижки достижимо
    const shallow = solveValveScenario({ ...base, hValveM: 300, dOrificeMm: 4 }, db);
    expect(shallow.qValveSm3day).toBeGreaterThan(0);
    expect(shallow.closedValveFeasible).toBe(true);
    expect(shallow.qVentSm3day).toBeCloseTo(0, 3);
    // равновесное P_cas не выше предела
    expect(shallow.pCasAtma).toBeLessThanOrEqual(base.pCasMaxAtma + 1e-6);
  }, 60000);

  it("проход при заданном pwf согласует клапан и затруб", () => {
    const sol = calcWellFromPwf(120, base, db, { pCasAtma: 40, ksepEff: base.ksep });
    expect(sol.qLiqSm3day).toBeGreaterThan(0);
    expect(sol.pAnnAtValveAtma).toBeGreaterThan(0);
    // затрубное давление на глубине клапана выше устьевого
    expect(sol.pAnnAtValveAtma).toBeGreaterThan(sol.pCasAtma * 0.9);
  });
});

describe("Сценарий Б: без клапана, задвижка закрыта", () => {
  it("весь газ в насос — ГСФ выше, чем при сепарации", () => {
    const b = solveBaselineClosed(base, db);
    const a = solveBaselineOpen(base, db);
    if (b.ok) {
      expect(b.gasFracIntake).toBeGreaterThan(a.gasFracIntake);
      expect(b.qValveSm3day).toBe(0);
    } else {
      // срыв — тоже валидный результат
      expect(b.message).toContain("срыв");
    }
  }, 30000);
});
