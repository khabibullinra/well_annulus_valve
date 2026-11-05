// Автоматический поиск параметров клапана: перебор сетки (глубина × диаметр),
// для каждой точки — сценарий В (клапан). Результат — таблица для UI:
// возможность закрытия задвижки, дебит нефти, удельная энергия, вентиляция.

import type { WellParams, WellSolution } from "./well.js";
import { solveBaselineClosed, solveBaselineOpen, solveValveScenario } from "./well.js";
import type { PumpDbRecord } from "./esp.js";

export interface SweepCell {
  hValveM: number;
  dOrificeMm: number;
  ok: boolean;
  closedValveFeasible: boolean;
  qLiqSm3day: number;
  qOilSm3day: number;
  specificEnergyKwhM3: number;
  powerElectricW: number;
  qVentSm3day: number;
  qValveSm3day: number;
  qSepSm3day: number;
  pCasAtma: number;
  gasFracIntake: number;
  pwfAtma: number;
}

export interface SweepResult {
  cells: SweepCell[];
  hValveList: number[];
  dOrificeList: number[];
  /** база сравнения: без клапана, задвижка открыта (вентиляция) */
  baselineOpen: WellSolution;
  /** база сравнения: без клапана, задвижка закрыта (газ в насос) */
  baselineClosed: WellSolution;
  /** лучшие ячейки */
  bestOil: SweepCell | null; // максимум нефти среди закрытых (или всех, если закрытых нет)
  bestEnergy: SweepCell | null; // минимум удельной энергии среди закрытых
}

/**
 * Перебор сетки параметров клапана. onProgress вызывается после каждой точки
 * (для прогресс-бара в worker'е).
 */
export function sweepValve(
  p: WellParams,
  pumpDb: PumpDbRecord,
  hValveList: number[],
  dOrificeList: number[],
  onProgress?: (done: number, total: number, cell: SweepCell) => void,
): SweepResult {
  const cells: SweepCell[] = [];
  const total = hValveList.length * dOrificeList.length;
  let done = 0;

  // базовые сценарии (без клапана)
  const pNoValve: WellParams = { ...p, valveEnabled: false };
  const baselineOpen = solveBaselineOpen(pNoValve, pumpDb);
  const baselineClosed = solveBaselineClosed(pNoValve, pumpDb);

  for (const hValveM of hValveList) {
    for (const dOrificeMm of dOrificeList) {
      const p2: WellParams = { ...p, valveEnabled: true, hValveM, dOrificeMm };
      let cell: SweepCell;
      try {
        const sol = solveValveScenario(p2, pumpDb);
        cell = {
          hValveM, dOrificeMm,
          ok: sol.ok,
          closedValveFeasible: sol.closedValveFeasible,
          qLiqSm3day: sol.qLiqSm3day,
          qOilSm3day: sol.qOilSm3day,
          specificEnergyKwhM3: sol.specificEnergyKwhM3,
          powerElectricW: sol.powerElectricW,
          qVentSm3day: sol.qVentSm3day,
          qValveSm3day: sol.qValveSm3day,
          qSepSm3day: sol.qSepSm3day,
          pCasAtma: sol.pCasAtma,
          gasFracIntake: sol.gasFracIntake,
          pwfAtma: sol.pwfAtma,
        };
      } catch {
        cell = {
          hValveM, dOrificeMm, ok: false, closedValveFeasible: false,
          qLiqSm3day: 0, qOilSm3day: 0, specificEnergyKwhM3: NaN, powerElectricW: 0,
          qVentSm3day: NaN, qValveSm3day: 0, qSepSm3day: 0, pCasAtma: 0,
          gasFracIntake: NaN, pwfAtma: 0,
        };
      }
      cells.push(cell);
      done++;
      onProgress?.(done, total, cell);
    }
  }

  // лучшие: среди возможных закрытий, иначе среди всех рабочих
  const closedCells = cells.filter((c) => c.ok && c.closedValveFeasible && c.qLiqSm3day > 0);
  const workingCells = closedCells.length > 0 ? closedCells : cells.filter((c) => c.ok && c.qLiqSm3day > 0);
  const bestOil = workingCells.length > 0
    ? workingCells.reduce((a, b) => (b.qOilSm3day > a.qOilSm3day ? b : a))
    : null;
  const bestEnergy = workingCells.length > 0
    ? workingCells.reduce((a, b) => (b.specificEnergyKwhM3 < a.specificEnergyKwhM3 ? b : a))
    : null;

  return { cells, hValveList, dOrificeList, baselineOpen, baselineClosed, bestOil, bestEnergy };
}
