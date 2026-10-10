// Strategy lab: every evening it invents condition strategies, backtests each one on the past year and keeps score.
//   data      – refresh a candle cache per asset (5-minute index candles, daily candles for everything)
//   generate  – write tonight's strategies (new random ones plus the best recent ones, re-tested on the rolling year)
//   screen    – backtest each as futures (index futures proxy / MCX near-month futures), with charges
//   options   – the best index strategies are re-priced with real expired-option prices, as option buying and option writing
// Scoring is walk-forward: strategies are ranked on months 1–9 and must also make money in the last 3 months.
// Each step runs in a short instalment (Supabase allows ~2 s of computing per call) and chains to the next.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Dhan, DhanBusyError, type OptBar } from "./dhan.ts";
import { type Acc, type BtParams, type ChargeRates, type MBar, newAcc, type OptStore, type Plan, priceBatch, simulateRules, type SimData } from "./backtest.ts";
import { addDays, type DayBar, ist, sessionFor } from "./logic.ts";
import { describeCond, type Cond, type Rules, validateRules } from "./rules.ts";
import { dataSecurity } from "./instruments.ts";
import { describeRisk, type Risk } from "./risk.ts";
import { loadMarginRates, type MarginRate, refreshMargins } from "./margins.ts";

/* ---------- assets ---------- */
export type LabAsset = {
  key: string; name: string; seg: string; sec: string; instr: string; exchange: string; lot: number; commodity: boolean;
  step?: number; wd?: number; flag?: "WEEK" | "MONTH";
};
const IDX = (key: string, name: string, sec: string, exchange: string, step: number, wd: number, lot: number, flag: "WEEK" | "MONTH"): LabAsset =>
  ({ key, name, seg: "IDX_I", sec, instr: "INDEX", exchange, lot, commodity: false, step, wd, flag });
const MCX = (key: string, name: string, lot: number): LabAsset => ({ key, name, seg: "MCX_COMM", sec: key, instr: "FUTCOM", exchange: "MCX", lot, commodity: true });
export const LAB_ASSETS: Record<string, LabAsset> = Object.fromEntries([
  IDX("NIFTY", "Nifty 50", "13", "NSE", 50, 2, 65, "WEEK"),
  IDX("BANKNIFTY", "Bank Nifty", "25", "NSE", 100, 2, 30, "MONTH"),
  IDX("FINNIFTY", "Fin Nifty", "27", "NSE", 50, 2, 60, "MONTH"),
  IDX("MIDCPNIFTY", "Midcap Nifty Select", "442", "NSE", 25, 2, 120, "MONTH"),
  IDX("NIFTYNXT50", "Nifty Next 50", "38", "NSE", 100, 2, 25, "MONTH"),
  IDX("SENSEX", "Sensex", "51", "BSE", 100, 4, 20, "WEEK"),
  IDX("BANKEX", "Bankex", "69", "BSE", 100, 4, 30, "MONTH"),
  MCX("GOLD", "Gold", 100), MCX("GOLDM", "Gold Mini", 10), MCX("GOLDTEN", "Gold Ten", 1), MCX("GOLDGUINEA", "Gold Guinea", 1),
  MCX("GOLDPETAL", "Gold Petal", 1), MCX("SILVER", "Silver", 30), MCX("SILVERM", "Silver Mini", 5), MCX("SILVERMIC", "Silver Micro", 1),
  MCX("CRUDEOIL", "Crude Oil", 100), MCX("CRUDEOILM", "Crude Oil Mini", 10), MCX("NATURALGAS", "Natural Gas", 1250),
  MCX("NATGASMINI", "Natural Gas Mini", 250), MCX("COPPER", "Copper", 2500), MCX("ZINC", "Zinc", 5000), MCX("ZINCMINI", "Zinc Mini", 1000),
  MCX("LEAD", "Lead", 5000), MCX("LEADMINI", "Lead Mini", 1000), MCX("ALUMINIUM", "Aluminium", 5000), MCX("ALUMINI", "Aluminium Mini", 1000),
  MCX("NICKEL", "Nickel", 250),
].map((a) => [a.key, a]));

/** Charge rates (%), the same defaults as the backtest form. */
export function chargeRates(a: LabAsset): ChargeRates {
  if (a.commodity) return { brk_pct: 0.03, stt_fut: 0.01, stt_opt: 0.05, exch_fut: 0.0021, exch_opt: 0.0418, sebi: 0.0001, gst: 18, stamp_fut: 0.002, stamp_opt: 0.003 };
  const bse = a.exchange === "BSE";
  return { brk_pct: 0.03, stt_fut: 0.05, stt_opt: 0.15, exch_fut: bse ? 0 : 0.00183, exch_opt: bse ? 0.0325 : 0.03553, sebi: 0.0001, gst: 18, stamp_fut: 0.002, stamp_opt: 0.003 };
}

/* ---------- strategy generator ---------- */
function rng(seed: number) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type R = () => number;
const pick = <T>(r: R, xs: T[]): T => xs[Math.floor(r() * xs.length)];

const MIRROR: Record<string, string> = {};
for (const [a, b] of [["up", "down"], ["turns_up", "turns_down"], ["green", "red"], ["turns_green", "turns_red"], ["price_above", "price_below"],
  ["price_cross_above", "price_cross_below"], ["fast_above_slow", "fast_below_slow"], ["fast_cross_above", "fast_cross_below"], ["above_signal", "below_signal"],
  ["cross_above_signal", "cross_below_signal"], ["hist_pos", "hist_neg"], ["above_zero", "below_zero"], ["close_above_upper", "close_below_lower"],
  ["cross_above_upper", "cross_below_lower"], ["price_above_mid", "price_below_mid"], ["plus_above_minus", "minus_above_plus"], ["above_pdh", "below_pdl"],
  ["cross_above_pdh", "cross_below_pdl"], ["above_orh", "below_orl"], ["cross_above_orh", "cross_below_orl"], ["bull_sweep", "bear_sweep"]]) { MIRROR[a] = b; MIRROR[b] = a; }

/** The same condition for the other direction (RSI 60 ↔ 40; ADX and ATR are non-directional and stay as they are). */
export function mirror(c: Cond): Cond {
  if (c.ind === "ADX" || c.ind === "ATR") return c.op in MIRROR ? { ...c, op: MIRROR[c.op] } : { ...c };
  if (c.ind === "RSI") {
    const op = { gt: "lt", lt: "gt", cross_above: "cross_below", cross_below: "cross_above" }[c.op] ?? c.op;
    return { ...c, op, v: 100 - Number(c.v ?? 50) };
  }
  return { ...c, op: MIRROR[c.op] ?? c.op };
}

type Tpl = (r: R) => Omit<Cond, "tf">;
// Parameter ranges the generator draws from (wide on purpose: the walk-forward check weeds out lucky settings).
const ST_ATR = [7, 10, 12, 14, 20], ST_FAC = [1.5, 2, 2.5, 3, 3.5, 4];
const EMA_LEN = [9, 13, 20, 34, 50, 100, 200], EMA_PAIRS = [[5, 13], [9, 21], [13, 34], [20, 50], [50, 100], [50, 200]];
const RSI_LEN = [7, 9, 14, 21], BB_MULT = [1.5, 2, 2.5], ADX_LEN = [10, 14, 20];
const st = (r: R) => ({ atr: pick(r, ST_ATR), factor: pick(r, ST_FAC) });
const STATE: [Tpl, boolean][] = [ // [template, intraday only]
  [(r) => ({ ind: "ST", p: st(r), op: "up" }), false],
  [() => ({ ind: "HA", op: "green" }), false],
  [(r) => ({ ind: "EMA", p: { len: pick(r, EMA_LEN) }, op: "price_above" }), false],
  [(r) => { const [a, b] = pick(r, EMA_PAIRS); return { ind: "EMA", p: { len: a, len2: b }, op: "fast_above_slow" }; }, false],
  [(r) => ({ ind: "SMA", p: { len: pick(r, [20, 50, 100, 200]) }, op: "price_above" }), false],
  [(r) => ({ ind: "MACD", p: pick(r, [{ fast: 12, slow: 26, sig: 9 }, { fast: 8, slow: 21, sig: 5 }, { fast: 5, slow: 35, sig: 5 }]), op: pick(r, ["above_signal", "hist_pos", "above_zero"]) }), false],
  [(r) => ({ ind: "BB", p: { len: pick(r, [20, 30]), mult: pick(r, BB_MULT) }, op: "price_above_mid" }), false],
  [(r) => ({ ind: "ADX", p: { len: pick(r, ADX_LEN) }, op: "plus_above_minus" }), false],
  [(r) => ({ ind: "RSI", p: { len: pick(r, RSI_LEN) }, op: "gt", v: pick(r, [50, 55, 60]) }), false],
  [() => ({ ind: "VWAP", op: "price_above" }), true],
  [() => ({ ind: "PDHL", op: "above_pdh" }), true],
];
const EVENT: [Tpl, boolean][] = [
  [(r) => ({ ind: "ST", p: st(r), op: "turns_up" }), false],
  [() => ({ ind: "HA", op: "turns_green" }), false],
  [(r) => ({ ind: "EMA", p: { len: pick(r, [9, 13, 20, 34, 50]) }, op: "price_cross_above" }), false],
  [(r) => { const [a, b] = pick(r, EMA_PAIRS.slice(0, 4)); return { ind: "EMA", p: { len: a, len2: b }, op: "fast_cross_above" }; }, false],
  [(r) => ({ ind: "MACD", p: pick(r, [{ fast: 12, slow: 26, sig: 9 }, { fast: 8, slow: 21, sig: 5 }]), op: "cross_above_signal" }), false],
  [(r) => ({ ind: "RSI", p: { len: pick(r, RSI_LEN) }, op: "cross_above", v: pick(r, [50, 55, 60, 65]) }), false],
  [(r) => ({ ind: "BB", p: { len: 20, mult: pick(r, BB_MULT) }, op: "cross_above_upper" }), false],
  [(r) => ({ ind: "ORB", p: { mins: pick(r, [15, 30, 45, 60]) }, op: "cross_above_orh" }), true],
  [() => ({ ind: "PDHL", op: "cross_above_pdh" }), true],
  [() => ({ ind: "VWAP", op: "price_cross_above" }), true],
  [(r) => ({ ind: "SWEEP", p: sweepP(r, false), op: "bull_sweep" }), false],
];
/** Liquidity-sweep settings: swing look-back, how long the signal stays alive, and (intraday) swing or previous-day levels. */
const sweepP = (r: R, daily: boolean) => ({ len: pick(r, [5, 10, 20, 30, 50]), within: pick(r, [1, 1, 2, 3]), src: daily ? 0 : pick(r, [0, 0, 1]) });
const FILTER: Tpl[] = [
  (r) => ({ ind: "RSI", p: { len: pick(r, RSI_LEN) }, op: "gt", v: pick(r, [50, 55, 60]) }),
  (r) => ({ ind: "ADX", p: { len: pick(r, ADX_LEN) }, op: "gt", v: pick(r, [18, 20, 25, 30]) }),
  (r) => ({ ind: "RSI", p: { len: 14 }, op: "lt", v: pick(r, [70, 75, 80]) }),
];

export type LabConfig = Record<string, any>;

/** Stop loss / target / trailing stop / daily loss limit for a lab strategy (about 65% get some). */
function randomRisk(r: R, daily: boolean, intraday: boolean, capital: number): Risk | null {
  if (r() < 0.35) return null;
  const useAtr = r() < 0.5, type = useAtr ? "ATR" as const : "PCT" as const;
  const sl = useAtr ? pick(r, daily ? [1, 1.5, 2, 3] : [0.75, 1, 1.5, 2, 3]) : pick(r, daily ? [1, 1.5, 2, 3, 5] : [0.2, 0.3, 0.5, 0.75, 1, 1.5]);
  const risk: Risk = { basis: "UNDERLYING", atr_len: pick(r, [10, 14, 20]), sl: { type, value: sl }, tgt: null, trail: null, max_day_loss: null };
  if (r() < 0.45) risk.tgt = { type, value: +(sl * pick(r, [1, 1.5, 2, 3, 4])).toFixed(2) };
  if (r() < 0.35) { risk.trail = { type, value: +(sl * pick(r, [0.75, 1, 1.5])).toFixed(2) }; if (r() < 0.5) risk.sl = null; }
  if (intraday && r() < 0.25) risk.max_day_loss = Math.round(capital * pick(r, [0.01, 0.02]));
  return risk;
}

/** One random strategy for an asset. Index strategies are intraday-candle based (85%) or once-a-day; commodities once-a-day. */
export function generate(assetKey: string, seed: number, capital = 500000): LabConfig {
  const a = LAB_ASSETS[assetKey];
  const r = rng(seed);
  const daily = a.commodity || r() < 0.15;
  const okTpl = (xs: [Tpl, boolean][]) => xs.filter(([, intra]) => !(daily && intra)).map(([t]) => t);
  const tf = daily ? 375 : pick(r, [5, 10, 15, 15, 25, 30, 30, 45, 60, 75, 125]);
  const higher = daily ? [] : [15, 25, 30, 60, 75, 125].filter((x) => x > tf && x % 5 === 0 && x !== tf).map(String).concat(["D"]);
  const ctf = (base: boolean) => daily ? "D" : base ? "base" : pick(r, higher);
  const candles = r() < 0.2 ? "HA" : "NORMAL";
  const sr = r();
  const style = sr < 0.2 ? "reversion" : sr < 0.45 ? "sweep" : "trend";
  const conds: Cond[] = [];
  let exitLong: Cond[] = [];
  if (style === "sweep") {
    // Liquidity sweep: buy after price runs the stops below a swing low (or yesterday's low) and closes back above it;
    // often only in the direction of the higher-timeframe trend.
    const primary: Cond = { ind: "SWEEP", tf: ctf(true), p: sweepP(r, daily), op: "bull_sweep" };
    conds.push(primary);
    if (r() < 0.6) conds.push({ ...pick(r, okTpl(STATE))(r), tf: daily ? "D" : (higher.length ? pick(r, higher) : "base") } as Cond);
    if (r() < 0.3) { const f = { ...pick(r, FILTER)(r), tf: ctf(true) } as Cond; if (!conds.some((x) => x.ind === f.ind && x.tf === f.tf)) conds.push(f); }
    const ex = r();
    if (ex < 0.45) exitLong = [{ ...primary, op: "bear_sweep" }];
    else if (ex < 0.75) exitLong = [mirror({ ...pick(r, okTpl(STATE))(r), tf: ctf(true) } as Cond)];
  } else if (style === "reversion") {
    // Oversold bounce: buy when RSI recovers from below a low level; take profit when RSI is strong again.
    const len = pick(r, RSI_LEN);
    conds.push({ ind: "RSI", tf: ctf(true), p: { len }, op: "cross_above", v: pick(r, [20, 25, 30, 35]) });
    if (r() < 0.5) conds.push({ ind: "ADX", tf: ctf(true), p: { len: pick(r, ADX_LEN) }, op: "lt", v: pick(r, [20, 25, 30]) });
    if (r() < 0.4) conds.push({ ...pick(r, okTpl(STATE))(r), tf: ctf(false) } as Cond);
    exitLong = [r() < 0.6 ? { ind: "RSI", tf: ctf(true), p: { len }, op: "gt", v: pick(r, [50, 55, 60, 70]) } : { ind: "BB", tf: ctf(true), p: { len: 20, mult: 2 }, op: "price_above_mid" }];
  } else {
    const event = r() < 0.55;
    const primary = { ...(event ? pick(r, okTpl(EVENT)) : pick(r, okTpl(STATE)))(r), tf: ctf(true) } as Cond;
    conds.push(primary);
    const nF = pick(r, [0, 1, 1, 2]);
    for (let i = 0; i < nF; i++) {
      const c = (r() < 0.6 && (daily || higher.length))
        ? { ...pick(r, okTpl(STATE))(r), tf: daily ? "D" : pick(r, higher) } as Cond
        : { ...pick(r, FILTER)(r), tf: ctf(true) } as Cond;
      if ((c.ind === "VWAP" || c.ind === "ORB") && c.tf === "D") continue;
      if (conds.some((x) => x.ind === c.ind && x.tf === c.tf)) continue;
      conds.push(c);
    }
    const ex = r();
    if (ex < 0.35 && event) exitLong = [mirror({ ...pick(r, okTpl(STATE))(r), tf: ctf(true) } as Cond)];
    else if (ex < 0.65) exitLong = [event ? mirror({ ...pick(r, okTpl(STATE))(r), tf: ctf(true) } as Cond) : mirror(primary)];
  }
  const dir = r();
  const direction = dir < 0.6 ? "BOTH" : dir < 0.85 ? "LONG_ONLY" : "SHORT_ONLY";
  // A one-sided strategy whose entry is a one-candle event needs explicit exits (otherwise it would exit a candle later).
  if (direction !== "BOTH" && !exitLong.length) exitLong = [mirror({ ...STATE[0][0](r), tf: ctf(true) } as Cond)];
  // Heikin Ashi candles make the Heikin Ashi colour condition meaningless; use normal candles there.
  const hasHA = [...conds, ...exitLong].some((c) => c.ind === "HA");
  const rules: Rules = {
    long: { mode: "ALL", conds }, short: { mode: "ALL", conds: conds.map(mirror) },
    exitLong: { mode: "ANY", conds: exitLong }, exitShort: { mode: "ANY", conds: exitLong.map(mirror) },
    ...(daily ? { daily: true } : {}), ...(candles === "HA" && !hasHA ? { candles: "HA" as const } : {}),
  };
  if (direction === "LONG_ONLY") rules.short = { mode: "ALL", conds: [] };
  if (direction === "SHORT_ONLY") { rules.short = { mode: "ALL", conds: conds.map(mirror) }; rules.long = { mode: "ALL", conds: [] }; }
  const intraday = !daily && r() < 0.7;
  const cfg: LabConfig = {
    strategy_kind: "RULES", underlying: a.key, data_security_id: a.sec, data_segment: a.seg, data_instrument: a.instr,
    exchange: a.exchange, dhan_symbol: a.key, futures_symbol: a.key + "1!",
    timeframe_min: tf, rules, direction, entry_mode: r() < 0.8 ? "FLIP" : "JOIN",
    session_start: daily ? "09:15" : intraday ? pick(r, ["09:15", "09:20", "09:30", "09:45", "10:15"]) : "09:15",
    last_entry: daily ? "15:15" : intraday ? pick(r, ["13:30", "14:30", "15:00"]) : "15:15",
    square_off: intraday ? pick(r, ["15:00", "15:15"]) : "15:20", intraday,
    trade_type: "FUTURES", option_side: "BUY", lots: 1, lot_size: a.lot, qty_mode: "LOTS", product_type: intraday ? "I" : "M",
    strike_step: a.step ?? 1, strike_offset: 0, expiry_weekday: a.wd ?? 4, expiry_flag: a.flag ?? "WEEK", roll_on_expiry: true,
    atr_period: 10, factor: 3, entry_trigger: "CLOSE", buffer_points: 0, after_hours_flip: "FIRST_CLOSE",
  };
  if (cfg.intraday && cfg.last_entry > cfg.square_off) cfg.last_entry = "14:30";
  if (a.commodity) Object.assign(cfg, { session_start: "09:00", last_entry: "23:00", square_off: "23:15" });
  cfg.risk = randomRisk(r, daily, intraday, capital);
  validateRules(cfg.rules);
  return cfg;
}

/* ---------- variations of winners ---------- */
const NEAR: Record<string, number[]> = {
  atr: ST_ATR, factor: ST_FAC, len: [5, 7, 9, 10, 13, 14, 20, 21, 30, 34, 50, 100, 200], len2: [13, 21, 34, 50, 100, 200],
  mult: BB_MULT, mins: [15, 30, 45, 60], fast: [5, 8, 12], slow: [21, 26, 35], sig: [5, 9], within: [1, 2, 3, 5],
};
/** The next value up or down in a list (never the value itself). */
const neighbour = (xs: number[], v: number, r: R) => {
  const s = [...new Set(xs)].sort((a, b) => a - b);
  const below = s.filter((x) => x < v).at(-1), above = s.find((x) => x > v);
  const opts = [below, above].filter((x): x is number => x !== undefined);
  return opts.length ? pick(r, opts) : v;
};
/**
 * A close relative of a winning strategy with one or two settings changed (indicator length, threshold, timeframe,
 * stop distance, trailing stop, candle type, direction, entry style, session). Returns null if the change isn't valid.
 */
export function mutate(parent: LabConfig, seed: number, capital = 500000): LabConfig | null {
  const r = rng(seed);
  const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
  delete cfg.lab_note;
  const changes: string[] = [];
  const daily = !!cfg.rules.daily;
  const sets = (["long", "short", "exitLong", "exitShort"] as const).filter((k) => cfg.rules[k]?.conds?.length);
  const n = r() < 0.6 ? 1 : 2;
  for (let step = 0; step < n; step++) {
    const what = r();
    if (what < 0.4 && sets.length) {
      // Change one indicator setting (applied to the matching condition on the other side too, so both stay mirrors).
      const k = pick(r, sets), i = Math.floor(r() * cfg.rules[k].conds.length), c: Cond = cfg.rules[k].conds[i];
      const keys = Object.keys(c.p ?? {}).filter((x) => NEAR[x]);
      const useV = c.v !== undefined && (r() < 0.5 || !keys.length);
      const same = (x: Cond) => x.ind === c.ind && x.tf === c.tf && JSON.stringify(x.p ?? {}) === JSON.stringify(c.p ?? {});
      if (useV) {
        const ov = Number(c.v), nv = ov + (r() < 0.5 ? -5 : 5);
        for (const s of sets) for (const x of cfg.rules[s].conds as Cond[]) if (same(x) && x.v !== undefined) x.v = x.v === ov ? nv : c.ind === "RSI" && x.v === 100 - ov ? 100 - nv : x.v;
        changes.push(`${c.ind} level ${ov} → ${nv}`);
      } else if (keys.length) {
        const pk = pick(r, keys), old = Number(c.p![pk]), nv = neighbour(NEAR[pk], old, r);
        if (nv === old) continue;
        const p0 = JSON.stringify(c.p);
        for (const s of sets) for (const x of cfg.rules[s].conds as Cond[]) if (x.ind === c.ind && x.tf === c.tf && JSON.stringify(x.p) === p0) x.p = { ...x.p, [pk]: nv };
        changes.push(`${c.ind} ${pk} ${old} → ${nv}`);
      }
    } else if (what < 0.55 && !daily) {
      const old = cfg.timeframe_min, nv = neighbour([5, 10, 15, 25, 30, 45, 60, 75, 125], old, r);
      if (nv === old) continue;
      // Condition timeframes must stay above the decision timeframe.
      const ok = sets.every((k) => (cfg.rules[k].conds as Cond[]).every((x) => x.tf === "base" || x.tf === "D" || Number(x.tf) > nv));
      if (ok) { cfg.timeframe_min = nv; changes.push(`decision candles ${old}m → ${nv}m`); }
    } else if (what < 0.75) {
      const rk = cfg.risk as Risk | null;
      if (!rk || (!rk.sl && !rk.trail)) { cfg.risk = randomRisk(r, daily, cfg.intraday, capital) ?? { basis: "UNDERLYING", atr_len: 14, sl: { type: "PCT", value: daily ? 2 : 0.5 } }; changes.push("added a stop loss"); }
      else if (r() < 0.6) {
        const q = rk.sl ?? rk.trail!, f = pick(r, [0.67, 0.8, 1.25, 1.5]), old = q.value; q.value = +(q.value * f).toFixed(2);
        changes.push(`${rk.sl ? "stop loss" : "trailing stop"} ${old} → ${q.value}${q.type === "PCT" ? "%" : q.type === "ATR" ? "×ATR" : " pts"}`);
      } else if (!rk.trail) { rk.trail = { ...(rk.sl ?? { type: "PCT", value: 0.5 }) }; changes.push("added a trailing stop"); }
      else if (!rk.tgt) { const q = rk.sl ?? rk.trail; rk.tgt = { type: q.type, value: +(q.value * 2).toFixed(2) }; changes.push("added a target at 2× the stop"); }
      else { rk.tgt = null; changes.push("removed the target"); }
    } else if (what < 0.83) {
      const hasHA = sets.some((k) => (cfg.rules[k].conds as Cond[]).some((x) => x.ind === "HA"));
      if (!hasHA) { if (cfg.rules.candles === "HA") { delete cfg.rules.candles; changes.push("Heikin Ashi → normal candles"); } else { cfg.rules.candles = "HA"; changes.push("normal → Heikin Ashi candles"); } }
    } else if (what < 0.9) {
      cfg.entry_mode = cfg.entry_mode === "JOIN" ? "FLIP" : "JOIN"; changes.push(cfg.entry_mode === "JOIN" ? "enter whenever the rules are true" : "enter only when the rules newly become true");
    } else if (!daily && cfg.intraday) {
      const old = cfg.session_start; cfg.session_start = pick(r, ["09:15", "09:20", "09:30", "09:45", "10:15"].filter((x) => x !== old)); changes.push(`first trade from ${old} → ${cfg.session_start}`);
    } else if (!daily && !LAB_ASSETS[cfg.underlying]?.commodity) {
      cfg.intraday = !cfg.intraday; cfg.product_type = cfg.intraday ? "I" : "M";
      if (cfg.intraday) Object.assign(cfg, { last_entry: "14:30", square_off: "15:15" }); else Object.assign(cfg, { last_entry: "15:15", square_off: "15:20" });
      changes.push(cfg.intraday ? "positional → intraday (square off daily)" : "intraday → positional (carry overnight)");
    }
  }
  if (!changes.length) return null;
  try { validateRules(cfg.rules); } catch { return null; }
  cfg.lab_note = `Variation of a winner: ${changes.join("; ")}`;
  return cfg;
}

/* ---------- exploring a winner: other assets, timeframes, stops, trailing, indicator combinations ---------- */
export type ExploreKind = "assets" | "timeframes" | "stops" | "trailing" | "indicators" | "tweaks" | "settings";
/**
 * Small steps on every indicator setting of a strategy, one setting at a time: lengths ±1, ±2 and ±10%, Supertrend
 * factor / Bollinger width ±0.25 and ±0.5, levels (RSI, ADX …) ±2 and ±5. The same change is made to the matching
 * condition on the other side, so buy and sell rules stay mirrors of each other.
 */
export function settingVariants(parent: LabConfig): LabConfig[] {
  const out: LabConfig[] = [];
  const sets = (["long", "short", "exitLong", "exitShort"] as const).filter((k) => parent.rules[k]?.conds?.length);
  const seenCond = new Set<string>();
  const INT = new Set(["len", "len2", "atr", "fast", "slow", "sig", "mins", "within"]);
  for (const k of sets) for (const c of parent.rules[k].conds as Cond[]) {
    const key = `${c.ind}|${c.tf}|${JSON.stringify(c.p ?? {})}`;
    if (seenCond.has(key)) continue;
    seenCond.add(key);
    const same = (x: Cond) => x.ind === c.ind && x.tf === c.tf && JSON.stringify(x.p ?? {}) === JSON.stringify(c.p ?? {});
    for (const [pk, pv] of Object.entries(c.p ?? {})) {
      if (pk === "src") continue;
      const v0 = Number(pv);
      const steps = INT.has(pk)
        ? [...new Set([v0 - 2, v0 - 1, v0 + 1, v0 + 2, Math.round(v0 * 0.9), Math.round(v0 * 1.1)])].filter((x) => x !== v0 && x >= (pk === "within" ? 1 : 2) && x <= 300)
        : [v0 - 0.5, v0 - 0.25, v0 + 0.25, v0 + 0.5].map((x) => +x.toFixed(2)).filter((x) => x > 0);
      for (const nv of steps) {
        const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
        for (const s2 of sets) for (const x of cfg.rules[s2].conds as Cond[]) if (same(x)) x.p = { ...x.p, [pk]: nv };
        // EMA/SMA pairs: the fast length must stay below the slow one; MACD fast below slow.
        const bad = (cfg.rules[k].conds as Cond[]).some((x) => (x.p?.len2 && x.p.len && x.p.len >= x.p.len2) || (x.p?.fast && x.p.slow && x.p.fast >= x.p.slow));
        if (bad) continue;
        cfg.lab_note = `Variation of a winner: ${c.ind} ${pk} ${v0} → ${nv}`;
        out.push(cfg);
      }
    }
    if (c.v !== undefined) {
      const ov = Number(c.v);
      for (const d of [-5, -2, 2, 5]) {
        const nv = ov + d;
        if (c.ind === "RSI" && (nv <= 0 || nv >= 100)) continue;
        if (nv < 0) continue;
        const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
        for (const s2 of sets) for (const x of cfg.rules[s2].conds as Cond[]) if (same(x) && x.v !== undefined) x.v = x.v === ov ? nv : c.ind === "RSI" && x.v === 100 - ov ? 100 - nv : x.v;
        cfg.lab_note = `Variation of a winner: ${c.ind} level ${ov} → ${nv}`;
        out.push(cfg);
      }
    }
  }
  return out;
}
export const EXPLORE_KINDS: ExploreKind[] = ["settings", "assets", "timeframes", "stops", "trailing", "indicators", "tweaks"];
const INTRA_ONLY = new Set(["VWAP", "ORB"]);
const condsOf = (cfg: LabConfig): Cond[] => (["long", "short", "exitLong", "exitShort"] as const).flatMap((k) => cfg.rules?.[k]?.conds ?? []);
/** Same rules on another asset (indices take intraday or daily strategies; commodities daily ones). */
export function transfer(parent: LabConfig, key: string): LabConfig | null {
  const a = LAB_ASSETS[key];
  if (!a || key === parent.underlying) return null;
  const daily = !!parent.rules?.daily;
  if (a.commodity && !daily) return null;
  const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
  Object.assign(cfg, { underlying: a.key, data_security_id: a.sec, data_segment: a.seg, data_instrument: a.instr, exchange: a.exchange, dhan_symbol: a.key,
    futures_symbol: a.key + "1!", lot_size: a.lot, strike_step: a.step ?? 1, expiry_weekday: a.wd ?? 4, expiry_flag: a.flag ?? "WEEK" });
  if (a.commodity) Object.assign(cfg, { session_start: "09:00", last_entry: "23:00", square_off: "23:15", intraday: false, product_type: "M" });
  else if (LAB_ASSETS[parent.underlying]?.commodity) Object.assign(cfg, { session_start: "09:15", last_entry: "15:15", square_off: "15:20" });
  // A rupee daily loss limit sized for one contract means nothing on another.
  if (cfg.risk?.max_day_loss) cfg.risk.max_day_loss = null;
  cfg.lab_note = `Same rules on ${a.name}`;
  return cfg;
}
/** Same rules decided on a different candle timeframe (conditions on the strategy's own timeframe move with it). */
export function retime(parent: LabConfig, tf: number): LabConfig | null {
  if (parent.rules?.daily || tf === parent.timeframe_min) return null;
  const ok = condsOf(parent).every((x) => x.tf === "base" || x.tf === "D" || Number(x.tf) > tf);
  if (!ok) return null;
  const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
  cfg.timeframe_min = tf;
  cfg.lab_note = `Decision candles ${parent.timeframe_min}m → ${tf}m`;
  return cfg;
}
/** Stop loss / target grid: no stop, tighter and wider stops, ATR or % stops, targets at 1–4× the stop. */
export function stopVariants(parent: LabConfig): LabConfig[] {
  const daily = !!parent.rules?.daily;
  const base: Risk | null = parent.risk ?? null;
  const out: { risk: Risk | null; note: string }[] = [];
  if (base) out.push({ risk: null, note: "no stop loss or target" });
  const pctSl = daily ? [1, 1.5, 2, 3, 5] : [0.25, 0.4, 0.6, 0.8, 1, 1.5];
  const atrSl = [0.75, 1, 1.5, 2, 3];
  for (const v of pctSl) out.push({ risk: { basis: "UNDERLYING", atr_len: 14, sl: { type: "PCT", value: v }, tgt: base?.tgt ? { type: "PCT", value: +(v * 2).toFixed(2) } : null, trail: null, max_day_loss: null }, note: `stop ${v}%${base?.tgt ? `, target ${+(v * 2).toFixed(2)}%` : ""}` });
  for (const v of atrSl) out.push({ risk: { basis: "UNDERLYING", atr_len: base?.atr_len ?? 14, sl: { type: "ATR", value: v }, tgt: null, trail: null, max_day_loss: null }, note: `stop ${v}×ATR` });
  const sl = base?.sl ?? base?.trail ?? { type: "PCT" as const, value: daily ? 2 : 0.5 };
  for (const m of [1, 1.5, 2, 3, 4]) out.push({ risk: { basis: "UNDERLYING", atr_len: base?.atr_len ?? 14, sl: { ...sl }, tgt: { type: sl.type, value: +(sl.value * m).toFixed(2) }, trail: null, max_day_loss: null }, note: `stop ${sl.value}${sl.type === "PCT" ? "%" : "×ATR"}, target ${m}× the stop` });
  return out.map((o) => { const cfg: LabConfig = JSON.parse(JSON.stringify(parent)); cfg.risk = o.risk; cfg.lab_note = `Stops: ${o.note}`; return cfg; });
}
/** Profit trailing: trailing stops of different widths, with and without a fixed stop, % or ATR. */
export function trailVariants(parent: LabConfig): LabConfig[] {
  const daily = !!parent.rules?.daily;
  const out: LabConfig[] = [];
  const pct = daily ? [1, 2, 3, 5] : [0.25, 0.4, 0.6, 1];
  for (const v of pct) for (const keepSl of [false, true]) {
    const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
    const sl = keepSl ? (parent.risk?.sl ?? { type: "PCT", value: +(v * 1.5).toFixed(2) }) : null;
    cfg.risk = { basis: "UNDERLYING", atr_len: parent.risk?.atr_len ?? 14, sl, tgt: null, trail: { type: "PCT", value: v }, max_day_loss: null };
    cfg.lab_note = `Trailing stop ${v}%${sl ? ` with a ${sl.value}${sl.type === "PCT" ? "%" : "×ATR"} stop` : ""}`;
    out.push(cfg);
  }
  for (const v of [1, 1.5, 2, 3]) {
    const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
    cfg.risk = { basis: "UNDERLYING", atr_len: parent.risk?.atr_len ?? 14, sl: null, tgt: null, trail: { type: "ATR", value: v }, max_day_loss: null };
    cfg.lab_note = `Trailing stop ${v}×ATR`;
    out.push(cfg);
  }
  return out;
}
/** Other indicator combinations: add a filter, swap a filter for another indicator, or drop one (the entry signal stays). */
export function recombine(parent: LabConfig, seed: number): LabConfig | null {
  const r = rng(seed);
  const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
  const daily = !!cfg.rules.daily;
  const side = cfg.rules.long?.conds?.length ? "long" : "short";
  const conds: Cond[] = cfg.rules[side].conds;
  const tf = cfg.timeframe_min;
  const higher = daily ? ["D"] : [15, 25, 30, 60, 75, 125].filter((x) => x > tf).map(String).concat(["D"]);
  const okState = STATE.filter(([, intra]) => !(daily && intra)).map(([t]) => t);
  const fresh = (): Cond => {
    const c = r() < 0.55 ? { ...pick(r, okState)(r), tf: pick(r, higher) } as Cond : { ...pick(r, FILTER)(r), tf: daily ? "D" : "base" } as Cond;
    return c;
  };
  const what = r();
  let note = "";
  if (what < 0.45 || conds.length === 1) {
    const c = fresh();
    if ((INTRA_ONLY.has(c.ind) && c.tf === "D") || conds.some((x) => x.ind === c.ind && x.tf === c.tf) || conds.length >= 5) return null;
    conds.push(c); note = `added ${describeCond(c)}`;
  } else if (what < 0.8) {
    const i = 1 + Math.floor(r() * (conds.length - 1)), old = conds[i], c = fresh();
    if ((INTRA_ONLY.has(c.ind) && c.tf === "D") || conds.some((x, j) => j !== i && x.ind === c.ind && x.tf === c.tf)) return null;
    conds[i] = c; note = `${describeCond(old)} → ${describeCond(c)}`;
  } else {
    const i = 1 + Math.floor(r() * (conds.length - 1)), old = conds.splice(i, 1)[0]; note = `dropped ${describeCond(old)}`;
  }
  // Keep the other side the mirror image of this one.
  const other = side === "long" ? "short" : "long";
  if (cfg.rules[other]?.conds?.length) cfg.rules[other].conds = conds.map(mirror);
  try { validateRules(cfg.rules); } catch { return null; }
  cfg.lab_note = `Indicators: ${note}`;
  return cfg;
}
/**
 * Many relatives of one strategy, shared out between the chosen kinds of change. Each carries a lab_note saying what
 * changed. seen: fingerprints to skip (already tested or already in the list).
 */
export function explore(parent: LabConfig, opts: { n: number; kinds: ExploreKind[]; assets: string[]; seed: number; capital?: number; seen?: Set<string> }): LabConfig[] {
  const seen = opts.seen ?? new Set<string>();
  const kinds = opts.kinds.filter((k) => EXPLORE_KINDS.includes(k));
  if (!kinds.length) return [];
  const out: LabConfig[] = [];
  const add = (c: LabConfig | null) => {
    if (!c) return false;
    try { validateRules(c.rules); } catch { return false; }
    const fp = fingerprint(c);
    if (seen.has(fp)) return false;
    seen.add(fp); out.push(c); return true;
  };
  const pools: Record<string, LabConfig[]> = {
    assets: opts.assets.map((k) => transfer(parent, k)).filter((x): x is LabConfig => !!x),
    timeframes: [5, 10, 15, 25, 30, 45, 60, 75, 125].map((t) => retime(parent, t)).filter((x): x is LabConfig => !!x),
    stops: stopVariants(parent),
    trailing: trailVariants(parent),
    settings: settingVariants(parent),
  };
  const per = Math.max(1, Math.ceil(opts.n / kinds.length));
  let seed = opts.seed >>> 0;
  // Start from a different kind each time, so small batches don't always favour the same changes.
  const rot = seed % kinds.length;
  const order = [...kinds.slice(rot), ...kinds.slice(0, rot)];
  for (const k of order) {
    let made = 0;
    // Small setting steps get a double share: the cheapest way to see whether a winner depends on one exact setting.
    const quota = k === "settings" ? per * 2 : per;
    if (pools[k]) { const r0 = rng(seed + k.length); const list = [...pools[k]].sort(() => r0() - 0.5); for (const c of list) { if (made >= quota || out.length >= opts.n) break; if (add(c)) made++; } }
    else {
      for (let tries = 0; made < per && tries < per * 8 && out.length < opts.n; tries++) {
        seed = (seed + 104729) >>> 0;
        if (add(k === "indicators" ? recombine(parent, seed) : mutate(parent, seed, opts.capital ?? 500000))) made++;
      }
    }
  }
  // Fill what is left with setting tweaks and combinations (e.g. a promising other asset with a different stop).
  for (let tries = 0; out.length < opts.n && tries < opts.n * 6; tries++) {
    seed = (seed + 7919) >>> 0;
    const r = rng(seed);
    const base = out.length && r() < 0.5 ? pick(r, out) : parent;
    const c = r() < 0.5 ? mutate(base, seed, opts.capital ?? 500000) : recombine(base, seed);
    if (c && base !== parent) c.lab_note = `${base.lab_note}; ${c.lab_note}`;
    add(c);
  }
  return out.slice(0, opts.n);
}

/** Short name, e.g. "NIFTY 15m · Supertrend(10,3) own timeframe turns up & RSI(14) 60m > 55". */
export function labelFor(cfg: LabConfig): string {
  const r = cfg.rules as Rules;
  const set = r.long?.conds.length ? r.long : r.short!;
  const when = (cfg.rules.daily ? "daily" : `${cfg.timeframe_min}m`) + (cfg.rules.candles === "HA" ? " HA candles" : "");
  const rk = cfg.risk ? ` · ${describeRisk(cfg.risk).replace(/ \(on underlying\)/, "")}` : "";
  return `${cfg.underlying} ${when} · ${set.conds.map(describeCond).join(" & ").replace(/ own timeframe/g, "")}${rk}`.slice(0, 240);
}

/** Identifies a strategy's rules regardless of when it was tested. */
export function fingerprint(cfg: LabConfig): string {
  const key = JSON.stringify([cfg.underlying, cfg.timeframe_min, cfg.rules, cfg.direction, cfg.entry_mode, cfg.session_start, cfg.last_entry, cfg.square_off, cfg.intraday, cfg.risk ?? null]);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822507); }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/* ---------- scoring ---------- */
type T = { entry: string; exit: string; net: number; gross: number; costs: number };
export type PeriodStats = { n: number; net: number; gross: number; costs: number; wins: number; win_rate: number; pf: number | null; max_dd: number; avg: number; best: number; worst: number };
function stats(ts: T[]): PeriodStats {
  let net = 0, gross = 0, costs = 0, wins = 0, gw = 0, gl = 0, peak = 0, dd = 0, best = 0, worst = 0;
  for (const t of ts) {
    net += t.net; gross += t.gross; costs += t.costs;
    if (t.net > 0) { wins++; gw += t.net; } else gl -= t.net;
    peak = Math.max(peak, net); dd = Math.max(dd, peak - net);
    best = Math.max(best, t.net); worst = Math.min(worst, t.net);
  }
  const n = ts.length;
  return { n, net, gross, costs, wins, win_rate: n ? +((wins / n) * 100).toFixed(1) : 0, pf: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : null),
    max_dd: dd, avg: n ? Math.trunc(net / n) : 0, best, worst };
}
export type LabMetrics = {
  full: PeriodStats; train: PeriodStats; test: PeriodStats; months: { m: string; net: number; n: number }[];
  pos_months: number; months_n: number; train_pos_months: number; train_months_n: number; score: number; passed: boolean; why: string[];
  margin_lot?: number | null; ret_margin?: number | null; margin_max?: number | null; margin_pct?: number | null; margin_src?: string;
};
/** Walk-forward scoring: score from the training months only; "passed" also needs a profitable, untouched test period. */
export function labMetrics(trades: T[], from: string, split: string, to: string, daily: boolean): LabMetrics {
  const exitDay = (t: T) => t.exit.slice(0, 10);
  const train = trades.filter((t) => exitDay(t) < split), test = trades.filter((t) => exitDay(t) >= split);
  const months: { m: string; net: number; n: number }[] = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addDays(`${m}-28`, 7).slice(0, 7)) months.push({ m, net: 0, n: 0 });
  for (const t of trades) { const row = months.find((x) => x.m === exitDay(t).slice(0, 7)); if (row) { row.net += t.net; row.n++; } }
  const splitM = split.slice(0, 7);
  const trainMonths = months.filter((x) => x.m < splitM);
  const f = stats(trades), tr = stats(train), te = stats(test);
  // Enough trades in the ranked 9 months to mean something (once-a-day strategies trade less often).
  const minN = daily ? 6 : 20, minTest = daily ? 2 : 5;
  const avgAbs = train.length ? train.reduce((a, t) => a + Math.abs(t.net), 0) / train.length : 0;
  const trainPos = trainMonths.filter((x) => x.net > 0).length;
  const score = tr.n >= minN ? +((tr.net / Math.max(tr.max_dd, avgAbs * 3, 1)) * (trainMonths.length ? trainPos / trainMonths.length : 0)).toFixed(3) : 0;
  const why: string[] = [];
  if (tr.n < minN) why.push(`only ${tr.n} trades in the first 9 months (needs ${minN})`);
  if (tr.net <= 0) why.push("lost money in the first 9 months");
  if (tr.pf !== null && tr.pf < 1.1) why.push("profit factor under 1.1 in the first 9 months");
  if (te.n < minTest) why.push(`only ${te.n} trades in the last 3 months`);
  if (te.net <= 0) why.push("lost money in the last 3 months");
  return { full: f, train: tr, test: te, months, pos_months: months.filter((x) => x.net > 0).length, months_n: months.length,
    train_pos_months: trainPos, train_months_n: trainMonths.length, score, passed: why.length === 0, why };
}

/* ---------- candle cache ---------- */
type Col = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v?: number[] };
const toCol = (rows: { t: number; o: number; h: number; l: number; c: number; v?: number }[], withV: boolean): Col => ({
  t: rows.map((r) => r.t), o: rows.map((r) => r.o), h: rows.map((r) => r.h), l: rows.map((r) => r.l), c: rows.map((r) => r.c),
  ...(withV ? { v: rows.map((r) => r.v ?? 0) } : {}),
});
const fromCol = (c: Col) => c.t.map((t, i) => ({ t, o: c.o[i], h: c.h[i], l: c.l[i], c: c.c[i], v: c.v ? c.v[i] : 0 }));
export const WARM_DAYS = 150, YEAR_DAYS = 365;

/** Bring an asset's cached candles up to date (5-minute candles for indices, daily candles for every asset). */
export async function refreshAsset(sb: SupabaseClient, creds: { client: string; token: string }, key: string, today: string, freshHours = 0) {
  const a = LAB_ASSETS[key];
  if (freshHours > 0) {
    // Back-to-back runs (around-the-clock mode) reuse candles fetched in the last few hours.
    const { data: d } = await sb.from("lab_candles").select("updated_at").eq("asset", key).eq("kind", "D").maybeSingle();
    if (d && Date.now() - Date.parse(d.updated_at) < freshHours * 3600000) return;
  }
  const dhan = new Dhan(creds.client, creds.token);
  const sec = (await dataSecurity(sb, creds, a.seg, a.sec, today)).sec;
  // 11 years of daily candles: the year-by-year test covers 10 years (plus warm-up for the indicators).
  const daily = await dhan.daily(sec, a.seg, a.instr, addDays(today, -4100), addDays(today, 1));
  await sb.from("lab_candles").upsert({ asset: key, kind: "D", from_day: daily[0]?.day ?? today, to_day: daily.at(-1)?.day ?? today, bars: toCol(daily, false), updated_at: new Date().toISOString() });
  const want = addDays(today, -(YEAR_DAYS + WARM_DAYS));
  if (a.commodity) return refreshMcxIntraday(sb, dhan, a, today, want);
  const { data: cached } = await sb.from("lab_candles").select("from_day, to_day, bars").eq("asset", key).eq("kind", "I5").maybeSingle();
  const map = new Map<number, { t: number; o: number; h: number; l: number; c: number }>();
  let start = want;
  if (cached && cached.from_day <= addDays(want, 5)) {
    for (const r of fromCol(cached.bars)) map.set(r.t, r);
    start = addDays(cached.to_day, -2);
  }
  for (let s = start; s <= today; s = addDays(s, 86)) {
    const z = addDays(s, 85) < today ? addDays(s, 85) : today;
    for (const r of await dhan.intraday(a.sec, a.seg, a.instr, 5, `${s} 09:00:00`, `${z} 23:59:00`)) map.set(r.t, r);
  }
  const lo = Date.parse(`${want}T00:00:00+05:30`) / 1000;
  const rows = [...map.values()].filter((r) => r.t >= lo).sort((x, y) => x.t - y.t);
  await sb.from("lab_candles").upsert({ asset: key, kind: "I5", from_day: ist(rows[0]?.t ?? lo).date, to_day: ist(rows.at(-1)?.t ?? lo).date, bars: toCol(rows, false), updated_at: new Date().toISOString() });
  await refreshYearChunks(sb, dhan, a, today);
}
/**
 * Older 5-minute candles of an index for the year-by-year test, one stored row per calendar year ("I5Y:2022"),
 * fetched once a year is complete. Dhan keeps 5 years of intraday history.
 */
async function refreshYearChunks(sb: SupabaseClient, dhan: Dhan, a: LabAsset, today: string) {
  const first = addDays(today, -5 * 365 + 2), y0 = Number(first.slice(0, 4)), y1 = Number(today.slice(0, 4)) - 1;
  const { data: have } = await sb.from("lab_candles").select("kind").eq("asset", a.key).like("kind", "I5Y:%");
  const got = new Set((have ?? []).map((h) => h.kind));
  for (let y = y0; y <= y1; y++) {
    if (got.has(`I5Y:${y}`)) continue;
    const from = `${y}-01-01` < first ? first : `${y}-01-01`, to = `${y}-12-31`;
    const map = new Map<number, { t: number; o: number; h: number; l: number; c: number }>();
    for (let s = from; s <= to; s = addDays(s, 86)) {
      const z = addDays(s, 85) < to ? addDays(s, 85) : to;
      for (const r of await dhan.intraday(a.sec, a.seg, a.instr, 5, `${s} 09:00:00`, `${z} 23:59:00`)) map.set(r.t, r);
    }
    const rows = [...map.values()].sort((x, z) => x.t - z.t);
    if (!rows.length) continue;
    await sb.from("lab_candles").upsert({ asset: a.key, kind: `I5Y:${y}`, from_day: ist(rows[0].t).date, to_day: ist(rows.at(-1)!.t).date, bars: toCol(rows, false), updated_at: new Date().toISOString() });
  }
}

/**
 * 5-minute candles for an MCX commodity. Dhan serves intraday candles only for contracts that are still listed, so the
 * first download stitches the listed contracts (each day from the nearest-expiring contract that traded properly that
 * day, as far back as it was listed); after that every night adds the near-month contract's new days, so the history
 * grows into a true near-month series and is kept after contracts expire.
 */
async function refreshMcxIntraday(sb: SupabaseClient, dhan: Dhan, a: LabAsset, today: string, want: string) {
  const { data: cached } = await sb.from("lab_candles").select("from_day, to_day, bars").eq("asset", a.key).eq("kind", "I5").maybeSingle();
  const map = new Map<number, { t: number; o: number; h: number; l: number; c: number }>();
  let start = want;
  if (cached) { for (const r of fromCol(cached.bars)) map.set(r.t, r); start = addDays(cached.to_day, -3); }
  const { data: cons } = await sb.from("mcx_contracts").select("sec_id, expiry").eq("underlying", a.sec).gt("expiry", start).order("expiry").limit(cached ? 2 : 3);
  if (!cons?.length) return;
  // Each contract's candles by day.
  const per: { expiry: string; days: Map<string, { t: number; o: number; h: number; l: number; c: number }[]> }[] = [];
  let firstErr: unknown = null, got = 0;
  for (const c of cons) {
    const days = new Map<string, { t: number; o: number; h: number; l: number; c: number }[]>();
    const end = c.expiry < today ? c.expiry : today;
    for (let s = start; s <= end; s = addDays(s, 86)) {
      const z = addDays(s, 85) < end ? addDays(s, 85) : end;
      try {
        for (const r of await dhan.intraday(c.sec_id, a.seg, a.instr, 5, `${s} 09:00:00`, `${z} 23:59:00`)) {
          const d = ist(r.t).date, arr = days.get(d);
          if (arr) arr.push(r); else days.set(d, [r]);
          got++;
        }
      } catch (e) {
        if (e instanceof DhanBusyError || /token|401|DH-901|DH-902/i.test(String(e))) throw e;
        firstErr ??= e; // no candles for a range before the contract was listed
      }
    }
    per.push({ expiry: c.expiry, days });
  }
  if (!got && firstErr && !cached) throw firstErr;
  // For every day: the nearest contract (not expiring that day) that traded at least 40% of the busiest contract's candles.
  const allDays = new Set(per.flatMap((p) => [...p.days.keys()]));
  for (const d of allDays) {
    const live = per.filter((p) => p.expiry > d && p.days.has(d));
    if (!live.length) continue;
    const most = Math.max(...live.map((p) => p.days.get(d)!.length));
    const use = live.find((p) => p.days.get(d)!.length >= most * 0.4)!;
    // Replace that day's candles (a day is never mixed from two contracts).
    const lo = Date.parse(`${d}T00:00:00+05:30`) / 1000, hi = lo + 86400;
    for (const t of [...map.keys()]) if (t >= lo && t < hi) map.delete(t);
    for (const r of use.days.get(d)!) map.set(r.t, r);
  }
  const lo = Date.parse(`${want}T00:00:00+05:30`) / 1000;
  const rows = [...map.values()].filter((r) => r.t >= lo).sort((x, y) => x.t - y.t);
  if (!rows.length) return;
  await sb.from("lab_candles").upsert({ asset: a.key, kind: "I5", from_day: ist(rows[0].t).date, to_day: ist(rows.at(-1)!.t).date, bars: toCol(rows, false), updated_at: new Date().toISOString() });
}

/** Cached candles in the shape the simulator wants. */
export async function loadAsset(sb: SupabaseClient, key: string, long = false): Promise<SimData> {
  const a = LAB_ASSETS[key];
  // The year-by-year test also loads the older yearly 5-minute chunks.
  let q = sb.from("lab_candles").select("kind, bars").eq("asset", key);
  q = long ? q.or("kind.eq.D,kind.eq.I5,kind.like.I5Y*") : q.in("kind", ["D", "I5"]);
  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  const d = rows?.find((r) => r.kind === "D");
  if (!d) throw new Error(`No cached candles for ${key} yet.`);
  const daily: DayBar[] = fromCol(d.bars).map((r) => ({ ...r, day: ist(r.t).date }));
  const raw: MBar[] = [];
  const byDay = new Map<string, MBar[]>();
  const parts = (rows ?? []).filter((r) => r.kind !== "D").sort((x, y) => (x.kind === "I5" ? 1 : 0) - (y.kind === "I5" ? 1 : 0) || x.kind.localeCompare(y.kind));
  const seenT = new Set<number>();
  for (const i5 of parts) {
    for (const r of fromCol(i5.bars)) {
      if (seenT.has(r.t)) continue;
      seenT.add(r.t);
      const p = ist(r.t), sess = sessionFor(a.seg, p.date);
      if (p.min < sess.open || p.min >= sess.close) continue;
      const m = { ...r, day: p.date, min: p.min };
      raw.push(m);
      const arr = byDay.get(p.date); if (arr) arr.push(m); else byDay.set(p.date, [m]);
    }
  }
  if (parts.length > 1) { raw.sort((x, y) => x.t - y.t); for (const arr of byDay.values()) arr.sort((x, y) => x.t - y.t); }
  return { raw, byDay, daily };
}

/* ---------- one strategy ---------- */
export function labParams(a: LabAsset, from: string, to: string, capital: number): BtParams {
  return { from, to, capital, brokerage: 20, charges: chargeRates(a), near_code: 1 };
}
/** Futures backtest of a lab strategy on cached candles (no network calls). */
export async function screenOne(cfg: LabConfig, data: SimData, memo: Map<string, unknown>, win: { from: string; split: string; to: string }, capital: number, rates: Record<string, MarginRate> = {}) {
  const a = LAB_ASSETS[cfg.underlying];
  const plans = simulateRules(cfg, data, win.from, win.to, memo);
  const { trades } = await priceBatch(cfg, { client: "-", token: "-" }, labParams(a, win.from, win.to, capital), plans, 0, newAcc(capital), Infinity, async () => {});
  const base = labMetrics(trades as T[], win.from, win.split, win.to, !!cfg.rules.daily);
  // Margin for every trade at its own entry price; with no trades, at the last close.
  const metrics = withTradeMargins(base, cfg, "FUT", trades, rates, data.daily.at(-1)?.c ?? 0);
  return { metrics, trades };
}

/**
 * Margin rate (share of contract value) for a lab strategy: Dhan's margin calculator figure for the asset when the lab
 * has checked it (intraday or carry-forward, as the strategy trades), else about 12% for index F&O and 10% for MCX.
 */
export function marginRate(cfg: LabConfig, kind: "FUT" | "SELL", rates: Record<string, MarginRate>): { pct: number; src: string } {
  const r = rates[cfg.underlying];
  const v = r ? (kind === "SELL" ? (cfg.intraday ? r.sellI ?? r.sell : r.sell ?? r.sellI) : (cfg.intraday ? r.futI ?? r.fut : r.fut ?? r.futI)) : null;
  if (v) return { pct: v, src: "Dhan" };
  return { pct: cfg.data_segment === "MCX_COMM" ? 0.10 : 0.12, src: "estimate" };
}
/** Strike from a priced option trade's contract text ("NIFTY 24500 CE"). */
const strikeOf = (t: Record<string, unknown>) => { const m = / (\d+(?:\.\d+)?) (?:CE|PE)\b/.exec(String(t.contract ?? "")); return m ? Number(m[1]) : 0; };
/**
 * Money one lot tied up in one trade, at the price of that trade's entry:
 *  futures – entry price × lot × margin rate; option writing – strike × lot × writing margin rate; option buying – premium paid × lot.
 */
export function tradeMargin(cfg: LabConfig, kind: "FUT" | "BUY" | "SELL" | "SPREAD", t: Record<string, unknown>, pct: number): number {
  if (kind === "SPREAD") return Math.trunc(Number(t.margin) || 0); // worked out from the legs when the trade was priced
  const lot = Number(cfg.lot_size), px = Number(t.entry_px);
  if (kind === "BUY") return Math.trunc(px * lot);
  if (kind === "SELL") return Math.trunc((strikeOf(t) || Number(t.spot_in) || 0) * lot * pct);
  return Math.trunc(px * lot * pct);
}
/**
 * Stamps each trade with its margin and adds to the metrics: the average margin per lot over the trades (the capital
 * the strategy typically needs), the largest, and the year's net profit as a % of the average.
 */
export function withTradeMargins(m: LabMetrics, cfg: LabConfig, kind: "FUT" | "BUY" | "SELL" | "SPREAD", trades: Record<string, unknown>[], rates: Record<string, MarginRate>, fallbackPx: number): LabMetrics {
  const { pct, src } = kind === "BUY" ? { pct: 1, src: "premium" } : kind === "SPREAD" ? { pct: 0, src: "legs" } : marginRate(cfg, kind, rates);
  const ms: number[] = [];
  for (const t of trades) { const v = tradeMargin(cfg, kind, t, pct); t.margin = v; if (v > 0) ms.push(v); }
  const avgM = ms.length ? Math.trunc(avg(ms)) : Math.trunc(kind === "BUY" ? 0 : fallbackPx * Number(cfg.lot_size) * pct);
  return { ...m, margin_lot: avgM || null, margin_max: ms.length ? Math.max(...ms) : avgM || null, margin_pct: kind === "BUY" || kind === "SPREAD" ? null : +pct.toFixed(5), margin_src: src,
    ret_margin: avgM > 0 ? +((m.full.net / avgM) * 100).toFixed(1) : null };
}
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Trades trimmed for storage. */
const slim = (trades: Record<string, unknown>[]) => trades.map(({ chg: _c, units: _u, ...t }) => t);

/* ---------- orchestration ---------- */
type Run = Record<string, any>;
type Ctx = { sb: SupabaseClient; creds: { client: string; token: string }; started: number; chain: () => Promise<void> };
const CPU_BUDGET = 900; // ms of computing per instalment (Supabase's limit is 2 s)
const WALL_BUDGET = 100000; // ms of wall time per instalment

/**
 * When the lab may run. "nightly": one run a day at 16:05 IST. "auto": back-to-back runs around the clock while no
 * strategy trades live, and only 23:30–08:30 IST once any does. "night": back-to-back runs 23:30–08:30 IST only.
 */
export async function labWindowOpen(sb: SupabaseClient, mode: string): Promise<boolean> {
  if (mode !== "auto" && mode !== "night") return false;
  const m = ist(Date.now() / 1000).min, night = m >= 23 * 60 + 30 || m < 8 * 60 + 30;
  if (night || mode === "night") return night;
  const { count } = await sb.from("algo_strategies").select("id", { count: "exact", head: true }).eq("live", true).eq("active", true).eq("archived", false).eq("is_master", false);
  return (count ?? 0) === 0;
}

export async function labStart(sb: SupabaseClient, manual: boolean, trigger?: string): Promise<number | null> {
  const { data: set } = await sb.from("lab_settings").select("*").eq("id", 1).maybeSingle();
  if (!set || (!set.enabled && !manual)) return null;
  // With back-to-back runs on, the 16:05 schedule has nothing extra to do.
  if (!manual && !trigger && (set.schedule_mode ?? "nightly") !== "nightly") return null;
  const { data: running } = await sb.from("lab_runs").select("id, settings, trigger").eq("status", "running").limit(1);
  if (running?.length && running[0].trigger === "robust") {
    // The re-check of earlier winners gives way; it carries on from where it was once the lab is free again.
    await sb.from("lab_runs").update({ status: "done", phase: "done", progress: "Paused for a new run; carries on later", finished_at: new Date().toISOString(), lease_until: null }).eq("id", running[0].id);
  } else if (running?.length) {
    // A variation run is busy: tonight's run starts as soon as it finishes.
    if (!manual && running[0].settings?.request_id) await sb.from("lab_settings").update({ nightly_due: true }).eq("id", 1);
    return running[0].id;
  }
  const today = ist(Date.now() / 1000).date;
  const from = addDays(today, -YEAR_DAYS), split = addDays(today, -92);
  const { data: run, error } = await sb.from("lab_runs").insert({
    run_day: today, status: "running", phase: "data", progress: "Updating candles", from_day: from, split_day: split, to_day: today,
    trigger: trigger ?? (manual ? "manual" : "schedule"), settings: set,
  }).select("id").single();
  if (error) throw new Error(error.message);
  return run.id;
}

/**
 * When the lab is free: starts the nightly run that was held back, or the next variation run anyone asked for.
 * Returns the run id started, or null.
 */
export async function labNext(sb: SupabaseClient): Promise<number | null> {
  const { data: running } = await sb.from("lab_runs").select("id").eq("status", "running").limit(1);
  if (running?.length) return null;
  // Variation runs whose run ended without finishing (stopped or failed) are closed.
  const { data: stale } = await sb.from("lab_requests").select("id, run_id").eq("status", "running");
  for (const q of stale ?? []) {
    const { data: rr } = await sb.from("lab_runs").select("status, error").eq("id", q.run_id).maybeSingle();
    if (!rr || rr.status !== "running") await sb.from("lab_requests").update({ status: rr?.status === "done" ? "done" : "failed", error: rr?.error ?? (rr ? "The run was stopped." : "The run disappeared."), finished_at: new Date().toISOString() }).eq("id", q.id);
  }
  const { data: set } = await sb.from("lab_settings").select("*").eq("id", 1).maybeSingle();
  if (set?.nightly_due) {
    await sb.from("lab_settings").update({ nightly_due: false }).eq("id", 1);
    const id = await labStart(sb, false);
    if (id) return id;
  }
  const { data: reqs } = await sb.from("lab_requests").select("*").eq("status", "pending").order("id").limit(1);
  const q = reqs?.[0];
  if (!q && set) {
    // Nothing else to do: re-check earlier first-round winners against the tougher test.
    const { count } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("basic_passed", true).is("robust_status", null);
    const { count: open } = await sb.from("lab_checks").select("id", { count: "exact", head: true }).eq("status", "pending");
    if ((count ?? 0) > 0 || (open ?? 0) > 0) {
      const today = ist(Date.now() / 1000).date;
      const { data: run, error } = await sb.from("lab_runs").insert({
        run_day: today, status: "running", phase: "robust", progress: "Re-checking earlier winners", from_day: addDays(today, -YEAR_DAYS), split_day: addDays(today, -92), to_day: today,
        trigger: "robust", settings: { ...set, nightly_due: undefined },
      }).select("id").single();
      if (error) throw new Error(error.message);
      return run.id;
    }
  }
  if (!q && set?.enabled && await labWindowOpen(sb, set.schedule_mode ?? "nightly")) return await labStart(sb, false, "continuous");
  if (!q || !set) return null;
  const parentAsset = String(q.config?.underlying ?? "");
  const daily = !!q.config?.rules?.daily;
  const wantAssets: string[] = (q.kinds ?? []).includes("assets")
    ? ((q.assets?.length ? q.assets : set.assets) ?? []).filter((k: string) => LAB_ASSETS[k] && (daily || !LAB_ASSETS[k].commodity))
    : [];
  const assets = [...new Set([parentAsset, ...wantAssets])].filter((k) => LAB_ASSETS[k]);
  if (!assets.length) { await sb.from("lab_requests").update({ status: "failed", error: "This strategy's asset isn't one the lab can test.", finished_at: new Date().toISOString() }).eq("id", q.id); return null; }
  const today = ist(Date.now() / 1000).date;
  const { data: run, error } = await sb.from("lab_runs").insert({
    run_day: today, status: "running", phase: "data", progress: "Updating candles", from_day: addDays(today, -YEAR_DAYS), split_day: addDays(today, -92), to_day: today,
    trigger: "request", settings: { ...set, nightly_due: undefined, assets, per_night: q.n, top_options: Math.min(5, Number(set.top_options ?? 5)), request_id: q.id, requested_by: q.user_id },
  }).select("id").single();
  if (error) throw new Error(error.message);
  await sb.from("lab_requests").update({ status: "running", run_id: run.id, progress: "Started" }).eq("id", q.id);
  return run.id;
}

/** One instalment of the current lab run. Returns true when another instalment should follow. */
export async function labStep(ctx: Ctx): Promise<boolean> {
  const { sb } = ctx;
  const now = new Date();
  // Take the run's lease so two instalments never work on it at the same time.
  const { data: claimed } = await sb.from("lab_runs").update({ lease_until: new Date(now.getTime() + 240000).toISOString(), updated_at: now.toISOString() })
    .eq("status", "running").or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select("*").limit(1);
  const run: Run | undefined = claimed?.[0];
  if (!run) return false;
  const set = run.settings ?? {};
  const reqId = run.settings?.request_id ?? null;
  const patch = async (f: Record<string, unknown>) => {
    await sb.from("lab_runs").update({ ...f, updated_at: new Date().toISOString() }).eq("id", run.id);
    // A variation run reports its progress to whoever asked for it.
    if (reqId) {
      const st = f.status === "done" ? "done" : f.status === "failed" ? "failed" : null;
      await sb.from("lab_requests").update({ ...(f.progress ? { progress: f.progress } : {}), ...(st ? { status: st, finished_at: new Date().toISOString(), error: f.error ?? null } : {}) }).eq("id", reqId);
    }
  };
  const counts = run.counts ?? {};
  let more = true;
  try {
    if (!ctx.creds.client || !ctx.creds.token) throw new Error("Add your Dhan client ID and access token under Dhan connection.");
    const assets: string[] = (set.assets ?? []).filter((k: string) => LAB_ASSETS[k]);
    if (!assets.length) throw new Error("Pick at least one asset in the lab settings.");
    const win = { from: String(run.from_day), split: String(run.split_day), to: String(run.to_day) };

    if (run.trigger === "continuous" && !(await labWindowOpen(sb, (await sb.from("lab_settings").select("schedule_mode").eq("id", 1).maybeSingle()).data?.schedule_mode ?? "nightly"))) {
      await patch({ status: "stopped", phase: "done", progress: "Stopped: outside the lab's hours (a strategy is trading live, or back-to-back runs were switched off)", finished_at: new Date().toISOString(), lease_until: null });
      return false;
    }
    if (run.phase === "data") {
      let i = Number(run.cursor ?? 0);
      if (i === 0 && !counts.margins_checked && run.trigger === "continuous") counts.margins_checked = -2; // rates from the last full run
      if (i === 0 && !counts.margins_checked) {
        // Today's margin rates from Dhan's margin calculator (used for each trade's margin and the return on margin).
        await patch({ progress: "Checking margin rates with Dhan" });
        const n = await refreshMargins(sb, ctx.creds, assets.map((k) => LAB_ASSETS[k]));
        counts.margins_checked = n || -1; await patch({ counts });
      }
      while (i < assets.length && Date.now() - ctx.started < WALL_BUDGET - 20000) {
        await patch({ progress: `Updating candles: ${LAB_ASSETS[assets[i]].name} (${i + 1} of ${assets.length})` });
        await refreshAsset(sb, ctx.creds, assets[i], win.to, run.trigger === "continuous" ? 6 : 0);
        i++;
      }
      await patch(i < assets.length ? { cursor: i } : { cursor: 0, phase: "generate", progress: "Writing tonight's strategies" });
    } else if (run.phase === "generate") {
      await generatePhase(sb, run, assets, win);
      await patch({ phase: "screen", progress: "Backtesting strategies", counts: { ...counts, generated: (await countRows(sb, run.id)) } });
    } else if (run.phase === "screen") {
      const left = await screenPhase(ctx, run, win);
      if (!left) {
        const { count: basic } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).eq("basic_passed", true);
        await patch({ phase: "robust", progress: `Checking ${basic ?? 0} first-round winners on other assets, other timeframes and year by year`, counts: { ...counts, screened: counts.generated, basic_passed: basic } });
      } else {
        await patch({ progress: `Backtested ${run.counts?.tested ?? 0} of ${counts.generated ?? "?"} strategies (${run.counts?.failed1 ?? 0} failed the first round and were cleared)` });
      }
    } else if (run.phase === "robust") {
      const left = await robustPhase(ctx, run, win, patch);
      if (!left && run.trigger === "robust") {
        await patch({ status: "done", phase: "done", progress: "Finished re-checking earlier winners", finished_at: new Date().toISOString(), lease_until: null });
        more = false;
      } else if (!left) {
        const top = Number(set.top_options ?? 20);
        // Options are priced for index strategies on intraday candles; positional once-a-day trades run across expiries.
        const { data: best } = await sb.from("lab_results").select("id, asset, mode").eq("run_id", run.id).eq("stage", "screened").eq("passed", true)
          .order("score", { ascending: false }).limit(400);
        const pickIds = (best ?? []).filter((b) => !LAB_ASSETS[b.asset]?.commodity && b.mode === "INTRADAY").slice(0, top).map((b) => b.id);
        if (pickIds.length) await sb.from("lab_results").update({ stage: "opt_queue" }).in("id", pickIds);
        const { count: passed } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).eq("passed", true);
        await patch({ phase: "options", progress: `Pricing the best ${pickIds.length} with real option prices`, counts: { ...counts, passed, to_price: pickIds.length } });
      }
    } else if (run.phase === "options") {
      const left = await optionsPhase(ctx, run, win, patch);
      if (!left) {
        await prune(sb);
        const { count: priced } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).eq("stage", "priced");
        await patch({ status: "done", phase: "done", progress: "Finished", finished_at: new Date().toISOString(), lease_until: null, counts: { ...counts, priced } });
        more = false;
      }
    } else more = false;
  } catch (e) {
    await patch({ status: "failed", progress: "Failed", error: e instanceof Error ? e.message : String(e), finished_at: new Date().toISOString(), lease_until: null });
    return false;
  }
  if (more) await sb.from("lab_runs").update({ lease_until: null }).eq("id", run.id);
  return more;
}

async function countRows(sb: SupabaseClient, runId: number) {
  const { count } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", runId);
  return count ?? 0;
}

async function generatePhase(sb: SupabaseClient, run: Run, assets: string[], _win: { from: string }) {
  const set = run.settings ?? {};
  const n = Math.max(10, Math.min(1000, Number(set.per_night ?? 300)));
  if ((await countRows(sb, run.id)) > 0) return; // already written (instalment repeated)
  if (set.request_id) return requestPhase(sb, run, assets);
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const { data: recent } = await sb.from("lab_results").select("fingerprint").gte("created_at", since).limit(20000);
  const seen = new Set((recent ?? []).map((x) => x.fingerprint));
  // Strategies already tried and failed are never written again.
  for (let from = 0; ; from += 1000) {
    const { data: tried } = await sb.from("lab_tried").select("fingerprint").range(from, from + 999);
    for (const x of tried ?? []) seen.add(x.fingerprint);
    if (!tried || tried.length < 1000 || from > 400000) break;
  }
  // Champions: the best strategies of the last 30 days are re-tested every night on the rolling year.
  const { data: champs } = await sb.from("lab_results").select("fingerprint, config, score").eq("passed", true)
    .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()).order("score", { ascending: false }).limit(300);
  const rows: Record<string, unknown>[] = [];
  // Earlier winners are re-tested once a day (on the latest candles); the rest of every run goes to new strategies and variations.
  const { data: fresh } = await sb.from("lab_results").select("fingerprint").gte("created_at", new Date(Date.now() - 20 * 3600000).toISOString()).limit(20000);
  const champSeen = new Set<string>(), testedToday = new Set((fresh ?? []).map((x) => x.fingerprint));
  for (const c of champs ?? []) {
    if (testedToday.has(c.fingerprint)) continue;
    if (champSeen.size >= 25 || champSeen.has(c.fingerprint) || !assets.includes(c.config?.underlying)) continue;
    champSeen.add(c.fingerprint);
    rows.push({ run_id: run.id, asset: c.config.underlying, mode: c.config.rules?.daily ? "DAILY" : "INTRADAY", label: labelFor(c.config), fingerprint: c.fingerprint, champion: true, config: c.config, stage: "pending" });
  }
  const capital = Number(set.capital ?? 500000);
  let seed = (Number(run.id) * 1000003) >>> 0;
  // Evolution: about 40% of the night goes to the winners. Each is tried on the other assets, other decision timeframes,
  // other stop / target / trailing-stop settings, other indicator combinations and setting tweaks. A strategy that keeps
  // passing night after night gets more of these tries, so the strongest ideas are tested hardest.
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: parents } = await sb.from("lab_results").select("id, fingerprint, config, score").eq("passed", true)
    .gte("created_at", since30).order("score", { ascending: false }).limit(2000);
  const { data: passHist } = await sb.from("lab_results").select("fingerprint").eq("passed", true).gte("created_at", since30).limit(20000);
  const passes = new Map<string, number>();
  for (const x of passHist ?? []) passes.set(x.fingerprint, (passes.get(x.fingerprint) ?? 0) + 1);
  // Parents from as many different ideas as possible: at most 2 per family (same asset, indicators and conditions),
  // so one strong idea can't take over every run with tiny variations of itself.
  const famOf = (c: LabConfig) => { const sig = (x?: { conds?: Cond[] }) => (x?.conds ?? []).map((q) => `${q.ind}:${q.op}`).sort().join("+") || "-";
    return [c.underlying, c.rules?.daily ? "D" : "I", c.direction, sig(c.rules?.long), sig(c.rules?.short)].join("|"); };
  const perFam = new Map<string, number>();
  const pSeen = new Set<string>(), pool = (parents ?? []).filter((x) => {
    if (!assets.includes(x.config?.underlying) || pSeen.has(x.fingerprint)) return false;
    const f = famOf(x.config), k = perFam.get(f) ?? 0;
    if (k >= 2) return false;
    perFam.set(f, k + 1); pSeen.add(x.fingerprint); return true;
  }).slice(0, 40);
  const nVar = pool.length ? Math.round(n * 0.4) : 0;
  const weight = pool.map((p, i) => Math.sqrt(passes.get(p.fingerprint) ?? 1) * (1 + (pool.length - i) / pool.length));
  const wTot = weight.reduce((a, b) => a + b, 0) || 1;
  let nMade = 0;
  pool.forEach((parent, i) => {
    const want = Math.max(1, Math.round((nVar * weight[i]) / wTot));
    if (nMade >= nVar) return;
    seed = (seed + 104729) >>> 0;
    const kids = explore(parent.config, { n: Math.min(want, nVar - nMade), kinds: EXPLORE_KINDS, assets, seed, capital, seen });
    for (const cfg of kids) {
      cfg.lab_note = `${cfg.lab_note} (from lab strategy #${parent.id}, passed ${passes.get(parent.fingerprint) ?? 1} night${(passes.get(parent.fingerprint) ?? 1) === 1 ? "" : "s"})`;
      rows.push({ run_id: run.id, asset: cfg.underlying, mode: cfg.rules.daily ? "DAILY" : "INTRADAY", label: labelFor(cfg), fingerprint: fingerprint(cfg), champion: false, config: cfg, stage: "pending" });
      nMade++;
    }
  });
  // New strategies, shared between assets (an index gets twice a commodity's share: it has intraday and option variants).
  const w = assets.map((k) => LAB_ASSETS[k].commodity ? 1 : 2), wsum = w.reduce((a, b) => a + b, 0);
  const nNew = Math.max(0, n - nMade);
  assets.forEach((k, i) => {
    const want = Math.max(1, Math.round((nNew * w[i]) / wsum));
    let made = 0, tries = 0;
    while (made < want && tries < want * 5) {
      tries++; seed = (seed + 7919) >>> 0;
      let cfg: LabConfig;
      try { cfg = generate(k, seed, capital); } catch { continue; }
      const fp = fingerprint(cfg);
      if (seen.has(fp)) continue;
      seen.add(fp); made++;
      rows.push({ run_id: run.id, asset: k, mode: cfg.rules.daily ? "DAILY" : "INTRADAY", label: labelFor(cfg), fingerprint: fp, champion: false, config: cfg, stage: "pending" });
    }
  });
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("lab_results").insert(rows.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
}

/** A variation run for one strategy: the strategy itself as the baseline, plus its relatives of the kinds asked for. */
async function requestPhase(sb: SupabaseClient, run: Run, assets: string[]) {
  const set = run.settings ?? {};
  const { data: q } = await sb.from("lab_requests").select("*").eq("id", set.request_id).single();
  if (!q) throw new Error("The variation request was removed.");
  const parent: LabConfig = {};
  const KEYS = ["strategy_kind", "underlying", "data_security_id", "data_segment", "data_instrument", "exchange", "dhan_symbol", "futures_symbol", "timeframe_min", "rules",
    "direction", "entry_mode", "session_start", "last_entry", "square_off", "intraday", "trade_type", "option_side", "lots", "lot_size", "qty_mode", "product_type",
    "strike_step", "strike_offset", "expiry_weekday", "expiry_flag", "roll_on_expiry", "atr_period", "factor", "entry_trigger", "buffer_points", "after_hours_flip", "risk"];
  for (const k of KEYS) if (q.config?.[k] !== undefined) parent[k] = q.config[k];
  // The lab tests futures; option settings are priced afterwards for the best index results.
  Object.assign(parent, { trade_type: "FUTURES", lots: 1, qty_mode: "LOTS", strategy_kind: "RULES" });
  for (const t of ["session_start", "last_entry", "square_off"]) if (typeof parent[t] === "string") parent[t] = parent[t].slice(0, 5);
  validateRules(parent.rules);
  const seen = new Set<string>([fingerprint(parent)]);
  let kids: LabConfig[];
  if (q.exact) {
    // A manual test: exactly the assets, timeframes and setting steps that were picked, nothing random.
    const out: LabConfig[] = [];
    const add = (c: LabConfig | null) => { if (!c) return; try { validateRules(c.rules); } catch { return; } const fp = fingerprint(c); if (seen.has(fp)) return; seen.add(fp); out.push(c); };
    for (const k of (q.assets ?? []) as string[]) if (k !== parent.underlying && LAB_ASSETS[k]) add(transfer(parent, k));
    for (const t of (q.tfs ?? []) as number[]) add(retime(parent, Number(t)));
    const kinds = (q.kinds ?? []) as string[];
    if (kinds.includes("settings")) settingVariants(parent).forEach(add);
    if (kinds.includes("stops")) stopVariants(parent).forEach(add);
    if (kinds.includes("trailing")) trailVariants(parent).forEach(add);
    kids = out.slice(0, 400);
  } else kids = explore(parent, { n: Math.max(1, Number(q.n) - 1), kinds: (q.kinds ?? EXPLORE_KINDS) as ExploreKind[], assets: assets.filter((k) => k !== parent.underlying), seed: (Number(q.id) * 7919 + Number(run.id)) >>> 0, capital: Number(set.capital ?? 500000), seen });
  const base = { ...parent, lab_note: "The strategy as it is (baseline)" };
  const rows = [base, ...kids].map((cfg, i) => ({ run_id: run.id, asset: cfg.underlying, mode: cfg.rules.daily ? "DAILY" : "INTRADAY", label: labelFor(cfg), fingerprint: fingerprint(cfg),
    champion: i === 0, config: cfg, stage: "pending", requested_by: q.user_id, request_id: q.id }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("lab_results").insert(rows.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
}

/* ---------- failed strategies: a short record, then the row goes ---------- */
type Forgettable = { id: number; fingerprint: string; asset: string; label?: string; mode?: string; score?: number; metrics?: any; round: number; why: string[] };
/** Rows that may be removed when they fail: not starred, not saved as a strategy, not a user's variation run. */
const keepable = (r: { starred?: boolean; promoted_id?: unknown; request_id?: unknown }) => !r.starred && !r.promoted_id && !r.request_id;
/**
 * Failed strategies are removed to save space; lab_tried keeps one line per strategy (asset, result, why it failed,
 * how often it was tried) so the generator never writes it again.
 */
export async function forget(sb: SupabaseClient, items: Forgettable[]) {
  if (!items.length) return;
  const byFp = new Map<string, Forgettable>();
  for (const it of items) if (it.fingerprint) byFp.set(it.fingerprint, it);
  const fps = [...byFp.keys()];
  const { data: old } = fps.length ? await sb.from("lab_tried").select("fingerprint, times").in("fingerprint", fps) : { data: [] };
  const times = new Map((old ?? []).map((o) => [o.fingerprint, Number(o.times) || 0]));
  const now = new Date().toISOString();
  const rows = [...byFp.values()].map((it) => {
    const f = it.metrics?.full ?? {};
    return { fingerprint: it.fingerprint, asset: it.asset, label: (it.label ?? "").slice(0, 300), mode: it.mode ?? null, round: it.round, why: (it.why ?? []).slice(0, 6),
      net: f.net ?? null, win_rate: f.win_rate ?? null, trades: f.n ?? null, score: it.score ?? it.metrics?.score ?? null, times: (times.get(it.fingerprint) ?? 0) + 1, last_at: now };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("lab_tried").upsert(rows.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  const ids = items.map((x) => x.id);
  for (let i = 0; i < ids.length; i += 300) await sb.from("lab_results").delete().in("id", ids.slice(i, i + 300));
  // A winner whose latest re-test failed no longer counts as passed (its earlier results are cleared in turn).
  for (let i = 0; i < fps.length; i += 200) await sb.from("lab_results").update({ passed: false }).in("fingerprint", fps.slice(i, i + 200)).eq("passed", true).eq("starred", false).is("promoted_id", null);
}
/** Clears earlier failures in batches (results kept from before failures were removed straight away). */
async function forgetOld(sb: SupabaseClient, limit = 400) {
  const cols = "id, fingerprint, asset, label, mode, score, metrics, robust, basic_passed, stage, error";
  const { data: rows } = await sb.from("lab_results").select(cols).in("stage", ["screened", "error"]).eq("starred", false).is("promoted_id", null).is("request_id", null)
    .or("basic_passed.eq.false,stage.eq.error,and(robust_status.eq.done,passed.eq.false)").limit(limit);
  await forget(sb, (rows ?? []).map((r: any) => ({ ...r, round: r.stage === "error" ? 0 : r.basic_passed ? 2 : 1,
    why: r.stage === "error" ? [String(r.error ?? "error")] : r.basic_passed ? (r.robust?.why ?? []) : (r.metrics?.why ?? []) })));
  return (rows ?? []).length;
}

/* ---------- robustness: other assets, other timeframes, buy & hold ---------- */
const ROBUST_TFS = [5, 10, 15, 25, 30, 45, 60, 75, 125];
/** Mini and micro contracts follow the same commodity, so they don't count as another asset. */
export const assetRoot = (k: string) => /^GOLD/.test(k) ? "GOLD" : /^SILVER/.test(k) ? "SILVER" : /^CRUDE/.test(k) ? "CRUDE" : /^NAT/.test(k) ? "NATGAS" : /^ZINC/.test(k) ? "ZINC" : /^LEAD/.test(k) ? "LEAD" : /^ALUMIN/.test(k) ? "ALUMINIUM" : k;
type Check = { kind: "self" | "asset" | "tf" | "year"; asset: string; tf: number | null; config: LabConfig };
/** Years back for the year-by-year test: 10 on daily candles; 5 on 5-minute candles (the depth Dhan keeps). */
export const yearsFor = (cfg: LabConfig) => cfg.rules?.daily ? 10 : 5;
/** The checks for one first-round winner, limited to assets the lab has candles for. */
export function robustChecks(cfg: LabConfig, haveD: Set<string>, haveI5: Set<string>): Check[] {
  const out: Check[] = [{ kind: "self", asset: cfg.underlying, tf: null, config: cfg }];
  const daily = !!cfg.rules?.daily, me = LAB_ASSETS[cfg.underlying];
  // Other assets: the same family first (indices for an index strategy, commodities for a commodity one), up to 6.
  const roots = new Set([assetRoot(cfg.underlying)]);
  const pool = Object.keys(LAB_ASSETS).filter((k) => { const r = assetRoot(k); if (roots.has(r) || !haveD.has(k) || !(daily || haveI5.has(k))) return false; roots.add(r); return true; })
    .sort((a, b) => Number(LAB_ASSETS[a].commodity !== me?.commodity) - Number(LAB_ASSETS[b].commodity !== me?.commodity));
  for (const k of pool) {
    if (out.filter((c) => c.kind === "asset").length >= 6) break;
    const c = transfer(cfg, k);
    if (c) out.push({ kind: "asset", asset: k, tf: null, config: c });
  }
  // Other timeframes: the nearest decision timeframes that keep the rules valid (up to 4).
  if (!daily && haveI5.has(cfg.underlying)) {
    const own = Number(cfg.timeframe_min);
    const tfs = ROBUST_TFS.filter((t) => t !== own).sort((a, b) => Math.abs(Math.log(a / own)) - Math.abs(Math.log(b / own)));
    for (const t of tfs) {
      if (out.filter((c) => c.kind === "tf").length >= 4) break;
      const c = retime(cfg, t);
      if (c) out.push({ kind: "tf", asset: cfg.underlying, tf: t, config: c });
    }
  } else if (daily && haveI5.has(cfg.underlying)) {
    // A once-a-day index strategy, decided instead at the close of 60- and 125-minute candles (daily conditions stay daily).
    for (const t of [60, 125]) {
      const c: LabConfig = JSON.parse(JSON.stringify(cfg));
      delete c.rules.daily; c.timeframe_min = t; c.lab_note = `Decided on ${t}-minute candles instead of once a day`;
      try { validateRules(c.rules); out.push({ kind: "tf", asset: cfg.underlying, tf: t, config: c }); } catch { /* skip */ }
    }
  }
  // Round 3: profitable in each of the past years, one check per year (year 1 = the latest 12 months).
  for (let k = 1; k <= yearsFor(cfg); k++) out.push({ kind: "year", asset: cfg.underlying, tf: k, config: cfg });
  return out;
}
/** Buy & hold over the window: 1 lot bought at the first close and held to the last, with its worst fall. */
function buyHold(data: SimData, from: string, to: string, lot: number) {
  const ds = data.daily.filter((d) => d.day >= from && d.day <= to);
  if (ds.length < 2) return null;
  const c0 = ds[0].c;
  let peak = 0, dd = 0;
  for (const d of ds) { const v = (d.c - c0) * lot; peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  const net = Math.trunc((ds[ds.length - 1].c - c0) * lot);
  return { net, max_dd: Math.trunc(dd), ratio: dd > 0 ? +(net / dd).toFixed(2) : null, from: ds[0].day, to: ds[ds.length - 1].day };
}
/** The verdict once every check of a winner is done. */
export function robustVerdict(cfg: LabConfig, checks: { kind: string; asset: string; tf: number | null; result: any }[]) {
  const daily = !!cfg.rules?.daily;
  const self = checks.find((c) => c.kind === "self")?.result ?? null;
  const assets = checks.filter((c) => c.kind === "asset").map((c) => ({ asset: c.asset, ...c.result }));
  const tfs = checks.filter((c) => c.kind === "tf" && !c.result?.skip).map((c) => ({ tf: c.tf, ...c.result }));
  const okA = assets.filter((x) => x.ok).length, okT = tfs.filter((x) => x.ok).length;
  const yrs = checks.filter((c) => c.kind === "year" && !c.result?.skip).map((c) => { const { tr: _t, ...rest } = c.result ?? {}; return { y: c.tf, ...rest }; }).sort((a, b) => a.y - b.y);
  const allTrades = unpackTrades(joinTrades(checks.filter((c) => c.kind === "year" && !c.result?.skip).map((c) => c.result?.tr).filter(Boolean)));
  const okY = yrs.filter((x) => x.ok).length;
  const why: string[] = [];
  if (!self || !(self.net > 0)) why.push("lost money on the latest year");
  if (!assets.length) why.push("no other asset to test it on");
  else if (okA < Math.min(2, assets.length)) why.push(`worked on ${okA} of ${assets.length} other assets (needs ${Math.min(2, assets.length)})`);
  if (tfs.length) { const need = tfs.length >= 3 ? 2 : 1; if (okT < need) why.push(`worked on ${okT} of ${tfs.length} other timeframes (needs ${need})`); }
  else why.push("could not be tested on another timeframe yet (not enough 5-minute candles for this asset; MCX history grows every night)");
  if (yrs.length < 3) why.push(`only ${yrs.length} year${yrs.length === 1 ? "" : "s"} of history to test year by year (needs 3)`);
  else if (okY < yrs.length) why.push(`profitable in ${okY} of the past ${yrs.length} years (needs every year; lost or flat in ${yrs.filter((x) => !x.ok).map((x) => `year ${x.y}`).join(", ")})`);
  const bh = self?.bh ?? null;
  const sRatio = self && self.max_dd > 0 ? self.net / self.max_dd : self?.net > 0 ? 99 : 0;
  let vsBh: number | null = null, riskVsBh: number | null = null;
  if (bh && self) {
    vsBh = bh.net > 0 ? +(self.net / bh.net).toFixed(2) : null;
    riskVsBh = bh.ratio && bh.ratio > 0 ? +(sRatio / bh.ratio).toFixed(2) : null;
    // Shown for comparison only: the strategies trade long and short, so a falling asset is no reason to fail one.
  }
  const quality = qualityScore(yrs, allTrades, { okA, nA: assets.length, okT, nT: tfs.length });
  return { passed: why.length === 0, why, self, bh, vs_bh: vsBh, risk_vs_bh: riskVsBh, assets: { ok: okA, n: assets.length, list: assets },
    tfs: { ok: okT, n: tfs.length, list: tfs }, years: { ok: okY, n: yrs.length, list: yrs }, quality, daily, checked_at: new Date().toISOString() };
}

/* ---------- long trade lists and the quality score ---------- */
type Packed = { e: string[]; x: string[]; s: string[]; i: number[]; o: number[]; n: number[]; w: number[]; why: string[] };
/** Trades packed in columns: entry, exit, side (L/S), in, out, net, exit reason (index into why). */
export function packTrades(ts: Record<string, any>[]): Packed {
  const why: string[] = [], wi = new Map<string, number>();
  const p: Packed = { e: [], x: [], s: [], i: [], o: [], n: [], w: [], why };
  for (const t of ts) {
    const w = String(t.exit_why ?? "").slice(0, 60);
    if (!wi.has(w)) { wi.set(w, why.length); why.push(w); }
    p.e.push(String(t.entry)); p.x.push(String(t.exit)); p.s.push(t.side === "SHORT" ? "S" : "L");
    p.i.push(+Number(t.entry_px ?? 0).toFixed(2)); p.o.push(+Number(t.exit_px ?? 0).toFixed(2)); p.n.push(Math.trunc(Number(t.net) || 0)); p.w.push(wi.get(w)!);
  }
  return p;
}
export function joinTrades(parts: Packed[]): Packed {
  const all = parts.flatMap((p) => unpackTrades(p)).sort((a, b) => a.exit.localeCompare(b.exit));
  return packTrades(all);
}
export function unpackTrades(p: Packed | null | undefined) {
  if (!p || !Array.isArray(p.e)) return [] as { entry: string; exit: string; side: string; entry_px: number; exit_px: number; net: number; exit_why: string }[];
  return p.e.map((e, k) => ({ entry: e, exit: p.x[k], side: p.s[k] === "S" ? "SHORT" : "LONG", entry_px: p.i[k], exit_px: p.o[k], net: p.n[k], exit_why: p.why[p.w[k]] ?? "" }));
}
/**
 * Quality score, 0–100, from the whole year-by-year test (up to 10 years; 5 for 5-minute strategies):
 *  continuity 25 – profitable years, with unbroken runs of profitable years counting more (sum of run lengths² ÷ years²)
 *  months 15     – share of months that made money
 *  return/risk 20 – yearly net ÷ the worst drawdown over the whole period (2 or more scores full)
 *  profit factor 10 – gross profit ÷ gross loss (2.5 or more scores full)
 *  steadiness 15 – how even the yearly profits are (spread of yearly nets, and the worst year against the average)
 *  robustness 10 – share of other assets and other timeframes the rules also worked on
 *  sample 5      – enough trades to trust it (12 or more a year scores full)
 */
export function qualityScore(yrs: { y: number; net: number; n: number; ok: boolean }[], trades: { exit: string; net: number }[], rb: { okA: number; nA: number; okT: number; nT: number }) {
  const n = yrs.length;
  if (n < 1) return null;
  const byOld = [...yrs].sort((a, b) => b.y - a.y); // oldest first
  let runs = 0, cur = 0, best = 0;
  for (const y of byOld) { if (y.ok) { cur++; best = Math.max(best, cur); } else { runs += cur * cur; cur = 0; } }
  runs += cur * cur;
  let latest = 0; for (const y of [...yrs].sort((a, b) => a.y - b.y)) { if (y.ok) latest++; else break; }
  const continuity = runs / (n * n);
  const months = new Map<string, number>();
  let eq = 0, peak = 0, dd = 0, gw = 0, gl = 0;
  for (const t of trades) {
    const v = Number(t.net) || 0;
    eq += v; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    if (v > 0) gw += v; else gl += -v;
    const m = String(t.exit).slice(0, 7); months.set(m, (months.get(m) ?? 0) + v);
  }
  const mVals = [...months.values()], posM = mVals.filter((x) => x > 0).length;
  const monthsShare = mVals.length ? posM / mVals.length : 0;
  const total = trades.reduce((a, t) => a + (Number(t.net) || 0), 0);
  const perYear = total / n;
  const calmar = dd > 0 ? perYear / dd : perYear > 0 ? 9 : 0;
  const pf = gl > 0 ? gw / gl : gw > 0 ? 9 : 0;
  const nets = yrs.map((y) => Number(y.net) || 0), mean = nets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(nets.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const cv = mean > 0 ? sd / mean : 9;
  const worst = Math.min(...nets);
  const steady = mean > 0 ? 0.6 * (1 / (1 + cv)) + 0.4 * Math.max(0, Math.min(1, worst / mean)) : 0;
  const robust = ((rb.nA ? rb.okA / rb.nA : 0) + (rb.nT ? rb.okT / rb.nT : 0)) / 2;
  const sample = Math.min(1, trades.length / (n * 12));
  const parts = {
    continuity: +(25 * continuity).toFixed(1), months: +(15 * monthsShare).toFixed(1), return_risk: +(20 * Math.max(0, Math.min(1, calmar / 2))).toFixed(1),
    profit_factor: +(10 * Math.max(0, Math.min(1, (pf - 1) / 1.5))).toFixed(1), steadiness: +(15 * steady).toFixed(1), robustness: +(10 * robust).toFixed(1), sample: +(5 * sample).toFixed(1),
  };
  const score = +Object.values(parts).reduce((a, b) => a + b, 0).toFixed(1);
  return { score, parts, years: n, profitable_years: yrs.filter((y) => y.ok).length, best_streak: best, latest_streak: latest,
    months: mVals.length, pos_months: posM, net: Math.trunc(total), per_year: Math.trunc(perYear), max_dd: Math.trunc(dd), calmar: +calmar.toFixed(2),
    pf: +pf.toFixed(2), cv: +cv.toFixed(2), worst_year: Math.trunc(worst), trades: trades.length };
}
async function robustPhase(ctx: Ctx, run: Run, win: { from: string; split: string; to: string }, patch: (f: Record<string, unknown>) => unknown): Promise<boolean> {
  const { sb } = ctx;
  const capital = Number(run.settings?.capital ?? 500000);
  // 1. Queue the checks: this run's first-round winners, then (a batch at a time) earlier ones.
  const { data: cands } = await sb.from("lab_candles").select("asset, kind");
  const haveD = new Set((cands ?? []).filter((c) => c.kind === "D").map((c) => c.asset)), haveI5 = new Set((cands ?? []).filter((c) => c.kind === "I5").map((c) => c.asset));
  await sb.from("lab_checks").delete().eq("status", "void");
  await forgetOld(sb, 300);
  const { count: open0 } = await sb.from("lab_checks").select("id", { count: "exact", head: true }).eq("status", "pending");
  for (const mine of [true, false]) {
    if (!mine && (open0 ?? 0) > 600) break;
    let q = sb.from("lab_results").select("id, config").eq("basic_passed", true).is("robust_status", null).order("score", { ascending: false }).limit(mine ? 400 : 60);
    q = mine ? q.eq("run_id", run.id) : q.neq("run_id", run.id);
    const { data: rows } = await q;
    for (const r of rows ?? []) {
      if (Date.now() - ctx.started > WALL_BUDGET - 20000) return true;
      const checks = robustChecks(r.config, haveD, haveI5).map((c) => ({ lab_id: r.id, kind: c.kind, asset: c.asset, tf: c.tf, config: c.config, status: "pending" }));
      const { error } = await sb.from("lab_checks").insert(checks);
      if (error) throw new Error(error.message);
      await sb.from("lab_results").update({ robust_status: "queued" }).eq("id", r.id);
    }
    if (!mine && (rows ?? []).length) break;
  }
  // 2. Run pending checks, one asset's candles at a time.
  const { data: pend } = await sb.from("lab_checks").select("id, lab_id, kind, asset, tf, config").eq("status", "pending").order("lab_id", { ascending: false }).limit(400);
  if (pend?.length) {
    const asset = pend[0].asset, long = pend[0].kind === "year";
    let cpu = 0;
    const t0 = performance.now();
    const data = await loadAsset(sb, asset, long);
    cpu += Math.min(250, performance.now() - t0);
    const memo = new Map<string, unknown>();
    const rates = await loadMarginRates(sb);
    const ups: Promise<unknown>[] = [];
    for (const c of pend.filter((p) => p.asset === asset && (p.kind === "year") === long)) {
      if (cpu > CPU_BUDGET || Date.now() - ctx.started > WALL_BUDGET) break;
      const t1 = performance.now();
      let result: Record<string, unknown>;
      try {
        // Timeframe checks run on 5-minute candles, which for MCX only go back as far as the listed contracts have traded:
        // they are judged on that stretch (after 10 days of warm-up), with the trade minimum scaled to its length.
        let w = win, scale = 1;
        if (c.kind === "year") {
          // Year k = the 12 months ending k-1 years before the test's last day, after warm-up for the indicators.
          const daily = !!c.config.rules?.daily, first = daily ? data.daily[0]?.day : data.raw[0]?.day;
          const hi = addDays(win.to, -365 * (Number(c.tf) - 1)), lo = addDays(hi, -364);
          const warm = first ? addDays(first, daily ? 60 : 20) : hi; // 60 days lets the 10th year back fit in the daily history Dhan has (from mid-2015)
          const from = lo < warm ? warm : lo;
          if ((Date.parse(hi) - Date.parse(from)) / 86400000 < 300) {
            ups.push(sb.from("lab_checks").update({ status: "done", result: { skip: true, ok: false, error: "not enough history" } }).eq("id", c.id).then(() => {}));
            continue;
          }
          const { metrics, trades } = await screenOne(c.config, data, memo, { from, split: from, to: hi }, capital, rates);
          const f = metrics.full;
          result = { from, to: hi, net: f.net, n: f.n, win_rate: f.win_rate, pf: f.pf, max_dd: f.max_dd, ok: f.net > 0, tr: packTrades(trades) };
          cpu += performance.now() - t1;
          ups.push(sb.from("lab_checks").update({ status: "done", result }).eq("id", c.id).then(() => {}));
          continue;
        }
        if (c.kind === "tf") {
          const first = data.raw[0]?.day;
          const from = first ? addDays(first, 10) : win.to;
          if (from > win.from) w = { ...win, from, split: from > win.split ? from : win.split };
          const days = (Date.parse(win.to) - Date.parse(w.from)) / 86400000;
          if (days < 60) { ups.push(sb.from("lab_checks").update({ status: "done", result: { skip: true, ok: false, error: `only ${Math.max(0, Math.round(days))} days of 5-minute candles so far` } }).eq("id", c.id).then(() => {})); continue; }
          scale = Math.min(1, days / 365);
        }
        const { metrics } = await screenOne(c.config, data, memo, w, capital, rates);
        const f = metrics.full, daily = !!c.config.rules?.daily;
        const minN = Math.max(3, Math.round((daily ? 5 : 10) * scale));
        result = { net: f.net, pf: f.pf, max_dd: f.max_dd, n: f.n, win_rate: f.win_rate, test_net: metrics.test.net, ok: f.net > 0 && (f.pf == null || f.pf >= 1.1) && f.n >= minN, ...(w.from !== win.from ? { from: w.from } : {}) };
        if (c.kind === "self") result.bh = buyHold(data, win.from, win.to, Number(c.config.lot_size));
      } catch (e) { result = { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : String(e) }; }
      cpu += performance.now() - t1;
      ups.push(sb.from("lab_checks").update({ status: "done", result }).eq("id", c.id).then(() => {}));
    }
    await Promise.all(ups);
  }
  // 3. Verdicts for winners whose checks are all done.
  const { data: queued } = await sb.from("lab_results").select("id, config, fingerprint, asset, label, mode, score, metrics, starred, promoted_id, request_id").eq("robust_status", "queued").order("id", { ascending: false }).limit(20);
  let decided = 0;
  const ids = (queued ?? []).map((r) => r.id);
  const { data: allCs } = ids.length ? await sb.from("lab_checks").select("lab_id, kind, asset, tf, status, result").in("lab_id", ids).neq("status", "void").limit(1000) : { data: [] };
  for (const r of queued ?? []) {
    const cs = (allCs ?? []).filter((c) => c.lab_id === r.id);
    if (!cs.length || cs.some((c) => c.status === "pending")) continue;
    const v = robustVerdict(r.config, cs);
    // Every trade of the year-by-year test is kept with the result (packed in columns to stay small).
    const longTrades = joinTrades(cs.filter((c) => c.kind === "year" && !c.result?.skip).map((c) => c.result?.tr).filter(Boolean));
    await sb.from("lab_results").update({ robust_status: "done", robust: v, passed: v.passed, trades_long: longTrades }).eq("id", r.id);
    await sb.from("lab_checks").delete().eq("lab_id", r.id);
    if (!v.passed && keepable(r)) await forget(sb, [{ ...r, round: v.why.some((w: string) => /year/.test(w)) && v.why.length === 1 ? 3 : 2, why: v.why }]);
    decided++;
  }
  const { count: left } = await sb.from("lab_checks").select("id", { count: "exact", head: true }).eq("status", "pending");
  const { count: mineLeft } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).eq("basic_passed", true).neq("robust_status", "done");
  const { count: backlog } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("basic_passed", true).is("robust_status", null);
  await patch({ progress: `Tougher test: ${left ?? 0} checks to run${backlog ? `, ${backlog} earlier winners still to re-check` : ""} (${decided} decided just now)` });
  // A nightly run moves on once its own winners are decided; the re-check run keeps going until the backlog is done.
  if (run.trigger === "robust") {
    // Somebody asked for a variation run: stop here so it can start; the re-check resumes afterwards.
    const { count: asks } = await sb.from("lab_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
    if ((asks ?? 0) > 0) return false;
    return (left ?? 0) > 0 || (backlog ?? 0) > 0 || (queued ?? []).length > decided;
  }
  return (mineLeft ?? 0) > 0;
}

async function screenPhase(ctx: Ctx, run: Run, win: { from: string; split: string; to: string }): Promise<boolean> {
  const { sb } = ctx;
  const { data: pend } = await sb.from("lab_results").select("id, asset, config, fingerprint, label, mode, request_id").eq("run_id", run.id).eq("stage", "pending").order("asset").order("id").limit(300);
  if (!pend?.length) return false;
  const asset = pend[0].asset;
  const capital = Number(run.settings?.capital ?? 500000);
  let cpu = 0;
  const t0 = performance.now();
  const data = await loadAsset(sb, asset);
  cpu += Math.min(250, performance.now() - t0);
  const memo = new Map<string, unknown>();
  const rates = await loadMarginRates(sb);
  const updates: Promise<unknown>[] = [];
  const failed: Forgettable[] = [];
  for (const row of pend.filter((p) => p.asset === asset)) {
    if (cpu > CPU_BUDGET || Date.now() - ctx.started > WALL_BUDGET) break;
    const t1 = performance.now();
    let fields: Record<string, unknown>;
    try {
      const { metrics, trades } = await screenOne(row.config, data, memo, win, capital, rates);
      if (!metrics.passed && !row.request_id) {
        // Failed the first round: keep only the short record.
        failed.push({ id: row.id, fingerprint: row.fingerprint, asset: row.asset, label: row.label, mode: row.mode, score: metrics.score, metrics, round: 1, why: metrics.why });
        cpu += performance.now() - t1;
        continue;
      }
      // The walk-forward check is only the first gate: "passed" is set after the robustness checks (other assets,
      // other timeframes, against buy & hold).
      fields = { stage: "screened", basic_passed: metrics.passed, passed: false, robust_status: null, robust: null, score: metrics.score, metrics, trades: slim(trades), error: null };
    } catch (e) {
      fields = { stage: "error", error: e instanceof Error ? e.message : String(e) };
    }
    cpu += performance.now() - t1;
    updates.push(sb.from("lab_results").update(fields).eq("id", row.id).then(() => {}));
  }
  await Promise.all(updates);
  await forget(sb, failed);
  run.counts = run.counts ?? {};
  run.counts.tested = Number(run.counts.tested ?? 0) + updates.length + failed.length;
  run.counts.failed1 = Number(run.counts.failed1 ?? 0) + failed.length;
  await sb.from("lab_runs").update({ counts: run.counts }).eq("id", run.id);
  return true;
}

/** Option-series store backed by the lab_opt_cache table. */
function dbStore(sb: SupabaseClient): OptStore {
  return {
    async get(key) {
      const { data } = await sb.from("lab_opt_cache").select("bars").eq("key", key).maybeSingle();
      return data ? fromCol(data.bars).map((r, i) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, strike: data.bars.s?.[i] ?? null, spot: data.bars.p?.[i] ?? null })) as OptBar[] : null;
    },
    async put(key, rows) {
      const bars = { t: rows.map((r) => r.t), o: rows.map((r) => r.o), h: rows.map((r) => r.h ?? Math.max(r.o, r.c)), l: rows.map((r) => r.l ?? Math.min(r.o, r.c)),
        c: rows.map((r) => r.c), s: rows.map((r) => r.strike), p: rows.map((r) => r.spot) };
      await sb.from("lab_opt_cache").upsert({ key, bars, created_at: new Date().toISOString() });
    },
  };
}

const MAX_BUSY = 12;
/** Dhan's answer when a token was replaced (renewed) or has expired. */
export const TOKEN_ERR = /DH-90[16]|Invalid Token|HTTP 401/i;
/** Option versions priced for each of the night's best index strategies. */
function optVariants(cfg: LabConfig) {
  const own = cfg.risk ? `Same stops as tested (${describeRisk(cfg.risk)})` : "No stop loss";
  return [
    { side: "BUY", label: `Buy options · ${own}`, risk: cfg.risk ?? null },
    { side: "BUY", label: "Buy options · premium stop 30%, target 60%", risk: { basis: "PREMIUM", sl: { type: "PCT", value: 30 }, tgt: { type: "PCT", value: 60 } } },
    { side: "SELL", label: `Write options · ${own}`, risk: cfg.risk ?? null },
    { side: "SELL", label: "Write options · premium stop 50%, target 50%", risk: { basis: "PREMIUM", sl: { type: "PCT", value: 50 }, tgt: { type: "PCT", value: 50 } } },
    // Multi-leg versions: the signal decides the direction; the structure caps the risk.
    { side: "SPREAD", label: `Debit spread (bull call / bear put, 2 strikes wide) · ${own}`, risk: cfg.risk ?? null, structure: { preset: "BULL_CALL", w: 2 } },
    { side: "SPREAD", label: `Credit spread (bull put / bear call, 2 strikes wide) · ${own}`, risk: cfg.risk ?? null, structure: { preset: "BULL_PUT", w: 2 } },
    { side: "SPREAD", label: `Futures + protective option 2 strikes out · ${own}`, risk: cfg.risk ?? null, structure: { preset: "FUT_HEDGED", d: 2 } },
  ] as { side: "BUY" | "SELL" | "SPREAD"; label: string; risk: any; structure?: Record<string, unknown> }[];
}
async function optionsPhase(ctx: Ctx, run: Run, win: { from: string; split: string; to: string }, patch: (f: Record<string, unknown>) => unknown): Promise<boolean> {
  const { sb } = ctx;
  const capital = Number(run.settings?.capital ?? 500000);
  const store = dbStore(sb);
  while (Date.now() - ctx.started < WALL_BUDGET - 15000) {
    const { data: rows } = await sb.from("lab_results").select("id, asset, config, opt_job, opt_buy, opt_sell, opt_struct, label").eq("run_id", run.id).in("stage", ["pricing", "opt_queue"])
      .order("stage", { ascending: false }).order("score", { ascending: false }).limit(1);
    const row = rows?.[0];
    if (!row) return false;
    const a = LAB_ASSETS[row.asset];
    const job = row.opt_job ?? { v: 0 };
    const variants = optVariants(row.config);
    // A version whose pricing keeps getting cut off (the function's CPU limit) without moving forward is skipped,
    // so one heavy version can never hold up the whole lab.
    job.tries = (job.tries ?? 0) + 1;
    if (job.tries > 3) {
      const lastV = job.v + 1 >= variants.length;
      await sb.from("lab_results").update({ stage: lastV ? "priced" : "pricing", opt_job: lastV ? null : { v: job.v + 1 } }).eq("id", row.id);
      continue;
    }
    await sb.from("lab_results").update({ opt_job: job }).eq("id", row.id);
    const vr = variants[job.v];
    const s = { ...row.config, trade_type: "OPTIONS", option_side: vr.side === "SELL" ? "SELL" : "BUY", structure: vr.structure ?? null, risk: vr.risk, strike_offset: 0, strike_step: a.step, expiry_flag: a.flag, expiry_weekday: a.wd, roll_on_expiry: true };
    if (!job.plans) {
      const data = await loadAsset(sb, row.asset);
      job.plans = simulateRules(s, data, win.from, win.to);
      job.cursor = 0; job.acc = newAcc(capital); job.trades = [];
    }
    const { count: left } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).in("stage", ["pricing", "opt_queue"]);
    await patch({ progress: `Real option prices: ${row.label.slice(0, 60)}… (${vr.label}; ${left} strategies to go)` });
    const busyBefore = job.acc.busy ?? 0;
    let res: { trades: Record<string, unknown>[]; next: number; acc: Acc };
    try {
      res = await priceBatch(s, ctx.creds, labParams(a, win.from, win.to, capital), job.plans as Plan[], job.cursor, job.acc,
        // Short slices: reading many saved option series is CPU work, and the function is stopped after 2 s of CPU.
        Math.min(ctx.started + WALL_BUDGET - 10000, Date.now() + 8000), async () => {}, store);
    } catch (e) {
      if (e instanceof DhanBusyError) { job.acc.busy = busyBefore + 1; res = { trades: [], next: job.cursor, acc: job.acc }; }
      else if (TOKEN_ERR.test(e instanceof Error ? e.message : String(e))) {
        // The access token was renewed while this ran: keep the work and carry on with the new token in the next instalment.
        await sb.from("lab_results").update({ stage: "pricing", opt_job: job }).eq("id", row.id);
        return true;
      } else { await sb.from("lab_results").update({ stage: "error", error: e instanceof Error ? e.message : String(e), opt_job: null }).eq("id", row.id); continue; }
    }
    job.tries = 0; // this instalment finished normally: not stuck
    job.trades = job.trades.concat(slim(res.trades)); job.cursor = res.next; job.acc = res.acc;
    if (job.cursor >= job.plans.length) {
      // Option buying ties up the premium; writing ties up margin on the index's contract value.
      const fallback = avg((job.plans as Plan[]).map((pl) => Number(pl.spotIn)));
      const metrics = withTradeMargins(labMetrics(job.trades, win.from, win.split, win.to, !!row.config.rules?.daily), row.config, vr.side, job.trades, await loadMarginRates(sb), fallback);
      // Results with many trades that couldn't be priced aren't trustworthy.
      const unpriced = Object.values(job.acc.skipped ?? {}).reduce((a: number, b) => a + Number(b), 0);
      if (unpriced > job.plans.length * 0.2) { metrics.passed = false; metrics.why.push(`${unpriced} of ${job.plans.length} trades couldn't be priced with real option data`); }
      const out = { label: vr.label, risk: vr.risk, structure: vr.structure ?? null, metrics, trades: job.trades, skipped: job.acc.skipped, planned: job.plans.length };
      const col = vr.side === "BUY" ? "opt_buy" : vr.side === "SELL" ? "opt_sell" : "opt_struct";
      const list = [...((row as any)[col]?.variants ?? []), out];
      // The headline for each side is its best-scoring version; every version is kept.
      const best = list.reduce((x: any, y: any) => (y.metrics.score > x.metrics.score ? y : x));
      const last = job.v + 1 >= variants.length;
      const summary = { label: best.label, risk: best.risk, metrics: best.metrics, versions: list.map((x: any) => ({ label: x.label, score: x.metrics.score, net: x.metrics.full.net, passed: x.metrics.passed })) };
      await sb.from("lab_results").update({ stage: last ? "priced" : "pricing", [col]: { variants: list, best: list.indexOf(best), summary }, opt_job: last ? null : { v: job.v + 1 } }).eq("id", row.id);
      continue;
    }
    if ((job.acc.busy ?? 0) > busyBefore) {
      if ((job.acc.busy ?? 0) > MAX_BUSY) {
        await sb.from("lab_results").update({ stage: "error", error: "Dhan's option-data server kept timing out.", opt_job: null }).eq("id", row.id);
        continue;
      }
      await sb.from("lab_results").update({ stage: "pricing", opt_job: job }).eq("id", row.id);
      await new Promise((r) => setTimeout(r, 20000)); // give Dhan a moment, then carry on in the next instalment
      return true;
    }
    await sb.from("lab_results").update({ stage: "pricing", opt_job: job }).eq("id", row.id);
    return true; // out of time: continue in the next instalment
  }
  return true;
}

/** Keep the tables small: strategies that didn't pass for 7 days, everything else for 45 days unless starred or turned into a strategy. */
async function prune(sb: SupabaseClient) {
  const d = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  // Losers go after a week; first-round winners stay (45 days) so the tougher test's verdict can be seen.
  await sb.from("lab_results").delete().eq("passed", false).or("basic_passed.is.null,basic_passed.eq.false").eq("starred", false).is("promoted_id", null).lt("created_at", d(7));
  await sb.from("lab_results").delete().eq("starred", false).is("promoted_id", null).lt("created_at", d(45));
  await sb.from("lab_opt_cache").delete().lt("created_at", d(420));
  await sb.from("lab_runs").delete().lt("created_at", d(90));
}

/* ---------- long tests: one backtest cut into 3M … 10Y windows ---------- */
export const LONG_WINDOWS: [string, number][] = [["3M", 3], ["6M", 6], ["1Y", 12], ["2Y", 24], ["3Y", 36], ["4Y", 48], ["5Y", 60], ["6Y", 72], ["7Y", 84], ["8Y", 96], ["9Y", 108], ["10Y", 120]];
const monthsBack = (day: string, m: number) => { const [y, mo, d] = day.split("-").map(Number); const t = new Date(Date.UTC(y, mo - 1 - m, d + 1)); return t.toISOString().slice(0, 10); };
/**
 * Results for each window ending on the test's last day. A window is only reported when the test covers it
 * (its start is on or after the first day tested). Figures are for 1 lot, after charges.
 */
export function periodWindows(trades: { exit: string; net: number }[], from: string, to: string, capital: number) {
  const out: Record<string, unknown> = {};
  for (const [k, m] of LONG_WINDOWS) {
    const start = monthsBack(to, m);
    if (start < addDays(from, -7)) { out[k] = null; continue; }
    const ts = trades.filter((t) => { const d = String(t.exit).slice(0, 10); return d >= start && d <= to; });
    let eq = 0, peak = 0, dd = 0, win = 0, gw = 0, gl = 0;
    const byMonth = new Map<string, number>();
    for (const t of ts) {
      const n = Number(t.net) || 0;
      eq += n; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
      if (n > 0) { win++; gw += n; } else gl += -n;
      const mk = String(t.exit).slice(0, 7); byMonth.set(mk, (byMonth.get(mk) ?? 0) + n);
    }
    const yrs = m / 12;
    out[k] = { from: start, n: ts.length, net: Math.trunc(eq), win_rate: ts.length ? +((win / ts.length) * 100).toFixed(1) : 0,
      pf: gl > 0 ? +(gw / gl).toFixed(2) : null, max_dd: Math.trunc(dd), ret_pct: +((eq / capital) * 100).toFixed(1),
      ret_yr: +(((eq / capital) * 100) / yrs).toFixed(1), months_pos: [...byMonth.values()].filter((x) => x > 0).length, months: byMonth.size,
      ratio: dd > 0 ? +(eq / dd).toFixed(2) : null };
  }
  return out;
}
