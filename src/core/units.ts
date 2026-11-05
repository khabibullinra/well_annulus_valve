// Константы и конвертеры единиц.
// Внешние единицы приложения: atma, °C, sm3/сут, м, сП, м3/м3.
// Внутренние ядра корреляций: МПа, K (как в unfpy).

export const G = 9.80665; // м/с2
export const P_SC_ATMA = 1.0; // стандартные условия, давление
export const T_SC_C = 20.0; // стандартные условия, температура
export const T_K_ZERO_C = 273.0; // unfpy использует 273.0, не 273.15
export const RHO_AIR_SC = 1.2217; // кг/м3 плотность воздуха при с.у.
export const R_UNIVERSAL = 8.31; // Дж/(моль·К)
export const M_AIR = 0.029; // кг/моль
export const CONVERT_M3M3_SCFBBL = 5.614583544;
export const CONVERT_ATMA_MPA = 101325 / 1e6; // atma -> МПа
export const CONVERT_MPA_ATMA = 1e6 / 101325;
export const PSI_PER_MPA = 145.0377377;
export const M3DAY_TO_M3SEC = 1.0 / 86400;

export const atmaToMpa = (p: number): number => p * CONVERT_ATMA_MPA;
export const mpaToAtma = (p: number): number => p * CONVERT_MPA_ATMA;
export const cToK = (t: number): number => t + T_K_ZERO_C;
export const kToC = (t: number): number => t - T_K_ZERO_C;

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;
