// Indicator maths, written to match TradingView's built-ins (ta.rsi, ta.ema, ta.sma, ta.macd, ta.atr, ta.dmi,
// ta.bb, ta.vwap). Every function returns arrays aligned with the input candles; NaN where not yet defined.

type OHLC = { o: number; h: number; l: number; c: number; v?: number; day?: string };

const nan = (n: number) => new Array<number>(n).fill(NaN);

/** Simple moving average. */
export function sma(x: number[], n: number): number[] {
  const out = nan(x.length);
  let sum = 0, count = 0, start = x.findIndex((v) => !isNaN(v));
  if (start < 0) return out;
  for (let i = start; i < x.length; i++) {
    sum += x[i]; count++;
    if (count > n) sum -= x[i - n];
    if (count >= n) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first n values (as TradingView does). */
export function ema(x: number[], n: number): number[] {
  const out = nan(x.length);
  const a = 2 / (n + 1);
  const start = x.findIndex((v) => !isNaN(v));
  if (start < 0 || x.length - start < n) return out;
  let seed = 0;
  for (let i = start; i < start + n; i++) seed += x[i];
  out[start + n - 1] = seed / n;
  for (let i = start + n; i < x.length; i++) out[i] = a * x[i] + (1 - a) * out[i - 1];
  return out;
}

/** Wilder's moving average (ta.rma), seeded with an SMA. */
export function rma(x: number[], n: number): number[] {
  const out = nan(x.length);
  const start = x.findIndex((v) => !isNaN(v));
  if (start < 0 || x.length - start < n) return out;
  let seed = 0;
  for (let i = start; i < start + n; i++) seed += x[i];
  out[start + n - 1] = seed / n;
  for (let i = start + n; i < x.length; i++) out[i] = (out[i - 1] * (n - 1) + x[i]) / n;
  return out;
}

export function trueRange(b: OHLC[]): number[] {
  return b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)));
}

export function atr(b: OHLC[], n: number): number[] { return rma(trueRange(b), n); }

/** RSI with Wilder smoothing (ta.rsi). */
export function rsi(close: number[], n: number): number[] {
  const up = close.map((c, i) => i === 0 ? NaN : Math.max(c - close[i - 1], 0));
  const dn = close.map((c, i) => i === 0 ? NaN : Math.max(close[i - 1] - c, 0));
  const au = rma(up, n), ad = rma(dn, n);
  return au.map((u, i) => isNaN(u) || isNaN(ad[i]) ? NaN : ad[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / ad[i]));
}

export function macd(close: number[], fast: number, slow: number, signal: number) {
  const f = ema(close, fast), s = ema(close, slow);
  const line = f.map((v, i) => v - s[i]);
  const sig = ema(line, signal);
  return { line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

/** Bollinger Bands (ta.bb): SMA basis, population standard deviation. */
export function bollinger(close: number[], n: number, mult: number) {
  const basis = sma(close, n);
  const upper = nan(close.length), lower = nan(close.length);
  for (let i = n - 1; i < close.length; i++) {
    if (isNaN(basis[i])) continue;
    let ss = 0;
    for (let k = i - n + 1; k <= i; k++) ss += (close[k] - basis[i]) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = basis[i] + mult * sd; lower[i] = basis[i] - mult * sd;
  }
  return { basis, upper, lower };
}

/** ADX with +DI / -DI (ta.dmi). */
export function adx(b: OHLC[], n: number, smoothing = n) {
  const plusDM = b.map((x, i) => {
    if (i === 0) return NaN;
    const up = x.h - b[i - 1].h, down = b[i - 1].l - x.l;
    return up > down && up > 0 ? up : 0;
  });
  const minusDM = b.map((x, i) => {
    if (i === 0) return NaN;
    const up = x.h - b[i - 1].h, down = b[i - 1].l - x.l;
    return down > up && down > 0 ? down : 0;
  });
  const tr = trueRange(b).map((v, i) => i === 0 ? NaN : v);
  const trur = rma(tr, n);
  const plus = rma(plusDM, n).map((v, i) => 100 * v / trur[i]);
  const minus = rma(minusDM, n).map((v, i) => 100 * v / trur[i]);
  const dx = plus.map((p, i) => { const s = p + minus[i]; return isNaN(s) ? NaN : Math.abs(p - minus[i]) / (s === 0 ? 1 : s); });
  return { adx: rma(dx, smoothing).map((v) => 100 * v), plus, minus };
}

/**
 * Session VWAP, reset each day, on the typical price (h+l+c)/3. Index candles carry no volume, so when a day's
 * volume is zero every candle counts equally (a time-weighted average) instead.
 */
export function vwap(b: (OHLC & { day: string })[]): number[] {
  const out = nan(b.length);
  let day = "", pv = 0, vol = 0, tpSum = 0, cnt = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i].day !== day) { day = b[i].day; pv = 0; vol = 0; tpSum = 0; cnt = 0; }
    const tp = (b[i].h + b[i].l + b[i].c) / 3, v = b[i].v ?? 0;
    pv += tp * v; vol += v; tpSum += tp; cnt++;
    out[i] = vol > 0 ? pv / vol : tpSum / cnt;
  }
  return out;
}
