// Стресс-тест: решатель не должен падать и выдавать NaN ни на одном
// сочетании параметров из широкого диапазона (граничные случаи — либо решение,
// либо корректное сообщение о невозможности режима).

import { describe, expect, it } from "vitest";
import pumps from "../src/data/pumps.json";
import {
  solveBaselineClosed, solveBaselineOpen, solveValveScenario, type WellParams,
} from "../src/core/well.js";
import type { PumpDbRecord } from "../src/core/esp.js";

const dbList = pumps as unknown as PumpDbRecord[];
const db80 = dbList.find((x) => x.id === "ЭЦН5-80")!;
const db125 = dbList.find((x) => x.id === "ЭЦН5-125")!;
const db30 = dbList.find((x) => x.id === "ЭЦН4-30")!;

const mk = (over: Partial<WellParams>): WellParams => ({
  gammaGas: 0.7, gammaOil: 0.86, gammaWat: 1.0,
  rsbM3m3: 80, rpM3m3: 80, pbAtma: 0, bOilbM3m3: 0, muOilbCP: 0,
  tResC: 90, zCorrelation: "kareem",
  pResAtma: 200, pbIprAtma: 0, qTestSm3day: 90, pTestAtma: 150, fwPerc: 30,
  hPerfM: 2500, hEspM: 2000, dTubingM: 0.062, dTubingOdM: 0.073, dCasingM: 0.13,
  pumpId: "ЭЦН5-80", stageNum: 250, freqHz: 50, gasCorrectModel: 1, motorEffD: 0.85,
  valveEnabled: true, hValveM: 300, dOrificeMm: 3, cd: 0.85,
  pBufAtma: 20, pCasMaxAtma: 40, ksep: 0.5,
  tSurfC: 5, geoGradC100: 3,
  ...over,
});

const noNaN = (s: { qLiqSm3day: number; pwfAtma: number; pIntakeAtma: number; pDisAtma: number; pCasAtma: number; powerShaftW: number }): void => {
  for (const v of [s.qLiqSm3day, s.pwfAtma, s.pIntakeAtma, s.pDisAtma, s.pCasAtma, s.powerShaftW]) {
    expect(Number.isFinite(v)).toBe(true);
  }
};

describe("Стресс: глубина клапана × диаметр × насосы", () => {
  const depths = [100, 300, 600, 1000, 1400, 1800];
  const diameters = [1, 2, 4, 8];
  const dbs = [db80, db125, db30];

  it("все комбинации завершаются без исключений и NaN", () => {
    let n = 0;
    for (const db of dbs) {
      for (const hv of depths) {
        for (const d of diameters) {
          const p = mk({ pumpId: db.id, hValveM: hv, dOrificeMm: d });
          const v = solveValveScenario(p, db);
          noNaN(v);
          const a = solveBaselineOpen({ ...p, valveEnabled: false }, db);
          noNaN(a);
          const b = solveBaselineClosed({ ...p, valveEnabled: false }, db);
          noNaN(b);
          // согласованность: закрытие => вентиляция 0; не закрытие => вентиляция > 0
          if (v.closedValveFeasible) expect(v.qVentSm3day).toBeLessThanOrEqual(1e-6);
          else {
            expect(v.qVentSm3day).toBeGreaterThanOrEqual(-1e-6);
            expect(v.pCasAtma).toBeLessThanOrEqual(p.pCasMaxAtma + 1e-6);
          }
          n++;
        }
      }
    }
    expect(n).toBe(72);
  }, 240000);
});

describe("Стресс: границы физических условий", () => {
  it("высокий ГФ (200 м3/м3) — не падает, деградация газа видна", () => {
    const v = solveValveScenario(mk({ rpM3m3: 200, rsbM3m3: 200 }), db80);
    noNaN(v);
    expect(v.gasFracIntake).toBeGreaterThan(0.02);
  }, 60000);

  it("обводнённость 0% и 100%", () => {
    for (const fw of [0, 100]) {
      const v = solveValveScenario(mk({ fwPerc: fw }), db80);
      noNaN(v);
    }
  }, 120000);

  it("малая глубина спуска и малый перепад", () => {
    const v = solveValveScenario(mk({ hEspM: 800, hPerfM: 1000, pResAtma: 80, pTestAtma: 60, qTestSm3day: 50, pBufAtma: 10, pCasMaxAtma: 20 }), db80);
    noNaN(v);
  }, 60000);

  it("ksep = 0 и ksep = 1", () => {
    for (const ks of [0, 1]) {
      const v = solveValveScenario(mk({ ksep: ks }), db80);
      noNaN(v);
      if (ks === 0) expect(v.qSepSm3day).toBe(0);
    }
  }, 120000);

  it("высокая вязкость (mu_ob = 100 сП)", () => {
    const v = solveValveScenario(mk({ muOilbCP: 100 }), db80);
    noNaN(v);
  }, 60000);

  it("клапан у самого приёма насоса — не падает", () => {
    const v = solveValveScenario(mk({ hValveM: 1900 }), db80);
    noNaN(v);
  }, 60000);
});
