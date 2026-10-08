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
  ["cross_above_pdh", "cross_below_pdl"], ["above_orh", "below_orl"], ["cross_above_orh", "cross_below_orl"]]) { MIRROR[a] = b; MIRROR[b] = a; }

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
];
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
  const style = r() < 0.2 ? "reversion" : "trend";
  const conds: Cond[] = [];
  let exitLong: Cond[] = [];
  if (style === "reversion") {
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
  atr: ST_ATR, factor: ST_FAC, len: [5, 7, 9, 13, 14, 20, 21, 30, 34, 50, 100, 200], len2: [13, 21, 34, 50, 100, 200],
  mult: BB_MULT, mins: [15, 30, 45, 60], fast: [5, 8, 12], slow: [21, 26, 35], sig: [5, 9],
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
export async function refreshAsset(sb: SupabaseClient, creds: { client: string; token: string }, key: string, today: string) {
  const a = LAB_ASSETS[key];
  const dhan = new Dhan(creds.client, creds.token);
  const sec = (await dataSecurity(sb, creds, a.seg, a.sec, today)).sec;
  const daily = await dhan.daily(sec, a.seg, a.instr, addDays(today, -1100), addDays(today, 1));
  await sb.from("lab_candles").upsert({ asset: key, kind: "D", from_day: daily[0]?.day ?? today, to_day: daily.at(-1)?.day ?? today, bars: toCol(daily, false), updated_at: new Date().toISOString() });
  if (a.commodity) return;
  const want = addDays(today, -(YEAR_DAYS + WARM_DAYS));
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
}

/** Cached candles in the shape the simulator wants. */
export async function loadAsset(sb: SupabaseClient, key: string): Promise<SimData> {
  const a = LAB_ASSETS[key];
  const { data: rows, error } = await sb.from("lab_candles").select("kind, bars").eq("asset", key);
  if (error) throw new Error(error.message);
  const d = rows?.find((r) => r.kind === "D"), i5 = rows?.find((r) => r.kind === "I5");
  if (!d) throw new Error(`No cached candles for ${key} yet.`);
  const daily: DayBar[] = fromCol(d.bars).map((r) => ({ ...r, day: ist(r.t).date }));
  const raw: MBar[] = [];
  const byDay = new Map<string, MBar[]>();
  if (i5) {
    for (const r of fromCol(i5.bars)) {
      const p = ist(r.t), sess = sessionFor(a.seg, p.date);
      if (p.min < sess.open || p.min >= sess.close) continue;
      const m = { ...r, day: p.date, min: p.min };
      raw.push(m);
      const arr = byDay.get(p.date); if (arr) arr.push(m); else byDay.set(p.date, [m]);
    }
  }
  return { raw, byDay, daily };
}

/* ---------- one strategy ---------- */
export function labParams(a: LabAsset, from: string, to: string, capital: number): BtParams {
  return { from, to, capital, brokerage: 20, charges: chargeRates(a), near_code: 1 };
}
/** Futures backtest of a lab strategy on cached candles (no network calls). */
export async function screenOne(cfg: LabConfig, data: SimData, memo: Map<string, unknown>, win: { from: string; split: string; to: string }, capital: number) {
  const a = LAB_ASSETS[cfg.underlying];
  const plans = simulateRules(cfg, data, win.from, win.to, memo);
  const { trades } = await priceBatch(cfg, { client: "-", token: "-" }, labParams(a, win.from, win.to, capital), plans, 0, newAcc(capital), Infinity, async () => {});
  const metrics = labMetrics(trades as T[], win.from, win.split, win.to, !!cfg.rules.daily);
  return { metrics, trades };
}

/** Trades trimmed for storage. */
const slim = (trades: Record<string, unknown>[]) => trades.map(({ chg: _c, units: _u, ...t }) => t);

/* ---------- orchestration ---------- */
type Run = Record<string, any>;
type Ctx = { sb: SupabaseClient; creds: { client: string; token: string }; started: number; chain: () => Promise<void> };
const CPU_BUDGET = 900; // ms of computing per instalment (Supabase's limit is 2 s)
const WALL_BUDGET = 100000; // ms of wall time per instalment

export async function labStart(sb: SupabaseClient, manual: boolean): Promise<number | null> {
  const { data: set } = await sb.from("lab_settings").select("*").eq("id", 1).maybeSingle();
  if (!set || (!set.enabled && !manual)) return null;
  const { data: running } = await sb.from("lab_runs").select("id").eq("status", "running").limit(1);
  if (running?.length) return running[0].id;
  const today = ist(Date.now() / 1000).date;
  const from = addDays(today, -YEAR_DAYS), split = addDays(today, -92);
  const { data: run, error } = await sb.from("lab_runs").insert({
    run_day: today, status: "running", phase: "data", progress: "Updating candles", from_day: from, split_day: split, to_day: today,
    trigger: manual ? "manual" : "schedule", settings: set,
  }).select("id").single();
  if (error) throw new Error(error.message);
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
  const patch = (f: Record<string, unknown>) => sb.from("lab_runs").update({ ...f, updated_at: new Date().toISOString() }).eq("id", run.id);
  const counts = run.counts ?? {};
  let more = true;
  try {
    if (!ctx.creds.client || !ctx.creds.token) throw new Error("Add your Dhan client ID and access token under Dhan connection.");
    const assets: string[] = (set.assets ?? []).filter((k: string) => LAB_ASSETS[k]);
    if (!assets.length) throw new Error("Pick at least one asset in the lab settings.");
    const win = { from: String(run.from_day), split: String(run.split_day), to: String(run.to_day) };

    if (run.phase === "data") {
      let i = Number(run.cursor ?? 0);
      while (i < assets.length && Date.now() - ctx.started < WALL_BUDGET - 20000) {
        await patch({ progress: `Updating candles: ${LAB_ASSETS[assets[i]].name} (${i + 1} of ${assets.length})` });
        await refreshAsset(sb, ctx.creds, assets[i], win.to);
        i++;
      }
      await patch(i < assets.length ? { cursor: i } : { cursor: 0, phase: "generate", progress: "Writing tonight's strategies" });
    } else if (run.phase === "generate") {
      await generatePhase(sb, run, assets, win);
      await patch({ phase: "screen", progress: "Backtesting strategies", counts: { ...counts, generated: (await countRows(sb, run.id)) } });
    } else if (run.phase === "screen") {
      const left = await screenPhase(ctx, run, win);
      if (!left) {
        const top = Number(set.top_options ?? 20);
        // Options are priced for index strategies on intraday candles; positional once-a-day trades run across expiries.
        const { data: best } = await sb.from("lab_results").select("id, asset, mode").eq("run_id", run.id).eq("stage", "screened").eq("passed", true)
          .order("score", { ascending: false }).limit(400);
        const pickIds = (best ?? []).filter((b) => !LAB_ASSETS[b.asset]?.commodity && b.mode === "INTRADAY").slice(0, top).map((b) => b.id);
        if (pickIds.length) await sb.from("lab_results").update({ stage: "opt_queue" }).in("id", pickIds);
        const { count: passed } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).eq("passed", true);
        await patch({ phase: "options", progress: `Pricing the best ${pickIds.length} with real option prices`, counts: { ...counts, screened: counts.generated, passed, to_price: pickIds.length } });
      } else {
        const { count: done } = await sb.from("lab_results").select("id", { count: "exact", head: true }).eq("run_id", run.id).neq("stage", "pending");
        await patch({ progress: `Backtested ${done} of ${counts.generated ?? "?"} strategies` });
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
    await patch({ status: "failed", error: e instanceof Error ? e.message : String(e), finished_at: new Date().toISOString(), lease_until: null });
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
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  const { data: recent } = await sb.from("lab_results").select("fingerprint").gte("created_at", since).limit(20000);
  const seen = new Set((recent ?? []).map((x) => x.fingerprint));
  // Champions: the best strategies of the last 30 days are re-tested every night on the rolling year.
  const { data: champs } = await sb.from("lab_results").select("fingerprint, config, score").eq("passed", true)
    .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()).order("score", { ascending: false }).limit(300);
  const rows: Record<string, unknown>[] = [];
  const champSeen = new Set<string>();
  for (const c of champs ?? []) {
    if (champSeen.size >= 25 || champSeen.has(c.fingerprint) || !assets.includes(c.config?.underlying)) continue;
    champSeen.add(c.fingerprint);
    rows.push({ run_id: run.id, asset: c.config.underlying, mode: c.config.rules?.daily ? "DAILY" : "INTRADAY", label: labelFor(c.config), fingerprint: c.fingerprint, champion: true, config: c.config, stage: "pending" });
  }
  const capital = Number(set.capital ?? 500000);
  let seed = (Number(run.id) * 1000003) >>> 0;
  // Variations: about a quarter of the night goes to close relatives of the best recent strategies (one or two settings changed).
  const { data: parents } = await sb.from("lab_results").select("id, fingerprint, config").eq("passed", true)
    .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()).order("score", { ascending: false }).limit(200);
  const pSeen = new Set<string>(), pool = (parents ?? []).filter((x) => assets.includes(x.config?.underlying) && !pSeen.has(x.fingerprint) && pSeen.add(x.fingerprint)).slice(0, 40);
  const nVar = pool.length ? Math.round(n * 0.25) : 0;
  for (let made = 0, tries = 0; made < nVar && tries < nVar * 6; tries++) {
    seed = (seed + 104729) >>> 0;
    const parent = pool[made % pool.length];
    const cfg = mutate(parent.config, seed, capital);
    if (!cfg) continue;
    const fp = fingerprint(cfg);
    if (seen.has(fp)) continue;
    seen.add(fp); made++;
    cfg.lab_note = `${cfg.lab_note} (from lab strategy #${parent.id})`;
    rows.push({ run_id: run.id, asset: cfg.underlying, mode: cfg.rules.daily ? "DAILY" : "INTRADAY", label: labelFor(cfg), fingerprint: fp, champion: false, config: cfg, stage: "pending" });
  }
  // New strategies, shared between assets (an index gets twice a commodity's share: it has intraday and option variants).
  const w = assets.map((k) => LAB_ASSETS[k].commodity ? 1 : 2), wsum = w.reduce((a, b) => a + b, 0);
  const nNew = n - nVar;
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

async function screenPhase(ctx: Ctx, run: Run, win: { from: string; split: string; to: string }): Promise<boolean> {
  const { sb } = ctx;
  const { data: pend } = await sb.from("lab_results").select("id, asset, config").eq("run_id", run.id).eq("stage", "pending").order("asset").order("id").limit(300);
  if (!pend?.length) return false;
  const asset = pend[0].asset;
  const capital = Number(run.settings?.capital ?? 500000);
  let cpu = 0;
  const t0 = performance.now();
  const data = await loadAsset(sb, asset);
  cpu += Math.min(250, performance.now() - t0);
  const memo = new Map<string, unknown>();
  const updates: Promise<unknown>[] = [];
  for (const row of pend.filter((p) => p.asset === asset)) {
    if (cpu > CPU_BUDGET || Date.now() - ctx.started > WALL_BUDGET) break;
    const t1 = performance.now();
    let fields: Record<string, unknown>;
    try {
      const { metrics, trades } = await screenOne(row.config, data, memo, win, capital);
      fields = { stage: "screened", passed: metrics.passed, score: metrics.score, metrics, trades: slim(trades), error: null };
    } catch (e) {
      fields = { stage: "error", error: e instanceof Error ? e.message : String(e) };
    }
    cpu += performance.now() - t1;
    updates.push(sb.from("lab_results").update(fields).eq("id", row.id).then(() => {}));
  }
  await Promise.all(updates);
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
  ];
}
async function optionsPhase(ctx: Ctx, run: Run, win: { from: string; split: string; to: string }, patch: (f: Record<string, unknown>) => unknown): Promise<boolean> {
  const { sb } = ctx;
  const capital = Number(run.settings?.capital ?? 500000);
  const store = dbStore(sb);
  while (Date.now() - ctx.started < WALL_BUDGET - 15000) {
    const { data: rows } = await sb.from("lab_results").select("id, asset, config, opt_job, opt_buy, opt_sell, label").eq("run_id", run.id).in("stage", ["pricing", "opt_queue"])
      .order("stage", { ascending: false }).order("score", { ascending: false }).limit(1);
    const row = rows?.[0];
    if (!row) return false;
    const a = LAB_ASSETS[row.asset];
    const job = row.opt_job ?? { v: 0 };
    const variants = optVariants(row.config);
    const vr = variants[job.v];
    const s = { ...row.config, trade_type: "OPTIONS", option_side: vr.side, risk: vr.risk, strike_offset: 0, strike_step: a.step, expiry_flag: a.flag, expiry_weekday: a.wd, roll_on_expiry: true };
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
      res = await priceBatch(s, ctx.creds, labParams(a, win.from, win.to, capital), job.plans as Plan[], job.cursor, job.acc, ctx.started + WALL_BUDGET - 10000, async () => {}, store);
    } catch (e) {
      if (e instanceof DhanBusyError) { job.acc.busy = busyBefore + 1; res = { trades: [], next: job.cursor, acc: job.acc }; }
      else if (TOKEN_ERR.test(e instanceof Error ? e.message : String(e))) {
        // The access token was renewed while this ran: keep the work and carry on with the new token in the next instalment.
        await sb.from("lab_results").update({ stage: "pricing", opt_job: job }).eq("id", row.id);
        return true;
      } else { await sb.from("lab_results").update({ stage: "error", error: e instanceof Error ? e.message : String(e), opt_job: null }).eq("id", row.id); continue; }
    }
    job.trades = job.trades.concat(slim(res.trades)); job.cursor = res.next; job.acc = res.acc;
    if (job.cursor >= job.plans.length) {
      const metrics = labMetrics(job.trades, win.from, win.split, win.to, !!row.config.rules?.daily);
      // Results with many trades that couldn't be priced aren't trustworthy.
      const unpriced = Object.values(job.acc.skipped ?? {}).reduce((a: number, b) => a + Number(b), 0);
      if (unpriced > job.plans.length * 0.2) { metrics.passed = false; metrics.why.push(`${unpriced} of ${job.plans.length} trades couldn't be priced with real option data`); }
      const out = { label: vr.label, risk: vr.risk, metrics, trades: job.trades, skipped: job.acc.skipped, planned: job.plans.length };
      const col = vr.side === "BUY" ? "opt_buy" : "opt_sell";
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
  await sb.from("lab_results").delete().eq("passed", false).eq("starred", false).is("promoted_id", null).lt("created_at", d(7));
  await sb.from("lab_results").delete().eq("starred", false).is("promoted_id", null).lt("created_at", d(45));
  await sb.from("lab_opt_cache").delete().lt("created_at", d(420));
  await sb.from("lab_runs").delete().lt("created_at", d(90));
}
