// Паритет-тесты PVT против эталонных данных unfpy (tests/reference/pvt_correlations).
// Эталоны сгенерированы directly из unfpy-корреляций — совпадение должно быть точным.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bGasM3m3, bWatM3m3, boStandingM3m3, coVB1MPa, muDeadOilBeggsRobinsonCP, muGasCP,
  muOilVasquezBeggsCP, muSatOilBeggsRobinsonCP, muWatCP, pbStandingMPa,
  pseudoPressureStandingMPa, pseudoTemperatureStandingK, rhoOilRcKgm3, rsStandingM3m3,
  zFactorBB, zFactorDranchuk, zFactorKareem,
} from "../src/core/pvt.js";

const refOil = JSON.parse(readFileSync(resolve(__dirname, "data/oil_standing.json"), "utf8"));
const refGas = JSON.parse(readFileSync(resolve(__dirname, "data/gas.json"), "utf8"));
const refWat = JSON.parse(readFileSync(resolve(__dirname, "data/water.json"), "utf8"));

const close = (a: number, b: number, relTol = 1e-6) => {
  if (b === 0) return Math.abs(a) < 1e-9;
  return Math.abs(a - b) / Math.abs(b) < relTol;
};

describe("PVT нефти: паритет с unfpy oil_standing", () => {
  for (const res of refOil.results) {
    const f = res.fluid;
    describe(`${f.id} (γg=${f.gamma_gas}, γo=${f.gamma_oil}, rsb=${f.rsb_m3m3})`, () => {
      for (const pt of res.points) {
        it(`p=${pt.p_MPa} МПа, T=${pt.t_K} K`, () => {
          // pb — одинаков во всех точках жидкости
          expect(close(pbStandingMPa(f.rsb_m3m3, f.gamma_gas, pt.t_K, f.gamma_oil), pt.pb_MPa)).toBe(true);
          // Rs ( Standing) — при p < pb
          if (pt.p_MPa < pt.pb_MPa) {
            expect(close(rsStandingM3m3(pt.p_MPa, f.gamma_gas, pt.t_K, f.gamma_oil), pt.rs_m3m3, 1e-5)).toBe(true);
            expect(close(boStandingM3m3(pt.rs_m3m3, f.gamma_gas, pt.t_K, f.gamma_oil), pt.bo_m3m3, 1e-5)).toBe(true);
          }
          // вязкости
          expect(close(muDeadOilBeggsRobinsonCP(pt.t_K, f.gamma_oil), pt.mu_dead_BR_cP, 1e-5)).toBe(true);
          expect(
            close(muSatOilBeggsRobinsonCP(pt.rs_m3m3, muDeadOilBeggsRobinsonCP(pt.t_K, f.gamma_oil)), pt.mu_sat_BR_cP, 1e-5),
          ).toBe(true);
          expect(
            close(
              muOilVasquezBeggsCP(
                muSatOilBeggsRobinsonCP(pt.rs_m3m3, muDeadOilBeggsRobinsonCP(pt.t_K, f.gamma_oil)),
                pt.p_MPa, pt.pb_MPa,
              ),
              pt.mu_VB_cP, 1e-5,
            ),
          ).toBe(true);
          // co
          expect(
            close(coVB1MPa(pt.rs_m3m3, f.gamma_gas, pt.t_K, f.gamma_oil, Math.max(pt.p_MPa, 0.101)), pt.co_1MPa, 1e-5),
          ).toBe(true);
        });
      }
    });
  }
});

describe("Газ: паритет с unfpy gas.json", () => {
  for (const res of refGas.results) {
    const f = res.fluid;
    describe(`${f.id} (γg=${f.gamma_gas})`, () => {
      for (const pt of res.points) {
        it(`p=${pt.p_MPa} МПа, T=${pt.t_K} K`, () => {
          // BB в эталоне считается с упрощёнными псевдокритическими (как в unfpy z_gas)
          const TprBB = pt.t_K / (95 + 171 * f.gamma_gas);
          const PprBB = pt.p_MPa / (4.9 - 0.4 * f.gamma_gas);
          expect(close(zFactorBB(TprBB, PprBB), pt.z_BB, 1e-6)).toBe(true);
          const Tpr = pt.t_K / pseudoTemperatureStandingK(f.gamma_gas);
          const Ppr = pt.p_MPa / pseudoPressureStandingMPa(f.gamma_gas);
          expect(close(zFactorDranchuk(Tpr, Ppr), pt.z_DAK, 1e-4)).toBe(true);
          expect(close(zFactorKareem(Tpr, Ppr), pt.z_Kareem, 1e-6)).toBe(true);
          // Bg и вязкость газа считаются с dispatch z (Kareem по умолчанию)
          expect(close(bGasM3m3(pt.t_K, pt.p_MPa, pt.z_gas_dispatch), pt.b_gas_m3m3, 1e-6)).toBe(true);
          expect(close(muGasCP(pt.t_K, pt.p_MPa, pt.z_gas_dispatch, f.gamma_gas), pt.mu_gas_cP, 1e-5)).toBe(true);
        });
      }
    });
  }
});

describe("Вода: паритет с unfpy water.json", () => {
  for (const res of refWat.results) {
    const f = res.fluid;
    describe(`${f.id} (γw=${f.gamma_wat}, минерализация=${f.salinity_ppm})`, () => {
      for (const pt of res.points) {
        it(`p=${pt.p_MPa} МПа, T=${pt.t_K} K`, () => {
          expect(close(bWatM3m3(pt.p_MPa, pt.t_K), pt.b_wat_m3m3, 1e-6)).toBe(true);
          expect(close(muWatCP(pt.p_MPa, pt.t_K, f.salinity_ppm), pt.mu_wat_cP, 1e-6)).toBe(true);
        });
      }
    });
  }
});

describe("Плотность нефти (массовый баланс Standing)", () => {
  it("rs=0 -> rho = 1000*gamma_oil/bo, bo~1", () => {
    const bo = boStandingM3m3(0, 0.8, 350, 0.86);
    const rho = rhoOilRcKgm3(0, 0.8, 0.86, bo);
    expect(rho).toBeCloseTo(860 / bo, 0);
  });
});
