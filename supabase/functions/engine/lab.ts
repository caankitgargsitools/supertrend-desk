// Strategy lab: every evening it invents condition strategies, backtests each one on the past year and keeps score.
//   data      – refresh a candle cache per asset (5-minute index candles, daily candles for everything)
//   generate  – write tonight's strategies (new random ones plus the best recent ones, re-tested on the rolling year)
//   screen    – backtest each as futures (index futures proxy / MCX near-month futures), with charges
//   options   – the best index strategies are re-priced with real expired-option prices, as option buying and option writing
// Scoring is walk-forward: strategies are ranked on months 1–9 and must also make money in the last 3 months.
// Each step runs in a short instalment (Supabase allows ~2 s of computing per call) and chains to the next.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Dhan, DhanBusyError, type OptBar } from "./dhan.ts";
import { type Acc, type BtParams, type ChargeRates, type MBar, newAcc, type OptStore, slippageFor, type Plan, priceBatch, simulateRules, type SimData } from "./backtest.ts";
import { addDays, type DayBar, isCrypto, ist, sessionFor } from "./logic.ts";
import { describeCond, HAS_WEIGHTS, type Cond, type Rules, validateRules } from "./rules.ts";
import { dataSecurity } from "./instruments.ts";
import { describeRisk, type Risk } from "./risk.ts";
import { loadMarginRates, type MarginRate, refreshMargins } from "./margins.ts";
import { readCandles, saveCandles } from "./candles.ts";
import { deflatedSharpe, median, pbo } from "./stats.ts";
import { closesFor, pValue, randomEntries, shuffledData } from "./noise.ts";
export { readCandles, saveCandles };
import { CRYPTO, cryptoDaily, cryptoFunding, cryptoIntraday, cryptoLot, loadCrypto } from "./crypto.ts";

/* ---------- assets ---------- */
export type LabAsset = {
  key: string; name: string; seg: string; sec: string; instr: string; exchange: string; lot: number; commodity: boolean;
  step?: number; wd?: number; flag?: "WEEK" | "MONTH"; crypto?: boolean;
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

/* ---------- crypto (Delta Exchange perpetuals) ---------- */
/**
 * Adds the enabled coins of crypto_assets to the asset list (and drops ones switched off). Their "lot" is the rupee
 * P&L of one contract for a $1 move (coins per contract × rupees per dollar). Called at the start of every request.
 */
export async function loadCryptoAssets(sb: SupabaseClient) {
  await loadCrypto(sb);
  for (const [k, a] of Object.entries(LAB_ASSETS)) if (a.crypto && !CRYPTO[k]) delete LAB_ASSETS[k];
  for (const c of Object.values(CRYPTO)) {
    LAB_ASSETS[c.key] = { key: c.key, name: c.name, seg: "DELTA", sec: c.key, instr: "PERP", exchange: "DELTA", lot: cryptoLot(c), commodity: false, crypto: true };
  }
}
/** Decision timeframes the lab uses per kind of asset. Crypto runs on 15-minute base candles (it trades 18½ hours a day). */
export const TF_INDEX = [5, 10, 15, 25, 30, 45, 60, 75, 125], TF_CRYPTO = [15, 30, 45, 60, 120, 240];
export const tfsFor = (key: string) => LAB_ASSETS[key]?.crypto ? TF_CRYPTO : TF_INDEX;
/** The nearest timeframe in a list (a 25-minute idea becomes 30 minutes on crypto, 120 becomes 125 on an index). */
const nearestTf = (tf: number, list: number[]) => list.reduce((b, x) => Math.abs(Math.log(x / tf)) < Math.abs(Math.log(b / tf)) ? x : b, list[0]);
/** Moves every timeframe of a strategy into the target asset's set (decision candles and condition candles). */
function fitTimeframes(cfg: LabConfig, key: string) {
  if (cfg.rules?.daily) return;
  const list = tfsFor(key);
  const own = nearestTf(Number(cfg.timeframe_min), list);
  cfg.timeframe_min = own;
  for (const k of ["long", "short", "exitLong", "exitShort"] as const) {
    for (const c of (cfg.rules?.[k]?.conds ?? []) as Cond[]) {
      if (c.tf === "base" || c.tf === "D" || c.tf === "W") continue;
      const v = nearestTf(Number(c.tf), list.filter((x) => x > own));
      c.tf = Number(c.tf) > own && list.some((x) => x > own) ? String(v) : "base";
    }
  }
}

/** Charge rates (%), the same defaults as the backtest form. */
export function chargeRates(a: LabAsset): ChargeRates {
  // Delta Exchange India: 0.05% taker fee on the contract value each side, plus 18% GST on it; no STT or stamp duty.
  if (a.crypto) return { brk_pct: 0, stt_fut: 0, stt_opt: 0, exch_fut: 0.05, exch_opt: 0.03, sebi: 0, gst: 18, stamp_fut: 0, stamp_opt: 0 };
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
  ["cross_above_pdh", "cross_below_pdl"], ["above_orh", "below_orl"], ["cross_above_orh", "cross_below_orl"], ["bull_sweep", "bear_sweep"],
  ["new_high", "new_low"], ["above_mid", "below_mid"], ["btc_up", "btc_down"], ["has_buy", "has_sell"]]) { MIRROR[a] = b; MIRROR[b] = a; }

/** The same condition for the other direction (RSI 60 ↔ 40; ADX and ATR are non-directional and stay as they are). */
export function mirror(c: Cond): Cond {
  if (c.ind === "ADX" || c.ind === "ATR") return c.op in MIRROR ? { ...c, op: MIRROR[c.op] } : { ...c };
  // Volatility and time filters work the same for both directions.
  if (c.ind === "VOL" || c.ind === "TIME") return { ...c };
  // Funding (contrarian): longs when funding is low (crowd short) ↔ shorts when it is high (crowd long).
  if (c.ind === "FUND") return { ...c, op: c.op === "lt" ? "gt" : "lt", v: +(0.02 - Number(c.v ?? 0)).toFixed(4) };
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
export function generate(assetKey: string, seed: number, capital = 500000, hasPct = 8): LabConfig {
  const a = LAB_ASSETS[assetKey];
  // A set share of new strategies (lab_settings.ha_strength_pct, default 8%) trade on Heikin Ashi strength.
  if (((Math.imul(seed, 2654435761) >>> 0) % 1000) < hasPct * 10) return generateHAS(a, seed, capital);
  if (a.crypto) return generateCrypto(a, seed, capital);
  const r = rng(seed);
  const cr = !!a.crypto;
  const daily = a.commodity || r() < (cr ? 0.3 : 0.15);
  const okTpl = (xs: [Tpl, boolean][]) => xs.filter(([, intra]) => !(daily && intra)).map(([t]) => t);
  const tf = daily ? 375 : pick(r, cr ? [15, 15, 30, 30, 45, 60, 60, 120, 240] : [5, 10, 15, 15, 25, 30, 30, 45, 60, 75, 125]);
  const higher = daily ? [] : (cr ? [30, 60, 120, 240] : [15, 25, 30, 60, 75, 125]).filter((x) => x > tf && x % 5 === 0 && x !== tf).map(String).concat(["D"]);
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
  if (cr) Object.assign(cfg, cryptoTimes(cfg, r), { futures_symbol: a.key });
  cfg.risk = randomRisk(r, daily, intraday, capital);
  validateRules(cfg.rules);
  return cfg;
}

/** Crypto session times: crypto trades round the clock (the desk's crypto day is the IST calendar day). */
function cryptoTimes(cfg: LabConfig, r?: R) {
  if (cfg.rules?.daily || !cfg.intraday) return { session_start: "00:00", last_entry: "23:59", square_off: "23:59" };
  return { session_start: r ? pick(r, ["00:00", "00:00", "05:30", "13:30", "18:00"]) : "00:00", last_entry: r ? pick(r, ["21:00", "22:30", "23:30"]) : "23:30", square_off: "23:45" };
}

/* ---------- Heikin Ashi strength generator ---------- */
/**
 * Buy on a green Heikin Ashi candle, sell on a red one, hold through dojis, and act only when the candle is strong
 * enough: each side gets its own minimum strength (say buy at 60+, sell at 70+), drawn at random, as are the strength
 * recipe (balanced / candle shape / trend / momentum), the ADX length and the doji size. Some also exit early on a
 * weaker opposite candle instead of waiting for a strong one, and some add a higher-timeframe trend filter.
 */
export function generateHAS(a: LabAsset, seed: number, capital = 500000): LabConfig {
  const r = rng(seed ^ 0x5a17);
  const cr = !!a.crypto;
  const daily = a.commodity || r() < (cr ? 0.6 : 0.25);
  const tf = daily ? 375 : pick(r, cr ? [60, 120, 240, 240] : [15, 25, 30, 60, 75, 125]);
  const ctf = daily ? (cr && r() < 0.25 ? "W" : "D") : "base";
  const p = { len: pick(r, [10, 14, 20]), w: pick(r, [0, 1, 2, 3]), doji: pick(r, [5, 10, 10, 15, 20]) };
  const lv = [40, 50, 55, 60, 65, 70, 75, 80];
  const buyAt = pick(r, lv), sellAt = pick(r, lv);
  const conds: Cond[] = [{ ind: "HAS", tf: ctf, p, op: "has_buy", v: buyAt }];
  const short: Cond[] = [{ ind: "HAS", tf: ctf, p, op: "has_sell", v: sellAt }];
  if (r() < 0.35) {
    // Only in the direction of a slower trend (higher timeframe, or daily/weekly for a daily strategy).
    const htf = daily ? (ctf === "W" ? "W" : pick(r, ["D", "W"])) : pick(r, (cr ? ["240", "D"] : ["60", "125", "D"]).filter((x) => x === "D" || Number(x) > tf));
    const f: Cond = r() < 0.5 ? { ind: "ST", tf: htf, p: st(r), op: "up" } : { ind: "EMA", tf: htf, p: { len: pick(r, [20, 50, 100, 200]) }, op: "price_above" };
    if (!(f.tf === ctf && daily)) { conds.push(f); short.push(mirror(f)); }
  }
  const dir = r();
  const direction = dir < 0.7 ? "BOTH" : dir < 0.9 ? "LONG_ONLY" : "SHORT_ONLY";
  // Exits: wait for a strong opposite candle (stop and reverse), or get out on any opposite candle above a lower level.
  const early = direction !== "BOTH" || r() < 0.4;
  const exitAt = pick(r, [0, 20, 30, 40, 50]);
  const rules: Rules = {
    long: { mode: "ALL", conds: direction === "SHORT_ONLY" ? [] : conds },
    short: { mode: "ALL", conds: direction === "LONG_ONLY" ? [] : short },
    exitLong: { mode: "ANY", conds: early ? [{ ind: "HAS", tf: ctf, p, op: "has_sell", v: exitAt }] : [] },
    exitShort: { mode: "ANY", conds: early ? [{ ind: "HAS", tf: ctf, p, op: "has_buy", v: exitAt }] : [] },
    ...(daily ? { daily: true } : {}),
  };
  const intraday = !daily && !cr && r() < 0.6;
  const cfg: LabConfig = {
    strategy_kind: "RULES", underlying: a.key, data_security_id: a.sec, data_segment: a.seg, data_instrument: a.instr,
    exchange: a.exchange, dhan_symbol: a.key, futures_symbol: cr ? a.key : a.key + "1!", timeframe_min: tf, rules, direction,
    entry_mode: r() < 0.5 ? "FLIP" : "JOIN", intraday, lots: 1, lot_size: a.lot, qty_mode: "LOTS",
    session_start: daily ? "09:15" : intraday ? pick(r, ["09:15", "09:30", "10:15"]) : "09:15",
    last_entry: daily ? "15:15" : intraday ? pick(r, ["14:30", "15:00"]) : "15:15", square_off: intraday ? "15:15" : "15:20",
    trade_type: "FUTURES", option_side: "BUY", product_type: intraday ? "I" : "M", strike_step: a.step ?? 1, strike_offset: 0,
    expiry_weekday: a.wd ?? 4, expiry_flag: a.flag ?? "WEEK", roll_on_expiry: true, atr_period: 10, factor: 3, entry_trigger: "CLOSE",
    buffer_points: 0, after_hours_flip: "FIRST_CLOSE",
    lab_note: `Heikin Ashi strength: buy ≥ ${buyAt}, sell ≥ ${sellAt}${early ? `, exit on an opposite candle ≥ ${exitAt}` : ""}, ${HAS_WEIGHTS[p.w].name} recipe`,
  };
  if (a.commodity) Object.assign(cfg, { session_start: "09:00", last_entry: "23:00", square_off: "23:15" });
  if (cr) Object.assign(cfg, cryptoTimes(cfg, r));
  cfg.risk = cr ? (r() < 0.5 ? null : { basis: "UNDERLYING", atr_len: 14, sl: null, tgt: null, trail: { type: "ATR", value: pick(r, [2, 3, 4]) }, max_day_loss: null })
    : randomRisk(r, daily, intraday, capital);
  validateRules(cfg.rules);
  return cfg;
}

/* ---------- crypto generator ---------- */
/**
 * Crypto strategies follow what the research and the lab's own results point to: slow trend following (daily and weekly
 * Supertrend, Heikin Ashi colour, moving averages, Donchian breakouts), buying dips only inside an uptrend, and the
 * late-US-evening hours (21:00–23:00 UTC = 02:30–04:30 IST). Long and short both, so a crash year can still be a
 * profitable year; few trades, because every trade pays about 0.12% in fees and GST plus slippage and funding.
 */
export function generateCrypto(a: LabAsset, seed: number, capital = 500000): LabConfig {
  const r = rng(seed);
  const btc = a.key === "BTCUSD";
  const sr = r();
  const style = sr < 0.4 ? "trend" : sr < 0.62 ? "breakout" : sr < 0.8 ? "dip" : sr < 0.9 ? "hours" : "intratrend";
  const daily = style !== "hours" && style !== "intratrend";
  const dtf = () => (r() < 0.3 ? "W" : "D");
  const conds: Cond[] = [];
  let exitLong: Cond[] = [];
  let tf = daily ? 375 : 60, intraday = false, times: Record<string, string> | null = null, direction = r() < 0.75 ? "BOTH" : r() < 0.6 ? "LONG_ONLY" : "SHORT_ONLY";
  const TREND: Tpl[] = [
    (q) => ({ ind: "ST", p: st(q), op: "up" }),
    () => ({ ind: "HA", op: "green" }),
    (q) => { const [x, y] = pick(q, [[9, 21], [20, 50], [50, 100], [50, 200], [13, 34]]); return { ind: "EMA", p: { len: x, len2: y }, op: "fast_above_slow" }; },
    (q) => ({ ind: pick(q, ["EMA", "SMA"]), p: { len: pick(q, [20, 50, 100, 200]) }, op: "price_above" }),
    (q) => ({ ind: "DON", p: { len: pick(q, [20, 30, 55]) }, op: "above_mid" }),
    (q) => ({ ind: "MACD", p: pick(q, [{ fast: 12, slow: 26, sig: 9 }, { fast: 8, slow: 21, sig: 5 }]), op: pick(q, ["above_zero", "above_signal"]) }),
  ];
  const filters = (tfx: () => string) => {
    const out: Cond[] = [];
    if (r() < 0.35) out.push({ ind: "VOL", tf: tfx(), p: { len: pick(r, [10, 20, 30]), look: pick(r, [120, 250, 365]) }, op: pick(r, ["high_vol", "low_vol"]) });
    if (r() < 0.25) out.push({ ind: "ADX", tf: tfx(), p: { len: pick(r, ADX_LEN) }, op: "gt", v: pick(r, [18, 20, 25]) });
    if (!btc && r() < 0.35) out.push({ ind: "BTC", tf: "D", p: { len: pick(r, [20, 50, 100, 200]) }, op: "btc_up" });
    // (Funding is offered in the strategy builder only: Delta's history starts in late 2023, too short for the
    // every-year test.)
    return out;
  };
  if (style === "trend") {
    // Stop and reverse on a slow trend signal (weekly or daily); its mirror rides the downtrends short.
    const primary = { ...pick(r, TREND)(r), tf: dtf() } as Cond;
    conds.push(primary);
    if (r() < 0.4) { const f = { ...pick(r, TREND)(r), tf: primary.tf === "W" ? "D" : pick(r, ["D", "W"]) } as Cond; if (f.ind !== primary.ind) conds.push(f); }
    conds.push(...filters(() => "D"));
  } else if (style === "breakout") {
    // New N-day high (or low for the short side): momentum after new highs is Bitcoin's best-documented edge.
    const len = pick(r, [10, 20, 30, 55]);
    conds.push({ ind: "DON", tf: "D", p: { len }, op: "new_high" });
    if (r() < 0.5) conds.push({ ...pick(r, TREND)(r), tf: dtf() } as Cond);
    conds.push(...filters(() => "D"));
    exitLong = [r() < 0.5 ? { ind: "DON", tf: "D", p: { len: Math.max(5, Math.round(len / 2)) }, op: "new_low" } : mirror({ ...pick(r, TREND.slice(0, 2))(r), tf: "D" } as Cond)];
  } else if (style === "dip") {
    // Buy a fresh N-day low only while the longer trend is up (and short a fresh high in a downtrend).
    const len = pick(r, [5, 10, 15, 20]);
    conds.push({ ind: "DON", tf: "D", p: { len }, op: "new_low" }, { ind: pick(r, ["EMA", "SMA"]), tf: "D", p: { len: pick(r, [50, 100, 200]) }, op: "price_above" });
    if (r() < 0.5) conds[0] = { ind: "RSI", tf: "D", p: { len: pick(r, [2, 3, 5, 7]) }, op: "lt", v: pick(r, [10, 15, 20, 25]) };
    conds.push(...filters(() => "D"));
    exitLong = [r() < 0.5 ? { ind: "DON", tf: "D", p: { len: pick(r, [5, 10]) }, op: "new_high" } : { ind: "RSI", tf: "D", p: { len: 3 }, op: "gt", v: pick(r, [60, 70, 80]) }];
  } else if (style === "hours") {
    // The late-US-evening window: in by 02:30 IST, out by 04:30–05:30 IST, mostly in uptrends.
    tf = 30; intraday = true; direction = r() < 0.8 ? "LONG_ONLY" : "BOTH";
    conds.push({ ind: "TIME", tf: "base", p: { from: 2, to: 6 }, op: "in_hours" });
    conds.push({ ...pick(r, TREND)(r), tf: "D" } as Cond);
    if (r() < 0.4) conds.push({ ind: "TIME", tf: "base", p: { d: 6 }, op: "on_weekday" }); // Friday night in the US = early Saturday IST
    if (r() < 0.3) conds.push({ ind: "VOL", tf: "D", p: { len: 30, look: 365 }, op: "high_vol" });
    times = { session_start: "02:00", last_entry: "03:00", square_off: pick(r, ["04:30", "05:30"]) };
  } else {
    // Positional on 4-hour / 2-hour candles in the direction of the daily trend.
    tf = pick(r, [240, 240, 120]);
    conds.push({ ...pick(r, TREND)(r), tf: "base" } as Cond, { ...pick(r, TREND)(r), tf: pick(r, ["D", "W"]) } as Cond);
    conds.push(...filters(() => "D"));
  }
  // De-duplicate identical indicator/timeframe pairs.
  const seen = new Set<string>(); const cs = conds.filter((c) => { const k = `${c.ind}|${c.tf}|${c.op}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const rules: Rules = {
    long: { mode: "ALL", conds: cs }, short: { mode: "ALL", conds: cs.map(mirror) },
    exitLong: { mode: "ANY", conds: exitLong }, exitShort: { mode: "ANY", conds: exitLong.map(mirror) },
    ...(daily ? { daily: true } : {}),
  };
  if (style === "hours") { rules.exitLong = { mode: "ANY", conds: [] }; rules.exitShort = { mode: "ANY", conds: [] }; }
  if (direction === "LONG_ONLY") rules.short = { mode: "ALL", conds: [] };
  if (direction === "SHORT_ONLY") rules.long = { mode: "ALL", conds: [] };
  if (direction !== "BOTH" && !exitLong.length && style !== "hours") {
    rules.exitLong = { mode: "ANY", conds: [mirror(cs[0])] }; rules.exitShort = { mode: "ANY", conds: [cs[0]] };
  }
  const cfg: LabConfig = {
    strategy_kind: "RULES", underlying: a.key, data_security_id: a.sec, data_segment: a.seg, data_instrument: a.instr,
    exchange: a.exchange, dhan_symbol: a.key, futures_symbol: a.key, timeframe_min: tf, rules, direction,
    entry_mode: style === "hours" ? "JOIN" : r() < 0.8 ? "FLIP" : "JOIN", intraday, lots: 1, lot_size: a.lot, qty_mode: "LOTS",
    trade_type: "FUTURES", option_side: "BUY", product_type: intraday ? "I" : "M", strike_step: 1, strike_offset: 0, expiry_weekday: 4, expiry_flag: "WEEK",
    roll_on_expiry: true, atr_period: 10, factor: 3, entry_trigger: "CLOSE", buffer_points: 0, after_hours_flip: "FIRST_CLOSE",
  };
  Object.assign(cfg, times ?? cryptoTimes(cfg, r));
  // Wide stops: trends need room. ATR trailing stops on most; some with no stop (the opposite signal closes them).
  const rk = r();
  cfg.risk = rk < 0.25 ? null
    : rk < 0.7 ? { basis: "UNDERLYING", atr_len: pick(r, [14, 20]), sl: null, tgt: null, trail: { type: "ATR", value: pick(r, [2, 2.5, 3, 4]) }, max_day_loss: null }
    : { basis: "UNDERLYING", atr_len: pick(r, [14, 20]), sl: { type: "ATR", value: pick(r, [1.5, 2, 3]) }, tgt: r() < 0.4 ? { type: "ATR", value: pick(r, [4, 6, 8]) } : null, trail: null, max_day_loss: null };
  if (style === "hours") cfg.risk = r() < 0.5 ? null : { basis: "UNDERLYING", atr_len: 14, sl: { type: "PCT", value: pick(r, [1, 1.5, 2]) }, tgt: null, trail: null, max_day_loss: null };
  void capital;
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
      const old = cfg.timeframe_min, nv = neighbour(tfsFor(cfg.underlying), old, r);
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
      const cr = !!LAB_ASSETS[cfg.underlying]?.crypto;
      const old = cfg.session_start; cfg.session_start = pick(r, (cr ? ["00:00", "05:30", "09:00", "13:30", "18:00"] : ["09:15", "09:20", "09:30", "09:45", "10:15"]).filter((x) => x !== old)); changes.push(`first trade from ${old} → ${cfg.session_start}`);
    } else if (!daily && !LAB_ASSETS[cfg.underlying]?.commodity) {
      cfg.intraday = !cfg.intraday; cfg.product_type = cfg.intraday ? "I" : "M";
      if (LAB_ASSETS[cfg.underlying]?.crypto) Object.assign(cfg, cfg.intraday ? { last_entry: "23:00", square_off: "23:45" } : { session_start: "00:00", last_entry: "23:59", square_off: "23:59" });
      else if (cfg.intraday) Object.assign(cfg, { last_entry: "14:30", square_off: "15:15" }); else Object.assign(cfg, { last_entry: "15:15", square_off: "15:20" });
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
  const INT = new Set(["len", "len2", "atr", "fast", "slow", "sig", "mins", "within", "look"]);
  for (const k of sets) for (const c of parent.rules[k].conds as Cond[]) {
    if (c.ind === "TIME" || c.ind === "FUND") continue; // a clock window or funding level isn't a setting to nudge
    const key = `${c.ind}|${c.tf}|${JSON.stringify(c.p ?? {})}`;
    if (seenCond.has(key)) continue;
    seenCond.add(key);
    const same = (x: Cond) => x.ind === c.ind && x.tf === c.tf && JSON.stringify(x.p ?? {}) === JSON.stringify(c.p ?? {});
    for (const [pk, pv] of Object.entries(c.p ?? {})) {
      if (pk === "src") continue;
      const v0 = Number(pv);
      const steps = pk === "w" ? [0, 1, 2, 3].filter((x) => x !== v0) : pk === "doji" ? [5, 10, 15, 20].filter((x) => x !== v0) : INT.has(pk)
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
        if ((c.ind === "RSI" || c.ind === "HAS") && (nv <= 0 || nv >= 100)) continue;
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
/**
 * Same rules on another asset. Intraday strategies can move to MCX too (5-minute MCX candles go back as far as the
 * listed contracts have traded, so the test there is shorter); MCX sessions run 09:00–23:30.
 */
export function transfer(parent: LabConfig, key: string): LabConfig | null {
  const a = LAB_ASSETS[key];
  if (!a || key === parent.underlying) return null;
  const daily = !!parent.rules?.daily;
  const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
  Object.assign(cfg, { underlying: a.key, data_security_id: a.sec, data_segment: a.seg, data_instrument: a.instr, exchange: a.exchange, dhan_symbol: a.key,
    futures_symbol: a.crypto ? a.key : a.key + "1!", lot_size: a.lot, strike_step: a.step ?? 1, expiry_weekday: a.wd ?? 4, expiry_flag: a.flag ?? "WEEK" });
  const from = LAB_ASSETS[parent.underlying];
  if (a.commodity) Object.assign(cfg, { session_start: "09:00", last_entry: "23:00", square_off: "23:15", ...(daily ? { intraday: false, product_type: "M" } : {}) });
  else if (a.crypto) Object.assign(cfg, cryptoTimes(cfg));
  else if (from?.commodity || from?.crypto) Object.assign(cfg, cfg.intraday ? { session_start: "09:15", last_entry: "14:30", square_off: "15:15" } : { session_start: "09:15", last_entry: "15:15", square_off: "15:20" });
  // Timeframes the target's candles support (crypto: 15-minute steps; indices and MCX: 5-minute steps).
  if (!!a.crypto !== !!from?.crypto) { fitTimeframes(cfg, key); try { validateRules(cfg.rules); } catch { return null; } }
  // A rupee daily loss limit sized for one contract means nothing on another.
  if (cfg.risk?.max_day_loss) cfg.risk.max_day_loss = null;
  cfg.lab_note = `Same rules on ${a.name}`;
  return cfg;
}
/** Same rules decided on a different candle timeframe (conditions on the strategy's own timeframe move with it). */
export function retime(parent: LabConfig, tf: number): LabConfig | null {
  if (!(tf > 0)) return null;
  if (parent.rules?.daily) {
    // A once-a-day strategy decided instead at the close of every tf-minute candle; its daily conditions stay daily
    // (the same change the tougher test makes for its "other timeframes" check).
    const cfg: LabConfig = JSON.parse(JSON.stringify(parent));
    delete cfg.rules.daily; cfg.timeframe_min = tf;
    cfg.lab_note = `Decided on ${tf}-minute candles instead of once a day`;
    try { validateRules(cfg.rules); } catch { return null; }
    return cfg;
  }
  if (tf === parent.timeframe_min) return null;
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
  const higher = daily ? ["D"] : (LAB_ASSETS[cfg.underlying]?.crypto ? [30, 60, 120, 240] : [15, 25, 30, 60, 75, 125]).filter((x) => x > tf).map(String).concat(["D"]);
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
    timeframes: tfsFor(parent.underlying).map((t) => retime(parent, t)).filter((x): x is LabConfig => !!x),
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
/**
 * The vault: the most recent months are held back from everything that picks or tunes strategies (generation, the
 * ranked 9 months and the 3 after, the year-by-year test, other assets / timeframes, setting steps). A strategy sees
 * them once, at the very end, and must make money there. 6 months; 3 for minute strategies on MCX, whose minute
 * history is only about a year deep.
 */
export const vaultDays = (cfg: LabConfig) => (!cfg.rules?.daily && LAB_ASSETS[cfg.underlying]?.commodity ? 92 : 182);
/** A run's window moved back to end where the vault starts (same shape: 12 months, the last 3 as the test). */
export function preVault(win: { from: string; split: string; to: string }, cfg: LabConfig) {
  const to = addDays(win.to, -(Number(cfg.vault_days) || vaultDays(cfg)));
  return { from: addDays(to, -YEAR_DAYS), split: addDays(to, -92), to };
}

/** Bring an asset's cached candles up to date (5-minute candles for indices, daily candles for every asset). */
export async function refreshAsset(sb: SupabaseClient, creds: { client: string; token: string }, key: string, today: string, freshHours = 0) {
  const a = LAB_ASSETS[key];
  if (freshHours > 0) {
    // Back-to-back runs (around-the-clock mode) reuse candles fetched in the last few hours.
    const { data: d } = await sb.from("lab_candles").select("updated_at").eq("asset", key).eq("kind", "D").maybeSingle();
    if (d && Date.now() - Date.parse(d.updated_at) < freshHours * 3600000) return;
  }
  if (a.crypto) return refreshCrypto(sb, a, today);
  const dhan = new Dhan(creds.client, creds.token);
  const sec = (await dataSecurity(sb, creds, a.seg, a.sec, today)).sec;
  // 11 years of daily candles: the year-by-year test covers 10 years (plus warm-up for the indicators).
  const daily = await dhan.daily(sec, a.seg, a.instr, addDays(today, -4100), addDays(today, 1));
  await saveCandles(sb, { asset: key, kind: "D", from_day: daily[0]?.day ?? today, to_day: daily.at(-1)?.day ?? today, bars: toCol(daily, false) });
  const want = addDays(today, -(YEAR_DAYS + WARM_DAYS));
  if (a.commodity) return refreshMcxIntraday(sb, dhan, a, today, want);
  const cached = (await readCandles(sb, key, ["I5"]))[0];
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
  await saveCandles(sb, { asset: key, kind: "I5", from_day: ist(rows[0]?.t ?? lo).date, to_day: ist(rows.at(-1)?.t ?? lo).date, bars: toCol(rows, false) });
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
    await saveCandles(sb, { asset: a.key, kind: `I5Y:${y}`, from_day: ist(rows[0].t).date, to_day: ist(rows.at(-1)!.t).date, bars: toCol(rows, false) });
  }
}

/**
 * A coin's candles: 11 years of daily candles, the latest 17 months of 15-minute candles ("I5", kept up to date), and
 * one row of 15-minute candles per earlier calendar year for the year-by-year test (two missing years per run, so a
 * first download is spread over a couple of runs). Crypto trades all day, so every candle is kept.
 */
async function refreshCrypto(sb: SupabaseClient, a: LabAsset, today: string) {
  const daily = await cryptoDaily(a.sec, addDays(today, -4100), addDays(today, 1));
  try {
    const fm = await cryptoFunding(a.sec, "2023-12-01", addDays(today, 1));
    const d = [...fm.keys()].sort();
    if (d.length) await saveCandles(sb, { asset: a.key, kind: "F", from_day: d[0], to_day: d.at(-1)!, bars: { d, r: d.map((x) => +fm.get(x)!.toFixed(6)) } });
  } catch (e) { console.error("funding", a.key, e); }
  await saveCandles(sb, { asset: a.key, kind: "D", from_day: daily[0]?.day ?? today, to_day: daily.at(-1)?.day ?? today, bars: toCol(daily, true) });
  const inSess = (t: number) => { const p = ist(t), ss = sessionFor(a.seg, p.date); return p.min >= ss.open && p.min < ss.close; };
  const want = addDays(today, -(YEAR_DAYS + WARM_DAYS));
  const cached = (await readCandles(sb, a.key, ["I5"]))[0];
  const map = new Map<number, { t: number; o: number; h: number; l: number; c: number; v?: number }>();
  let start = want;
  if (cached && cached.from_day <= addDays(want, 5)) { for (const r of fromCol(cached.bars)) map.set(r.t, r); start = addDays(cached.to_day, -2); }
  for (const r of await cryptoIntraday(a.sec, 15, `${start} 00:00:00`, `${today} 23:59:00`)) if (inSess(r.t)) map.set(r.t, r);
  const lo = Date.parse(`${want}T00:00:00+05:30`) / 1000, nowSec = Date.now() / 1000;
  // Only finished candles are kept (the one still forming would be stored half-done).
  const rows = [...map.values()].filter((r) => r.t >= lo && r.t + 900 <= nowSec).sort((x, y) => x.t - y.t);
  if (rows.length) await saveCandles(sb, { asset: a.key, kind: "I5", from_day: ist(rows[0].t).date, to_day: ist(rows.at(-1)!.t).date, bars: toCol(rows, true) });
  const first = addDays(today, -5 * 365 + 2), y0 = Number(first.slice(0, 4)), y1 = Number(today.slice(0, 4)) - 1;
  const { data: have } = await sb.from("lab_candles").select("kind").eq("asset", a.key).like("kind", "I5Y:%");
  const got = new Set((have ?? []).map((h) => h.kind));
  let fetched = 0;
  for (let y = y1; y >= y0 && fetched < 2; y--) {
    if (got.has(`I5Y:${y}`)) continue;
    const from = `${y}-01-01` < first ? first : `${y}-01-01`;
    const yr = (await cryptoIntraday(a.sec, 15, `${from} 00:00:00`, `${y}-12-31 23:59:00`)).filter((r) => inSess(r.t));
    fetched++;
    if (!yr.length) continue;
    await saveCandles(sb, { asset: a.key, kind: `I5Y:${y}`, from_day: ist(yr[0].t).date, to_day: ist(yr.at(-1)!.t).date, bars: toCol(yr, true) });
  }
}

/**
 * 5-minute candles for an MCX commodity. Dhan serves intraday candles only for contracts that are still listed, so the
 * first download stitches the listed contracts (each day from the nearest-expiring contract that traded properly that
 * day, as far back as it was listed); after that every night adds the near-month contract's new days, so the history
 * grows into a true near-month series and is kept after contracts expire.
 */
async function refreshMcxIntraday(sb: SupabaseClient, dhan: Dhan, a: LabAsset, today: string, want: string) {
  const cached = (await readCandles(sb, a.key, ["I5"]))[0];
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
  await saveCandles(sb, { asset: a.key, kind: "I5", from_day: ist(rows[0].t).date, to_day: ist(rows.at(-1)!.t).date, bars: toCol(rows, false) });
}

/** Cached candles in the shape the simulator wants. */
export async function loadAsset(sb: SupabaseClient, key: string, long = false): Promise<SimData> {
  const a = LAB_ASSETS[key];
  // The year-by-year test also loads the older yearly 5-minute chunks.
  const rows = await readCandles(sb, key, long ? "long" : ["D", "I5", "F"]);
  const d = rows?.find((r) => r.kind === "D");
  if (!d) throw new Error(`No cached candles for ${key} yet.`);
  const daily: DayBar[] = fromCol(d.bars).map((r) => ({ ...r, day: ist(r.t).date }));
  const raw: MBar[] = [];
  const byDay = new Map<string, MBar[]>();
  const parts = (rows ?? []).filter((r) => r.kind !== "D" && r.kind !== "F").sort((x, y) => (x.kind === "I5" ? 1 : 0) - (y.kind === "I5" ? 1 : 0) || x.kind.localeCompare(y.kind));
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
  const out: SimData = { raw, byDay, daily };
  if (a.crypto) {
    // Crypto extras: Delta's daily funding rates, and Bitcoin's daily candles for the "Bitcoin trend" filter on other coins.
    const f = rows?.find((r) => r.kind === "F")?.bars as { d?: string[]; r?: number[] } | undefined;
    if (f?.d) out.funding = new Map(f.d.map((d, i) => [d, Number(f.r![i])]));
    if (key !== "BTCUSD") {
      const b = (await readCandles(sb, "BTCUSD", ["D"]))[0];
      if (b) out.btc = fromCol(b.bars).map((r) => ({ ...r, day: ist(r.t).date }));
    }
  }
  return out;
}

/**
 * Candle data kept in the engine's memory between steps (and between calls while the function instance stays warm),
 * so the lab doesn't reload several MB of candles from the database for every batch of checks. A cheap look at the
 * rows' update times tells when the stored candles changed (each run's candle update), and only then is it reloaded.
 * Least recently used assets are dropped beyond about 600,000 candles (roughly 80 MB).
 */
const ASSET_CACHE = new Map<string, { sig: string; data: SimData; bars: number; used: number }>();
const CACHE_MAX_BARS = 600000;
export const cacheStats = { hits: 0, loads: 0 };
export async function cachedAsset(sb: SupabaseClient, key: string, long = false): Promise<SimData> {
  const ck = `${key}|${long ? 1 : 0}`;
  let q = sb.from("lab_candles").select("kind, updated_at").eq("asset", key);
  q = long ? q.or("kind.eq.D,kind.eq.I5,kind.eq.F,kind.like.I5Y*") : q.in("kind", ["D", "I5", "F"]);
  const { data: meta } = await q;
  let sig = (meta ?? []).map((m) => `${m.kind}@${m.updated_at}`).sort().join(",");
  if (LAB_ASSETS[key]?.crypto && key !== "BTCUSD") {
    const { data: b } = await sb.from("lab_candles").select("updated_at").eq("asset", "BTCUSD").eq("kind", "D").maybeSingle();
    sig += `|BTC@${b?.updated_at ?? ""}`;
  }
  const hit = ASSET_CACHE.get(ck);
  if (hit && hit.sig === sig) { hit.used = Date.now(); cacheStats.hits++; return hit.data; }
  const data = await loadAsset(sb, key, long);
  cacheStats.loads++;
  ASSET_CACHE.set(ck, { sig, data, bars: data.raw.length + data.daily.length, used: Date.now() });
  let total = [...ASSET_CACHE.values()].reduce((a, x) => a + x.bars, 0);
  while (total > CACHE_MAX_BARS && ASSET_CACHE.size > 1) {
    const [oldK, old] = [...ASSET_CACHE.entries()].filter(([k]) => k !== ck).sort((a, b) => a[1].used - b[1].used)[0];
    ASSET_CACHE.delete(oldK); total -= old.bars;
  }
  return data;
}

/* ---------- one strategy ---------- */
export function labParams(a: LabAsset, from: string, to: string, capital: number): BtParams {
  return { from, to, capital, brokerage: 20, charges: chargeRates(a), near_code: 1 };
}
/** Futures backtest of a lab strategy on cached candles (no network calls). */
export async function screenOne(cfg: LabConfig, data: SimData, memo: Map<string, unknown>, win: { from: string; split: string; to: string }, capital: number, rates: Record<string, MarginRate> = {}) {
  const a = LAB_ASSETS[cfg.underlying];
  const plans = simulateRules(cfg, data, win.from, win.to, memo);
  const fk = "__funding_obj", dm = data as SimData & { [fk]?: Record<string, number> };
  if (data.funding && !dm[fk]) dm[fk] = Object.fromEntries(data.funding);
  const { trades } = await priceBatch(cfg, { client: "-", token: "-" }, { ...labParams(a, win.from, win.to, capital), funding: dm[fk] ?? null }, plans, 0, newAcc(capital), Infinity, async () => {});
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
  if (cfg.data_segment === "DELTA") return { pct: 0.10, src: "10× leverage (Delta allows more; the lab stays at 10×)" };
  return { pct: cfg.data_segment === "MCX_COMM" ? 0.10 : 0.12, src: "estimate" };
}
/**
 * Today's margin for one lot of each coin (Delta perpetual at the lab's 10× leverage, the same rate its backtests use),
 * stored with Dhan's index and MCX margins so the Lab page can show "Margin today (1 lot)" for every asset.
 * One lot's value in rupees = latest daily close (USD) × the coin's lot (rupees per $1 per lot).
 */
export async function refreshCryptoMargins(sb: SupabaseClient, keys: string[]) {
  for (const k of keys) {
    const a = LAB_ASSETS[k]; if (!a?.crypto) continue;
    try {
      const d = (await readCandles(sb, k, ["D"]))[0];
      const px = Number(d?.bars?.c?.at(-1));
      if (!(px > 0)) continue;
      const value = px * a.lot, margin = Math.trunc(value * 0.10);
      await sb.from("lab_margins").upsert({ asset: k, price: px, fut_pct: 0.10, fut_pct_i: 0.10, sell_pct: null, sell_pct_i: null, error: null, checked_at: new Date().toISOString(),
        detail: { price: px, value: Math.trunc(value), margin, margin_intraday: margin, contract: `${a.name} perpetual on Delta (10× leverage)` } });
    } catch (e) { console.error("crypto margin", k, e); }
  }
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
 * strategy is running (active, in paper or live mode), and only 23:30–08:30 IST once any is. "night": back-to-back
 * runs 23:30–08:30 IST only.
 */
export async function labWindowOpen(sb: SupabaseClient, mode: string): Promise<boolean> {
  if (mode !== "auto" && mode !== "night") return false;
  if (mode === "night") return labNight();
  return await labQuiet(sb);
}
const labNight = () => { const m = ist(Date.now() / 1000).min; return m >= 23 * 60 + 30 || m < 8 * 60 + 30; };
/**
 * Lab work that nobody asked for just now (new runs, the 16:05 run, re-checks of earlier winners, option pricing)
 * waits for the night (23:30–08:30 IST) while any strategy is running: active, in paper or live mode.
 * Runs you start yourself (Run now, focused runs, variations, manual tests) are not held back.
 */
export async function labQuiet(sb: SupabaseClient): Promise<boolean> {
  if (labNight()) return true;
  // Also quiet while no Dhan market a running strategy trades is open (weekends, exchange holidays, after hours, with
  // 15 minutes either side); crypto strategies run round the clock but their ticks are light.
  const { data } = await sb.from("algo_strategies").select("data_segment").eq("active", true).eq("archived", false).eq("is_master", false);
  const segs = new Set((data ?? []).map((x) => String(x.data_segment)).filter((g) => !isCrypto(g)));
  if (!segs.size) return true;
  const now = ist(Date.now() / 1000);
  if (now.wd === 0 || now.wd === 6) return true;
  const { data: hol } = await sb.from("market_holidays").select("exch, opens_at").eq("day", now.date);
  for (const g of segs) {
    const h = (hol ?? []).find((x) => x.exch === (g === "MCX_COMM" ? "MCX" : "NSE"));
    if (h && h.opens_at == null) continue; // closed all day
    const ss = sessionFor(g, now.date);
    if (now.min >= ss.open - 15 && now.min <= ss.close + 15) return false;
  }
  return true;
}

export async function labStart(sb: SupabaseClient, manual: boolean, trigger?: string): Promise<number | null> {
  const { data: set } = await sb.from("lab_settings").select("*").eq("id", 1).maybeSingle();
  if (!set || (!set.enabled && !manual)) return null;
  // With back-to-back runs on, the 16:05 schedule has nothing extra to do.
  if (!manual && !trigger && (set.schedule_mode ?? "nightly") !== "nightly") return null;
  // The 16:05 run waits for the night while strategies are running.
  if (!manual && !trigger && !(await labQuiet(sb))) { await sb.from("lab_settings").update({ nightly_due: true }).eq("id", 1); return null; }
  // A focused run (one or a few assets, new strategies only), asked for from the Lab page.
  const focus = manual && trigger === "focus" ? set.focus as { assets?: string[]; n?: number } | null : null;
  if (trigger === "focus" && !focus?.assets?.length) return null;
  const { data: running } = await sb.from("lab_runs").select("id, settings, trigger").eq("status", "running").limit(1);
  if (running?.length && (running[0].trigger === "robust" || (manual && ["continuous", "schedule"].includes(running[0].trigger)))) {
    // The re-check of earlier winners (or, for a run you start yourself, the automatic run) gives way.
    // The re-check of earlier winners gives way; it carries on from where it was once the lab is free again.
    await sb.from("lab_runs").update({ status: "done", phase: "done", progress: "Paused for a new run; carries on later", finished_at: new Date().toISOString(), lease_until: null }).eq("id", running[0].id);
  } else if (running?.length) {
    // A variation run is busy: tonight's run starts as soon as it finishes.
    if (!manual && running[0].settings?.request_id) await sb.from("lab_settings").update({ nightly_due: true }).eq("id", 1);
    return running[0].id;
  }
  const today = ist(Date.now() / 1000).date;
  const from = addDays(today, -YEAR_DAYS), split = addDays(today, -92);
  const settings = focus
    ? { ...set, focus: true, assets: focus.assets!.filter((k) => LAB_ASSETS[k]), per_night: Math.max(10, Math.min(1000, Number(focus.n) || 300)) }
    : { ...set, focus: undefined };
  if (focus) await sb.from("lab_settings").update({ focus: null }).eq("id", 1);
  if (trigger === "retest") await sb.from("lab_settings").update({ retest_until_done: true }).eq("id", 1);
  if (manual) await sb.from("lab_settings").update({ paused_until: null }).eq("id", 1);
  const { data: run, error } = await sb.from("lab_runs").insert({
    run_day: today, status: "running", phase: "data", progress: focus ? `Focused run: ${settings.assets.map((k: string) => LAB_ASSETS[k]?.name ?? k).join(", ")}` : "Updating candles", from_day: from, split_day: split, to_day: today,
    trigger: trigger ?? (manual ? "manual" : "schedule"), settings,
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
  // A run stopped by hand pauses the lab for an hour; after that it carries on by itself.
  if (set?.paused_until && Date.parse(set.paused_until) > Date.now()) return null;
  // A re-test of the saved strategies you asked for (lab_settings.retest_until_done) goes first and alone: batch after
  // batch with 10 minutes' rest between them, only while the lab may work unasked (night, weekends, holidays, markets
  // closed). A daytime re-test of thousands of strategies used up the database's disk allowance on 23 Oct.
  if (set?.retest_until_done) {
    const { count } = await sb.from("lab_refresh").select("fingerprint", { count: "exact", head: true }).is("run_id", null).in("asset", (set.assets ?? []) as string[]);
    if ((count ?? 0) === 0) await sb.from("lab_settings").update({ retest_until_done: false }).eq("id", 1);
    else {
      const { data: last } = await sb.from("lab_runs").select("finished_at").eq("trigger", "retest").order("id", { ascending: false }).limit(1);
      const rested = !last?.[0]?.finished_at || Date.now() - Date.parse(last[0].finished_at) > 10 * 60000;
      return rested && await labQuiet(sb) ? await labStart(sb, true, "retest") : null;
    }
  }
  const quiet = await labQuiet(sb);
  if (set?.nightly_due && quiet) {
    await sb.from("lab_settings").update({ nightly_due: false }).eq("id", 1);
    const id = await labStart(sb, false);
    if (id) return id;
  }
  const { data: reqs } = await sb.from("lab_requests").select("*").eq("status", "pending").order("id").limit(1);
  const q = reqs?.[0];
  if (!q && set && quiet) {
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
    ? ((q.assets?.length ? q.assets : set.assets) ?? []).filter((k: string) => LAB_ASSETS[k])
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
/**
 * The lab gives way to everything else. Before any work it times a tiny query: if the database answers slowly
 * (over 2 seconds; normally ~50 ms) the lab rests for 20 minutes, so logins and live trading always come first.
 * Returns true when the lab may work now.
 */
const SLOW_MS = 2000;
export async function labMayWork(sb: SupabaseClient, allowDuringRest = false): Promise<boolean> {
  const t0 = Date.now();
  const { data, error } = await sb.from("lab_settings").select("paused_until, pause_reason").eq("id", 1).maybeSingle();
  const lag = Date.now() - t0;
  if (error || lag > SLOW_MS) { await labRest(sb, 20, "slow"); return false; }
  const paused = data?.paused_until && Date.parse(data.paused_until) > Date.now();
  return !paused || (allowDuringRest && data?.pause_reason === "rest");
}
/** Pauses the lab for some minutes (never shortens a longer pause). reason: "rest" between runs, "slow" database. */
export async function labRest(sb: SupabaseClient, minutes: number, reason: "rest" | "slow") {
  const until = new Date(Date.now() + minutes * 60000).toISOString();
  await sb.from("lab_settings").update({ paused_until: until, pause_reason: reason }).eq("id", 1).or(`paused_until.is.null,paused_until.lt.${until}`)
    .then(() => {}, () => {});
}
/** After a run: rest as long as the run worked (at least 10, at most 45 minutes), so the database's daily allowance lasts. */
async function restAfterRun(sb: SupabaseClient, run: Run, extraMs: number) {
  const t = run.timings ?? {};
  const work = Object.entries(t).filter(([k]) => k !== "steps").reduce((a, [, v]) => a + Number(v || 0), 0) + extraMs;
  await labRest(sb, Math.min(45, Math.max(10, Math.round(work / 60000))), "rest");
}

export async function labStep(ctx: Ctx): Promise<boolean> {
  const { sb } = ctx;
  if (!(await labMayWork(sb))) return false;
  const now = new Date();
  // Take the run's lease so two instalments never work on it at the same time.
  const { data: claimed } = await sb.from("lab_runs").update({ lease_until: new Date(now.getTime() + 240000).toISOString(), updated_at: now.toISOString() })
    .eq("status", "running").or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select("*").limit(1);
  const run: Run | undefined = claimed?.[0];
  if (!run) return false;
  // How long each step takes, added up per run (lab_runs.timings, milliseconds; "recheck" for re-check runs).
  const stepT0 = Date.now(), stepName = run.trigger === "robust" ? "recheck" : String(run.phase);
  const logTime = () => sb.rpc("lab_add_time", { p_run: run.id, p_phase: stepName, p_ms: Math.round(Date.now() - stepT0) }).then(() => {}, () => {});
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

    if (run.trigger === "robust" && !(await labQuiet(sb))) {
      // Picks up where it left off at night (the checks still to do stay queued).
      await patch({ status: "done", phase: "done", progress: "Paused: strategies are running, so the re-check carries on at 11:30 PM", finished_at: new Date().toISOString(), lease_until: null });
      return false;
    }
    if (run.trigger === "continuous" && !(await labWindowOpen(sb, (await sb.from("lab_settings").select("schedule_mode").eq("id", 1).maybeSingle()).data?.schedule_mode ?? "nightly"))) {
      await patch({ status: "stopped", phase: "done", progress: "Stopped: outside the lab's hours (strategies are running, in paper or live, so the lab works 11:30 PM – 8:30 AM only)", finished_at: new Date().toISOString(), lease_until: null });
      return false;
    }
    if (run.phase === "data") {
      let i = Number(run.cursor ?? 0);
      if (i === 0 && !counts.margins_checked && (run.trigger === "continuous" || run.trigger === "retest")) counts.margins_checked = -2; // rates from the last full run
      if (i === 0 && !counts.margins_checked) {
        // Today's margin rates from Dhan's margin calculator (used for each trade's margin and the return on margin).
        await patch({ progress: "Checking margin rates with Dhan" });
        const n = await refreshMargins(sb, ctx.creds, assets.map((k) => LAB_ASSETS[k]).filter((a) => !a.crypto));
        counts.margins_checked = n || -1; await patch({ counts });
      }
      while (i < assets.length && Date.now() - ctx.started < WALL_BUDGET - 20000) {
        await patch({ progress: `Updating candles: ${LAB_ASSETS[assets[i]].name} (${i + 1} of ${assets.length})` });
        // One asset's candles not coming back (Dhan hiccups, mostly early in the morning) doesn't stop the run: it is
        // tried once more, then that asset carries on with the candles already saved and the run goes on.
        try {
          await refreshAsset(sb, ctx.creds, assets[i], win.to, run.trigger === "continuous" || run.trigger === "retest" ? 6 : 0);
        } catch (e1) {
          await new Promise((r) => setTimeout(r, 3000));
          try { await refreshAsset(sb, ctx.creds, assets[i], win.to, run.trigger === "continuous" || run.trigger === "retest" ? 6 : 0); }
          catch (e2) {
            const msg = `${LAB_ASSETS[assets[i]].name}: ${String(e2 instanceof Error ? e2.message : e2).slice(0, 160)}`;
            counts.stale = [...(Array.isArray(counts.stale) ? counts.stale : []), msg].slice(-10);
            await patch({ counts });
            console.error("lab candles", msg);
          }
        }
        i++;
      }
      if (i >= assets.length) await refreshCryptoMargins(sb, assets.filter((k) => LAB_ASSETS[k]?.crypto));
      await patch(i < assets.length ? { cursor: i } : { cursor: 0, phase: "generate", progress: "Writing tonight's strategies" });
    } else if (run.phase === "generate") {
      const carried = await generatePhase(sb, run, assets, win);
      await patch({ phase: "screen", progress: carried ? `Backtesting strategies (${carried} carried over from stopped runs)` : "Backtesting strategies",
        counts: { ...counts, generated: (await countRows(sb, run.id)), ...(carried ? { carried } : {}) } });
    } else if (run.phase === "screen") {
      const left = await screenPhase(ctx, run, win);
      if (!left) {
        await overfitGauge(sb, run.id).catch((e) => console.error("pbo", e));
        const { count: basic } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).eq("basic_passed", true);
        await patch({ phase: "robust", progress: `Checking ${basic ?? 0} first-round winners on other assets, other timeframes and year by year`, counts: { ...counts, screened: counts.generated, basic_passed: basic } });
      } else {
        await patch({ progress: `Backtested ${run.counts?.tested ?? 0} of ${counts.generated ?? "?"} strategies (${run.counts?.failed1 ?? 0} failed the first round and were cleared)` });
      }
    } else if (run.phase === "robust") {
      const left = await robustPhase(ctx, run, win, patch);
      if (!left && run.trigger === "robust") {
        await patch({ status: "done", phase: "done", progress: "Finished re-checking earlier winners", finished_at: new Date().toISOString(), lease_until: null });
        await restAfterRun(sb, run, Date.now() - stepT0);
        more = false;
      } else if (!left) {
        // Every passed index strategy on intraday candles joins the option-pricing queue, which works in the background
        // (one strategy at a time, oldest first, only while no run is going); the run itself is finished here.
        // (Positional once-a-day trades run across expiries, and commodities and crypto have no listed index options.)
        const { data: won } = await sb.from("lab_results").select("id, asset, mode").eq("run_id", run.id).eq("stage", "screened").eq("passed", true).limit(1000);
        const ids = (won ?? []).filter((b) => !LAB_ASSETS[b.asset]?.commodity && !LAB_ASSETS[b.asset]?.crypto && b.mode === "INTRADAY").map((b) => b.id);
        for (let i = 0; i < ids.length; i += 200) await sb.from("lab_results").update({ stage: "opt_queue" }).in("id", ids.slice(i, i + 200));
        const { count: passed } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).eq("passed", true);
        await prune(sb);
        await patch({ status: "done", phase: "done", progress: ids.length ? `Finished; ${ids.length} sent to the option-pricing queue` : "Finished",
          finished_at: new Date().toISOString(), lease_until: null, counts: { ...counts, passed, to_price: ids.length } });
        await restAfterRun(sb, run, Date.now() - stepT0);
        more = false;
      }
    } else if (run.phase === "options") {
      // Runs from before option pricing moved to the background queue: their strategies are already queued.
      await patch({ status: "done", phase: "done", progress: "Finished; option pricing continues in the background queue", finished_at: new Date().toISOString(), lease_until: null });
      await restAfterRun(sb, run, Date.now() - stepT0);
      more = false;
    } else more = false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A slow database (statement timeouts, dropped connections) is not the run's fault: give the database an hour's rest
    // instead of starting the next run straight away, which only made it slower and kept logins timing out.
    const overloaded = /statement timeout|timed? ?out|connection|503|504|ECONNRESET|fetch failed/i.test(msg);
    const slowTries = Number(counts.slow_tries ?? 0) + 1;
    if (overloaded && slowTries <= 6) {
      // The run waits and carries on where it was once the database has recovered (it is only failed if this keeps happening).
      await patch({ progress: `Resting: the database was slow; carrying on in 30 minutes (${run.progress ?? ""})`.slice(0, 300), lease_until: null, counts: { ...counts, slow_tries: slowTries } });
      await labRest(sb, 30, "slow");
    } else {
      await patch({ status: "failed", progress: "Failed", error: msg, finished_at: new Date().toISOString(), lease_until: null });
      await labRest(sb, 30, "rest");
    }
    await logTime();
    return false;
  }
  await logTime();
  if (more) await sb.from("lab_runs").update({ lease_until: null }).eq("id", run.id);
  return more;
}

async function countRows(sb: SupabaseClient, runId: number) {
  const { count } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", runId);
  return count ?? 0;
}

async function generatePhase(sb: SupabaseClient, run: Run, assets: string[], _win: { from: string }): Promise<number> {
  const set = run.settings ?? {};
  let n = Math.max(10, Math.min(1000, Number(set.per_night ?? 300)));
  if ((await countRows(sb, run.id)) > 0) return 0; // already written (instalment repeated)
  if (set.request_id) { await requestPhase(sb, run, assets); return 0; }
  // Nothing is left half-way: strategies that a stopped or failed run hadn't backtested yet, or that were waiting for
  // option pricing, move into this run first (oldest first, only for this run's assets). They count towards this run's
  // size, so a big backlog is cleared over a few runs without making any one run heavier.
  const carried = await adoptLeftovers(sb, run, assets, n);
  n -= carried;
  // Re-test of every saved strategy with the current rules (queued in lab_refresh, strategies on desks first): while
  // any is left, runs re-test those and write no new strategies or variations. A focused run is new strategies only.
  if (!set.focus) {
    const { data: rq, error: rqe } = await sb.from("lab_refresh").select("fingerprint, asset, config").is("run_id", null).in("asset", assets)
      .order("prio").order("score", { ascending: false, nullsFirst: false }).limit(Math.max(0, Math.min(n, run.trigger === "retest" ? 100 : 200)));
    if (rqe) throw new Error(rqe.message);
    if (rq?.length) {
      const rows = rq.map((c) => ({ run_id: run.id, asset: c.asset, mode: c.config.rules?.daily ? "DAILY" : "INTRADAY", label: labelFor(c.config), fingerprint: c.fingerprint,
        champion: true, refresh: true, config: { ...c.config, lab_note: "Re-test of a saved strategy with the current rules" }, stage: "pending" }));
      for (let i = 0; i < rows.length; i += 100) { const { error } = await sb.from("lab_results").insert(rows.slice(i, i + 100)); if (error) throw new Error(error.message); }
      const { error: ue } = await sb.from("lab_refresh").update({ run_id: run.id, queued_at: new Date().toISOString() }).in("fingerprint", rq.map((x) => x.fingerprint));
      if (ue) throw new Error(ue.message);
      return carried;
    }
  }
  // A re-test run writes nothing new: when the queue is empty it simply ends.
  if (run.trigger === "retest") return carried;
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
  // Earlier winners are re-tested once a day on the latest candles, and only at night (23:30–08:30 IST); the rest of
  // every run goes to new strategies and variations. A focused run is new strategies only.
  const nm = ist(Date.now() / 1000).min, night = nm >= 23 * 60 + 30 || nm < 8 * 60 + 30;
  const { data: fresh } = await sb.from("lab_results").select("fingerprint").gte("created_at", new Date(Date.now() - 20 * 3600000).toISOString()).limit(20000);
  const champSeen = new Set<string>(), testedToday = new Set((fresh ?? []).map((x) => x.fingerprint));
  for (const c of (night && !set.focus) ? champs ?? [] : []) {
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
  // And at most 6 per asset, so one asset with many winners (Midcap Select, say) can't fill the variation runs.
  const perFam = new Map<string, number>(), perAsset = new Map<string, number>();
  const pSeen = new Set<string>(), pool = (parents ?? []).filter((x) => {
    if (!assets.includes(x.config?.underlying) || pSeen.has(x.fingerprint)) return false;
    const f = famOf(x.config), k = perFam.get(f) ?? 0, a = String(x.config?.underlying), ka = perAsset.get(a) ?? 0;
    if (k >= 2 || ka >= 6) return false;
    perFam.set(f, k + 1); perAsset.set(a, ka + 1); pSeen.add(x.fingerprint); return true;
  }).slice(0, 40);
  // Breeding from winners searches the same history the tests use, so it is off unless switched on (lab_settings.evolve).
  const nVar = pool.length && !set.focus && set.evolve === true ? Math.round(n * 0.4) : 0;
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
    const want = nNew ? Math.max(1, Math.round((nNew * w[i]) / wsum)) : 0;
    let made = 0, tries = 0;
    while (made < want && tries < want * 5) {
      tries++; seed = (seed + 7919) >>> 0;
      let cfg: LabConfig;
      try { cfg = generate(k, seed, capital, Number(run.settings?.ha_strength_pct ?? 8)); } catch { continue; }
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
  return carried;
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
const keepable = (r: { starred?: boolean; promoted_id?: unknown; request_id?: unknown; refresh?: boolean }) => !r.starred && !r.promoted_id && !r.request_id && !r.refresh;
/** Strategies (fingerprints) that someone has on their desk: their re-test results are always kept, pass or fail. */
async function deskFingerprints(sb: SupabaseClient): Promise<Set<string>> {
  const { data: st } = await sb.from("algo_strategies").select("lab_id").not("lab_id", "is", null).eq("is_master", false).limit(5000);
  const ids = [...new Set((st ?? []).map((x) => Number(x.lab_id)))];
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await sb.from("lab_results").select("fingerprint").in("id", ids.slice(i, i + 300));
    for (const x of data ?? []) if (x.fingerprint) out.add(x.fingerprint);
  }
  return out;
}
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
  const { data: rows } = await sb.from("lab_results").select(cols).in("stage", ["screened", "error"]).eq("starred", false).is("promoted_id", null).is("request_id", null).eq("refresh", false)
    .or("basic_passed.eq.false,stage.eq.error,and(robust_status.eq.done,passed.eq.false)").limit(limit);
  await forget(sb, (rows ?? []).map((r: any) => ({ ...r, round: r.stage === "error" ? 0 : r.basic_passed ? 2 : 1,
    why: r.stage === "error" ? [String(r.error ?? "error")] : r.basic_passed ? (r.robust?.why ?? []) : (r.metrics?.why ?? []) })));
  return (rows ?? []).length;
}

/* ---------- robustness: other assets, other timeframes, buy & hold ---------- */
const clsOf = (a?: LabAsset) => a?.crypto ? "C" : a?.commodity ? "M" : "I";
/** Mini and micro contracts follow the same commodity, so they don't count as another asset. */
export const assetRoot = (k: string) => /^GOLD/.test(k) ? "GOLD" : /^SILVER/.test(k) ? "SILVER" : /^CRUDE/.test(k) ? "CRUDE" : /^NAT/.test(k) ? "NATGAS" : /^ZINC/.test(k) ? "ZINC" : /^LEAD/.test(k) ? "LEAD" : /^ALUMIN/.test(k) ? "ALUMINIUM" : k;
type Check = { kind: "self" | "asset" | "tf" | "year" | "step" | "vault"; asset: string; tf: number | null; config: LabConfig };
/** Years back for the year-by-year test: 10 on daily candles; 5 on 5-minute candles (the depth Dhan keeps). */
export const yearsFor = (cfg: LabConfig) => cfg.rules?.daily ? 10 : 5;
/**
 * The checks for one first-round winner, limited to assets the lab has candles for. Simple rules (rev 5, the default
 * since 27 Oct 2026): the strategy itself, year by year, and the held-back months. `strict` (lab_settings.strict) adds
 * the other assets, other timeframes and nearby settings of rev 4.
 */
export function robustChecks(cfg: LabConfig, haveD: Set<string>, haveI5: Set<string>, strict = false): Check[] {
  const out: Check[] = [{ kind: "self", asset: cfg.underlying, tf: null, config: cfg }];
  const daily = !!cfg.rules?.daily, me = LAB_ASSETS[cfg.underlying];
  if (!strict) {
    for (let k = 1; k <= yearsFor(cfg); k++) out.push({ kind: "year", asset: cfg.underlying, tf: k, config: cfg });
    out.push({ kind: "vault", asset: cfg.underlying, tf: null, config: cfg });
    const vd = vaultDays(cfg);
    return out.map((c) => ({ ...c, config: { ...c.config, vault_days: vd } }));
  }
  // Other assets: the same family first (indices for an index strategy, commodities for a commodity one, coins for a
  // coin), up to 6.
  const roots = new Set([assetRoot(cfg.underlying)]);
  const pool = Object.keys(LAB_ASSETS).filter((k) => { const r = assetRoot(k); if (roots.has(r) || !haveD.has(k) || !(daily || haveI5.has(k))) return false; roots.add(r); return true; })
    .sort((a, b) => Number(clsOf(LAB_ASSETS[a]) !== clsOf(me)) - Number(clsOf(LAB_ASSETS[b]) !== clsOf(me)));
  for (const k of pool) {
    if (out.filter((c) => c.kind === "asset").length >= 6) break;
    const c = transfer(cfg, k);
    if (c) out.push({ kind: "asset", asset: k, tf: null, config: c });
  }
  // Other timeframes: the nearest decision timeframes that keep the rules valid (up to 4).
  if (!daily && haveI5.has(cfg.underlying)) {
    const own = Number(cfg.timeframe_min);
    const tfs = tfsFor(cfg.underlying).filter((t) => t !== own).sort((a, b) => Math.abs(Math.log(a / own)) - Math.abs(Math.log(b / own)));
    for (const t of tfs) {
      if (out.filter((c) => c.kind === "tf").length >= 4) break;
      const c = retime(cfg, t);
      if (c) out.push({ kind: "tf", asset: cfg.underlying, tf: t, config: c });
    }
  } else if (daily && haveI5.has(cfg.underlying)) {
    // A once-a-day index strategy, decided instead at the close of 60- and 125-minute candles (daily conditions stay daily).
    for (const t of me?.crypto ? [60, 240] : [60, 125]) {
      const c: LabConfig = JSON.parse(JSON.stringify(cfg));
      delete c.rules.daily; c.timeframe_min = t; c.lab_note = `Decided on ${t}-minute candles instead of once a day`;
      try { validateRules(c.rules); out.push({ kind: "tf", asset: cfg.underlying, tf: t, config: c }); } catch { /* skip */ }
    }
  }
  // Round 3: profitable in each of the past years, one check per year (year 1 = the latest 12 months).
  for (let k = 1; k <= yearsFor(cfg); k++) out.push({ kind: "year", asset: cfg.underlying, tf: k, config: cfg });
  // Setting stability: up to 8 small steps on the indicator settings (±1 / ±2 on lengths, ±2 / ±5 on levels …),
  // each tested on the latest year. A strategy that only works at one exact setting is curve-fitted.
  const steps = settingVariants(cfg).filter((c) => { try { validateRules(c.rules); return true; } catch { return false; } });
  const pickN = Math.min(8, steps.length);
  for (let i = 0; i < pickN; i++) out.push({ kind: "step", asset: cfg.underlying, tf: null, config: steps[Math.floor((i * steps.length) / pickN)] });
  // Last: the held-back months, the strategy itself, once.
  out.push({ kind: "vault", asset: cfg.underlying, tf: null, config: cfg });
  // Every check keeps the strategy's own vault, so a check on another asset or timeframe never looks into it.
  const vd = vaultDays(cfg);
  return out.map((c) => ({ ...c, config: { ...c.config, vault_days: vd } }));
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
/**
 * Rule families tried (same indicators and conditions, any settings): the lab's number of independent tries.
 * Counted once a night into lab_settings.families (lab_families_refresh: reading every result takes longer than the
 * API allows). Never guessed: without the count no verdict is given, so the luck test can't quietly get easier.
 */
const FAM_CACHE = { at: 0, map: new Map<string, number>() };
export async function familiesFor(sb: SupabaseClient, cfg: LabConfig): Promise<number> {
  if (Date.now() - FAM_CACHE.at > 3600000) {
    const { data, error } = await sb.from("lab_settings").select("families").eq("id", 1).maybeSingle();
    const fams = (data?.families ?? null) as Record<string, number> | null;
    if (error || !fams || !Object.keys(fams).length) throw new Error(`lab: rule-family counts not available (${error?.message ?? "lab_settings.families empty; run lab_families_refresh()"})`);
    FAM_CACHE.map = new Map(Object.entries(fams));
    FAM_CACHE.at = Date.now();
  }
  // Counted across every asset: ideas found on one asset are tried on the others, so the choice is lab-wide.
  const n = Number(FAM_CACHE.map.get(`*|${cfg.rules?.daily ? "DAILY" : "INTRADAY"}`));
  if (!(n > 0)) throw new Error("lab: no rule-family count for this mode");
  return Math.max(10, n);
}
/**
 * The verdict once every check of a winner is done.
 * Simple rules (rev 5, 27 Oct 2026, Papa: "relax the strategies, reward continuous profit"): profitable in all but one
 * year in five (8 of 10, 4 of 5; minute strategies with under 3 years: 3 of the last 4 quarters), still profitable in
 * total with slippage doubled, enough trades, and profitable in the held-back last months. Luck, the best trades
 * removed (and, with `strict`, other assets, timeframes, nearby settings and the stage-2 noise tests) are shown for
 * information; strategies are ranked by the consistency score.
 */
export function robustVerdict(cfg: LabConfig, checks: { kind: string; asset: string; tf: number | null; result: any }[], opts: { families?: number; strict?: boolean } = {}) {
  const daily = !!cfg.rules?.daily, strict = !!opts.strict;
  const self = checks.find((c) => c.kind === "self")?.result ?? null;
  const assets = checks.filter((c) => c.kind === "asset").map((c) => ({ asset: c.asset, ...c.result }));
  const tfs = checks.filter((c) => c.kind === "tf" && !c.result?.skip).map((c) => ({ tf: c.tf, ...c.result }));
  const okA = assets.filter((x) => x.ok).length, okT = tfs.filter((x) => x.ok).length;
  const yrs = checks.filter((c) => c.kind === "year" && !c.result?.skip).map((c) => { const { tr: _t, ...rest } = c.result ?? {}; return { y: c.tf, ...rest }; }).sort((a, b) => a.y - b.y);
  const allTrades = unpackTrades(joinTrades(checks.filter((c) => c.kind === "year" && !c.result?.skip).map((c) => c.result?.tr).filter(Boolean)));
  const okY = yrs.filter((x) => x.ok).length;
  const why: string[] = [];
  if (strict) {
    if (!self || !(self.net > 0)) why.push("lost money on the latest year");
    if (!assets.length) why.push("no other asset to test it on");
    else if (okA < 1) why.push(`worked on ${okA} of ${assets.length} other assets (needs 1)`);
    if (tfs.length) { const need = tfs.length >= 3 ? 2 : 1; if (okT < need) why.push(`worked on ${okT} of ${tfs.length} other timeframes (needs ${need})`); }
    else why.push("could not be tested on another timeframe yet (not enough 5-minute candles for this asset; MCX history grows every night)");
  }
  // Years needed: every year (strict), or all but one in five (simple: 8 of 10, 4 of 5, 3 of 3).
  const needY = strict ? yrs.length : yrs.length - Math.floor(yrs.length / 5);
  // Minute-candle strategies on assets with only about a year of minute prices (Dhan keeps an MCX contract's intraday
  // history for about a year): judged quarter by quarter instead, at least 3 of the last 4 quarters profitable.
  let quarters: { q: number; from: string; to: string; n: number; net: number; ok: boolean }[] | null = null;
  if (yrs.length < 3 && !daily && yrs.length >= 1) {
    const end0 = String((yrs.find((y) => y.y === 1) as any)?.to ?? allTrades.map((t) => t.exit.slice(0, 10)).sort().pop() ?? "");
    const back = (d: string, m: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCMonth(x.getUTCMonth() - m); return x.toISOString().slice(0, 10); };
    if (end0) {
      quarters = [1, 2, 3, 4].map((q) => {
        const to = back(end0, 3 * (q - 1)), from = back(end0, 3 * q);
        const ts = allTrades.filter((t) => { const d = t.exit.slice(0, 10); return d > from && d <= to; });
        const net = Math.trunc(ts.reduce((a, t) => a + (Number(t.net) || 0), 0));
        return { q, from, to, n: ts.length, net, ok: net > 0 };
      });
      const okQ = quarters.filter((x) => x.ok).length;
      if (okQ < 3) why.push(`only ${yrs.length} year${yrs.length === 1 ? "" : "s"} of minute prices, so judged by quarter: profitable in ${okQ} of the last 4 quarters (needs 3; lost or flat in ${quarters.filter((x) => !x.ok).map((x) => `quarter ${x.q}`).join(", ")})`);
    } else why.push(`only ${yrs.length} year${yrs.length === 1 ? "" : "s"} of history to test year by year (needs 3)`);
  } else if (yrs.length < 3) why.push(`only ${yrs.length} year${yrs.length === 1 ? "" : "s"} of history to test year by year (needs 3)`);
  else if (okY < needY) why.push(`profitable in ${okY} of the past ${yrs.length} years (needs ${needY === yrs.length ? "every year" : needY}; lost or flat in ${yrs.filter((x) => !x.ok).map((x) => `year ${x.y}`).join(", ")})`);
  // Fills decide a strategy's edge: it must still make money in total and in every year with the asset's slippage
  // doubled (charges are known exactly and counted once). Minute and daily strategies alike.
  if (yrs.length >= 3 || quarters) {
    const st = yrs.map((y) => ({ y: y.y, v: (Number(y.net) || 0) - (Number(y.xcost) || 0), has: y.xcost != null }));
    if (st.every((x) => x.has)) {
      const tot = st.reduce((a, x) => a + x.v, 0), bad = st.filter((x) => !(x.v > 0));
      if (!(tot > 0)) why.push(`loses money once slippage is doubled (₹${Math.trunc(tot).toLocaleString("en-IN")} over ${st.length} years)`);
      else if (strict && bad.length) why.push(`with slippage doubled it lost money in ${bad.map((x) => `year ${x.y}`).join(", ")}`);
    }
  }
  const bh = self?.bh ?? null;
  const sRatio = self && self.max_dd > 0 ? self.net / self.max_dd : self?.net > 0 ? 99 : 0;
  let vsBh: number | null = null, riskVsBh: number | null = null;
  if (bh && self) {
    vsBh = bh.net > 0 ? +(self.net / bh.net).toFixed(2) : null;
    riskVsBh = bh.ratio && bh.ratio > 0 ? +(sRatio / bh.ratio).toFixed(2) : null;
    // Shown for comparison only: the strategies trade long and short, so a falling asset is no reason to fail one.
  }
  const stepList = checks.filter((c) => c.kind === "step" && c.result && !c.result.skip && !c.result.error).map((c) => ({ note: c.result.note, net: c.result.net, pf: c.result.pf, n: c.result.n, ok: !!c.result.ok }));
  // --- Stricter rules (23 Oct 2026): the vault, luck, neighbouring settings, a few lucky trades, enough trades. ---
  // Neighbouring settings: at least 3 of 4 must make money, and the typical one at least half as much as the strategy.
  let plateau: { ok: number; n: number; median: number | null; self: number | null } | null = null;
  if (stepList.length >= 3) {
    const med = median(stepList.map((x) => Number(x.net) || 0)), selfNet = Number(self?.net) || 0, okS = stepList.filter((x) => x.ok).length;
    plateau = { ok: okS, n: stepList.length, median: med == null ? null : Math.trunc(med), self: Math.trunc(selfNet) };
    if (!strict) { /* shown for information */ }
    else if (okS < Math.ceil(stepList.length * 0.75)) why.push(`works only near this exact setting: ${okS} of ${stepList.length} nearby settings made money (needs ${Math.ceil(stepList.length * 0.75)})`);
    else if (med != null && selfNet > 0 && med < selfNet * 0.5) why.push(`nearby settings made much less (typical ₹${Math.trunc(med).toLocaleString("en-IN")} against ₹${Math.trunc(selfNet).toLocaleString("en-IN")}): the result depends on the exact setting`);
  }
  const nets = allTrades.map((t) => Number(t.net) || 0);
  // Enough trades over the whole history to judge it at all.
  const minAll = daily ? 30 : 100;
  if (nets.length < minAll) why.push(`only ${nets.length} trades over the years tested (needs ${minAll})`);
  // Not carried by a few lucky trades: without its best 5% of trades it must still make money.
  let topCut: { dropped: number; net: number } | null = null;
  if (nets.length) {
    const k = Math.max(1, Math.ceil(nets.length * 0.05)), rest = [...nets].sort((a, b) => b - a).slice(k).reduce((a, x) => a + x, 0);
    topCut = { dropped: k, net: Math.trunc(rest) };
    if (strict && !(rest > 0)) why.push(`the profit comes from a few trades: without its best ${k} it ${rest < 0 ? `lost ₹${Math.trunc(-rest).toLocaleString("en-IN")}` : "made nothing"}`);
  }
  // Luck: the chance its trades beat the best result expected from luck alone among the rule families the lab has
  // tried (Deflated Sharpe Ratio); 95% needed.
  const luck = { ...deflatedSharpe(nets, opts.families ?? 100), families: opts.families ?? null };
  if (strict && nets.length >= 3 && luck.dsr < 0.95) why.push(`could be luck: ${Math.round(luck.dsr * 100)}% confidence it beats the best of ${luck.trials} rule families the lab has tried, by chance (needs 95%)`);
  // The vault: the held-back latest months, seen once.
  const vc = checks.find((c) => c.kind === "vault");
  const vault = vc?.result ?? null;
  const vMonths = Math.round((Number(cfg.vault_days) || vaultDays(cfg)) / 30.4);
  if (!vc) why.push("not yet tested on the held-back latest months");
  else if (vault?.error) why.push(`held-back months couldn't be tested: ${vault.error}`);
  else if (!(vault?.n >= 1)) why.push(`no trade in the held-back last ${vMonths} months, so it can't be confirmed`);
  else if (!(vault?.net > 0)) why.push(`lost money in the held-back last ${vMonths} months (₹${Math.trunc(Number(vault.net) || 0).toLocaleString("en-IN")} over ${vault.n} trade${vault.n === 1 ? "" : "s"})`);
  // Phase 2, only for a strategy that passed everything above: shuffled prices and random entries.
  const nz = checks.filter((c) => c.kind === "noise" && c.result && !c.result.error);
  const rnd = checks.find((c) => c.kind === "random")?.result ?? null;
  let noise: { p: number; runs: number; real: number } | null = null, needsStage2 = false;
  if (!strict) { /* stage 2 belongs to the strict rules */ }
  else if (!nz.length && !rnd) { if (!why.length) { needsStage2 = true; why.push("waiting for the noise tests (shuffled prices, random entries)"); } }
  else {
    const real = nz.find((c) => Number(c.tf) === 0)?.result?.net, runs = nz.filter((c) => Number(c.tf) !== 0).map((c) => Number(c.result.net) || 0);
    if (real == null || runs.length < 20) why.push("the shuffled-price test didn't finish");
    else {
      noise = { p: +pValue(Number(real), runs).toFixed(3), runs: runs.length, real: Math.trunc(Number(real)) };
      if (noise.p > 0.05) why.push(`does no better than noise: ${Math.round(noise.p * 100)}% of ${runs.length} runs on shuffled prices did as well (needs under 5%)`);
    }
    if (!rnd || rnd.error) why.push("the random-entry test didn't finish");
    else if (rnd.p > 0.05) why.push(`random entries did as well: ${Math.round(rnd.p * 100)}% of 1,000 sets of random entries, held as long, matched it (needs under 5%)`);
  }
  const quality = qualityScore(yrs, allTrades, { okA, nA: assets.length, okT, nT: tfs.length },
    { stepsOk: stepList.filter((x) => x.ok).length, stepsN: stepList.length, twoWay: cfg.direction === "BOTH", capital: 500000 });
  const consistency = consistencyScore(yrs, allTrades, quarters);
  return { passed: why.length === 0, why, consistency, strict, self, bh, vs_bh: vsBh, risk_vs_bh: riskVsBh, assets: { ok: okA, n: assets.length, list: assets },
    tfs: { ok: okT, n: tfs.length, list: tfs }, years: { ok: okY, n: yrs.length, list: yrs }, vault, luck, plateau, top_cut: topCut, noise, random: rnd, needs_stage2: needsStage2, rev: strict ? 4 : 5, ...(quarters ? { quarters: { ok: quarters.filter((x) => x.ok).length, n: quarters.length, list: quarters } } : {}), steps: { ok: stepList.filter((x) => x.ok).length, n: stepList.length, list: stepList }, quality, daily, checked_at: new Date().toISOString() };
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
 * Quality score, 0–100, from the whole year-by-year test (up to 10 years; 5 for 5-minute strategies) and the checks:
 *  continuity 16 – profitable years, unbroken runs counting more (sum of run lengths² ÷ years²)
 *  return/risk 11 – yearly net ÷ the worst drawdown over the whole period (2 or more = full)
 *  months 7 – share of months that made money          steadiness 8 – how even the yearly profits are
 *  profit factor 6 (2.5 or more = full)                 robustness 6 – other assets and timeframes that work
 *  enough trades 3 (12 a year)                          setting stability 10 – small setting steps that also work
 *  cost stress 7 – profit left with the slippage paid twice, and the years still profitable
 *  time under water 5 – longest stretch from a peak back to a new peak (a year or more = 0)
 *  tail risk 5 – worst month vs the average month, worst trade vs the average winning trade
 *  random order 5 – trades shuffled 1,000 times: how often the drawdown passes 25% of the capital
 *  up vs down years 4 – profitable in years when the asset rose and in years when it fell
 *  long / short 3 – for two-way strategies, both sides make money
 *  return on margin 4 – yearly net ÷ average margin per lot (100% a year = full)
 */
export function qualityScore(
  yrs: { y: number; net: number; n: number; ok: boolean; xcost?: number; under?: number | null; margin?: number | null }[],
  trades: { exit: string; net: number; side?: string }[],
  rb: { okA: number; nA: number; okT: number; nT: number },
  ex: { stepsOk: number; stepsN: number; twoWay: boolean; capital: number } = { stepsOk: 0, stepsN: 0, twoWay: false, capital: 500000 },
) {
  const n = yrs.length;
  if (n < 1) return null;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  // Continuity: unbroken runs of profitable years, each run counting by its length squared.
  const byOld = [...yrs].sort((a, b) => b.y - a.y); // oldest first
  let runs = 0, cur = 0, best = 0;
  for (const y of byOld) { if (y.ok) { cur++; best = Math.max(best, cur); } else { runs += cur * cur; cur = 0; } }
  runs += cur * cur;
  let latest = 0; for (const y of [...yrs].sort((a, b) => a.y - b.y)) { if (y.ok) latest++; else break; }
  // Equity curve over the whole period: drawdown, time under water, months, wins and losses, long and short.
  const months = new Map<string, number>();
  let eq = 0, peak = 0, dd = 0, gw = 0, gl = 0, wins = 0, worstTrade = 0, longNet = 0, shortNet = 0;
  let peakDay = trades[0]?.exit?.slice(0, 10) ?? "", longestUw = 0;
  const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;
  for (const t of trades) {
    const v = Number(t.net) || 0, d = String(t.exit).slice(0, 10);
    eq += v;
    if (eq >= peak) { if (peak > 0 || eq > 0) longestUw = Math.max(longestUw, days(peakDay, d)); peak = eq; peakDay = d; }
    dd = Math.max(dd, peak - eq);
    if (v > 0) { gw += v; wins++; } else gl += -v;
    worstTrade = Math.min(worstTrade, v);
    if (t.side === "SHORT") shortNet += v; else longNet += v;
    const m = d.slice(0, 7); months.set(m, (months.get(m) ?? 0) + v);
  }
  if (trades.length) longestUw = Math.max(longestUw, days(peakDay, String(trades[trades.length - 1].exit).slice(0, 10))); // still under water at the end
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
  const steady = mean > 0 ? 0.6 * (1 / (1 + cv)) + 0.4 * clamp(worst / mean) : 0;
  const robust = ((rb.nA ? rb.okA / rb.nA : 0) + (rb.nT ? rb.okT / rb.nT : 0)) / 2;
  const sample = Math.min(1, trades.length / (n * 12));
  // Setting stability: share of the small setting steps that also work (no steps to try: half marks).
  const stability = ex.stepsN ? ex.stepsOk / ex.stepsN : 0.5;
  // Slippage stress: what is left after paying the slippage a second time on every order.
  const xcost = yrs.reduce((a, y) => a + (Number(y.xcost) || 0), 0);
  const stressNet = total - xcost, stressYearsOk = yrs.filter((y) => (Number(y.net) || 0) - (Number(y.xcost) || 0) > 0).length;
  const cost = total > 0 && stressNet > 0 ? clamp(stressNet / total) * (stressYearsOk / n) : 0;
  // Time under water: longest stretch from a peak back to a new peak (a year or more scores nothing).
  const underwater = clamp(1 - longestUw / 365);
  // Tail risk: worst month against the average month, and worst trade against the average winning trade.
  const avgMonth = mVals.length ? total / mVals.length : 0, worstMonth = mVals.length ? Math.min(...mVals) : 0, avgWin = wins ? gw / wins : 0;
  const tailM = worstMonth < 0 ? (avgMonth > 0 ? -worstMonth / avgMonth : 99) : 0, tailT = worstTrade < 0 ? (avgWin > 0 ? -worstTrade / avgWin : 99) : 0;
  const tail = (1 / (1 + tailM / 3) + 1 / (1 + tailT / 5)) / 2;
  // Random order: the same trades shuffled 1,000 times; how often the drawdown passes 25% of the capital.
  const margins = yrs.map((y) => Number(y.margin)).filter((x) => x > 0), avgMargin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
  const capital = Math.max(ex.capital, 2 * avgMargin), limit = capital * 0.25;
  const nv = trades.map((t) => Number(t.net) || 0), r = rng(12345), dds: number[] = [];
  let over = 0;
  for (let k = 0; k < 1000 && nv.length; k++) {
    for (let i = nv.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [nv[i], nv[j]] = [nv[j], nv[i]]; }
    let e = 0, pk = 0, d = 0;
    for (const v of nv) { e += v; pk = Math.max(pk, e); d = Math.max(d, pk - e); }
    dds.push(d); if (d > limit) over++;
  }
  dds.sort((a, b) => a - b);
  const mcP = dds.length ? over / dds.length : 1, mcP95 = dds.length ? dds[Math.floor(dds.length * 0.95)] : 0;
  // Up years vs down years of the asset itself.
  const up = yrs.filter((y) => (y.under ?? 0) > 0), down = yrs.filter((y) => y.under != null && y.under < 0);
  const upShare = up.length ? up.filter((y) => y.ok).length / up.length : null, downShare = down.length ? down.filter((y) => y.ok).length / down.length : null;
  const updown = upShare != null && downShare != null ? 0.5 * Math.min(upShare, downShare) + 0.25 * (upShare + downShare) : 0.6 * (upShare ?? downShare ?? 0);
  // Long / short balance for two-way strategies (one-way strategies: full marks, nothing to balance).
  const longShort = ex.twoWay ? (longNet > 0 ? 0.5 : 0) + (shortNet > 0 ? 0.5 : 0) : 1;
  // Return on margin per year (100% a year or more scores full).
  const rom = avgMargin > 0 ? perYear / avgMargin : 0;
  const pts = (w: number, x: number) => +(w * clamp(x)).toFixed(1);
  const parts = {
    continuity: pts(16, runs / (n * n)), return_risk: pts(11, calmar / 2), months: pts(7, monthsShare), steadiness: pts(8, steady),
    profit_factor: pts(6, (pf - 1) / 1.5), robustness: pts(6, robust), sample: pts(3, sample),
    stability: pts(10, stability), cost: pts(7, cost), underwater: pts(5, underwater), tail: pts(5, tail), montecarlo: pts(5, 1 - mcP),
    updown: pts(4, updown), longshort: pts(3, longShort), margin: pts(4, rom),
  };
  const score = +Object.values(parts).reduce((a, b) => a + b, 0).toFixed(1);
  return { score, parts, years: n, profitable_years: yrs.filter((y) => y.ok).length, best_streak: best, latest_streak: latest,
    months: mVals.length, pos_months: posM, net: Math.trunc(total), per_year: Math.trunc(perYear), max_dd: Math.trunc(dd), calmar: +calmar.toFixed(2),
    pf: +pf.toFixed(2), cv: +cv.toFixed(2), worst_year: Math.trunc(worst), trades: trades.length,
    steps_ok: ex.stepsOk, steps_n: ex.stepsN, stress_net: Math.trunc(stressNet), stress_years_ok: stressYearsOk, extra_cost: Math.trunc(xcost),
    underwater_days: Math.round(longestUw), worst_month: Math.trunc(worstMonth), avg_month: Math.trunc(avgMonth), worst_trade: Math.trunc(worstTrade), avg_win: Math.trunc(avgWin),
    mc_over: +(mcP * 100).toFixed(1), mc_p95: Math.trunc(mcP95), mc_capital: Math.trunc(capital),
    up_ok: up.filter((y) => y.ok).length, up_n: up.length, down_ok: down.filter((y) => y.ok).length, down_n: down.length,
    long_net: Math.trunc(longNet), short_net: Math.trunc(shortNet), two_way: ex.twoWay, rom_pct: +(rom * 100).toFixed(1), avg_margin: Math.trunc(avgMargin) };
}
/**
 * Consistency score, 0–100 (rev 5, the lab's ranking): steady profit scores more than the same profit made in a few
 * good stretches.
 *  years 25 – share of years profitable (minute strategies with under 3 years: the last 4 quarters)
 *  quarters 25 – share of calendar quarters with trades that made money
 *  smoothness 20 – half: how close the month-end profit curve is to a straight rising line (R², rising only);
 *                  half: how even the yearly profits are (1 ÷ (1 + spread ÷ average))
 *  return ÷ drawdown 15 – yearly net ÷ worst drawdown (1.5 or more = full)
 *  worst year 15 – full if no year lost; losing a whole average year's profit = 0
 */
export function consistencyScore(
  yrs: { y: number; net: number; ok: boolean }[],
  trades: { exit: string; net: number }[],
  quarters: { ok: boolean }[] | null = null,
) {
  const n = yrs.length;
  if (n < 1 || !trades.length) return null;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const yearShare = quarters && n < 3 ? quarters.filter((q) => q.ok).length / quarters.length : yrs.filter((y) => y.ok).length / n;
  const qs = new Map<string, number>(), ms = new Map<string, number>();
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => String(a.exit).localeCompare(String(b.exit)))) {
    const v = Number(t.net) || 0, d = String(t.exit).slice(0, 10);
    eq += v; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    const q = `${d.slice(0, 4)}Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
    qs.set(q, (qs.get(q) ?? 0) + v); ms.set(d.slice(0, 7), (ms.get(d.slice(0, 7)) ?? 0) + v);
  }
  const qVals = [...qs.values()], qShare = qVals.length ? qVals.filter((x) => x > 0).length / qVals.length : 0;
  // Month-end profit curve over every calendar month from the first trade to the last (months without trades count flat).
  const keys = [...ms.keys()].sort(), curve: number[] = [];
  if (keys.length) {
    let [yy, mm] = keys[0].split("-").map(Number); const [ly, lm] = keys[keys.length - 1].split("-").map(Number);
    let c = 0;
    while (yy < ly || (yy === ly && mm <= lm)) { c += ms.get(`${yy}-${String(mm).padStart(2, "0")}`) ?? 0; curve.push(c); if (++mm > 12) { mm = 1; yy++; } }
  }
  let r2 = 0, slope = 0;
  if (curve.length >= 3) {
    const k = curve.length, mx = (k - 1) / 2, my = curve.reduce((a, b) => a + b, 0) / k;
    let sxy = 0, sxx = 0, syy = 0;
    curve.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; syy += (y - my) ** 2; });
    slope = sxx ? sxy / sxx : 0; r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  }
  const total = trades.reduce((a, t) => a + (Number(t.net) || 0), 0), perYear = total / n;
  const rdd = dd > 0 ? perYear / dd : perYear > 0 ? 9 : 0;
  const nets = yrs.map((y) => Number(y.net) || 0), mean = nets.reduce((a, b) => a + b, 0) / n, worst = Math.min(...nets);
  // Smoothness: half the straight-line fit, half how even the yearly profits are (a few big years score low).
  const cv = mean > 0 ? Math.sqrt(nets.reduce((a, x) => a + (x - mean) ** 2, 0) / n) / mean : 9;
  const smooth = slope > 0 ? 0.5 * r2 + 0.5 / (1 + cv) : 0;
  const worstPart = worst >= 0 ? 1 : mean > 0 ? clamp(1 + worst / mean) : 0;
  const pts = (w: number, x: number) => +(w * clamp(x)).toFixed(1);
  const parts = { years: pts(25, yearShare), quarters: pts(25, qShare), smooth: pts(20, smooth), return_dd: pts(15, rdd / 1.5), worst_year: pts(15, worstPart) };
  const score = +Object.values(parts).reduce((a, b) => a + b, 0).toFixed(1);
  return { score, parts, years_share: +(yearShare * 100).toFixed(0), quarters_ok: qVals.filter((x) => x > 0).length, quarters_n: qVals.length,
    r2: +r2.toFixed(2), cv: +cv.toFixed(2), return_dd: +rdd.toFixed(2), worst_year: Math.trunc(worst), avg_year: Math.trunc(mean), per_year: Math.trunc(perYear), max_dd: Math.trunc(dd) };
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
      const checks = robustChecks(r.config, haveD, haveI5, !!run.settings?.strict).map((c) => ({ lab_id: r.id, kind: c.kind, asset: c.asset, tf: c.tf, config: c.config, status: "pending" }));
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
    const data = await cachedAsset(sb, asset, long);
    cpu += Math.min(250, performance.now() - t0);
    const memo = new Map<string, unknown>();
    const rates = await loadMarginRates(sb);
    const ups: Promise<unknown>[] = [];
    for (const c of pend.filter((p) => p.asset === asset && (p.kind === "year") === long)) {
      if (cpu > CPU_BUDGET || Date.now() - ctx.started > WALL_BUDGET) break;
      const t1 = performance.now();
      let result: Record<string, unknown>;
      try {
        const pw = preVault(win, c.config);
        if (c.kind === "noise" || c.kind === "random") {
          // Phase 2 (finalists only): the whole history before the vault, on shuffled candles (tf = shuffle number,
          // 0 = the real candles) or against random entries.
          const daily = !!c.config.rules?.daily;
          const first = daily ? data.daily[0]?.day : data.raw[0]?.day;
          const from = first ? addDays(first, daily ? 60 : 20) : pw.from, nw = { from, split: from, to: pw.to };
          if (c.kind === "noise") {
            const d = Number(c.tf) === 0 ? data : shuffledData(data, daily, Number(c.lab_id) * 1009 + Number(c.tf));
            const { metrics } = await screenOne(c.config, d, Number(c.tf) === 0 ? memo : new Map(), nw, capital, rates);
            result = { net: metrics.full.net, n: metrics.full.n, ok: true };
          } else {
            const { trades } = await screenOne(c.config, data, memo, nw, capital, rates);
            result = { ...randomEntries(trades as any[], closesFor(data, daily, from, pw.to), 1000, Number(c.lab_id)), n: trades.length, ok: true };
          }
          cpu += performance.now() - t1;
          ups.push(sb.from("lab_checks").update({ status: "done", result }).eq("id", c.id).then(() => {}));
          continue;
        }
        if (c.kind === "vault") {
          const vw = { from: addDays(pw.to, 1), split: addDays(pw.to, 1), to: win.to };
          const { metrics } = await screenOne(c.config, data, memo, vw, capital, rates);
          const f = metrics.full;
          result = { from: vw.from, to: vw.to, net: f.net, n: f.n, pf: f.pf, win_rate: f.win_rate, max_dd: f.max_dd, ok: f.n >= 1 && f.net > 0 };
          cpu += performance.now() - t1;
          ups.push(sb.from("lab_checks").update({ status: "done", result }).eq("id", c.id).then(() => {}));
          continue;
        }
        // Timeframe checks run on 5-minute candles, which for MCX only go back as far as the listed contracts have traded:
        // they are judged on that stretch (after 10 days of warm-up), with the trade minimum scaled to its length.
        let w = pw, scale = 1;
        if (c.kind === "year") {
          // Year k = the 12 months ending k-1 years before the test's last day, after warm-up for the indicators.
          const daily = !!c.config.rules?.daily, first = daily ? data.daily[0]?.day : data.raw[0]?.day;
          const hi = addDays(pw.to, -365 * (Number(c.tf) - 1)), lo = addDays(hi, -364);
          const warm = first ? addDays(first, daily ? 60 : 20) : hi; // 60 days lets the 10th year back fit in the daily history Dhan has (from mid-2015)
          const from = lo < warm ? warm : lo;
          if ((Date.parse(hi) - Date.parse(from)) / 86400000 < 300) {
            ups.push(sb.from("lab_checks").update({ status: "done", result: { skip: true, ok: false, error: "not enough history" } }).eq("id", c.id).then(() => {}));
            continue;
          }
          const { metrics, trades } = await screenOne(c.config, data, memo, { from, split: from, to: hi }, capital, rates);
          const f = metrics.full;
          // Slippage stress: the asset's slippage paid a second time on every order (charges are known exactly, counted once).
          const xcost = Math.trunc(trades.reduce((a: number, t: any) => a + (Number(t.slip) || 0), 0));
          // How the asset itself moved in that year (for the up-years / down-years check).
          const dd0 = data.daily.filter((d) => d.day >= from && d.day <= hi);
          const under = dd0.length > 1 ? +(((dd0[dd0.length - 1].c - dd0[0].c) / dd0[0].c) * 100).toFixed(2) : null;
          result = { from, to: hi, net: f.net, n: f.n, win_rate: f.win_rate, pf: f.pf, max_dd: f.max_dd, ok: f.net > 0, xcost, under, margin: metrics.margin_lot ?? null, tr: packTrades(trades) };
          cpu += performance.now() - t1;
          ups.push(sb.from("lab_checks").update({ status: "done", result }).eq("id", c.id).then(() => {}));
          continue;
        }
        if (c.kind === "tf") {
          const first = data.raw[0]?.day;
          const from = first ? addDays(first, 10) : pw.to;
          if (from > pw.from) w = { ...pw, from, split: from > pw.split ? from : pw.split };
          const days = (Date.parse(pw.to) - Date.parse(w.from)) / 86400000;
          if (days < 60) { ups.push(sb.from("lab_checks").update({ status: "done", result: { skip: true, ok: false, error: `only ${Math.max(0, Math.round(days))} days of 5-minute candles so far` } }).eq("id", c.id).then(() => {})); continue; }
          scale = Math.min(1, days / 365);
        }
        const { metrics } = await screenOne(c.config, data, memo, w, capital, rates);
        const f = metrics.full, daily = !!c.config.rules?.daily;
        const minN = Math.max(3, Math.round((daily ? 5 : 10) * scale));
        result = { net: f.net, pf: f.pf, max_dd: f.max_dd, n: f.n, win_rate: f.win_rate, test_net: metrics.test.net, ok: f.net > 0 && (f.pf == null || f.pf >= 1.1) && f.n >= minN, ...(w.from !== pw.from ? { from: w.from } : {}),
          ...(c.kind === "step" ? { note: String(c.config.lab_note ?? "").replace(/^Variation of a winner: /, "") } : {}) };
        if (c.kind === "self") result.bh = buyHold(data, pw.from, pw.to, Number(c.config.lot_size));
      } catch (e) { result = { ok: false, error: e instanceof Error ? e.message.slice(0, 160) : String(e) }; }
      cpu += performance.now() - t1;
      ups.push(sb.from("lab_checks").update({ status: "done", result }).eq("id", c.id).then(() => {}));
    }
    await Promise.all(ups);
  }
  // 3. Verdicts for winners whose checks are all done.
  // Any run's winners, not just the newest: pick those with no check still waiting (so nothing finished sits undecided).
  const { data: qAll } = await sb.from("lab_results").select("id").eq("basic_passed", true).eq("robust_status", "queued").order("id", { ascending: false }).limit(1000); // basic_passed: uses the small index (lab_results_robust_q)
  const qIds = (qAll ?? []).map((r) => r.id);
  const waiting = new Set<number>();
  for (let i = 0; i < qIds.length; i += 200) {
    const { data: pw } = await sb.from("lab_checks").select("lab_id").in("lab_id", qIds.slice(i, i + 200)).eq("status", "pending").limit(10000);
    for (const x of pw ?? []) waiting.add(x.lab_id);
  }
  const ready = qIds.filter((id) => !waiting.has(id)).slice(0, 20);
  const { data: queued } = ready.length
    ? await sb.from("lab_results").select("id, config, fingerprint, asset, label, mode, score, metrics, starred, promoted_id, request_id, refresh").in("id", ready).order("id", { ascending: false })
    : { data: [] as any[] };
  let decided = 0;
  const desk = (queued ?? []).length ? await deskFingerprints(sb) : new Set<string>();
  const ids = (queued ?? []).map((r) => r.id);
  const { data: allCs } = ids.length ? await sb.from("lab_checks").select("lab_id, kind, asset, tf, status, result").in("lab_id", ids).neq("status", "void").limit(5000) : { data: [] };
  for (const r of queued ?? []) {
    const cs = (allCs ?? []).filter((c) => c.lab_id === r.id);
    // A winner whose checks went missing goes back in the queue to get a fresh set (never stuck as "queued").
    if (!cs.length) { await sb.from("lab_results").update({ robust_status: null }).eq("id", r.id).eq("robust_status", "queued"); continue; }
    if (cs.some((c) => c.status === "pending")) continue;
    const v = robustVerdict(r.config, cs, { families: await familiesFor(sb, r.config), strict: !!run.settings?.strict });
    if (v.needs_stage2) {
      // A finalist: 100 runs on shuffled prices (plus the real one) and the random-entry test, then decided again.
      const cfg = { ...r.config, vault_days: vaultDays(r.config) };
      const rows = [...Array.from({ length: 101 }, (_, k) => ({ lab_id: r.id, kind: "noise", asset: r.config.underlying, tf: k, config: cfg, status: "pending" })),
        { lab_id: r.id, kind: "random", asset: r.config.underlying, tf: null, config: cfg, status: "pending" }];
      const { error: qe } = await sb.from("lab_checks").insert(rows);
      if (qe) throw new Error(qe.message);
      continue;
    }
    // Every trade of the year-by-year test is kept with the result (packed in columns to stay small).
    const longTrades = joinTrades(cs.filter((c) => c.kind === "year" && !c.result?.skip).map((c) => c.result?.tr).filter(Boolean));
    // A re-test of a strategy on someone's desk is marked as a re-test (so it replaces the older results) and kept even if it fails.
    const onDesk = desk.has(r.fingerprint);
    if (onDesk) r.refresh = true;
    await sb.from("lab_results").update({ robust_status: "done", robust: v, passed: v.passed, trades_long: longTrades, ...(onDesk ? { refresh: true } : {}) }).eq("id", r.id);
    // Winners are grouped with their twins (same asset, 80%+ of trades opened on the same day in the same direction).
    if (v.passed) await sb.rpc("lab_assign_twin", { p_id: r.id }).then(() => {}, () => {});
    await sb.from("lab_checks").delete().eq("lab_id", r.id);
    if (!v.passed && keepable(r)) await forget(sb, [{ ...r, round: v.why.some((w: string) => /year/.test(w)) && v.why.length === 1 ? 3 : 2, why: v.why }]);
    decided++;
  }
  const { count: left } = await sb.from("lab_checks").select("id", { count: "exact", head: true }).eq("status", "pending");
  const { count: mineLeft } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).eq("basic_passed", true).neq("robust_status", "done");
  const { count: backlog } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("basic_passed", true).is("robust_status", null);
  // For the progress bar: this run's winners still to decide (the re-check run: checks still to run).
  const robLeft = run.trigger === "robust" ? (left ?? 0) : (mineLeft ?? 0);
  await patch({ progress: `Tougher test: ${left ?? 0} checks to run${backlog ? `, ${backlog} earlier winners still to re-check` : ""} (${decided} decided just now)`,
    counts: { ...(run.counts ?? {}), rob_left: robLeft, rob_max: Math.max(Number(run.counts?.rob_max ?? 0), robLeft) } });
  // A nightly run moves on once its own winners are decided; the re-check run keeps going until the backlog is done.
  if (run.trigger === "robust") {
    // Somebody asked for a variation run: stop here so it can start; the re-check resumes afterwards.
    const { count: asks } = await sb.from("lab_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
    if ((asks ?? 0) > 0) return false;
    return (left ?? 0) > 0 || (backlog ?? 0) > 0 || (queued ?? []).length > decided;
  }
  return (mineLeft ?? 0) > 0;
}

/**
 * Overfitting gauge for a run (Probability of Backtest Overfitting, CSCV) per asset and mode, from the month-by-month
 * results of every fresh try: how often the best of one half of the months lands in the bottom half of the other.
 */
async function overfitGauge(sb: SupabaseClient, runId: number) {
  const { data } = await sb.from("lab_months").select("asset, mode, nets").eq("run_id", runId).limit(5000);
  const groups = new Map<string, number[][]>();
  for (const r of data ?? []) { const k = `${r.asset}|${r.mode}`; const g = groups.get(k) ?? []; g.push((r.nets ?? []).map(Number)); groups.set(k, g); }
  const rows: Record<string, unknown>[] = [];
  for (const [k, g] of groups) {
    const len = Math.min(...g.map((x) => x.length));
    const res = pbo(g.map((x) => x.slice(0, len)));
    if (!res) continue;
    const [asset, mode] = k.split("|");
    rows.push({ run_id: runId, asset, mode, pbo: res.pbo, strategies: res.strategies, slices: res.slices });
  }
  if (rows.length) await sb.from("lab_pbo").upsert(rows);
}
async function screenPhase(ctx: Ctx, run: Run, win: { from: string; split: string; to: string }): Promise<boolean> {
  const { sb } = ctx;
  const { data: pend } = await sb.from("lab_results").select("id, asset, config, fingerprint, label, mode, request_id, refresh, champion").eq("run_id", run.id).eq("stage", "pending").order("asset").order("id").limit(300);
  if (!pend?.length) return false;
  const monthRows: Record<string, unknown>[] = [];
  const asset = pend[0].asset;
  const capital = Number(run.settings?.capital ?? 500000);
  let cpu = 0;
  const t0 = performance.now();
  const data = await cachedAsset(sb, asset);
  cpu += Math.min(250, performance.now() - t0);
  const memo = new Map<string, unknown>();
  const rates = await loadMarginRates(sb);
  const desk = await deskFingerprints(sb);
  const updates: Promise<unknown>[] = [];
  const failed: Forgettable[] = [];
  for (const row of pend.filter((p) => p.asset === asset)) {
    if (cpu > CPU_BUDGET || Date.now() - ctx.started > WALL_BUDGET) break;
    const t1 = performance.now();
    let fields: Record<string, unknown>;
    try {
      const { metrics, trades } = await screenOne(row.config, data, memo, preVault(win, row.config), capital, rates);
      // Month by month results of every fresh try (not re-tests of earlier winners) for the overfitting gauge.
      if (!row.refresh && !row.champion && !row.request_id) monthRows.push({ run_id: run.id, asset: row.asset, mode: row.mode, nets: metrics.months.map((m) => Math.trunc(m.net)) });
      if (!metrics.passed && (row.refresh || (desk.has(row.fingerprint) && !row.request_id))) {
        // A saved strategy re-tested with the current rules that now fails the first round: kept, with the verdict,
        // so it replaces its older (passing) result instead of quietly disappearing.
        fields = { stage: "screened", basic_passed: false, passed: false, robust_status: "done", refresh: true, score: metrics.score, metrics, trades: slim(trades), error: null,
          robust: { status: "done", passed: false, why: (metrics.why ?? []).map((w: string) => `first round (latest year): ${w}`), checked_at: new Date().toISOString() } };
        cpu += performance.now() - t1;
        updates.push(sb.from("lab_results").update(fields).eq("id", row.id).then(() => {}));
        continue;
      }
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
  if (monthRows.length) await sb.from("lab_months").insert(monthRows).then(() => {}, () => {});
  await forget(sb, failed);
  run.counts = run.counts ?? {};
  run.counts.tested = Number(run.counts.tested ?? 0) + updates.length + failed.length;
  run.counts.failed1 = Number(run.counts.failed1 ?? 0) + failed.length;
  await sb.from("lab_runs").update({ counts: run.counts }).eq("id", run.id);
  return true;
}

/** Option-series store backed by the lab_opt_cache table. */
export function dbStore(sb: SupabaseClient): OptStore {
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
/**
 * Option pricing queue, worked in the background: every passed index strategy waits here (stage "opt_queue"), and one
 * instalment at a time prices the oldest one (a strategy already half-priced first), version by version. It works only
 * while no lab run is going (also during the rest between runs) and the database is answering quickly, so it never
 * competes with a run or with logins. Progress is shown on the Lab page (lab_settings.opt_status).
 */
export async function labOptStep(ctx: Ctx): Promise<boolean> {
  const { sb } = ctx;
  if (!(await labMayWork(sb, true))) return false;
  // Option pricing is lab work too: with strategies running it waits for the night window like the runs do.
  if (!(await labQuiet(sb))) return false;
  const { count: busyRuns } = await sb.from("lab_runs").select("id", { count: "exact", head: true }).eq("status", "running");
  if ((busyRuns ?? 0) > 0) return false;
  // One worker at a time.
  const now = new Date();
  const { data: lease } = await sb.from("lab_settings").update({ opt_lease_until: new Date(now.getTime() + 240000).toISOString() }).eq("id", 1)
    .or(`opt_lease_until.is.null,opt_lease_until.lt.${now.toISOString()}`).select("capital");
  if (!lease?.length) return false;
  const capital = Number(lease[0].capital ?? 500000);
  try {
    if (!ctx.creds.client || !ctx.creds.token) return false;
    return await optionQueueWork(ctx, capital);
  } finally {
    await sb.from("lab_settings").update({ opt_lease_until: null }).eq("id", 1);
  }
}
async function optionQueueWork(ctx: Ctx, capital: number): Promise<boolean> {
  const { sb } = ctx;
  const store = dbStore(sb);
  const wins = new Map<number, { from: string; split: string; to: string }>();
  const report = (f: Record<string, unknown>) => sb.from("lab_settings").update({ opt_status: { ...f, at: new Date().toISOString() } }).eq("id", 1).then(() => {}, () => {});
  while (Date.now() - ctx.started < WALL_BUDGET - 15000) {
    const { data: rows } = await sb.from("lab_results").select("id, run_id, asset, config, opt_job, opt_buy, opt_sell, opt_struct, label").in("stage", ["pricing", "opt_queue"])
      .order("stage", { ascending: false }).order("id", { ascending: true }).limit(1);
    const row = rows?.[0];
    if (!row) { await report({ idle: true }); return false; }
    // The strategy is priced over the same year its own run tested.
    if (!wins.has(row.run_id)) {
      const { data: r } = await sb.from("lab_runs").select("from_day, split_day, to_day").eq("id", row.run_id).maybeSingle();
      if (!r) { await sb.from("lab_results").update({ stage: "error", error: "Its run is gone", opt_job: null }).eq("id", row.id); continue; }
      wins.set(row.run_id, { from: String(r.from_day), split: String(r.split_day), to: String(r.to_day) });
    }
    const win = wins.get(row.run_id)!;
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
      const data = await cachedAsset(sb, row.asset);
      job.plans = simulateRules(s, data, win.from, win.to);
      job.cursor = 0; job.acc = newAcc(capital); job.trades = [];
    }
    const { count: left } = await sb.from("lab_results").select("id", { count: "exact", head: true }).in("stage", ["pricing", "opt_queue"]);
    await report({ id: row.id, label: row.label.slice(0, 90), version: vr.label, v: job.v, vn: variants.length, left: left ?? null, done: job.cursor ?? 0, of: (job.plans as unknown[] | undefined)?.length ?? null });
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

/** Moves unfinished strategies of runs that are no longer running into this run. Returns how many still need a backtest. */
export async function adoptLeftovers(sb: SupabaseClient, run: Run, assets: string[], max: number): Promise<number> {
  // A focused run keeps to its own assets; any other run takes leftovers of every asset the lab knows (their candles are
  // already stored), so a strategy never waits because its asset was later unticked.
  const focused = run.settings?.focus === true, want = new Set(assets);
  const { data: rows, error } = await sb.from("lab_results").select("id, run_id, asset, stage").eq("stage", "pending")
    .neq("run_id", run.id).order("id").limit(5000);
  // A failed look-up must not quietly skip the leftovers: fail this instalment so it is retried.
  if (error) throw new Error(`Couldn't look up unfinished strategies: ${error.message}`);
  if (!rows?.length) return 0;
  const runIds = [...new Set(rows.map((r) => r.run_id))];
  const { data: live, error: e2 } = await sb.from("lab_runs").select("id").in("id", runIds).eq("status", "running");
  if (e2) throw new Error(`Couldn't look up unfinished strategies: ${e2.message}`);
  const busy = new Set((live ?? []).map((r) => r.id));
  const orphans = rows.filter((r) => !busy.has(r.run_id) && LAB_ASSETS[r.asset] && (!focused || want.has(r.asset)));
  const pend = orphans.slice(0, max).map((r) => r.id);
  const ids = pend;
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await sb.from("lab_results").update({ run_id: run.id }).in("id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
  return pend.length;
}

/** Keep the tables small: strategies that didn't pass for 7 days, everything else for 45 days unless starred or turned into a strategy. */
async function prune(sb: SupabaseClient) {
  const d = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
  // Losers go after a week; first-round winners stay (45 days) so the tougher test's verdict can be seen.
  // (Strategies still waiting for their backtest are never cleared here: the next run takes them over.)
  await sb.from("lab_results").delete().eq("passed", false).or("basic_passed.is.null,basic_passed.eq.false").neq("stage", "pending").eq("starred", false).is("promoted_id", null).lt("created_at", d(7));
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

/**
 * Re-applies the current pass rules to stored tougher-test results without re-running the backtests: the slippage
 * stress of each year is recomputed from the kept trades (entry and exit prices × the asset's slippage × the lot), and
 * the verdict and quality score are worked out again. Marks each row done (robust.rev) so it can be called repeatedly.
 */
/**
 * Re-scores stored results under the simple rules (rev 5) from what their full test kept: the year-by-year results and
 * trades (trades_long), the held-back months and the stored checks. No new backtests; a batch per call.
 */
export async function labReverdict(sb: SupabaseClient, limit = 50): Promise<{ done: number; passed: number; flipped: number; left: number }> {
  await loadCryptoAssets(sb);
  // Small index (lab_results_robust_q: basic_passed, robust_status) first, then the rows themselves.
  const { data: ids, error: ie } = await sb.from("lab_results").select("id").eq("basic_passed", true).eq("robust_status", "done")
    .is("superseded_by", null).or("robust->>rev.is.null,robust->>rev.neq.5").order("id", { ascending: false }).limit(limit);
  if (ie) throw new Error(ie.message);
  const { data: rows, error } = (ids ?? []).length
    ? await sb.from("lab_results").select("id, config, robust, trades_long, passed").in("id", ids!.map((r) => r.id))
    : { data: [] as any[], error: null };
  if (error) throw new Error(error.message);
  let done = 0, flipped = 0, passed = 0;
  for (const r of rows ?? []) {
    const x = r.robust ?? {}, cfg = r.config ?? {}, u = String(cfg.underlying);
    const checks = [
      ...(x.self ? [{ kind: "self", asset: u, tf: null, result: x.self }] : []),
      ...((x.assets?.list ?? []) as any[]).map((a) => ({ kind: "asset", asset: String(a.asset), tf: null, result: a })),
      ...((x.tfs?.list ?? []) as any[]).map((t) => ({ kind: "tf", asset: u, tf: Number(t.tf), result: t })),
      ...((x.years?.list ?? []) as any[]).map((y) => ({ kind: "year", asset: u, tf: Number(y.y), result: { ...y, ...(Number(y.y) === 1 && r.trades_long ? { tr: r.trades_long } : {}) } })),
      ...((x.steps?.list ?? []) as any[]).map((st) => ({ kind: "step", asset: u, tf: null, result: st })),
      ...(x.vault ? [{ kind: "vault", asset: u, tf: null, result: x.vault }] : []),
    ];
    const v: any = robustVerdict(cfg, checks as any, { families: Number(x.luck?.families ?? x.luck?.trials) || 100 });
    // Kept from the earlier test, for information.
    v.noise = x.noise ?? null; v.random = x.random ?? null; v.checked_at = x.checked_at ?? v.checked_at; v.rescored_at = new Date().toISOString();
    if (v.passed) passed++;
    if (v.passed !== !!r.passed) flipped++;
    const { error: ue } = await sb.from("lab_results").update({ robust: v, passed: v.passed }).eq("id", r.id);
    if (ue) throw new Error(ue.message);
    if (v.passed && !r.passed) await sb.rpc("lab_assign_twin", { p_id: r.id }).then(() => {}, () => {});
    done++;
  }
  const { count } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("basic_passed", true).eq("robust_status", "done").is("superseded_by", null).or("robust->>rev.is.null,robust->>rev.neq.5");
  return { done, passed, flipped, left: count ?? 0 };
}
