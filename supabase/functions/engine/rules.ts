// Condition-based strategies: "When Supertrend is up on 60m AND RSI(14) on 15m is above 60 → buy".
// A strategy has up to four rule sets (buy, sell, exit long, exit short); each set holds conditions combined
// with ALL (every condition true) or ANY (at least one true). Conditions are checked when a candle of the
// strategy's own timeframe closes, against the latest COMPLETED candle of each condition's timeframe, so a
// backtest never looks ahead.
import { adx, atr, bollinger, ema, macd, rsi, sma, vwap } from "./indicators.ts";
import { type Bar, type DayBar, heikinAshi, ist, sessionFor, supertrend } from "./logic.ts";

export type Cond = { ind: string; tf: string; p?: Record<string, number>; op: string; v?: number };
export type RuleSet = { mode: "ALL" | "ANY"; conds: Cond[] };
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
const REAL_PRICE = new Set(["VWAP", "PDHL", "ORB"]);
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
    if (c.ind === "PDHL") daily = true;
    if (c.tf === "D") daily = true;
    else tfs.add(c.tf === "base" ? baseTf : Number(c.tf));
  }
  return { intraday: [...tfs].filter((x) => x > 0).sort((a, b) => a - b), daily };
}

/** Longest look-back any condition needs, in candles (Supertrend/HA get 500 to settle like the chart). */
export function warmBarsFor(r: Rules): number {
  let n = 300;
  for (const c of allConds(r)) {
    const p = c.p ?? {};
    const len = Math.max(p.len ?? 0, p.len2 ?? 0, p.slow ?? 0, (p.slow ?? 0) + (p.sig ?? 0), p.atr ?? 0);
    n = Math.max(n, c.ind === "ST" || c.ind === "HA" ? 500 : len * 10 + 50);
  }
  return Math.min(n, 1500);
}

const tm = (x: string) => { const [h, m] = x.split(":").map(Number); return h * 60 + m; };

/** Human-readable text for one condition (used in logs and the trade list). */
export function describeCond(c: Cond): string {
  const p = c.p ?? {};
  const tf = c.tf === "D" ? "daily" : c.tf === "base" ? "own timeframe" : `${c.tf}m`;
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
  };
  const name: Record<string, string> = {
    ST: `Supertrend(${p.atr ?? 10},${p.factor ?? 3})`, HA: "Heikin Ashi", RSI: `RSI(${p.len ?? 14})`,
    EMA: p.len2 ? `EMA(${p.len ?? 9}/${p.len2})` : `EMA(${p.len ?? 20})`, SMA: p.len2 ? `SMA(${p.len ?? 9}/${p.len2})` : `SMA(${p.len ?? 20})`,
    MACD: `MACD(${p.fast ?? 12},${p.slow ?? 26},${p.sig ?? 9})`, VWAP: "VWAP", BB: `Bollinger(${p.len ?? 20},${p.mult ?? 2})`,
    ADX: `ADX(${p.len ?? 14})`, ATR: `ATR(${p.len ?? 14})`, PDHL: "Prev-day H/L", ORB: `Opening range (${p.mins ?? 15}m)`,
  };
  return `${name[c.ind] ?? c.ind} ${tf} ${ops[c.op] ?? c.op}`;
}

type Frame = { bars: (Bar | DayBar)[]; isDaily: boolean };
type Check = (k: number, T: number, day: string) => boolean;

/**
 * Builds a fast evaluator for a rule book over prepared candle frames.
 *  frames: intraday candles per timeframe (minutes) plus optional daily candles; base: raw base candles grouped by day (for opening range).
 */
export class RuleBook {
  private checks = new Map<Cond, { frame: Frame; check: Check }>();
  private rules: Rules;
  private baseTf: number;
  private frames: Map<number, Bar[]>;
  private daily: DayBar[];
  private baseByDay: Map<string, { min: number; h: number; l: number }[]>;
  private seg: string;
  private memo: Map<string, unknown>;
  /** memo: optional cache of indicator series shared by many rule books on the same candles (the strategy lab). */
  constructor(rules: Rules, baseTf: number, frames: Map<number, Bar[]>, daily: DayBar[],
    baseByDay: Map<string, { min: number; h: number; l: number }[]>, seg: string, memo?: Map<string, unknown>) {
    this.rules = rules; this.baseTf = baseTf; this.frames = frames; this.daily = daily; this.baseByDay = baseByDay; this.seg = seg;
    this.memo = memo ?? new Map();
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
    if (c.tf === "D") return { bars: conv("D", this.daily), isDaily: true, ha };
    const tf = c.tf === "base" ? this.baseTf : Number(c.tf);
    const bars = this.frames.get(tf);
    if (!bars) throw new Error(`No ${tf}-minute candles prepared for "${describeCond(c)}".`);
    return { bars: conv(String(tf), bars), isDaily: false, ha };
  }

  private build(c: Cond): { frame: Frame; check: Check } {
    const frame = this.frameFor(c);
    const b = frame.bars as (Bar & DayBar)[];
    const fk = (frame.ha ? "HA:" : "") + (c.tf === "D" ? "D" : String(c.tf === "base" ? this.baseTf : Number(c.tf)));
    const M = <T>(name: string, fn: () => T): T => {
      const key = `${fk}|${b.length}|${name}`;
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
    let check: Check = () => false;
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
        check = (k) => c.op === "price_above" ? above(close, w, k) : c.op === "price_below" ? below(close, w, k)
          : c.op === "price_cross_above" ? xUp(close, w, k) && b[k - 1].day === b[k].day
          : c.op === "price_cross_below" ? xDn(close, w, k) && b[k - 1].day === b[k].day : false;
        break;
      }
      case "BB": {
        const bb = M(`BB${p.len ?? 20},${p.mult ?? 2}`, () => bollinger(close, p.len ?? 20, p.mult ?? 2));
        check = (k) => ({
          close_above_upper: () => above(close, bb.upper, k), close_below_lower: () => below(close, bb.lower, k),
          cross_above_upper: () => xUp(close, bb.upper, k), cross_below_lower: () => xDn(close, bb.lower, k),
          price_above_mid: () => above(close, bb.basis, k), price_below_mid: () => below(close, bb.basis, k),
        } as Record<string, () => boolean>)[c.op]?.() ?? false;
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
          const sameDay = k > 0 && b[k - 1].day === b[k].day;
          return c.op === "above_pdh" ? close[k] > d.h : c.op === "below_pdl" ? close[k] < d.l
            : c.op === "cross_above_pdh" ? close[k] > d.h && (!sameDay || close[k - 1] <= d.h)
            : c.op === "cross_below_pdl" ? close[k] < d.l && (!sameDay || close[k - 1] >= d.l) : false;
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
          const sameDay = k > 0 && b[k - 1].day === b[k].day;
          return c.op === "above_orh" ? close[k] > r.h : c.op === "below_orl" ? close[k] < r.l
            : c.op === "cross_above_orh" ? close[k] > r.h && (!sameDay || close[k - 1] <= r.h)
            : c.op === "cross_below_orl" ? close[k] < r.l && (!sameDay || close[k - 1] >= r.l) : false;
        };
        break;
      }
    }
    return { frame, check };
  }

  /** Index of the latest candle of a frame completed by time T (daily: the last full day before today). */
  private latest(frame: Frame, T: number, day: string): number {
    const bars = frame.bars;
    let lo = 0, hi = bars.length - 1, k = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      const done = frame.isDaily ? (bars[m] as DayBar).day < day : (bars[m] as Bar).endT <= T;
      if (done) { k = m; lo = m + 1; } else hi = m - 1;
    }
    return k;
  }

  private evalSet(r: RuleSet | undefined, T: number, day: string): boolean | null {
    if (!has(r)) return null;
    const res = r!.conds.map((c) => {
      const { frame, check } = this.checks.get(c)!;
      const k = this.latest(frame, T, day);
      return k >= 1 && check(k, T, day);
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
  const IND = new Set(["ST", "HA", "RSI", "EMA", "SMA", "MACD", "VWAP", "BB", "ADX", "ATR", "PDHL", "ORB"]);
  const TF = new Set(["base", "1", "3", "5", "15", "25", "30", "60", "75", "120", "125", "240", "D"]);
  for (const k of ["long", "short", "exitLong", "exitShort"] as const) {
    const set = rules[k];
    if (!set) continue;
    if (!["ALL", "ANY"].includes(set.mode) || !Array.isArray(set.conds) || set.conds.length > 6) throw new Error("Each rule set holds up to 6 conditions.");
    for (const c of set.conds) {
      if (!IND.has(c.ind) || !TF.has(String(c.tf)) || typeof c.op !== "string") throw new Error(`Unsupported condition: ${JSON.stringify(c).slice(0, 80)}`);
    }
  }
  if (!has(rules.long) && !has(rules.short)) throw new Error("Add at least one Buy or Sell condition.");
  if (rules.candles !== undefined && rules.candles !== "NORMAL" && rules.candles !== "HA") throw new Error("Candle type must be normal or Heikin Ashi.");
  if (rules.daily) {
    for (const c of allConds(rules)) {
      if (c.tf !== "D") throw new Error("A once-a-day strategy uses daily candles only; set every condition's timeframe to Daily.");
      if (c.ind === "VWAP" || c.ind === "ORB") throw new Error("VWAP and opening range need intraday candles, so they can't be used in a once-a-day strategy.");
    }
  }
  return rules;
}

export { tm as timeOfDay };
