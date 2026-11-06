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

/** Keltner channel: EMA(len) of the close ± k × ATR(len). */
export function keltner(b: OHLC[], len: number, k: number) {
  const mid = ema(b.map((x) => x.c), len), a = atr(b, len);
  return { mid, upper: mid.map((m, i) => m + k * a[i]), lower: mid.map((m, i) => m - k * a[i]) };
}

/** Percentile rank (0–100) of each value among the `look` values before it; NaN until that many exist. */
export function pctRank(x: number[], look: number): number[] {
  const out = nan(x.length);
  for (let i = look; i < x.length; i++) {
    if (isNaN(x[i])) continue;
    let below = 0, n = 0;
    for (let j = i - look; j < i; j++) { if (isNaN(x[j])) continue; n++; if (x[j] < x[i]) below++; }
    if (n >= Math.max(10, look / 2)) out[i] = (100 * below) / n;
  }
  return out;
}

/**
 * A completed swing: from its low to its high (dir 1, the high came last: an up swing) or from its high to its low
 * (dir −1). `at` = the candle at which it became known (never before: a swing is confirmed only once price has turned).
 */
export type Swing = { dir: 1 | -1; lo: number; hi: number; iLo: number; iHi: number; at: number };
/**
 * Swing structure without look-ahead, for Fibonacci levels and divergences.
 *  mode 0 (zigzag): a swing high is confirmed once price has fallen k × ATR(atrLen) from it, a swing low once price has
 *                   risen k × ATR from it (k 1.5–3 keeps only swings worth retracing).
 *  mode 1 (fractal): a high is the highest high of n candles either side (no higher high among them; confirmed n
 *                    candles later); lows likewise; highs and lows alternate (two highs in a row keep the higher).
 * Returns the swings in order and, per candle, the index of the last swing completed by then (−1 = none yet).
 */
export function swings(b: OHLC[], mode: number, k: number, n: number, atrLen = 14): { list: Swing[]; last: Int32Array } {
  const N = b.length, list: Swing[] = [], last = new Int32Array(N).fill(-1);
  if (mode === 1) {
    const w = Math.max(1, Math.trunc(n));
    let piv: { kind: 1 | -1; px: number; i: number } | null = null; // the latest confirmed pivot (1 = high, -1 = low)
    for (let i = 0; i < N; i++) {
      const p = i - w;
      if (p >= w) {
        let isHi = true, isLo = true;
        for (let j = p - w; j <= p + w; j++) { if (j === p) continue; if (b[j].h > b[p].h) isHi = false; if (b[j].l < b[p].l) isLo = false; }
        // Both at once (a lone wide candle): take the one that continues the alternation.
        if (isHi && isLo) { if (piv?.kind === 1) isHi = false; else isLo = false; }
        const add = (kind: 1 | -1, px: number) => {
          if (!piv) { piv = { kind, px, i: p }; return; }
          if (piv.kind === kind) { if ((kind === 1 && px > piv.px) || (kind === -1 && px < piv.px)) piv = { kind, px, i: p }; return; }
          list.push(kind === 1 ? { dir: 1, lo: piv.px, hi: px, iLo: piv.i, iHi: p, at: i } : { dir: -1, hi: piv.px, lo: px, iHi: piv.i, iLo: p, at: i });
          piv = { kind, px, i: p };
        };
        if (isHi) add(1, b[p].h); else if (isLo) add(-1, b[p].l);
      }
      last[i] = list.length - 1;
    }
    return { list, last };
  }
  const a = atr(b, atrLen);
  let dir = 0, ext = 0, extI = 0, pivPx = 0, pivI = 0, hiE = -Infinity, hiI = 0, loE = Infinity, loI = 0;
  for (let i = 0; i < N; i++) {
    const th = k * a[i], x = b[i];
    if (!(th > 0)) { last[i] = list.length - 1; continue; }
    if (dir === 0) {
      if (x.h > hiE) { hiE = x.h; hiI = i; } if (x.l < loE) { loE = x.l; loI = i; }
      if (x.h - loE >= th && loI <= hiI) { dir = 1; pivPx = loE; pivI = loI; ext = hiE; extI = hiI; }
      else if (hiE - x.l >= th && hiI <= loI) { dir = -1; pivPx = hiE; pivI = hiI; ext = loE; extI = loI; }
    } else if (dir === 1) {
      if (x.h > ext) { ext = x.h; extI = i; }
      else if (ext - x.l >= th) { // the high at extI is confirmed: the up swing from the last low is complete
        list.push({ dir: 1, lo: pivPx, hi: ext, iLo: pivI, iHi: extI, at: i });
        pivPx = ext; pivI = extI; dir = -1;
        let m = Infinity, mi = i; for (let j = extI; j <= i; j++) if (b[j].l < m) { m = b[j].l; mi = j; }
        ext = m; extI = mi;
      }
    } else {
      if (x.l < ext) { ext = x.l; extI = i; }
      else if (x.h - ext >= th) {
        list.push({ dir: -1, hi: pivPx, lo: ext, iHi: pivI, iLo: extI, at: i });
        pivPx = ext; pivI = extI; dir = 1;
        let m = -Infinity, mi = i; for (let j = extI; j <= i; j++) if (b[j].h > m) { m = b[j].h; mi = j; }
        ext = m; extI = mi;
      }
    }
    last[i] = list.length - 1;
  }
  return { list, last };
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
