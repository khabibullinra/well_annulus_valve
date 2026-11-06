// Минималистичная canvas-библиотека линейных графиков (без зависимостей).

export interface Series {
  xs: number[];
  ys: number[];
  color: string;
  label: string;
  dashed?: boolean;
  widthPx?: number;
}

export interface Marker {
  x: number;
  y: number;
  color: string;
  label?: string;
  /** вертикальный сдвиг подписи в px относительно точки (по умолчанию -6, выше точки) */
  labelDy?: number;
  /** сторона подписи от точки (по умолчанию справа) */
  labelSide?: "left" | "right";
}

export interface VLine {
  x: number;
  label: string;
  color: string;
}

export interface HLine {
  y: number;
  label: string;
  color: string;
}

export interface LineChartSpec {
  canvas: HTMLCanvasElement;
  xLabel: string;
  yLabel: string;
  series: Series[];
  markers?: Marker[];
  vlines?: VLine[];
  hlines?: HLine[];
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  /** инвертировать Y (графики по глубине: 0 сверху) */
  yInverted?: boolean;
  legend?: boolean;
}

const M = { top: 14, right: 16, bottom: 40, left: 58 };

function niceTicks(min: number, max: number, n = 6): number[] {
  if (!isFinite(min) || !isFinite(max) || max <= min) return [min];
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

const fmt = (v: number): string => {
  if (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-2)) return v.toExponential(1);
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
};

export function drawLineChart(spec: LineChartSpec): void {
  const { canvas } = spec;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(200, rect.width), H = Math.max(150, rect.height);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // пределы
  let xMin = spec.xMin ?? Infinity, xMax = spec.xMax ?? -Infinity;
  let yMin = spec.yMin ?? Infinity, yMax = spec.yMax ?? -Infinity;
  const allPts: { x: number; y: number }[] = [];
  for (const s of spec.series) {
    for (let i = 0; i < s.xs.length; i++) {
      const x = s.xs[i], y = s.ys[i];
      if (!isFinite(x) || !isFinite(y)) continue;
      allPts.push({ x, y });
      if (spec.xMin === undefined) { if (x < xMin) xMin = x; if (x > xMax) xMax = x; }
      if (spec.yMin === undefined) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
    }
  }
  for (const m of spec.markers ?? []) allPts.push({ x: m.x, y: m.y });
  for (const vl of spec.vlines ?? []) {
    if (spec.xMin === undefined) { xMin = Math.min(xMin, vl.x); xMax = Math.max(xMax, vl.x); }
  }
  for (const hl of spec.hlines ?? []) {
    if (spec.yMin === undefined) { yMin = Math.min(yMin, hl.y); yMax = Math.max(yMax, hl.y); }
  }
  if (allPts.length === 0 || xMin === Infinity || yMin === Infinity) {
    ctx.fillStyle = "#888";
    ctx.font = "13px sans-serif";
    ctx.fillText("нет данных", W / 2 - 30, H / 2);
    return;
  }
  if (xMax - xMin < 1e-9) { xMax = xMin + 1; }
  if (yMax - yMin < 1e-9) { yMax = yMin + 1; }
  const padX = (xMax - xMin) * 0.03, padY = (yMax - yMin) * 0.05;
  if (spec.xMin === undefined) { xMin -= padX; xMax += padX; }
  if (spec.yMin === undefined) { yMin -= padY; yMax += padY; }

  const pw = W - M.left - M.right, ph = H - M.top - M.bottom;
  const X = (x: number) => M.left + ((x - xMin) / (xMax - xMin)) * pw;
  const Y = (y: number) => spec.yInverted
    ? M.top + ((y - yMin) / (yMax - yMin)) * ph
    : M.top + ph - ((y - yMin) / (yMax - yMin)) * ph;

  // сетка и подписи
  ctx.strokeStyle = "#e3e6ea";
  ctx.fillStyle = "#666";
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  const xTicks = niceTicks(xMin, xMax);
  for (const t of xTicks) {
    ctx.beginPath();
    ctx.moveTo(X(t), M.top);
    ctx.lineTo(X(t), M.top + ph);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillText(fmt(t), X(t), M.top + ph + 14);
  }
  const yTicks = niceTicks(yMin, yMax);
  ctx.textAlign = "right";
  for (const t of yTicks) {
    ctx.beginPath();
    ctx.moveTo(M.left, Y(t));
    ctx.lineTo(M.left + pw, Y(t));
    ctx.stroke();
    ctx.fillText(fmt(t), M.left - 6, Y(t) + 4);
  }
  // рамка
  ctx.strokeStyle = "#b7bdc6";
  ctx.strokeRect(M.left, M.top, pw, ph);
  // подписи осей
  ctx.fillStyle = "#333";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(spec.xLabel, M.left + pw / 2, H - 8);
  ctx.save();
  ctx.translate(12, M.top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(spec.yLabel, 0, 0);
  ctx.restore();

  // вертикальные/горизонтальные линии
  for (const vl of spec.vlines ?? []) {
    ctx.strokeStyle = vl.color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(X(vl.x), M.top);
    ctx.lineTo(X(vl.x), M.top + ph);
    ctx.stroke();
    ctx.setLineDash([]);
    if (vl.label) {
      ctx.fillStyle = vl.color;
      ctx.textAlign = "left";
      ctx.fillText(vl.label, X(vl.x) + 3, M.top + 10);
    }
  }
  for (const hl of spec.hlines ?? []) {
    ctx.strokeStyle = hl.color;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(M.left, Y(hl.y));
    ctx.lineTo(M.left + pw, Y(hl.y));
    ctx.stroke();
    ctx.setLineDash([]);
    if (hl.label) {
      ctx.fillStyle = hl.color;
      ctx.textAlign = "right";
      ctx.fillText(hl.label, M.left + pw - 4, Y(hl.y) - 4);
    }
  }

  // серии
  for (const s of spec.series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.widthPx ?? 2;
    if (s.dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < s.xs.length; i++) {
      const x = s.xs[i], y = s.ys[i];
      if (!isFinite(x) || !isFinite(y)) { started = false; continue; }
      if (!started) { ctx.moveTo(X(x), Y(y)); started = true; }
      else ctx.lineTo(X(x), Y(y));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // маркеры
  for (const mk of spec.markers ?? []) {
    ctx.fillStyle = mk.color;
    ctx.beginPath();
    ctx.arc(X(mk.x), Y(mk.y), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (mk.label) {
      ctx.fillStyle = "#222";
      ctx.font = "11px sans-serif";
      const side = mk.labelSide ?? "right";
      ctx.textAlign = side === "right" ? "left" : "right";
      ctx.fillText(mk.label, X(mk.x) + (side === "right" ? 8 : -8), Y(mk.y) + (mk.labelDy ?? -6));
    }
  }

  // легенда
  if (spec.legend !== false && spec.series.length > 0) {
    const legend = spec.series.filter((s) => s.label);
    ctx.font = "11px sans-serif";
    let lx = M.left + 8;
    const ly = spec.yInverted ? H - M.bottom - 10 : M.top + 14;
    for (const s of legend) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(lx, ly - 4);
      ctx.lineTo(lx + 18, ly - 4);
      ctx.stroke();
      ctx.fillStyle = "#333";
      ctx.textAlign = "left";
      const w = ctx.measureText(s.label).width;
      ctx.fillText(s.label, lx + 22, ly);
      lx += 34 + w + 10;
    }
  }
}
