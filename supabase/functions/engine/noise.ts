// Phase 2 of the stricter lab: does a strategy beat noise? Two tests on a finalist (one that passed everything else).
//  - Shuffled prices (Monte Carlo permutation, after Masters / Aronson): the same candles with their order shuffled keep
//    the asset's volatility and gaps but lose any real pattern. A real edge should beat almost all of those runs.
//  - Random entries: the same number of trades, each held as long and on the same side as a real one, entered at random
//    times. A real edge should beat almost all of those too (otherwise the market's drift did the work).
import type { MBar, SimData } from "./backtest.ts";
import type { DayBar } from "./logic.ts";

/** A small seeded random generator (mulberry32), so a shuffle can be repeated exactly. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle<T>(xs: T[], rnd: () => number) {
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
  return xs;
}
type Shape = { r: number; o: number; h: number; l: number };
/** A candle as its move from the previous close and its open / high / low around its own close (all in logs). */
const shapeOf = (prevC: number, b: { o: number; h: number; l: number; c: number }): Shape =>
  ({ r: Math.log(b.c / prevC), o: Math.log(b.o / b.c), h: Math.log(b.h / b.c), l: Math.log(b.l / b.c) });
const fromShape = (prevC: number, s: Shape) => { const c = prevC * Math.exp(s.r); return { o: c * Math.exp(s.o), h: c * Math.exp(s.h), l: c * Math.exp(s.l), c }; };

/**
 * Shuffled copy of an asset's candles.
 * Daily strategies: whole days are shuffled (minute candles are not used by them).
 * Minute strategies: the 5-minute candles are shuffled among themselves and each day's opening gap among the opening
 * gaps (so gaps stay at session opens); daily candles are rebuilt from them where minute candles exist (older daily
 * candles stay as they were, for the indicators' warm-up).
 */
export function shuffledData(data: SimData, daily: boolean, seed: number): SimData {
  const rnd = seeded(seed);
  if (daily) {
    const d = data.daily, shapes = d.slice(1).map((b, i) => shapeOf(d[i].c, b));
    shuffle(shapes, rnd);
    const out: DayBar[] = [d[0]];
    for (let i = 1; i < d.length; i++) out.push({ ...d[i], ...fromShape(out[i - 1].c, shapes[i - 1]), v: d[i].v });
    return { raw: [], byDay: new Map(), daily: out, btc: data.btc, funding: data.funding };
  }
  const raw = data.raw;
  if (raw.length < 2) return data;
  const firstOfDay = raw.map((b, i) => i === 0 || raw[i - 1].day !== b.day);
  const gaps: Shape[] = [], bars: Shape[] = [];
  for (let i = 1; i < raw.length; i++) (firstOfDay[i] ? gaps : bars).push(shapeOf(raw[i - 1].c, raw[i]));
  shuffle(gaps, rnd); shuffle(bars, rnd);
  const out: MBar[] = [raw[0]];
  let gi = 0, bi = 0;
  for (let i = 1; i < raw.length; i++) out.push({ ...raw[i], ...fromShape(out[i - 1].c, firstOfDay[i] ? gaps[gi++] : bars[bi++]) });
  const byDay = new Map<string, MBar[]>();
  for (const b of out) { const a = byDay.get(b.day); if (a) a.push(b); else byDay.set(b.day, [b]); }
  // Daily candles: rebuilt from the shuffled minutes; before the minutes start, the real ones (indicator warm-up).
  const first = out[0].day, built = new Map<string, DayBar>();
  for (const [day, bs] of byDay) built.set(day, { t: Date.parse(`${day}T00:00:00+05:30`) / 1000, o: bs[0].o, h: Math.max(...bs.map((b) => b.h)), l: Math.min(...bs.map((b) => b.l)), c: bs[bs.length - 1].c, v: 0, day });
  const dailyOut = data.daily.filter((x) => x.day < first).concat([...built.values()].sort((a, b) => a.t - b.t));
  return { raw: out, byDay, daily: dailyOut, btc: data.btc, funding: data.funding };
}

/** Share of the runs (with the real one counted in) that did at least as well as the real result: the p-value. */
export function pValue(real: number, runs: number[]) {
  return (1 + runs.filter((x) => x >= real).length) / (1 + runs.length);
}

type Tr = { entry: string; exit: string; side?: string; entry_px?: number; exit_px?: number };
const toSec = (s: string) => Date.parse(`${s.slice(0, 10)}T${s.length > 10 ? s.slice(11, 16) : "09:15"}:00+05:30`) / 1000;

/**
 * Random-entry benchmark in price points (costs left out on both sides): the strategy's own trades against `runs` sets of
 * the same trades entered at random candles. Returns the real points, the runs and the p-value.
 */
export function randomEntries(trades: Tr[], closes: { t: number; c: number }[], runs: number, seed: number) {
  const rnd = seeded(seed);
  const n = closes.length;
  const idx = (t: number) => { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (closes[m].t <= t) lo = m; else hi = m - 1; } return lo; };
  const real: { dir: number; hold: number; pts: number }[] = [];
  for (const t of trades) {
    const dir = /^S/i.test(String(t.side ?? "L")) ? -1 : 1;
    const i0 = idx(toSec(t.entry)), i1 = idx(toSec(t.exit));
    const pts = t.entry_px != null && t.exit_px != null ? (Number(t.exit_px) - Number(t.entry_px)) * dir : (closes[i1].c - closes[i0].c) * dir;
    real.push({ dir, hold: Math.max(1, i1 - i0), pts });
  }
  const realPts = real.reduce((a, x) => a + x.pts, 0);
  const out: number[] = [];
  for (let k = 0; k < runs; k++) {
    let sum = 0;
    for (const r of real) {
      if (n <= r.hold + 1) continue;
      const i = Math.floor(rnd() * (n - r.hold - 1));
      sum += (closes[i + r.hold].c - closes[i].c) * r.dir;
    }
    out.push(sum);
  }
  return { real: +realPts.toFixed(2), p: pValue(realPts, out), median: out.length ? [...out].sort((a, b) => a - b)[out.length >> 1] : null };
}

/** The candle times and closes a strategy trades on (daily candles, or the 5-minute candles), from `from` to `to`. */
export function closesFor(data: SimData, daily: boolean, from: string, to: string) {
  return daily
    ? data.daily.filter((d) => d.day >= from && d.day <= to).map((d) => ({ t: d.t, c: d.c }))
    : data.raw.filter((b) => b.day >= from && b.day <= to).map((b) => ({ t: b.t, c: b.c }));
}
