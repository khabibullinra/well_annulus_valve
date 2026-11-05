// Газлифтный клапан: расход газа через отверстие (дроссель) с обратным клапаном —
// только из затруба в НКТ. Сжимаемый поток: докритический/критический режим
// через отношение давлений с показателем адиабаты k (изотермический газ по PVT).

import { R_UNIVERSAL, M_AIR, P_SC_ATMA, T_SC_C } from "./units.js";
import { zGas } from "./pvt.js";

export interface ValveOrificeInput {
  pUpstreamAtma: number; // давление в затрубе на глубине клапана
  pDownstreamAtma: number; // давление в НКТ на глубине клапана
  tC: number; // температура на глубине клапана
  dOrificeMm: number; // диаметр отверстия, мм
  cd: number; // коэффициент расхода (0.7-0.95)
  gammaGas: number; // относительная плотность газа
  kAdiab: number; // показатель адиабаты (из PVT, ~1.2-1.3)
  zCorrelation: "bb" | "dranchuk" | "kareem";
}

export interface ValveOrificeResult {
  qGasSm3day: number; // расход газа через клапан, ст.м3/сут
  critical: boolean; // критический режим
  pressureRatio: number;
}

/**
 * Массовый расход сжимаемого газа через отверстие (адиабатический дроссель):
 *   w = Cd*A*p1*sqrt( 2k/((k-1)*Rspec*T1) * ( r^(2/k) - r^((k+1)/k) ) )  — докритический
 *   w = Cd*A*p1*sqrt( k/(Rspec*T1) * (2/(k+1))^((k+1)/(k-1)) )          — критический
 * r = p2/p1, критический при r < (2/(k+1))^(k/(k-1)).
 * Возврат в ст.м3/сут по плотности газа при стандартных условиях.
 */
export function valveGasRateSm3day(inp: ValveOrificeInput): ValveOrificeResult {
  const p1 = inp.pUpstreamAtma;
  const p2 = inp.pDownstreamAtma;
  if (p1 <= p2 + 1e-6 || p1 <= 1.0001) {
    return { qGasSm3day: 0, critical: false, pressureRatio: p1 > 0 ? p2 / p1 : 1 };
  }
  const k = Math.max(1.05, Math.min(inp.kAdiab, 1.7));
  const T1 = inp.tC + 273.0;
  const rSpec = R_UNIVERSAL / (M_AIR * inp.gammaGas); // Дж/(кг·К)
  const A = (Math.PI * (inp.dOrificeMm / 1000) ** 2) / 4;
  const rCrit = (2 / (k + 1)) ** (k / (k - 1));
  // при r < rCrit поток критический: подставляем rCrit (максимум функции расхода)
  const r = Math.max(p2 / p1, rCrit);
  const critical = p2 / p1 < rCrit;

  const w =
    inp.cd * A * p1 * 101325 *
    Math.sqrt(((2 * k) / ((k - 1) * rSpec * T1)) * (r ** (2 / k) - r ** ((k + 1) / k)));

  // плотность газа при стандартных условиях (1 атма, 20 °C)
  const zSc = zGas(T_SC_C + 273.0, P_SC_ATMA * 0.101325, inp.gammaGas, inp.zCorrelation);
  const rhoSc = (P_SC_ATMA * 101325 * M_AIR * inp.gammaGas) / (zSc * R_UNIVERSAL * (T_SC_C + 273.0));
  const qSc = (w / rhoSc) * 86400; // м3/сут
  return { qGasSm3day: qSc, critical, pressureRatio: p2 / p1 };
}
