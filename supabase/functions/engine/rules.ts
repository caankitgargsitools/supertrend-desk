// Condition-based strategies: "When Supertrend is up on 60m AND RSI(14) on 15m is above 60 → buy".
// A strategy has up to four rule sets (buy, sell, exit long, exit short); each set holds conditions combined
// with ALL (every condition true) or ANY (at least one true). Conditions are checked when a candle of the
// strategy's own timeframe closes, against the latest COMPLETED candle of each condition's timeframe, so a
// backtest never looks ahead.
import { adx, atr, bollinger, ema, keltner, macd, pctRank, rsi, sma, type Swing, swings, vwap } from "./indicators.ts";
import { addDays, aggregate, type Bar, type DayBar, heikinAshi, isLastWeekdayOfMonth, ist, marketEvents, nextExpiryFrom, type Raw, sessionFor, supertrend, tradingDaysLeftInMonth, weekdayOf, weeklyExpiryWeekday } from "./logic.ts";

export type Cond = { ind: string; tf: string; p?: Record<string, number>; op: string; v?: number };
/**
 * fill (entry sets, 6 Nov 2026): "CLOSE" (default) fills at the decision candle's close; "LEVEL" rests a limit order at
 * the level the first level-giving condition names (a Fibonacci retracement, a pivot, yesterday's high, a band …) for
 * the next candle: it fills at that level if the candle trades through it (a gap through it fills at the open), else at
 * that candle's close. A backtest-realism feature (the live engine decides at the close as before).
 */
export type RuleSet = { mode: "ALL" | "ANY"; conds: Cond[]; fill?: "CLOSE" | "LEVEL" };
/**
 * daily: decide once a day at the session open from completed daily candles (all conditions on "D").
 * candles: "HA" = indicators read Heikin Ashi candles instead of normal ones (price levels such as VWAP, previous-day
 * high/low and opening range always use real prices, and orders always fill at real prices).
 */
export type Rules = { long?: RuleSet; short?: RuleSet; exitLong?: RuleSet; exitShort?: RuleSet; daily?: boolean; candles?: "NORMAL" | "HA" };

/** Heikin Ashi candles built from normal ones (same times and days). */
export function haCandles<T extends { o: number; h: number; l: number; c: number }>(bars: T[]): T[] {
  const { ho, hc } = heikinAshi(bars);
  return bars.map((b, i) => ({ ...b, o: ho[i], c: hc[i], h: Math.max(b.h, ho[i], hc[i]), l: Math.min(b.l, ho[i], hc[i]) }));
}
const REAL_PRICE = new Set(["VWAP", "PDHL", "ORB", "SWEEP", "TIME", "BTC", "FUND", "HAS", "OI", "PIV", "FIB", "GAP", "RANGE", "CAL", "VIX", "FX", "USDPX"]);
/** Conditions that read the decision time or another series, not this asset's candle frames. */
const NO_FRAME = new Set(["TIME", "BTC", "FUND", "CAL", "VIX"]);
/** Does any condition of a rule book use this indicator? (the engine fetches India VIX only when a rule reads it) */
export const rulesUse = (r: Rules, ind: string) => allConds(r).some((c) => c.ind === ind);
/** Settings of the swing detector a rule book's Fibonacci / divergence conditions use (the first one found; defaults otherwise). */
export function swingParamsOf(r: Rules): { mode: number; k: number; n: number } {
  const c = allConds(r).find((x) => x.ind === "FIB" || x.ind === "DIV");
  const p = c?.p ?? {};
  return { mode: Math.trunc(p.mode ?? 0), k: Number(p.k ?? 2), n: Math.max(2, Math.trunc(p.n ?? 5)) };
}
/** Size (price points) of the last completed swing at each candle (0 = none yet), for the Fibonacci target. */
export function swingSizes(bars: { o: number; h: number; l: number; c: number }[], sp: { mode: number; k: number; n: number }): number[] {
  const sw = swings(bars, sp.mode, sp.k, sp.n, 14);
  return bars.map((_, i) => { const j = sw.last[i]; return j < 0 ? 0 : sw.list[j].hi - sw.list[j].lo; });
}

/**
 * Heikin Ashi strength ("HAS"): each Heikin Ashi candle is green (buy), red (sell) or a doji (hold: body smaller than
 * doji% of the candle's range), and gets a strength score from 0 to 100 in its own direction, made of five parts:
 *   body   — body as a share of the whole candle (a full-bodied candle is decisive);
 *   wick   — no wick on the "wrong" side (a green candle with no lower wick, a red one with no upper wick);
 *   streak — how many candles of the same colour in a row (up to 5);
 *   growth — this body against the average of the last 10 bodies (a growing candle is accelerating);
 *   adx    — trend strength, ADX(len) up to 40, counted only when +DI/−DI agree with the colour.
 * The weights of the parts come from one of four presets, so the lab tries different ideas of "strong":
 *   0 balanced, 1 candle shape, 2 trend (streak + ADX), 3 momentum (growth).
 */
export const HAS_WEIGHTS: Record<number, { name: string; w: [number, number, number, number, number] }> = {
  0: { name: "balanced", w: [25, 20, 15, 15, 25] },
  1: { name: "candle shape", w: [35, 30, 15, 20, 0] },
  2: { name: "trend", w: [15, 10, 25, 15, 35] },
  3: { name: "momentum", w: [20, 15, 20, 35, 10] },
};
export function haStrength(bars: { o: number; h: number; l: number; c: number }[], len = 14, preset = 0, dojiPct = 10) {
  const n = bars.length, { ho, hc } = heikinAshi(bars), d = adx(bars, len);
  const W = (HAS_WEIGHTS[preset] ?? HAS_WEIGHTS[0]).w;
  const col = new Array<number>(n).fill(0), score = new Array<number>(n).fill(0), body = new Array<number>(n).fill(0);
  let streak = 0;
  for (let i = 0; i < n; i++) {
    const top = Math.max(ho[i], hc[i]), bot = Math.min(ho[i], hc[i]);
    const hh = Math.max(bars[i].h, top), ll = Math.min(bars[i].l, bot), range = hh - ll;
    body[i] = top - bot;
    const c = range <= 0 || body[i] / range < dojiPct / 100 ? 0 : hc[i] > ho[i] ? 1 : -1;
    col[i] = c;
    streak = c !== 0 && i > 0 && col[i - 1] === c ? streak + 1 : c !== 0 ? 1 : 0;
    if (c === 0 || range <= 0) continue;
    let avg = 0, m = 0;
    for (let j = Math.max(0, i - 10); j < i; j++) { avg += body[j]; m++; }
    avg = m ? avg / m : 0;
    const sBody = body[i] / range;
    const sWick = 1 - (c > 0 ? bot - ll : hh - top) / range;
    const sStreak = Math.min(streak, 5) / 5;
    const sGrowth = avg > 0 ? Math.min(body[i] / (2 * avg), 1) : 0.5;
    const agree = c > 0 ? d.plus[i] > d.minus[i] : d.minus[i] > d.plus[i];
    const sAdx = isNaN(d.adx[i]) || !agree ? 0 : Math.min(d.adx[i] / 40, 1);
    score[i] = Math.round(W[0] * sBody + W[1] * sWick + W[2] * sStreak + W[3] * sGrowth + W[4] * sAdx);
  }
  return { col, score };
}
/** Monday of a date's week (weeks run Monday–Sunday). */
export const mondayOf = (day: string) => addDays(day, -((weekdayOf(day) + 6) % 7));
/** Weekly candles from daily ones, each dated by its Monday. */
export function weeklyBars(daily: DayBar[]): DayBar[] {
  const out: DayBar[] = [];
  for (const d of daily) {
    const wk = mondayOf(d.day), last = out[out.length - 1];
    if (last && last.day === wk) { last.h = Math.max(last.h, d.h); last.l = Math.min(last.l, d.l); last.c = d.c; last.v = (last.v ?? 0) + (d.v ?? 0); }
    else out.push({ t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v ?? 0, day: wk });
  }
  return out;
}
/**
 * Extra series some conditions read: Bitcoin's daily candles (a filter for other coins), daily funding rates, India VIX
 * (daily candles and, for intraday VIX conditions, its 5-minute candles), market-event days (else the engine-wide set
 * from market_events) and the strategy's expiry rule (weekday, monthly, underlying — the backtester's own convention)
 * for the calendar conditions when they don't carry `wd` / `monthly` themselves.
 */
export type RuleExt = { btc?: DayBar[]; funding?: Map<string, number>; vix?: DayBar[]; vixRaw?: Raw[];
  /** USD/INR daily candles (14 Nov 2026): the FX conditions read them, and USDPX divides this asset's rupee prices by them. */
  fx?: DayBar[]; events?: Set<string>; expiry?: { weekday: number; monthly: boolean; underlying: string } };
export type Signals = { long: boolean; short: boolean; exitLong: boolean | null; exitShort: boolean | null };
type Side = "LONG" | "SHORT";

const has = (r?: RuleSet) => !!r && Array.isArray(r.conds) && r.conds.length > 0;
export const ruleSets = (r: Rules) => ({ long: has(r.long), short: has(r.short), exitLong: has(r.exitLong), exitShort: has(r.exitShort) });

/** Every condition in a rule book. */
export function allConds(r: Rules): Cond[] {
  return [r.long, r.short, r.exitLong, r.exitShort].flatMap((x) => has(x) ? x!.conds : []);
}

/** Timeframes (in minutes, or "D") a rule book needs, with the strategy's own timeframe resolved. */
export function ruleTimeframes(r: Rules, baseTf: number): { intraday: number[]; daily: boolean } {
  if (r.daily) return { intraday: [], daily: true };
  const tfs = new Set<number>([baseTf]);
  let daily = false;
  for (const c of allConds(r)) {
    if (c.ind === "PDHL" || c.ind === "PIV" || c.ind === "GAP" || (c.ind === "SWEEP" && Number(c.p?.src) === 1)) daily = true;
    if (c.ind === "CAL" && c.op === "turn_of_month") daily = true; // the month's trading-day count comes from the daily candles
    if (c.ind === "VIX" || c.ind === "FX") continue; // its own candles, not this asset's
    if (c.ind === "TIME" || c.ind === "BTC" || c.ind === "FUND" || c.ind === "CAL") { if (c.tf !== "D" && c.tf !== "W") tfs.add(c.tf === "base" ? baseTf : Number(c.tf)); continue; }
    if (c.tf === "D" || c.tf === "W") daily = true;
    else tfs.add(c.tf === "base" ? baseTf : Number(c.tf));
  }
  return { intraday: [...tfs].filter((x) => x > 0).sort((a, b) => a - b), daily };
}

/** Longest look-back any condition needs, in candles (Supertrend/HA get 500 to settle like the chart). */
export function warmBarsFor(r: Rules): number {
  let n = 300;
  for (const c of allConds(r)) {
    const p = c.p ?? {};
    const len = Math.max(p.len ?? 0, p.len2 ?? 0, p.slow ?? 0, (p.slow ?? 0) + (p.sig ?? 0), p.atr ?? 0, p.n ?? 0);
    const lk = c.ind === "VOL" ? (p.look ?? 250) + (p.len ?? 20) : c.ind === "BB" && /bandwidth/.test(c.op) ? (p.look ?? 250) + (p.len ?? 20) : 0;
    // Swing-based conditions need a few swings behind them to settle.
    const sw = c.ind === "FIB" || c.ind === "DIV" ? 400 : 0;
    n = Math.max(n, c.ind === "ST" || c.ind === "HA" || c.ind === "HAS" ? 500 : Math.max(len * 10 + 50, lk + 20, sw));
    if (c.tf === "W") n = Math.max(n, Math.min(1500, (c.ind === "ST" || c.ind === "HA" || c.ind === "HAS" ? 120 : len * 4 + 10) * 7));
  }
  return Math.min(n, 1500);
}

const tm = (x: string) => { const [h, m] = x.split(":").map(Number); return h * 60 + m; };

/** Human-readable text for one condition (used in logs and the trade list). */
export function describeCond(c: Cond): string {
  const p = c.p ?? {};
  const tf = c.tf === "D" ? "daily" : c.tf === "W" ? "weekly" : c.tf === "base" ? "own timeframe" : `${c.tf}m`;
  const v = c.v ?? 0;
  const ops: Record<string, string> = {
    up: "is up", down: "is down", turns_up: "turns up", turns_down: "turns down",
    green: "is green", red: "is red", turns_green: "turns green", turns_red: "turns red",
    gt: `> ${v}`, lt: `< ${v}`, cross_above: `crosses above ${v}`, cross_below: `crosses below ${v}`,
    price_above: "price above", price_below: "price below", price_cross_above: "price crosses above", price_cross_below: "price crosses below",
    fast_above_slow: "fast above slow", fast_below_slow: "fast below slow", fast_cross_above: "fast crosses above slow", fast_cross_below: "fast crosses below slow",
    above_signal: "above signal", below_signal: "below signal", cross_above_signal: "crosses above signal", cross_below_signal: "crosses below signal",
    hist_pos: "histogram > 0", hist_neg: "histogram < 0", above_zero: "above 0", below_zero: "below 0",
    close_above_upper: "close above upper band", close_below_lower: "close below lower band", cross_above_upper: "crosses above upper band",
    cross_below_lower: "crosses below lower band", price_above_mid: "price above middle band", price_below_mid: "price below middle band",
    plus_above_minus: "+DI above −DI", minus_above_plus: "−DI above +DI",
    above_pdh: "price above previous day high", below_pdl: "price below previous day low",
    cross_above_pdh: "crosses above previous day high", cross_below_pdl: "crosses below previous day low",
    above_orh: "price above opening-range high", below_orl: "price below opening-range low",
    cross_above_orh: "breaks above opening-range high", cross_below_orl: "breaks below opening-range low",
    bull_sweep: "of the lows (wick below, close back above)", bear_sweep: "of the highs (wick above, close back below)",
    new_high: "close above the highest high (breakout)", new_low: "close below the lowest low (breakdown)", above_mid: "price above the channel middle", below_mid: "price below the channel middle",
    high_vol: "is high (above its usual level)", low_vol: "is low (below its usual level)",
    in_hours: `between ${String(p.from ?? 0).padStart(2, "0")}:00 and ${String(p.to ?? 24).padStart(2, "0")}:00 IST`, on_weekday: `is a ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][Number(p.d ?? 5)] ?? "?"}`,
    not_weekend: "is a weekday (Mon–Fri)", has_buy: `is green (buy) with strength ≥ ${v}`, has_sell: `is red (sell) with strength ≥ ${v}`, has_doji: "is a doji (hold)", btc_up: `is up (daily close above its ${p.len ?? 50}-day EMA)`, btc_down: `is down (daily close below its ${p.len ?? 50}-day EMA)`,
    oi_rising: "is rising", oi_falling: "is falling", oi_up_price_up: "rising with the price rising (long build-up)", oi_up_price_down: "rising with the price falling (short build-up)",
    above_pp: "price above the pivot", below_pp: "price below the pivot", cross_up_pp: "crosses above the pivot", cross_down_pp: "crosses below the pivot",
    above_r1: "price above R1", below_s1: "price below S1", cross_up_r1: "crosses above R1", cross_down_s1: "crosses below S1",
    cpr_narrow: `central pivot range narrow (under ${p.k ?? 0.5}× its ${PIV_LOOK}-day median)`, cpr_wide: `central pivot range wide (over ${p.k ?? 0.5}× its ${PIV_LOOK}-day median)`,
    pullback_to_382: "pulls back to the 38.2% level and closes up", pullback_to_50: "pulls back to the 50% level and closes up", pullback_to_618: "pulls back to the 61.8% level and closes up",
    rally_to_382: "rallies to the 38.2% level and closes down", rally_to_50: "rallies to the 50% level and closes down", rally_to_618: "rallies to the 61.8% level and closes down",
    in_zone_bull: "price inside the 38.2–61.8% pullback zone of an up swing", in_zone_bear: "price inside the 38.2–61.8% rally zone of a down swing",
    broke_down_786: "up swing failed (close under its 78.6% level)", broke_up_786: "down swing failed (close over its 78.6% level)",
    gap_up_gt: `gapped up more than ${p.k ?? 1}× the daily ATR`, gap_dn_gt: `gapped down more than ${p.k ?? 1}× the daily ATR`,
    gap_filled: "gap filled (price back through the previous close)", gap_held: `gap held through the first ${p.mins ?? 15} minutes`,
    bandwidth_pctile_lt: `bandwidth under its ${p.pct ?? 20}th percentile of ${p.look ?? 250} candles (squeeze)`, bandwidth_pctile_gt: `bandwidth over its ${p.pct ?? 20}th percentile of ${p.look ?? 250} candles`,
    nr_n: `previous candle was the narrowest of the last ${p.n ?? 7}`, inside_bar: "previous candle was an inside bar",
    range_gt_atr: `candle range over ${p.k ?? 1.5}× ATR(${p.len ?? 14})`, range_lt_atr: `candle range under ${p.k ?? 1.5}× ATR(${p.len ?? 14})`,
    above_upper: "close above the upper channel", below_lower: "close below the lower channel", squeeze: "Bollinger bands inside the channel (squeeze)", squeeze_release: "squeeze just released",
    is_expiry_day: "is an expiry day", not_expiry_day: "is not an expiry day", days_to_expiry_lt: `under ${v} days to the expiry`,
    turn_of_month: `is the turn of the month (last ${p.a ?? 2} / first ${p.b ?? 3} trading days)`, event_day: (p.n ?? 0) > 0 ? `is within ${p.n} days of a market event` : "is a market-event day",
    fx_rising: `is rising (vs ${p.n ?? 5} candles ago)`, fx_falling: `is falling (vs ${p.n ?? 5} candles ago)`, fx_above_sma: `above its ${p.len ?? 20}-candle average`, fx_below_sma: `below its ${p.len ?? 20}-candle average`,
    fx_chg_gt: `changed more than ${v}% in ${p.n ?? 5} candles`, fx_chg_lt: `changed less than ${v}% in ${p.n ?? 5} candles`,
    usd_rising: `is rising (vs ${p.n ?? 5} candles ago)`, usd_falling: `is falling (vs ${p.n ?? 5} candles ago)`, usd_above_sma: `above its ${p.len ?? 20}-candle average`, usd_below_sma: `below its ${p.len ?? 20}-candle average`,
    usd_chg_gt: `changed more than ${v}% in ${p.n ?? 5} candles`, usd_chg_lt: `changed less than ${v}% in ${p.n ?? 5} candles`,
    fx_share_gt: `move of the last ${p.n ?? 5} candles came more than ${v}% from USD/INR`, fx_share_lt: `move of the last ${p.n ?? 5} candles came less than ${v}% from USD/INR`,
    vix_gt: `> ${v}`, vix_lt: `< ${v}`, vix_rising: `is rising (vs ${p.n ?? 5} candles ago)`, vix_pctile_gt: `above its ${v}th percentile of ${p.look ?? 250} candles`, vix_pctile_lt: `below its ${v}th percentile of ${p.look ?? 250} candles`,
    rsi_bull_div: "bullish divergence (price lower low, RSI higher low)", rsi_bear_div: "bearish divergence (price higher high, RSI lower high)",
    macd_bull_div: "bullish divergence (price lower low, MACD higher low)", macd_bear_div: "bearish divergence (price higher high, MACD lower high)",
  };
  const name: Record<string, string> = {
    ST: `Supertrend(${p.atr ?? 10},${p.factor ?? 3})`, HA: "Heikin Ashi", HAS: `HA strength (${(HAS_WEIGHTS[Number(p.w ?? 0)] ?? HAS_WEIGHTS[0]).name}, ADX ${p.len ?? 14}, doji < ${p.doji ?? 10}%)`, RSI: `RSI(${p.len ?? 14})`,
    EMA: p.len2 ? `EMA(${p.len ?? 9}/${p.len2})` : `EMA(${p.len ?? 20})`, SMA: p.len2 ? `SMA(${p.len ?? 9}/${p.len2})` : `SMA(${p.len ?? 20})`,
    MACD: `MACD(${p.fast ?? 12},${p.slow ?? 26},${p.sig ?? 9})`, VWAP: "VWAP", BB: `Bollinger(${p.len ?? 20},${p.mult ?? 2})`,
    ADX: `ADX(${p.len ?? 14})`, ATR: `ATR(${p.len ?? 14})`, PDHL: "Prev-day H/L", ORB: `Opening range (${p.mins ?? 15}m)`,
    DON: `Donchian(${p.len ?? 20})`, VOL: `Volatility(${p.len ?? 20} vs ${p.look ?? 250})`, TIME: "Time", BTC: "Bitcoin trend", FUND: "Funding rate (% per 8h)",
    SWEEP: `Liquidity sweep (${Number(p.src) === 1 ? "prev-day high/low" : `${p.len ?? 20}-candle swing`}${(p.within ?? 1) > 1 ? `, within ${p.within} candles` : ""})`,
    OI: `Open interest (vs ${p.n ?? 5} candles ago)`,
    PIV: `Pivot points (${Number(p.src) === 1 ? "weekly" : "daily"}, ${Number(p.kind) === 1 ? "Camarilla" : "classic"})`,
    FIB: `Fibonacci (${Number(p.mode) === 1 ? `${p.n ?? 5}-bar swings` : `${p.k ?? 2}×ATR swings`}, tolerance ${p.tol ?? 0.2}×ATR)`,
    GAP: "Opening gap", RANGE: "Candle range", KC: `Keltner(${p.len ?? 20},${p.k ?? 1.5})`,
    CAL: "Calendar", VIX: "India VIX", FX: "USD/INR", USDPX: "Price in dollars (÷ USD/INR)",
    DIV: `Divergence (${c.op.startsWith("macd") ? `MACD(${p.fast ?? 12},${p.slow ?? 26},${p.sig ?? 9})` : `RSI(${p.len ?? 14})`}, ${Number(p.mode) === 1 ? `${p.n ?? 5}-bar swings` : `${p.k ?? 2}×ATR swings`})`,
  };
  if (c.ind === "TIME") return `Time ${ops[c.op] ?? c.op}`;
  if (c.ind === "CAL") return `Calendar: ${ops[c.op] ?? c.op}`;
  if (c.ind === "BTC") return `Bitcoin ${ops[c.op] ?? c.op}`;
  return `${name[c.ind] ?? c.ind} ${tf} ${ops[c.op] ?? c.op}`;
}

type Frame = { bars: (Bar | DayBar)[]; isDaily: boolean; weekly?: boolean };
type Check = (k: number, T: number, day: string) => boolean;
/** The price level a condition is about (for a "LEVEL" fill), or null. */
type Level = (k: number, T: number, day: string) => number | null;
/** Candles of the median of the central pivot range's width that "narrow" / "wide" are judged against. */
const PIV_LOOK = 20;
/** Classic pivots, Camarilla's H3 / H4 / L3 / L4 (as R1 / R2 / S1 / S2) and the central pivot range from one period's bar. */
export function pivotLevels(d: { h: number; l: number; c: number }, camarilla: boolean) {
  const pp = (d.h + d.l + d.c) / 3, r = d.h - d.l, bc = (d.h + d.l) / 2, tc = 2 * pp - bc;
  const cl = camarilla
    ? { r1: d.c + (r * 1.1) / 4, r2: d.c + (r * 1.1) / 2, s1: d.c - (r * 1.1) / 4, s2: d.c - (r * 1.1) / 2, r3: d.c + (r * 1.1) / 2 + (r * 1.1) / 4, s3: d.c - (r * 1.1) / 2 - (r * 1.1) / 4 }
    : { r1: 2 * pp - d.l, s1: 2 * pp - d.h, r2: pp + r, s2: pp - r, r3: d.h + 2 * (pp - d.l), s3: d.l - 2 * (d.h - pp) };
  return { pp, bc, tc, w: Math.abs(tc - bc), ...cl };
}

/**
 * Builds a fast evaluator for a rule book over prepared candle frames.
 *  frames: intraday candles per timeframe (minutes) plus optional daily candles; base: raw base candles grouped by day (for opening range).
 */
export class RuleBook {
  private checks = new Map<Cond, { frame: Frame; check: Check; level?: Level }>();
  private rules: Rules;
  private baseTf: number;
  private frames: Map<number, Bar[]>;
  private daily: DayBar[];
  private baseByDay: Map<string, { min: number; h: number; l: number }[]>;
  private seg: string;
  private memo: Map<string, unknown>;
  private ext: RuleExt;
  /** memo: optional cache of indicator series shared by many rule books on the same candles (the strategy lab). */
  constructor(rules: Rules, baseTf: number, frames: Map<number, Bar[]>, daily: DayBar[],
    baseByDay: Map<string, { min: number; h: number; l: number }[]>, seg: string, memo?: Map<string, unknown>, ext?: RuleExt) {
    this.rules = rules; this.baseTf = baseTf; this.frames = frames; this.daily = daily; this.baseByDay = baseByDay; this.seg = seg;
    this.memo = memo ?? new Map(); this.ext = ext ?? {};
    for (const c of allConds(rules)) this.checks.set(c, this.build(c));
  }

  private frameFor(c: Cond): Frame & { ha: boolean } {
    const ha = this.rules.candles === "HA" && !REAL_PRICE.has(c.ind);
    const conv = <T extends Bar | DayBar>(key: string, bars: T[]): T[] => {
      if (!ha) return bars;
      const k = `HAC|${key}|${bars.length}|${bars[0]?.t ?? 0}`;
      if (!this.memo.has(k)) this.memo.set(k, haCandles(bars));
      return this.memo.get(k) as T[];
    };
    // India VIX reads its own candles: daily ones, or its 5-minute candles aggregated to this condition's timeframe (the
    // daily ones when none are given). No VIX data at all → an empty frame, so the condition is simply false.
    if (c.ind === "VIX") {
      const vix = this.ext.vix ?? [];
      if (c.tf === "D" || c.tf === "W" || !this.ext.vixRaw?.length) return { bars: vix, isDaily: true, ha: false };
      const tf = c.tf === "base" ? this.baseTf : Number(c.tf), raw = this.ext.vixRaw;
      const k = `VIXF|${tf}|${raw.length}|${raw[0]?.t ?? 0}`;
      if (!this.memo.has(k)) this.memo.set(k, aggregate(raw, tf, "IDX_I"));
      return { bars: this.memo.get(k) as Bar[], isDaily: false, ha: false };
    }
    // USD/INR (14 Nov 2026, Papa: an MCX price moves with the commodity's dollar price and with the rupee — "factor in both"):
    // FX reads USD/INR's own daily candles; USDPX is this asset's own candles in dollars (each price ÷ USD/INR: the same
    // day's close for a daily candle, the last close before the candle's day for an intraday one — never a later rate).
    // Every USDPX bar also carries its rupee close (rc) and the rate used (f), so a condition can split the move.
    if (c.ind === "FX") return { bars: this.ext.fx ?? [], isDaily: true, ha: false };
    if (c.ind === "USDPX") {
      const fx = this.ext.fx ?? [], daily = c.tf === "D" || c.tf === "W";
      const tf = daily ? 0 : c.tf === "base" ? this.baseTf : Number(c.tf);
      const src = (daily ? this.daily : this.frames.get(tf)) ?? [];
      const k = `USDPX|${tf}|${src.length}|${src[0]?.t ?? 0}|${fx.length}|${fx[fx.length - 1]?.day ?? ""}`;
      if (!this.memo.has(k)) {
        let j = -1;
        const out = fx.length ? src.map((b) => {
          const day = (b as DayBar).day ?? ist(b.t).date;
          while (j + 1 < fx.length && (daily ? fx[j + 1].day <= day : fx[j + 1].day < day)) j++;
          const f = j >= 0 ? fx[j].c : NaN;
          return { ...b, o: b.o / f, h: b.h / f, l: b.l / f, c: b.c / f, rc: b.c, f };
        }) : [];
        this.memo.set(k, out);
      }
      return { bars: this.memo.get(k) as Bar[], isDaily: daily, ha: false };
    }
    if (c.tf === "D") return { bars: conv("D", this.daily), isDaily: true, ha };
    if (c.tf === "W") {
      const k = `WEEKLY|${this.daily.length}|${this.daily[0]?.t ?? 0}`;
      if (!this.memo.has(k)) this.memo.set(k, weeklyBars(this.daily));
      return { bars: conv("W", this.memo.get(k) as DayBar[]), isDaily: true, weekly: true, ha };
    }
    // Time, Bitcoin trend, funding and the calendar read the decision time itself: any frame will do.
    if (NO_FRAME.has(c.ind)) {
      const own = this.frames.get(this.baseTf);
      return own ? { bars: own, isDaily: false, ha: false } : { bars: this.daily, isDaily: true, ha: false };
    }
    const tf = c.tf === "base" ? this.baseTf : Number(c.tf);
    const bars = this.frames.get(tf);
    if (!bars) throw new Error(`No ${tf}-minute candles prepared for "${describeCond(c)}".`);
    return { bars: conv(String(tf), bars), isDaily: false, ha };
  }

  /** The previous period's bar (day, or week by its Monday) before a day, from a day-keyed series; -1 = none. */
  private static prevIdx(src: { day: string }[], key: string): number {
    let lo = 0, hi = src.length - 1, j = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (src[m].day < key) { j = m; lo = m + 1; } else hi = m - 1; }
    return j;
  }

  private build(c: Cond): { frame: Frame; check: Check; level?: Level } {
    const frame = this.frameFor(c);
    const b = frame.bars as (Bar & DayBar)[];
    const fk = (c.ind === "VIX" ? "VIX:" : c.ind === "FX" ? "FX:" : c.ind === "USDPX" ? "USD:" : "") + (frame.ha ? "HA:" : "") + (c.tf === "D" || c.tf === "W" ? c.tf : String(c.tf === "base" ? this.baseTf : Number(c.tf)));
    const M = <T>(name: string, fn: () => T): T => {
      const key = `${fk}|${b.length}|${name}`;
      if (!this.memo.has(key)) this.memo.set(key, fn());
      return this.memo.get(key) as T;
    };
    // Series shared by every frame (daily-candle levels), keyed by the daily series itself.
    const MD = <T>(name: string, fn: () => T): T => {
      const key = `DAILY|${this.daily.length}|${this.daily[0]?.t ?? 0}|${name}`;
      if (!this.memo.has(key)) this.memo.set(key, fn());
      return this.memo.get(key) as T;
    };
    const close = M("close", () => b.map((x) => x.c));
    const p = c.p ?? {}, v = Number(c.v ?? 0);
    const ok = (...xs: number[]) => xs.every((x) => !isNaN(x));
    const above = (a: number[], bb: number[] | number, k: number) => { const y = typeof bb === "number" ? bb : bb[k]; return ok(a[k], y) && a[k] > y; };
    const below = (a: number[], bb: number[] | number, k: number) => { const y = typeof bb === "number" ? bb : bb[k]; return ok(a[k], y) && a[k] < y; };
    const xUp = (a: number[], bb: number[] | number, k: number) => k > 0 && !above(a, bb, k - 1) && above(a, bb, k) && ok(a[k - 1]);
    const xDn = (a: number[], bb: number[] | number, k: number) => k > 0 && !below(a, bb, k - 1) && below(a, bb, k) && ok(a[k - 1]);
    const sameDay = (k: number) => k > 0 && b[k - 1].day === b[k].day;
    let check: Check = () => false;
    let level: Level | undefined;
    const ser = (s: number[]) => { level = (k) => ok(s[k]) ? s[k] : null; };
    switch (c.ind) {
      case "ST": {
        const tr = M(`ST${p.atr ?? 10},${p.factor ?? 3}`, () => supertrend(b, p.atr ?? 10, p.factor ?? 3).trend);
        check = (k) => c.op === "up" ? tr[k] === 1 : c.op === "down" ? tr[k] === -1
          : c.op === "turns_up" ? k > 0 && tr[k] === 1 && tr[k - 1] === -1 : c.op === "turns_down" ? k > 0 && tr[k] === -1 && tr[k - 1] === 1 : false;
        break;
      }
      case "HA": {
        const tr = M("HA", () => heikinAshi(b).trend);
        check = (k) => c.op === "green" ? tr[k] === 1 : c.op === "red" ? tr[k] === -1
          : c.op === "turns_green" ? k > 0 && tr[k] === 1 && tr[k - 1] === -1 : c.op === "turns_red" ? k > 0 && tr[k] === -1 && tr[k - 1] === 1 : false;
        break;
      }
      case "HAS": {
        const len = Math.max(2, Math.trunc(p.len ?? 14)), w = Math.trunc(p.w ?? 0), dj = Number(p.doji ?? 10);
        const hs = M(`HAS${len},${w},${dj}`, () => haStrength(b, len, w, dj));
        check = (k) => c.op === "has_buy" ? hs.col[k] === 1 && hs.score[k] >= v : c.op === "has_sell" ? hs.col[k] === -1 && hs.score[k] >= v
          : c.op === "has_doji" ? hs.col[k] === 0 : false;
        break;
      }
      case "RSI": case "ADX": case "ATR": {
        const d = c.ind === "ADX" ? M(`ADX${p.len ?? 14}`, () => adx(b, p.len ?? 14)) : null;
        const s = c.ind === "RSI" ? M(`RSI${p.len ?? 14}`, () => rsi(close, p.len ?? 14)) : c.ind === "ATR" ? M(`ATR${p.len ?? 14}`, () => atr(b, p.len ?? 14)) : d!.adx;
        check = (k) => c.op === "gt" ? above(s, v, k) : c.op === "lt" ? below(s, v, k) : c.op === "cross_above" ? xUp(s, v, k) : c.op === "cross_below" ? xDn(s, v, k)
          : c.op === "plus_above_minus" ? above(d!.plus, d!.minus, k) : c.op === "minus_above_plus" ? above(d!.minus, d!.plus, k) : false;
        break;
      }
      case "EMA": case "SMA": {
        const f = c.ind === "EMA" ? ema : sma;
        const m1 = M(`${c.ind}${p.len ?? 20}`, () => f(close, p.len ?? 20)), m2 = p.len2 ? M(`${c.ind}${p.len2}`, () => f(close, p.len2!)) : m1;
        if (c.op.startsWith("price_")) ser(m1);
        check = (k) => ({
          price_above: () => above(close, m1, k), price_below: () => below(close, m1, k),
          price_cross_above: () => xUp(close, m1, k), price_cross_below: () => xDn(close, m1, k),
          fast_above_slow: () => above(m1, m2, k), fast_below_slow: () => below(m1, m2, k),
          fast_cross_above: () => xUp(m1, m2, k), fast_cross_below: () => xDn(m1, m2, k),
        } as Record<string, () => boolean>)[c.op]?.() ?? false;
        break;
      }
      case "MACD": {
        const m = M(`MACD${p.fast ?? 12},${p.slow ?? 26},${p.sig ?? 9}`, () => macd(close, p.fast ?? 12, p.slow ?? 26, p.sig ?? 9));
        check = (k) => ({
          above_signal: () => above(m.line, m.signal, k), below_signal: () => below(m.line, m.signal, k),
          cross_above_signal: () => xUp(m.line, m.signal, k), cross_below_signal: () => xDn(m.line, m.signal, k),
          hist_pos: () => above(m.hist, 0, k), hist_neg: () => below(m.hist, 0, k),
          above_zero: () => above(m.line, 0, k), below_zero: () => below(m.line, 0, k),
        } as Record<string, () => boolean>)[c.op]?.() ?? false;
        break;
      }
      case "VWAP": {
        if (frame.isDaily) break; // VWAP is an intraday measure
        const w = M("VWAP", () => vwap(b));
        ser(w);
        check = (k) => c.op === "price_above" ? above(close, w, k) : c.op === "price_below" ? below(close, w, k)
          : c.op === "price_cross_above" ? xUp(close, w, k) && b[k - 1].day === b[k].day
          : c.op === "price_cross_below" ? xDn(close, w, k) && b[k - 1].day === b[k].day : false;
        break;
      }
      case "BB": {
        const bb = M(`BB${p.len ?? 20},${p.mult ?? 2}`, () => bollinger(close, p.len ?? 20, p.mult ?? 2));
        // Bandwidth percentile (6 Nov 2026): (upper − lower) ÷ basis ranked among the last `look` candles — a low
        // percentile is a volatility squeeze.
        const look = Math.max(20, Math.trunc(p.look ?? 250)), pct = Number(p.pct ?? 20);
        const bw = /bandwidth/.test(c.op) ? M(`BBW${p.len ?? 20},${p.mult ?? 2},${look}`, () => pctRank(bb.upper.map((u, i) => (u - bb.lower[i]) / bb.basis[i]), look)) : null;
        ser(/upper/.test(c.op) ? bb.upper : /lower/.test(c.op) ? bb.lower : bb.basis);
        check = (k) => ({
          close_above_upper: () => above(close, bb.upper, k), close_below_lower: () => below(close, bb.lower, k),
          cross_above_upper: () => xUp(close, bb.upper, k), cross_below_lower: () => xDn(close, bb.lower, k),
          price_above_mid: () => above(close, bb.basis, k), price_below_mid: () => below(close, bb.basis, k),
          bandwidth_pctile_lt: () => !!bw && ok(bw[k]) && bw[k] < pct, bandwidth_pctile_gt: () => !!bw && ok(bw[k]) && bw[k] > pct,
        } as Record<string, () => boolean>)[c.op]?.() ?? false;
        break;
      }
      case "KC": {
        // Keltner channel: EMA(len) ± k × ATR(len). The squeeze: Bollinger(len, mult) inside the channel (TTM squeeze);
        // its release = the candle on which the bands first leave the channel.
        const len = Math.max(2, Math.trunc(p.len ?? 20)), kk = Number(p.k ?? 1.5), mult = Number(p.mult ?? 2);
        const kc = M(`KC${len},${kk}`, () => keltner(b, len, kk));
        const sq = /squeeze/.test(c.op) ? M(`SQZ${len},${kk},${mult}`, () => { const bb = bollinger(close, len, mult); return bb.upper.map((u, i) => ok(u, kc.upper[i], bb.lower[i], kc.lower[i]) && u < kc.upper[i] && bb.lower[i] > kc.lower[i]); }) : null;
        ser(c.op === "below_lower" ? kc.lower : kc.upper);
        check = (k) => c.op === "above_upper" ? above(close, kc.upper, k) : c.op === "below_lower" ? below(close, kc.lower, k)
          : c.op === "squeeze" ? !!sq && sq[k] : c.op === "squeeze_release" ? !!sq && k > 0 && sq[k - 1] && !sq[k] : false;
        break;
      }
      case "RANGE": {
        // Candle ranges. The setups (narrowest of the last n, inside bar) are read on the PREVIOUS completed candle, so
        // this candle can be the breakout they set up; range vs ATR is this candle's own.
        const nn = Math.max(2, Math.trunc(p.n ?? 7)), kk = Number(p.k ?? 1.5), len = Math.max(2, Math.trunc(p.len ?? 14));
        const rg = M("RANGE", () => b.map((x) => x.h - x.l)), a = M(`ATR${len}`, () => atr(b, len));
        check = (k) => {
          if (c.op === "nr_n") { if (k - 1 < nn) return false; const r0 = rg[k - 1]; for (let j = k - nn; j < k - 1; j++) if (rg[j] <= r0) return false; return true; }
          if (c.op === "inside_bar") return k >= 2 && b[k - 1].h <= b[k - 2].h && b[k - 1].l >= b[k - 2].l;
          if (c.op === "range_gt_atr") return ok(a[k]) && rg[k] > kk * a[k];
          if (c.op === "range_lt_atr") return ok(a[k]) && rg[k] < kk * a[k];
          return false;
        };
        break;
      }
      case "PIV": {
        // Pivot points from the previous day's (src 0) or week's (src 1) high / low / close: classic (kind 0) PP, R1, S1
        // (R2 / R3, S2 / S3 for the level maths), Camarilla (kind 1) H3 / H4 / L3 / L4 standing in for R1 / R2 / S1 / S2,
        // and the central pivot range (PP, BC, TC) whose width is judged against its 20-period median.
        // Honest note: pivot levels are folklore (self-fulfilling at best); a narrow CPR is a range-contraction measure.
        const week = Number(p.src) === 1, cam = Number(p.kind) === 1, kw = Number(p.k ?? 0.5);
        const src: DayBar[] = week ? MD("WEEKLY", () => weeklyBars(this.daily)) : this.daily;
        const lv = MD(`PIVLV|${week ? "W" : "D"}|${cam ? 1 : 0}`, () => {
          const L = src.map((d) => pivotLevels(d, cam));
          const med = new Array<number>(src.length).fill(NaN);
          for (let j = PIV_LOOK; j < src.length; j++) { const w = L.slice(j - PIV_LOOK, j).map((x) => x.w).sort((x, y) => x - y); med[j] = w[w.length >> 1]; }
          return { L, med };
        });
        const keyOf = (k: number, day: string) => { const d = frame.isDaily ? b[k].day : day; return week ? mondayOf(d) : d; };
        const at = (k: number, day: string) => { const j = RuleBook.prevIdx(src, keyOf(k, day)); return j < 0 ? null : { j, L: lv.L[j] }; };
        check = (k, _T, day) => {
          const x = at(k, day); if (!x) return false;
          const { L } = x, sd = sameDay(k);
          switch (c.op) {
            case "above_pp": return close[k] > L.pp; case "below_pp": return close[k] < L.pp;
            case "cross_up_pp": return close[k] > L.pp && (!sd || close[k - 1] <= L.pp); case "cross_down_pp": return close[k] < L.pp && (!sd || close[k - 1] >= L.pp);
            case "above_r1": return close[k] > L.r1; case "below_s1": return close[k] < L.s1;
            case "cross_up_r1": return close[k] > L.r1 && (!sd || close[k - 1] <= L.r1); case "cross_down_s1": return close[k] < L.s1 && (!sd || close[k - 1] >= L.s1);
            case "cpr_narrow": return ok(lv.med[x.j]) && L.w < kw * lv.med[x.j]; case "cpr_wide": return ok(lv.med[x.j]) && L.w > kw * lv.med[x.j];
            default: return false;
          }
        };
        level = (k, _T, day) => { const x = at(k, day); if (!x) return null; return /r1/.test(c.op) ? x.L.r1 : /s1/.test(c.op) ? x.L.s1 : /pp/.test(c.op) ? x.L.pp : null; };
        break;
      }
      case "FIB": {
        // Fibonacci retracements of the last completed swing (swings from the zigzag or fractal detector, see
        // indicators.swings). Honest note: the ratios are folklore — tests find them no better than random levels; what
        // can be real is "a pullback in a trend", so the test is made fair: a tolerance in ATR units, a confirmation
        // candle (closes back in the swing's direction), and a limit fill at the level in the backtester (fill: "LEVEL").
        const mode = Math.trunc(p.mode ?? 0), kk = Number(p.k ?? 2), nn = Math.max(2, Math.trunc(p.n ?? 5)), tol = Number(p.tol ?? 0.2);
        const sw = M(`SW${mode},${kk},${nn}`, () => swings(b, mode, kk, nn, 14)), a = M("ATR14", () => atr(b, 14));
        const R: Record<string, number> = { pullback_to_382: 0.382, pullback_to_50: 0.5, pullback_to_618: 0.618, rally_to_382: 0.382, rally_to_50: 0.5, rally_to_618: 0.618 };
        const lvl = (s: Swing, r: number) => s.dir === 1 ? s.hi - r * (s.hi - s.lo) : s.lo + r * (s.hi - s.lo);
        const swingAt = (k: number): Swing | null => { const j = sw.last[k]; return j < 0 ? null : sw.list[j]; };
        check = (k) => {
          const s = swingAt(k); if (!s) return false;
          const x = b[k], t = tol * a[k];
          if (!(t >= 0)) return false;
          if (c.op in R) {
            const bull = c.op.startsWith("pullback");
            if (s.dir !== (bull ? 1 : -1)) return false;
            const L = lvl(s, R[c.op]);
            return bull ? x.l <= L + t && x.c >= L - t && x.c > x.o && x.c > s.lo && x.c < s.hi
              : x.h >= L - t && x.c <= L + t && x.c < x.o && x.c < s.hi && x.c > s.lo;
          }
          if (c.op === "in_zone_bull") return s.dir === 1 && x.c <= lvl(s, 0.382) && x.c >= lvl(s, 0.618);
          if (c.op === "in_zone_bear") return s.dir === -1 && x.c >= lvl(s, 0.382) && x.c <= lvl(s, 0.618);
          if (c.op === "broke_down_786") return s.dir === 1 && x.c < lvl(s, 0.786);
          if (c.op === "broke_up_786") return s.dir === -1 && x.c > lvl(s, 0.786);
          return false;
        };
        level = (k) => { const s = swingAt(k); const r = R[c.op]; return s && r != null ? lvl(s, r) : null; };
        break;
      }
      case "GAP": {
        // Today's open against the previous close, in units of the daily ATR(14): gap up / down beyond k ATRs; filled =
        // the price has since traded back through the previous close; held = after the first `mins` minutes the price
        // had stayed beyond the previous close. Intraday candles only (the open comes from this frame's first candle).
        if (frame.isDaily) break;
        const kk = Number(p.k ?? 1), mins = Math.max(1, Math.trunc(p.mins ?? 15)), daily = this.daily;
        const dATR = MD("ATR14", () => atr(daily, 14));
        const dayStart = M("DAYSTART", () => { const m = new Map<string, number>(); b.forEach((x, i) => { if (!m.has(x.day)) m.set(x.day, i); }); return m; });
        check = (k, T, day) => {
          const j = RuleBook.prevIdx(daily, day); if (j < 0 || !(dATR[j] > 0)) return false;
          const pc = daily[j].c, i0 = dayStart.get(b[k].day); if (i0 == null) return false;
          const gap = (b[i0].o - pc) / dATR[j];
          if (c.op === "gap_up_gt") return gap > kk;
          if (c.op === "gap_dn_gt") return -gap > kk;
          if (c.op === "gap_filled") {
            if (gap === 0) return false;
            for (let i = i0; i <= k; i++) if (gap > 0 ? b[i].l <= pc : b[i].h >= pc) return true;
            return false;
          }
          if (c.op === "gap_held") {
            const open = sessionFor(this.seg, day).open;
            if (ist(T).min < open + mins || gap === 0) return false;
            const rows = (this.baseByDay.get(day) ?? []).filter((r) => r.min >= open && r.min < open + mins);
            return rows.length > 0 && (gap > 0 ? rows.every((r) => r.l > pc) : rows.every((r) => r.h < pc));
          }
          return false;
        };
        break;
      }
      case "PDHL": {
        // Previous trading day's high/low from daily candles; price from this condition's timeframe.
        const daily = this.daily;
        const prevDay = (day: string) => { let j = -1; for (let i = daily.length - 1; i >= 0; i--) if (daily[i].day < day) { j = i; break; } return j >= 0 ? daily[j] : null; };
        let cacheDay = "", pd: DayBar | null = null;
        const get = (day: string) => { if (day !== cacheDay) { cacheDay = day; pd = prevDay(day); } return pd; };
        check = (k, _T, day) => {
          // On daily candles compare the candle with the day before it; intraday, with the day before today.
          const d = get(frame.isDaily ? b[k].day : day); if (!d) return false;
          const sd = sameDay(k);
          return c.op === "above_pdh" ? close[k] > d.h : c.op === "below_pdl" ? close[k] < d.l
            : c.op === "cross_above_pdh" ? close[k] > d.h && (!sd || close[k - 1] <= d.h)
            : c.op === "cross_below_pdl" ? close[k] < d.l && (!sd || close[k - 1] >= d.l) : false;
        };
        level = (k, _T, day) => { const d = get(frame.isDaily ? b[k].day : day); return d ? (/pdh/.test(c.op) ? d.h : d.l) : null; };
        break;
      }
      case "SWEEP": {
        // Liquidity sweep: price runs beyond a level where stops sit (the highest high / lowest low of the last N candles,
        // or the previous day's high / low) and the candle closes back on the other side of it. "within" keeps the
        // signal alive for that many candles after the sweep.
        const len = Math.max(2, Math.trunc(p.len ?? 20)), within = Math.max(1, Math.trunc(p.within ?? 1)), prevDaySrc = Number(p.src) === 1;
        const lv = prevDaySrc ? null : M(`SWLV${len}`, () => {
          const hi = new Array(b.length).fill(NaN), lo = new Array(b.length).fill(NaN);
          for (let k = len; k < b.length; k++) {
            let h = -Infinity, l = Infinity;
            for (let j = k - len; j < k; j++) { if (b[j].h > h) h = b[j].h; if (b[j].l < l) l = b[j].l; }
            hi[k] = h; lo[k] = l;
          }
          return { hi, lo };
        });
        const daily = this.daily;
        const prevOf = (day: string) => { let j = -1; for (let i = daily.length - 1; i >= 0; i--) if (daily[i].day < day) { j = i; break; } return j >= 0 ? daily[j] : null; };
        const pdCache = new Map<string, DayBar | null>();
        const pd = (day: string) => { if (!pdCache.has(day)) pdCache.set(day, prevOf(day)); return pdCache.get(day)!; };
        const swept = (j: number): number => { // 1 = lows swept (bullish), -1 = highs swept (bearish), 0 = none
          let H: number, L: number;
          if (prevDaySrc) { const d = pd(b[j].day); if (!d) return 0; H = d.h; L = d.l; }
          else { H = lv!.hi[j]; L = lv!.lo[j]; if (isNaN(H) || isNaN(L)) return 0; }
          const bull = b[j].l < L && b[j].c > L, bear = b[j].h > H && b[j].c < H;
          return bull && !bear ? 1 : bear && !bull ? -1 : 0;
        };
        const want = c.op === "bull_sweep" ? 1 : c.op === "bear_sweep" ? -1 : 0;
        check = (k) => {
          if (!want) return false;
          for (let j = k; j >= Math.max(1, k - within + 1); j--) {
            if (!frame.isDaily && prevDaySrc && b[j].day !== b[k].day) break; // a previous-day sweep counts on its own day only
            if (swept(j) === want) return true;
          }
          return false;
        };
        break;
      }
      case "DON": {
        // Donchian channel: highest high / lowest low of the previous N candles (not counting this one).
        const len = Math.max(2, Math.trunc(p.len ?? 20));
        const ch = M(`DON${len}`, () => {
          const hi = new Array(b.length).fill(NaN), lo = new Array(b.length).fill(NaN);
          for (let k = len; k < b.length; k++) { let h = -Infinity, l = Infinity; for (let j = k - len; j < k; j++) { if (b[j].h > h) h = b[j].h; if (b[j].l < l) l = b[j].l; } hi[k] = h; lo[k] = l; }
          return { hi, lo };
        });
        check = (k) => {
          const h = ch.hi[k], l = ch.lo[k]; if (isNaN(h) || isNaN(l)) return false;
          return c.op === "new_high" ? close[k] > h : c.op === "new_low" ? close[k] < l : c.op === "above_mid" ? close[k] > (h + l) / 2 : c.op === "below_mid" ? close[k] < (h + l) / 2 : false;
        };
        level = (k) => { const h = ch.hi[k], l = ch.lo[k]; return isNaN(h) || isNaN(l) ? null : c.op === "new_high" ? h : c.op === "new_low" ? l : (h + l) / 2; };
        break;
      }
      case "VOL": {
        // Volatility regime: standard deviation of the last N returns against its median over a longer look-back.
        const len = Math.max(5, Math.trunc(p.len ?? 20)), look = Math.max(20, Math.trunc(p.look ?? 250));
        const reg = M(`VOL${len},${look}`, () => {
          const r = close.map((x, i) => i ? Math.log(x / close[i - 1]) : NaN);
          const sd = new Array(b.length).fill(NaN);
          for (let k = len; k < b.length; k++) { let m = 0; for (let j = k - len + 1; j <= k; j++) m += r[j]; m /= len; let q = 0; for (let j = k - len + 1; j <= k; j++) q += (r[j] - m) ** 2; sd[k] = Math.sqrt(q / (len - 1)); }
          const med = new Array(b.length).fill(NaN);
          for (let k = len + look; k < b.length; k++) { const w = sd.slice(k - look, k).filter((x) => !isNaN(x)).sort((x, y) => x - y); if (w.length) med[k] = w[w.length >> 1]; }
          return { sd, med };
        });
        check = (k) => ok(reg.sd[k], reg.med[k]) && (c.op === "high_vol" ? reg.sd[k] > reg.med[k] : c.op === "low_vol" ? reg.sd[k] < reg.med[k] : false);
        break;
      }
      case "TIME": {
        // Hour of day (IST) at the decision time, or the day of the week.
        const from = Number(p.from ?? 0) * 60, to = Number(p.to ?? 24) * 60, wd = Number(p.d ?? 5);
        check = (_k, T, day) => {
          const m = ist(T - 1).min, w = weekdayOf(day);
          return c.op === "in_hours" ? (from <= to ? m >= from && m < to : m >= from || m < to)
            : c.op === "on_weekday" ? w === wd : c.op === "not_weekend" ? w >= 1 && w <= 5 : false;
        };
        break;
      }
      case "VIX": {
        // India VIX (its own frame, see frameFor): level, direction, or percentile of the last `look` candles.
        const n = Math.max(1, Math.trunc(p.n ?? 5)), look = Math.max(20, Math.trunc(p.look ?? 250));
        const pr = /pctile/.test(c.op) ? M(`VIXPCT${look}`, () => pctRank(close, look)) : null;
        check = (k) => c.op === "vix_gt" ? above(close, v, k) : c.op === "vix_lt" ? below(close, v, k)
          : c.op === "vix_rising" ? k >= n && ok(close[k], close[k - n]) && close[k] > close[k - n]
          : c.op === "vix_pctile_gt" ? !!pr && ok(pr[k]) && pr[k] > v : c.op === "vix_pctile_lt" ? !!pr && ok(pr[k]) && pr[k] < v : false;
        break;
      }
      case "FX": case "USDPX": {
        // FX = USD/INR itself; USDPX = this asset in dollars (see frameFor). Direction over n candles, above / below its
        // `len`-candle average, % change over n candles above / below v. USDPX also splits the rupee move of the last n
        // candles: share of it that came from USD/INR (log terms) above / below v % — "the rupee is carrying this move".
        const n = Math.max(1, Math.trunc(p.n ?? 5)), len = Math.max(2, Math.trunc(p.len ?? 20));
        const pre = c.ind === "FX" ? "fx_" : "usd_", op = c.op.startsWith(pre) ? c.op.slice(pre.length) : c.op;
        const av = /sma$/.test(op) ? M(`SMA${len}`, () => sma(close, len)) : null;
        const chg = (k: number) => k >= n && ok(close[k], close[k - n]) && close[k - n] > 0 ? (close[k] / close[k - n] - 1) * 100 : NaN;
        const share = (k: number) => {
          if (c.ind !== "USDPX" || k < n) return NaN;
          const x = b[k] as unknown as { rc: number; f: number }, y = b[k - n] as unknown as { rc: number; f: number };
          if (!(x.rc > 0 && y.rc > 0 && x.f > 0 && y.f > 0)) return NaN;
          const tot = Math.log(x.rc / y.rc), fxm = Math.log(x.f / y.f);
          return Math.abs(tot) < 1e-9 ? NaN : fxm / tot * 100;
        };
        check = (k) => op === "rising" ? k >= n && ok(close[k], close[k - n]) && close[k] > close[k - n]
          : op === "falling" ? k >= n && ok(close[k], close[k - n]) && close[k] < close[k - n]
          : op === "above_sma" ? !!av && above(close, av, k) : op === "below_sma" ? !!av && below(close, av, k)
          : op === "chg_gt" ? ok(chg(k)) && chg(k) > v : op === "chg_lt" ? ok(chg(k)) && chg(k) < v
          : op === "fx_share_gt" ? ok(share(k)) && share(k) > v : op === "fx_share_lt" ? ok(share(k)) && share(k) < v : false;
        break;
      }
      case "CAL": {
        // The calendar: expiry days (the strategy's own expiry rule: `wd` / `monthly` on the condition, else the rule
        // book's ext.expiry, else unknown → false), days to the next expiry, the turn of the month (last `a` / first `b`
        // trading days, from the daily candles' trading-day count; days still to come counted from the weekday calendar
        // and the holidays the engine knows), and market-event days ± n (table market_events; none known → false).
        const exp = p.wd != null ? { weekday: Math.trunc(p.wd), monthly: Number(p.monthly ?? 1) === 1, underlying: this.ext.expiry?.underlying ?? "" } : this.ext.expiry ?? null;
        const isExp = (day: string) => !!exp && (exp.monthly ? isLastWeekdayOfMonth(day, exp.weekday) : weekdayOf(day) === weeklyExpiryWeekday(exp.underlying, day, exp.weekday));
        const a = Math.max(1, Math.trunc(p.a ?? 2)), bb = Math.max(1, Math.trunc(p.b ?? 3)), nEv = Math.max(0, Math.trunc(p.n ?? 0));
        const daily = this.daily, seg = this.seg;
        const events = this.ext.events ?? marketEvents();
        check = (_k, _T, day) => {
          switch (c.op) {
            case "is_expiry_day": return isExp(day);
            case "not_expiry_day": return !!exp && !isExp(day);
            case "days_to_expiry_lt": { if (!exp) return false; const e = nextExpiryFrom(day, exp.underlying, exp.weekday, exp.monthly); return (Date.parse(e) - Date.parse(day)) / 86400000 < v; }
            case "turn_of_month": {
              const mo = day.slice(0, 7), j = RuleBook.prevIdx(daily, day);
              let before = 0; for (let i = j; i >= 0 && daily[i].day.slice(0, 7) === mo; i--) before++; // trading days of this month before today
              if (before < bb) return true; // one of the first b trading days (today is day before+1)
              // Trading days still to come this month: the daily candles where they exist (a backtest), the weekday
              // calendar less the known holidays beyond them (the live edge).
              const lastKnown = daily.length ? daily[daily.length - 1].day : "";
              let after = 0;
              for (let i = j + 1; i < daily.length && daily[i].day.slice(0, 7) === mo; i++) if (daily[i].day > day) after++;
              if (!(lastKnown > day) || lastKnown.slice(0, 7) === mo) after += tradingDaysLeftInMonth(lastKnown > day ? lastKnown : day, seg);
              return after < a; // one of the last a trading days
            }
            case "event_day": { if (!events.size) return false; for (let d = -nEv; d <= nEv; d++) if (events.has(addDays(day, d))) return true; return false; }
            default: return false;
          }
        };
        break;
      }
      case "DIV": {
        // Divergence between price and RSI / MACD over the last two swings of the same kind (the swing detector of the
        // Fibonacci conditions): bullish = price made a lower low while the indicator made a higher low; bearish = a
        // higher high with a lower indicator high. Known when the second swing completes; alive `within` candles after.
        const mode = Math.trunc(p.mode ?? 0), kk = Number(p.k ?? 2), nn = Math.max(2, Math.trunc(p.n ?? 5)), within = Math.max(1, Math.trunc(p.within ?? 3));
        const sw = M(`SW${mode},${kk},${nn}`, () => swings(b, mode, kk, nn, 14));
        const ind = c.op.startsWith("macd") ? M(`MACD${p.fast ?? 12},${p.slow ?? 26},${p.sig ?? 9}`, () => macd(close, p.fast ?? 12, p.slow ?? 26, p.sig ?? 9)).line : M(`RSI${p.len ?? 14}`, () => rsi(close, p.len ?? 14));
        const bull = /bull/.test(c.op);
        check = (k) => {
          const j = sw.last[k]; if (j < 1) return false;
          const s2 = sw.list[j], s1 = sw.list[j - 1];
          if (k < s2.at || k >= s2.at + within) return false;
          if (bull) { if (s2.dir !== -1 || s1.dir !== 1) return false; return s2.lo < s1.lo && ok(ind[s2.iLo], ind[s1.iLo]) && ind[s2.iLo] > ind[s1.iLo]; }
          if (s2.dir !== 1 || s1.dir !== -1) return false;
          return s2.hi > s1.hi && ok(ind[s2.iHi], ind[s1.iHi]) && ind[s2.iHi] < ind[s1.iHi];
        };
        break;
      }
      case "BTC": {
        // Bitcoin's own trend as a filter (for other coins): yesterday's daily close against its EMA.
        const btc = this.ext.btc ?? this.daily, len = Math.max(2, Math.trunc(p.len ?? 50));
        const e = M(`BTCEMA${len}|${btc.length}`, () => ema(btc.map((x) => x.c), len));
        check = (_k, _T, day) => {
          let j = -1, lo = 0, hi = btc.length - 1;
          while (lo <= hi) { const m = (lo + hi) >> 1; if (btc[m].day < day) { j = m; lo = m + 1; } else hi = m - 1; }
          if (j < 1 || isNaN(e[j])) return false;
          return c.op === "btc_up" ? btc[j].c > e[j] : c.op === "btc_down" ? btc[j].c < e[j] : false;
        };
        break;
      }
      case "FUND": {
        // Perpetual funding rate (% per 8 hours) of the previous day; unknown days (before Delta's history) are false.
        const f = this.ext.funding;
        check = (_k, _T, day) => {
          const x = f?.get(addDays(day, -1)); if (x === undefined) return false;
          return c.op === "gt" ? x > v : c.op === "lt" ? x < v : false;
        };
        break;
      }
      case "OI": {
        // Open interest (futures), against n candles ago; with the price move: OI up and price up = long build-up, OI up
        // and price down = short build-up. Candles without open interest (indices, shares, older stored files) never match.
        const n = Math.max(1, Math.trunc(p.n ?? 5));
        const oi = M("OI", () => b.map((x) => x.oi == null ? NaN : Number(x.oi)));
        check = (k) => {
          if (k < n || !ok(oi[k], oi[k - n]) || !(oi[k] > 0 && oi[k - n] > 0)) return false;
          const up = oi[k] > oi[k - n];
          return c.op === "oi_rising" ? up : c.op === "oi_falling" ? oi[k] < oi[k - n]
            : c.op === "oi_up_price_up" ? up && close[k] > close[k - n] : c.op === "oi_up_price_down" ? up && close[k] < close[k - n] : false;
        };
        break;
      }
      case "ORB": {
        // High/low of the first N minutes after the session opens, from base candles; usable once that window has passed.
        const mins = p.mins ?? 15;
        const range = new Map<string, { h: number; l: number } | null>();
        const orFor = (day: string) => {
          if (!range.has(day)) {
            const open = sessionFor(this.seg, day).open;
            const rows = (this.baseByDay.get(day) ?? []).filter((r) => r.min >= open && r.min < open + mins);
            range.set(day, rows.length ? { h: Math.max(...rows.map((r) => r.h)), l: Math.min(...rows.map((r) => r.l)) } : null);
          }
          return range.get(day)!;
        };
        check = (k, T, day) => {
          const open = sessionFor(this.seg, day).open, m = ist(T).min;
          if (m < open + mins || frame.isDaily) return false;
          const r = orFor(day); if (!r) return false;
          const sd = sameDay(k);
          return c.op === "above_orh" ? close[k] > r.h : c.op === "below_orl" ? close[k] < r.l
            : c.op === "cross_above_orh" ? close[k] > r.h && (!sd || close[k - 1] <= r.h)
            : c.op === "cross_below_orl" ? close[k] < r.l && (!sd || close[k - 1] >= r.l) : false;
        };
        level = (_k, _T, day) => { const r = orFor(day); return r ? (/orh/.test(c.op) ? r.h : r.l) : null; };
        break;
      }
    }
    return { frame, check, level };
  }

  /**
   * The limit price for a "LEVEL" fill of an entry set at decision time T: the level of the set's first condition that
   * names one (Fibonacci retracement, pivot, previous-day high / low, opening range, Donchian, Bollinger / Keltner band,
   * moving average, VWAP); null when none does.
   */
  levelFor(side: "long" | "short", T: number): number | null {
    const r = side === "long" ? this.rules.long : this.rules.short;
    if (!has(r)) return null;
    const day = ist(T - 1).date;
    for (const c of r!.conds) {
      const x = this.checks.get(c); if (!x?.level) continue;
      const k = this.latest(x.frame, T, day);
      if (k < 1) continue;
      const L = x.level(k, T, day);
      if (L != null && L > 0) return L;
    }
    return null;
  }

  /** Index of the latest candle of a frame completed by time T (daily: the last full day before today). */
  private latest(frame: Frame, T: number, day: string): number {
    const bars = frame.bars;
    let lo = 0, hi = bars.length - 1, k = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const done = frame.weekly ? (bars[m] as DayBar).day < mondayOf(day) : frame.isDaily ? (bars[m] as DayBar).day < day : (bars[m] as Bar).endT <= T;
      if (done) { k = m; lo = m + 1; } else hi = m - 1;
    }
    return k;
  }

  private evalSet(r: RuleSet | undefined, T: number, day: string): boolean | null {
    if (!has(r)) return null;
    const res = r!.conds.map((c) => {
      const { frame, check } = this.checks.get(c)!;
      const k = this.latest(frame, T, day);
      return (k >= 1 || ((c.ind === "TIME" || c.ind === "FUND" || c.ind === "BTC" || c.ind === "CAL") && k >= 0)) && check(Math.max(k, 0), T, day);
    });
    return r!.mode === "ANY" ? res.some(Boolean) : res.every(Boolean);
  }

  /** All four rule sets at decision time T (epoch seconds, the close of a candle of the strategy's timeframe). */
  at(T: number): Signals {
    const day = ist(T - 1).date;
    return {
      long: this.evalSet(this.rules.long, T, day) ?? false,
      short: this.evalSet(this.rules.short, T, day) ?? false,
      exitLong: this.evalSet(this.rules.exitLong, T, day),
      exitShort: this.evalSet(this.rules.exitShort, T, day),
    };
  }
}

/**
 * What to do at a decision point. Entries need the rule set to have just become true ("fresh", the default)
 * or merely to be true ("join"). A long is closed by the exit-long rules if given; otherwise by the sell rules
 * (and reversed into a short); with neither, as soon as the buy rules stop being true. Shorts mirror this.
 */
export function decide(pos: "FLAT" | Side, now: Signals, prev: Signals | null, cfg: {
  join: boolean; longOk: boolean; shortOk: boolean; sets: ReturnType<typeof ruleSets>;
}): { exit: boolean; enter: Side | null; why: string } {
  const fresh = (cur: boolean, before: boolean | undefined) => cur && (cfg.join || !before);
  const longNow = cfg.sets.long && cfg.longOk && now.long && !now.short;
  const shortNow = cfg.sets.short && cfg.shortOk && now.short && !now.long;
  if (pos === "LONG") {
    if (now.exitLong === true) return { exit: true, enter: null, why: "Exit-long rules met" };
    if (shortNow) return { exit: true, enter: "SHORT", why: "Sell rules met: reversing" };
    if (!cfg.sets.exitLong && !cfg.sets.short && !now.long) return { exit: true, enter: null, why: "Buy rules no longer true" };
    return { exit: false, enter: null, why: "" };
  }
  if (pos === "SHORT") {
    if (now.exitShort === true) return { exit: true, enter: null, why: "Exit-short rules met" };
    if (longNow) return { exit: true, enter: "LONG", why: "Buy rules met: reversing" };
    if (!cfg.sets.exitShort && !cfg.sets.long && !now.short) return { exit: true, enter: null, why: "Sell rules no longer true" };
    return { exit: false, enter: null, why: "" };
  }
  if (longNow && fresh(now.long, prev?.long)) return { exit: false, enter: "LONG", why: "Buy rules met" };
  if (shortNow && fresh(now.short, prev?.short)) return { exit: false, enter: "SHORT", why: "Sell rules met" };
  return { exit: false, enter: null, why: "" };
}

/** Validates a rule book from the strategy form / database. */
export function validateRules(r: unknown): Rules {
  const rules = (r ?? {}) as Rules;
  const IND = new Set(["ST", "HA", "RSI", "EMA", "SMA", "MACD", "VWAP", "BB", "ADX", "ATR", "PDHL", "ORB", "SWEEP", "DON", "VOL", "TIME", "BTC", "FUND", "HAS", "OI",
    "PIV", "FIB", "GAP", "RANGE", "KC", "CAL", "VIX", "DIV", "FX", "USDPX"]);
  const TF = new Set(["base", "1", "3", "5", "15", "25", "30", "45", "60", "75", "120", "125", "240", "D", "W"]);
  for (const k of ["long", "short", "exitLong", "exitShort"] as const) {
    const set = rules[k];
    if (!set) continue;
    if (!["ALL", "ANY"].includes(set.mode) || !Array.isArray(set.conds) || set.conds.length > 6) throw new Error("Each rule set holds up to 6 conditions.");
    for (const c of set.conds) {
      if (!IND.has(c.ind) || !TF.has(String(c.tf)) || typeof c.op !== "string") throw new Error(`Unsupported condition: ${JSON.stringify(c).slice(0, 80)}`);
    }
    if (set.fill !== undefined && set.fill !== "CLOSE" && set.fill !== "LEVEL") throw new Error("An entry fills at the close or as a limit order at the level.");
    if (set.fill === "LEVEL" && (k === "exitLong" || k === "exitShort")) throw new Error("A limit-at-level fill applies to entries only.");
    if (set.fill === "LEVEL" && rules.daily) throw new Error("A limit-at-level fill needs intraday candles; a once-a-day strategy fills at the open.");
  }
  if (!has(rules.long) && !has(rules.short)) throw new Error("Add at least one Buy or Sell condition.");
  if (rules.candles !== undefined && rules.candles !== "NORMAL" && rules.candles !== "HA") throw new Error("Candle type must be normal or Heikin Ashi.");
  if (rules.daily) {
    for (const c of allConds(rules)) {
      if (c.tf !== "D" && c.tf !== "W") throw new Error("A once-a-day strategy uses daily (or weekly) candles only; set every condition's timeframe to Daily or Weekly.");
      if (c.ind === "VWAP" || c.ind === "ORB" || c.ind === "GAP") throw new Error("VWAP, opening range and opening gap need intraday candles, so they can't be used in a once-a-day strategy.");
    }
  }
  return rules;
}

export { tm as timeOfDay };
