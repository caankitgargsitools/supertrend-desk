// Statistics for judging backtests that were picked out of many tries (the lab's luck adjustment).

/** Standard normal cumulative distribution (Abramowitz & Stegun 7.1.26, error under 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Inverse of the standard normal distribution (Acklam's rational approximation, relative error under 1.2e-9). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const EULER = 0.5772156649015329;

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, 2014) on a strategy's per-trade results.
 * The bar is the best Sharpe ratio expected by luck alone among `trials` independent tries of the same length
 * (the estimate's own variance, 1/(T-1), stands in for the spread across tries); the answer is the probability that
 * the strategy's true Sharpe ratio beats that bar, allowing for the skew and fat tails of its trades.
 */
export function deflatedSharpe(nets: number[], trials: number) {
  const n = nets.length, N = Math.max(2, Math.round(trials));
  if (n < 3) return { n, trials: N, sr: null, t: null, sr0: null, dsr: 0 };
  const mean = nets.reduce((a, x) => a + x, 0) / n;
  const m2 = nets.reduce((a, x) => a + (x - mean) ** 2, 0) / n;
  const sd = Math.sqrt(m2);
  if (!(sd > 0)) return { n, trials: N, sr: null, t: null, sr0: null, dsr: mean > 0 ? 1 : 0 };
  const m3 = nets.reduce((a, x) => a + (x - mean) ** 3, 0) / n, m4 = nets.reduce((a, x) => a + (x - mean) ** 4, 0) / n;
  const skew = m3 / sd ** 3, kurt = m4 / sd ** 4;
  const sr = mean / sd;
  const sr0 = Math.sqrt(1 / (n - 1)) * ((1 - EULER) * normInv(1 - 1 / N) + EULER * normInv(1 - 1 / (N * Math.E)));
  const den = Math.sqrt(Math.max(1e-9, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  const dsr = normCdf(((sr - sr0) * Math.sqrt(n - 1)) / den);
  return { n, trials: N, sr: +sr.toFixed(4), t: +(sr * Math.sqrt(n)).toFixed(2), sr0: +sr0.toFixed(4), dsr: +dsr.toFixed(4), skew: +skew.toFixed(2), kurt: +kurt.toFixed(2) };
}

/** Median of a list (null when empty). */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Probability of Backtest Overfitting by combinatorially symmetric cross-validation (Bailey, Borwein, López de Prado &
 * Zhu). `perf[k][j]` = strategy k's result in time slice j. Every way of splitting the slices into two halves is tried:
 * the best strategy of one half is ranked in the other. PBO = share of splits where it lands in the bottom half — near
 * 0 means the choosing works, 50% or more means the "best" is mostly luck.
 */
export function pbo(perf: number[][], maxSlices = 12) {
  const N = perf.length, T = perf[0]?.length ?? 0;
  const S = Math.min(maxSlices, T - (T % 2));
  if (N < 4 || S < 4) return null;
  // Slices: T columns grouped into S nearly equal blocks.
  const block = (k: number, s: number) => { const a = Math.floor((s * T) / S), b = Math.floor(((s + 1) * T) / S); let x = 0; for (let j = a; j < b; j++) x += perf[k][j]; return x; };
  const M = perf.map((_, k) => Array.from({ length: S }, (_, s) => block(k, s)));
  let below = 0, total = 0;
  const half = S / 2, pick: number[] = [];
  const rec = (start: number) => {
    if (pick.length === half) {
      const inSet = new Set(pick);
      const isP = M.map((row) => row.reduce((a, v, s) => a + (inSet.has(s) ? v : 0), 0));
      const osP = M.map((row) => row.reduce((a, v, s) => a + (inSet.has(s) ? 0 : v), 0));
      let best = 0; for (let k = 1; k < N; k++) if (isP[k] > isP[best]) best = k;
      const rank = osP.filter((v) => v < osP[best]).length + 1; // 1 = worst out of sample
      const w = rank / (N + 1);
      if (Math.log(w / (1 - w)) <= 0) below++;
      total++;
      return;
    }
    for (let s = start; s < S; s++) { pick.push(s); rec(s + 1); pick.pop(); }
  };
  rec(0);
  return { pbo: +(below / total).toFixed(3), strategies: N, slices: S, splits: total };
}
