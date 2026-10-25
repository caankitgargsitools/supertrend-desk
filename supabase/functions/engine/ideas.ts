// The Ideas lab (step 3, 25 Oct 2026). Instead of thousands of random rule mixes, a short list of trading ideas from
// published research, each written down with a small fixed set of settings before any result is seen (the try ledger,
// table idea_tries). Every idea is tested as a portfolio across its assets, sized by risk for ₹35 lakh of capital
// (minis where a big contract is too big), and judged by the strategy lab's protective tests: luck (counted from the
// ledger), the held-back last 6 months, doubled slippage, nearby settings, a few lucky trades; 8 of 10 years profitable.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { addDays, type DayBar, ist } from "./logic.ts";
import { atr } from "./indicators.ts";
import { type Cond, type Rules, validateRules } from "./rules.ts";
import { slippageFor, slipped, tradeCharges } from "./backtest.ts";
import { assetRoot, cachedAsset, labMayWork, labParams, labQuiet, LAB_ASSETS, type LabConfig, readCandles, screenOne } from "./lab.ts";
import { loadMarginRates } from "./margins.ts";
import { deflatedSharpe, median } from "./stats.ts";

export const IDEA_CAPITAL = 3500000;
/** Each position is sized so that its usual daily move (20-day ATR) is about 0.2% of the capital. */
export const RISK_PCT = 0.002;
export const IDEA_VAULT_DAYS = 182;
/** Share of the past years that must be profitable (Papa, 25 Oct 2026: 8 of 10). */
export const YEARS_NEEDED = 0.8;

const MCX_KEYS = ["GOLD", "GOLDM", "SILVER", "SILVERM", "SILVERMIC", "CRUDEOIL", "CRUDEOILM", "NATURALGAS", "NATGASMINI", "COPPER",
  "ZINC", "ZINCMINI", "LEAD", "LEADMINI", "ALUMINIUM", "ALUMINI", "NICKEL"];
const INDEX_KEYS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
const CRYPTO_KEYS = ["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD"];

/* ---------- the ideas and their settings (fixed before testing) ---------- */
export type IdeaSetting = { key: string; label: string; p: Record<string, number | string> };
export type IdeaDef = {
  key: string; order: number; name: string; why: string; kind: "rules" | "custom" | "later";
  universe: string[]; daily: boolean; settings: IdeaSetting[]; note?: string;
};
const S = (key: string, label: string, p: Record<string, number | string>): IdeaSetting => ({ key, label, p });

export const IDEAS: IdeaDef[] = [
  {
    key: "trend", order: 1, kind: "rules", daily: true, universe: [...MCX_KEYS, ...INDEX_KEYS, ...CRYPTO_KEYS],
    name: "Trend following (daily)",
    why: "Prices that have been rising tend to keep rising for a while, and falling ones keep falling. The most researched trading edge there is (Moskowitz, Ooi & Pedersen 2012; Hurst, Ooi & Pedersen, a century of trend following).",
    settings: [
      S("ema-10-50", "EMA 10/50: long while the 10-day average is above the 50-day, short while below", { t: "ema", f: 10, s: 50 }),
      S("ema-20-50", "EMA 20/50", { t: "ema", f: 20, s: 50 }),
      S("ema-20-100", "EMA 20/100", { t: "ema", f: 20, s: 100 }),
      S("ema-50-200", "EMA 50/200", { t: "ema", f: 50, s: 200 }),
      S("don-20-10", "Donchian 20/10: buy a 20-day high, exit on a 10-day low (shorts mirrored)", { t: "don", e: 20, x: 10 }),
      S("don-55-20", "Donchian 55/20", { t: "don", e: 55, x: 20 }),
      S("don-100-50", "Donchian 100/50", { t: "don", e: 100, x: 50 }),
      S("don-200-100", "Donchian 200/100", { t: "don", e: 200, x: 100 }),
    ],
  },
  {
    key: "relstrength", order: 2, kind: "custom", daily: true, universe: MCX_KEYS,
    name: "Relative strength among commodities",
    why: "Across commodities, the ones that rose most over the past months tend to keep beating the ones that rose least (cross-sectional momentum; Erb & Harvey 2006, Miffre & Rallis 2007). Long the strongest, short the weakest, rebalanced every month.",
    settings: [
      S("lb63-k1", "3-month strength, long the strongest 1, short the weakest 1", { lb: 63, k: 1 }),
      S("lb63-k2", "3-month strength, top 2 / bottom 2", { lb: 63, k: 2 }),
      S("lb126-k1", "6-month strength, top 1 / bottom 1", { lb: 126, k: 1 }),
      S("lb126-k2", "6-month strength, top 2 / bottom 2", { lb: 126, k: 2 }),
      S("lb252-k1", "12-month strength, top 1 / bottom 1", { lb: 252, k: 1 }),
      S("lb252-k2", "12-month strength, top 2 / bottom 2", { lb: 252, k: 2 }),
    ],
  },
  {
    key: "reversal", order: 3, kind: "rules", daily: true, universe: INDEX_KEYS,
    name: "Index short-term reversal",
    why: "After an unusually sharp one- or two-day move, stock indices tend to bounce back part of it (short-term reversal, well documented on equity indices).",
    settings: [
      S("rsi2-5", "RSI(2) below 5: buy, out when back above 50 (above 95: short)", { t: "rsi", len: 2, lo: 5 }),
      S("rsi2-10", "RSI(2) 10 / 90", { t: "rsi", len: 2, lo: 10 }),
      S("rsi2-20", "RSI(2) 20 / 80", { t: "rsi", len: 2, lo: 20 }),
      S("rsi3-5", "RSI(3) 5 / 95", { t: "rsi", len: 3, lo: 5 }),
      S("rsi3-10", "RSI(3) 10 / 90", { t: "rsi", len: 3, lo: 10 }),
      S("rsi3-20", "RSI(3) 20 / 80", { t: "rsi", len: 3, lo: 20 }),
      S("bb-20-2", "Close below the lower Bollinger band (20, 2): buy, out at the middle band (shorts mirrored)", { t: "bb", mult: 2 }),
      S("bb-20-2.5", "Bollinger (20, 2.5)", { t: "bb", mult: 2.5 }),
    ],
  },
  {
    key: "orb", order: 4, kind: "rules", daily: false, universe: INDEX_KEYS,
    name: "Index opening-range breakout",
    why: "The first minutes of the session set the day's range; a break of it often runs on during the day (opening-range breakout, Crabel; Zarattini & Aziz 2023).",
    settings: [
      S("orb15", "Break of the first 15 minutes' range, stop at the other side, out by 15:15", { mins: 15, vwap: 0 }),
      S("orb30", "First 30 minutes", { mins: 30, vwap: 0 }),
      S("orb45", "First 45 minutes", { mins: 45, vwap: 0 }),
      S("orb15-vwap", "First 15 minutes, only on the side of the day's VWAP", { mins: 15, vwap: 1 }),
      S("orb30-vwap", "First 30 minutes, VWAP side", { mins: 30, vwap: 1 }),
      S("orb45-vwap", "First 45 minutes, VWAP side", { mins: 45, vwap: 1 }),
    ],
  },
  {
    key: "optsell", order: 5, kind: "later", daily: false, universe: ["NIFTY"],
    name: "Option-selling premium (hedged)",
    why: "Index options are usually priced above the moves that follow (the volatility risk premium); hedged, defined-risk selling collects part of it.",
    note: "Built next: it needs the option-price backtests of the strategy lab joined into the portfolio test.",
    settings: [
      S("ic-1sd", "Weekly iron condor, short strikes about 1 standard deviation out", { w: 1 }), S("ic-1.5sd", "Iron condor, 1.5 SD", { w: 1.5 }),
      S("strangle-hedged-1sd", "Hedged strangle, 1 SD", { w: 1 }), S("strangle-hedged-1.5sd", "Hedged strangle, 1.5 SD", { w: 1.5 }),
      S("ic-1sd-sl", "Iron condor 1 SD, stop at 2× premium", { w: 1 }), S("ic-1.5sd-sl", "Iron condor 1.5 SD, stop at 2× premium", { w: 1.5 }),
      S("bull-put", "Bull put spread, 1 SD", { w: 1 }), S("bear-call", "Bear call spread, 1 SD", { w: 1 }),
    ],
  },
  {
    key: "funding", order: 6, kind: "later", daily: true, universe: CRYPTO_KEYS,
    name: "Crypto funding carry",
    why: "Perpetual futures pay funding between longs and shorts; a hedged position collects it when it is high.",
    note: "Delta's funding history starts in late 2023, about two years, so the 8-of-10-years test can't judge it yet; built after the others.",
    settings: [
      S("f-0.01", "Collect funding above 0.01% per 8 hours", { th: 0.01 }), S("f-0.02", "Above 0.02%", { th: 0.02 }), S("f-0.03", "Above 0.03%", { th: 0.03 }),
      S("f-0.01-btc", "Above 0.01%, Bitcoin only", { th: 0.01 }), S("f-0.02-btc", "Above 0.02%, Bitcoin only", { th: 0.02 }), S("f-0.03-btc", "Above 0.03%, Bitcoin only", { th: 0.03 }),
    ],
  },
  {
    key: "season", order: 7, kind: "custom", daily: true, universe: INDEX_KEYS,
    name: "Index calendar effects",
    why: "Stock indices have tended to rise around the turn of the month (pension and salary flows) and to earn much of their gain overnight rather than during the day.",
    settings: [
      S("tom-4-3", "Turn of the month: long from the 4th-last trading day to the 3rd trading day of the new month", { t: "tom", a: 4, b: 3 }),
      S("tom-2-2", "Turn of the month: 2nd-last day to the 2nd day", { t: "tom", a: 2, b: 2 }),
      S("tom-1-4", "Turn of the month: last day to the 4th day", { t: "tom", a: 1, b: 4 }),
      S("night-all", "Overnight: long at the close, out at the next open, every day", { t: "night", wd: 0 }),
      S("night-mon-thu", "Overnight, Monday to Thursday closes only", { t: "night", wd: 1 }),
    ],
  },
];
export const ideaByKey = (k: string) => IDEAS.find((x) => x.key === k);

/* ---------- strategy configs for rule-based ideas ---------- */
const C = (ind: string, tf: string, p: Record<string, number>, op: string, v?: number): Cond => ({ ind, tf, p, op, ...(v != null ? { v } : {}) });
const set = (conds: Cond[], mode: "ALL" | "ANY" = "ALL") => ({ mode, conds });

/** A lab strategy config for one asset (futures, both directions, one lot, no stop unless the rules exit). */
export function ideaConfig(key: string, rules: Rules, o: { tf?: number; intraday?: boolean; entry?: "FLIP" | "JOIN"; note?: string } = {}): LabConfig {
  const a = LAB_ASSETS[key];
  if (!a) throw new Error(`Unknown asset ${key}`);
  const daily = !!rules.daily, intraday = !!o.intraday;
  const cfg: LabConfig = {
    strategy_kind: "RULES", underlying: a.key, data_security_id: a.sec, data_segment: a.seg, data_instrument: a.instr,
    exchange: a.exchange, dhan_symbol: a.key, futures_symbol: a.crypto ? a.key : a.key + "1!",
    timeframe_min: daily ? 375 : (o.tf ?? 5), rules, direction: "BOTH", entry_mode: o.entry ?? "FLIP",
    session_start: "09:15", last_entry: intraday ? "13:30" : "15:15", square_off: intraday ? "15:15" : "15:20", intraday,
    trade_type: "FUTURES", option_side: "BUY", lots: 1, lot_size: a.lot, qty_mode: "LOTS", product_type: intraday ? "I" : "M",
    strike_step: a.step ?? 1, strike_offset: 0, expiry_weekday: a.wd ?? 4, expiry_flag: a.flag ?? "WEEK", roll_on_expiry: true,
    atr_period: 10, factor: 3, entry_trigger: "CLOSE", buffer_points: 0, after_hours_flip: "FIRST_CLOSE", risk: null,
    ...(o.note ? { lab_note: o.note } : {}),
  };
  if (a.commodity) Object.assign(cfg, { session_start: "09:00", last_entry: "23:00", square_off: "23:15" });
  if (a.crypto) Object.assign(cfg, { session_start: "00:00", last_entry: "23:59", square_off: "23:59" });
  validateRules(cfg.rules);
  return cfg;
}

/** Rules of a rule-based idea's setting. */
export function ideaRules(idea: string, p: Record<string, any>): { rules: Rules; entry: "FLIP" | "JOIN"; intraday: boolean } {
  if (idea === "trend" && p.t === "ema") {
    const c = C("EMA", "D", { len: p.f, len2: p.s }, "fast_above_slow");
    // Always in the market: long while the fast average is above the slow one, short while below (stop and reverse).
    return { rules: { long: set([c]), short: set([{ ...c, op: "fast_below_slow" }]), daily: true }, entry: "JOIN", intraday: false };
  }
  if (idea === "trend" && p.t === "don") {
    return {
      rules: {
        long: set([C("DON", "D", { len: p.e }, "new_high")]), short: set([C("DON", "D", { len: p.e }, "new_low")]),
        exitLong: set([C("DON", "D", { len: p.x }, "new_low")], "ANY"), exitShort: set([C("DON", "D", { len: p.x }, "new_high")], "ANY"), daily: true,
      }, entry: "FLIP", intraday: false,
    };
  }
  if (idea === "reversal" && p.t === "rsi") {
    const r = (op: string, v: number) => C("RSI", "D", { len: p.len }, op, v);
    return {
      rules: { long: set([r("lt", p.lo)]), short: set([r("gt", 100 - p.lo)]), exitLong: set([r("gt", 50)], "ANY"), exitShort: set([r("lt", 50)], "ANY"), daily: true },
      entry: "FLIP", intraday: false,
    };
  }
  if (idea === "reversal" && p.t === "bb") {
    const b = (op: string) => C("BB", "D", { len: 20, mult: p.mult }, op);
    return {
      rules: { long: set([b("close_below_lower")]), short: set([b("close_above_upper")]), exitLong: set([b("price_above_mid")], "ANY"), exitShort: set([b("price_below_mid")], "ANY"), daily: true },
      entry: "FLIP", intraday: false,
    };
  }
  if (idea === "orb") {
    const o = (op: string) => C("ORB", "base", { mins: p.mins }, op);
    const vw = (op: string) => C("VWAP", "base", {}, op);
    return {
      rules: {
        long: set([o("cross_above_orh"), ...(p.vwap ? [vw("price_above")] : [])]), short: set([o("cross_below_orl"), ...(p.vwap ? [vw("price_below")] : [])]),
        exitLong: set([o("below_orl")], "ANY"), exitShort: set([o("above_orh")], "ANY"),
      }, entry: "FLIP", intraday: true,
    };
  }
  throw new Error(`No rules for idea ${idea}`);
}

/* ---------- legs: the backtests a try needs ---------- */
export type LegSpec = { asset: string; win_from: string | null; win_to: string | null; config: LabConfig };
/**
 * The backtests of one setting: a rule-based idea runs on each asset of its universe (daily: the whole history in one
 * go; 5-minute: one leg per year, to stay inside the engine's time limit per call); a custom idea is one leg over all
 * its assets.
 */
export function legsFor(idea: IdeaDef, s: IdeaSetting, today: string, have: Set<string>): LegSpec[] {
  if (idea.kind === "custom") return [{ asset: "*", win_from: null, win_to: null, config: { idea: idea.key, setting: s.key, p: s.p } }];
  if (idea.kind !== "rules") return [];
  const out: LegSpec[] = [];
  for (const key of idea.universe) {
    if (!LAB_ASSETS[key] || !have.has(key)) continue;
    const { rules, entry, intraday } = ideaRules(idea.key, s.p);
    const config = ideaConfig(key, rules, { entry, intraday, note: `Idea: ${idea.name} · ${s.label}` });
    if (idea.daily) out.push({ asset: key, win_from: null, win_to: today, config });
    else for (let y = 1; y <= 5; y++) {
      const hi = addDays(today, -365 * (y - 1)), lo = addDays(hi, -364);
      out.push({ asset: key, win_from: lo, win_to: hi, config });
    }
  }
  return out;
}

/* ---------- leg results: trades for one lot, with the daily ATR at entry for sizing ---------- */
export type LegTrades = { k: string[]; e: string[]; x: string[]; s: string[]; n: number[]; sl: number[]; a: number[] };
export type LegResult = { n: number; first: string | null; last: string | null; atr_med: Record<string, number>; t: LegTrades; error?: string; skip?: boolean };
const emptyTrades = (): LegTrades => ({ k: [], e: [], x: [], s: [], n: [], sl: [], a: [] });

/** Daily ATR (20) in rupees for one lot, by day (the value known at that day's close). */
export function atrRupees(daily: DayBar[], lot: number): Map<string, number> {
  const a = atr(daily, 20), m = new Map<string, number>();
  daily.forEach((d, i) => { if (a[i] > 0) m.set(d.day, a[i] * lot); });
  return m;
}
/** The value on the last day before `day` in a day → value map (days sorted). */
export function before(days: string[], vals: Map<string, number>, day: string): number | null {
  let lo = 0, hi = days.length - 1, j = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] < day) { j = m; lo = m + 1; } else hi = m - 1; }
  return j >= 0 ? vals.get(days[j]) ?? null : null;
}
/** Median daily ATR (rupees, 1 lot) over the days before the vault: used to pick a commodity's contract size. */
export function atrMedian(daily: DayBar[], lot: number, until: string): number {
  const m = atrRupees(daily.filter((d) => d.day < until), lot);
  return Math.trunc(median([...m.values()].slice(-750)) ?? 0);
}

/* ---------- custom ideas: trades built straight from daily candles ---------- */
/** One trade of one lot at given prices, with the asset's slippage and the exact charges. */
export function lotTrade(key: string, side: "LONG" | "SHORT", entryAt: string, entryPx: number, exitAt: string, exitPx: number) {
  const a = LAB_ASSETS[key], dir = side === "LONG" ? 1 : -1, frac = slippageFor(key).fut;
  const inPx = slipped(entryPx, dir > 0, frac, false), outPx = slipped(exitPx, dir < 0, frac, false);
  const buyVal = (dir > 0 ? inPx : outPx) * a.lot, sellVal = (dir > 0 ? outPx : inPx) * a.lot;
  const ch = tradeCharges(labParams(a, entryAt.slice(0, 10), exitAt.slice(0, 10), IDEA_CAPITAL), false, buyVal, sellVal).total;
  const net = Math.trunc((outPx - inPx) * dir * a.lot - ch);
  const slip = Math.trunc((Math.abs(inPx - entryPx) + Math.abs(outPx - exitPx)) * a.lot);
  return { net, slip };
}

/** Picks, for each commodity, the contract whose lot comes closest to the risk budget (minis where the big one is too big). */
export function pickContracts(keys: string[], atrMed: Record<string, number>, target: number): Map<string, string> {
  const byRoot = new Map<string, string[]>();
  for (const k of keys) { const r = assetRoot(k); byRoot.set(r, [...(byRoot.get(r) ?? []), k]); }
  const out = new Map<string, string>();
  for (const [root, ks] of byRoot) {
    const c = ks.filter((k) => atrMed[k] > 0).map((k) => ({ k, raw: target / atrMed[k], lot: LAB_ASSETS[k]?.lot ?? 1 }));
    if (!c.length) continue;
    const fit = c.filter((x) => x.raw >= 0.75);
    const err = (x: { raw: number }) => Math.abs(Math.log(Math.max(1, Math.round(x.raw)) / x.raw));
    const best = fit.length ? fit.sort((x, y) => err(x) - err(y) || y.lot - x.lot)[0] : c.sort((x, y) => y.raw - x.raw)[0];
    out.set(root, best.k);
  }
  return out;
}

/** One side of a trade (one lot): the fill after slippage and that order's charges. */
function sideCost(key: string, px: number, buy: boolean, day: string) {
  const a = LAB_ASSETS[key], fill = slipped(px, buy, slippageFor(key).fut, false), val = fill * a.lot;
  const ch = tradeCharges(labParams(a, day, day, IDEA_CAPITAL), false, buy ? val : 0, buy ? 0 : val).total;
  return { fill, ch, slip: Math.abs(fill - px) * a.lot };
}

export type DailySet = Record<string, DayBar[]>;
/**
 * Relative strength among commodities: every 21 trading days, long the k strongest over the look-back, short the k
 * weakest. Each holding period between two rebalances is booked as its own trade (so the months show the profit as it
 * comes), with slippage and charges only when a position really opens or closes; everything is closed on the last day.
 */
export function relStrengthTrades(daily: DailySet, p: { lb: number; k: number }, contracts: Map<string, string>): LegTrades {
  const keys = [...contracts.values()].filter((k) => daily[k]?.length);
  const idx = new Map(keys.map((k) => [k, new Map(daily[k].map((d, i) => [d.day, i]))]));
  const cal = [...new Set(keys.flatMap((k) => daily[k].map((d) => d.day)))].sort();
  const out = emptyTrades();
  const open = new Map<string, { side: "LONG" | "SHORT"; day: string; px: number; ch: number; slip: number }>();
  const book = (k: string, day: string, px: number, closing: boolean) => {
    const o = open.get(k)!, dir = o.side === "LONG" ? 1 : -1, lot = LAB_ASSETS[k].lot;
    const x = closing ? sideCost(k, px, dir < 0, day) : { fill: px, ch: 0, slip: 0 };
    const net = Math.trunc((x.fill - o.px) * dir * lot - o.ch - x.ch);
    out.k.push(k); out.e.push(`${o.day} 15:30`); out.x.push(`${day} 15:30`); out.s.push(dir > 0 ? "L" : "S");
    out.n.push(net); out.sl.push(Math.trunc(o.slip + x.slip)); out.a.push(0);
    if (closing) open.delete(k); else open.set(k, { ...o, day, px, ch: 0, slip: 0 });
  };
  const pxAt = (k: string, day: string) => { const i = idx.get(k)!.get(day); return i == null ? null : daily[k][i].c; };
  for (let d = p.lb; d < cal.length; d += 21) {
    const day = cal[d], past = cal[d - p.lb];
    const ranked = keys.map((k) => {
      const now = pxAt(k, day), then = pxAt(k, past);
      return now == null || then == null ? null : { k, px: now, r: now / then - 1 };
    }).filter((x): x is { k: string; px: number; r: number } => !!x).sort((a, b) => b.r - a.r);
    if (ranked.length < 2 * p.k + 1) continue;
    const want = new Map<string, "LONG" | "SHORT">([...ranked.slice(0, p.k).map((x) => [x.k, "LONG"] as const), ...ranked.slice(-p.k).map((x) => [x.k, "SHORT"] as const)]);
    const pxOf = new Map(ranked.map((x) => [x.k, x.px]));
    for (const k of [...open.keys()]) if (pxOf.has(k)) book(k, day, pxOf.get(k)!, want.get(k) !== open.get(k)!.side);
    for (const [k, side] of want) if (!open.has(k)) { const s = sideCost(k, pxOf.get(k)!, side === "LONG", day); open.set(k, { side, day, px: s.fill, ch: s.ch, slip: s.slip }); }
  }
  const lastDay = cal[cal.length - 1];
  for (const k of [...open.keys()]) { const px = pxAt(k, lastDay) ?? daily[k][daily[k].length - 1].c; book(k, lastDay, px, true); }
  return out;
}
/** Calendar effects on an index: turn of the month (long from the a-th last trading day to the b-th of the new month) or overnight. */
export function seasonTrades(key: string, daily: DayBar[], p: { t: string; a?: number; b?: number; wd?: number }): LegTrades {
  const out = emptyTrades();
  const push = (side: "LONG" | "SHORT", eDay: string, eT: string, ePx: number, xDay: string, xT: string, xPx: number) => {
    const { net, slip } = lotTrade(key, side, eDay, ePx, xDay, xPx);
    out.k.push(key); out.e.push(`${eDay} ${eT}`); out.x.push(`${xDay} ${xT}`); out.s.push(side === "LONG" ? "L" : "S"); out.n.push(net); out.sl.push(slip); out.a.push(0);
  };
  if (p.t === "night") {
    for (let i = 0; i + 1 < daily.length; i++) {
      const wd = new Date(daily[i].day + "T12:00:00Z").getUTCDay();
      if (p.wd && !(wd >= 1 && wd <= 4)) continue;
      push("LONG", daily[i].day, "15:30", daily[i].c, daily[i + 1].day, "09:15", daily[i + 1].o);
    }
    return out;
  }
  const months = new Map<string, number[]>();
  daily.forEach((d, i) => { const m = d.day.slice(0, 7); months.set(m, [...(months.get(m) ?? []), i]); });
  const ms = [...months.keys()].sort();
  for (let j = 0; j + 1 < ms.length; j++) {
    const cur = months.get(ms[j])!, nxt = months.get(ms[j + 1])!;
    const a = Number(p.a ?? 4), b = Number(p.b ?? 3);
    if (cur.length < a + 1 || nxt.length < b) continue;
    const ei = cur[cur.length - a - 1], xi = nxt[b - 1];
    push("LONG", daily[ei].day, "15:30", daily[ei].c, daily[xi].day, "15:30", daily[xi].c);
  }
  return out;
}

/* ---------- combining a setting's legs into one portfolio ---------- */
export type TryResult = {
  capital: number; target: number; contracts: Record<string, string>; lots: Record<string, number>;
  from: string; pre_to: string; vault_from: string; months: Record<string, number>;
  net: number; trades: number; max_dd: number; per_year: number; ret_pct: number; calmar: number; sharpe: number | null;
  months_n: number; months_pos: number; years: { y: number; from: string; to: string; net: number; slip: number; n: number; ok: boolean; stress_ok: boolean }[];
  years_ok: number; years_n: number; stress_net: number; stress_years_ok: number; top_cut: { dropped: number; net: number };
  vault: { from: string; to: string; net: number; n: number }; by_asset: Record<string, { net: number; n: number }>;
};
type Flat = { k: string; e: string; x: string; s: string; n: number; sl: number; a: number };
const flatten = (t: LegTrades): Flat[] => t.n.map((_, i) => ({ k: t.k[i], e: t.e[i], x: t.x[i], s: t.s[i], n: t.n[i], sl: t.sl[i], a: t.a[i] }));

/**
 * A setting's portfolio: picks one contract per commodity, sizes every trade by the daily ATR at its entry (the risk
 * budget ÷ one lot's usual daily move, at least the contract's typical size, at most 3×), and adds the trades up.
 * Months, years, drawdown and the other figures cover the time before the vault; the vault is reported apart.
 */
export function combineTry(legs: { asset: string; result: LegResult }[], o: { today: string; capital?: number; risk?: number }): TryResult {
  const capital = o.capital ?? IDEA_CAPITAL, target = capital * (o.risk ?? RISK_PCT);
  const vaultFrom = addDays(o.today, -IDEA_VAULT_DAYS + 1), preTo = addDays(vaultFrom, -1);
  const atrMed: Record<string, number> = {};
  for (const l of legs) for (const [k, v] of Object.entries(l.result?.atr_med ?? {})) if (v > 0) atrMed[k] = v;
  const all = legs.filter((l) => l.result && !l.result.error && !l.result.skip).flatMap((l) => flatten(l.result.t));
  const keys = [...new Set(all.map((t) => t.k))];
  const contracts = pickContracts(keys, atrMed, target);
  const chosen = new Set(contracts.values());
  const lots: Record<string, number> = {};
  for (const k of chosen) lots[k] = atrMed[k] > 0 ? Math.max(1, Math.round(target / atrMed[k])) : 1;
  const trades = all.filter((t) => chosen.has(t.k)).map((t) => {
    const typical = lots[t.k], cap = 3 * typical;
    const want = t.a > 0 ? Math.round(target / t.a) : typical;
    const q = Math.min(cap, Math.max(t.a > 0 && want < 1 ? 0 : 1, want));
    return { ...t, q, net: t.n * q, slip: t.sl * q };
  }).filter((t) => t.q > 0).sort((a, b) => a.x.localeCompare(b.x));
  const firsts = legs.map((l) => l.result?.first).filter((x): x is string => !!x).sort();
  const from = firsts[0] ?? preTo;
  const pre = trades.filter((t) => t.x.slice(0, 10) <= preTo), post = trades.filter((t) => t.x.slice(0, 10) >= vaultFrom);
  // Months from the first data month to the vault (months without trades count as 0).
  const months: Record<string, number> = {};
  for (let m = from.slice(0, 7); m <= preTo.slice(0, 7); m = addDays(m + "-28", 7).slice(0, 7)) months[m] = 0;
  for (const t of pre) { const m = t.x.slice(0, 7); months[m] = (months[m] ?? 0) + t.net; }
  let eq = 0, peak = 0, dd = 0;
  for (const t of pre) { eq += t.net; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const net = pre.reduce((a, t) => a + t.net, 0);
  const yearsSpan = Math.max(0.25, (Date.parse(preTo) - Date.parse(from)) / (365.25 * 86400000));
  const perYear = net / yearsSpan;
  const mv = Object.values(months), mean = mv.reduce((a, b) => a + b, 0) / Math.max(1, mv.length);
  const sd = Math.sqrt(mv.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, mv.length - 1));
  // Years: the 12 months ending k-1 years before the vault, while the data covers them (a few weeks' warm-up allowed).
  const years: TryResult["years"] = [];
  for (let y = 1; y <= 10; y++) {
    const hi = addDays(preTo, -365 * (y - 1)), lo = addDays(hi, -364);
    if (addDays(from, -60) > lo) break;
    const ts = pre.filter((t) => { const d = t.x.slice(0, 10); return d >= lo && d <= hi; });
    const yn = ts.reduce((a, t) => a + t.net, 0), ys = ts.reduce((a, t) => a + t.slip, 0);
    years.push({ y, from: lo, to: hi, net: Math.trunc(yn), slip: Math.trunc(ys), n: ts.length, ok: yn > 0, stress_ok: yn - ys > 0 });
  }
  const k = Math.max(1, Math.ceil(pre.length * 0.05));
  const rest = [...pre.map((t) => t.net)].sort((a, b) => b - a).slice(k).reduce((a, b) => a + b, 0);
  const byAsset: Record<string, { net: number; n: number }> = {};
  for (const t of pre) { const b = byAsset[t.k] ?? (byAsset[t.k] = { net: 0, n: 0 }); b.net += t.net; b.n++; }
  for (const b of Object.values(byAsset)) b.net = Math.trunc(b.net);
  const slipTot = pre.reduce((a, t) => a + t.slip, 0);
  return {
    capital, target: Math.trunc(target), contracts: Object.fromEntries(contracts), lots,
    from, pre_to: preTo, vault_from: vaultFrom, months: Object.fromEntries(Object.entries(months).map(([m, v]) => [m, Math.trunc(v)])),
    net: Math.trunc(net), trades: pre.length, max_dd: Math.trunc(dd), per_year: Math.trunc(perYear), ret_pct: +((perYear / capital) * 100).toFixed(1),
    calmar: dd > 0 ? +(perYear / dd).toFixed(2) : perYear > 0 ? 9 : 0, sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(12)).toFixed(2) : null,
    months_n: mv.length, months_pos: mv.filter((v) => v > 0).length,
    years, years_ok: years.filter((y) => y.ok).length, years_n: years.length,
    stress_net: Math.trunc(net - slipTot), stress_years_ok: years.filter((y) => y.stress_ok).length,
    top_cut: { dropped: k, net: Math.trunc(rest) },
    vault: { from: vaultFrom, to: o.today, net: Math.trunc(post.reduce((a, t) => a + t.net, 0)), n: post.length }, by_asset: byAsset,
  };
}

/* ---------- honest counting of tries, and the verdict ---------- */
const corr = (a: number[], b: number[]) => {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
};
/**
 * Settings of one idea move together, so they are not independent tries: with M settings whose monthly results have an
 * average correlation ρ, they count as ρ + (1 − ρ)·M independent tries (1 when they are identical, M when unrelated).
 */
export function effectiveTries(series: Record<string, number>[]): { m: number; rho: number; n: number } {
  const M = series.length;
  if (M <= 1) return { m: M, rho: 1, n: Math.max(1, M) };
  const ms = [...new Set(series.flatMap((s) => Object.keys(s)))].sort();
  const vs = series.map((s) => ms.map((m) => s[m] ?? 0));
  let sum = 0, cnt = 0;
  for (let i = 0; i < M; i++) for (let j = i + 1; j < M; j++) { sum += corr(vs[i], vs[j]); cnt++; }
  const rho = Math.max(0, Math.min(1, sum / cnt));
  return { m: M, rho: +rho.toFixed(3), n: +(rho + (1 - rho) * M).toFixed(2) };
}

export type IdeaVerdict = { passed: boolean; finalist: boolean; why: string[]; luck: ReturnType<typeof deflatedSharpe> & { tries: number };
  plateau: { ok: number; n: number }; score: number; parts: Record<string, number> };
/**
 * The verdict for one setting, once every setting of its idea is combined. tries = the ledger's count of independent
 * tries over all ideas (finished ideas by their effective count, the others by their number of settings).
 */
export function ideaVerdict(r: TryResult, o: { tries: number; plateau: { ok: number; n: number } }): IdeaVerdict {
  const why: string[] = [];
  const need = Math.ceil(r.years_n * YEARS_NEEDED);
  if (r.years_n < 3) why.push(`only ${r.years_n} year${r.years_n === 1 ? "" : "s"} of history to test year by year (needs 3)`);
  else if (r.years_ok < need) why.push(`profitable in ${r.years_ok} of the past ${r.years_n} years (needs ${need})`);
  if (!(r.net > 0)) why.push("lost money over the years tested");
  if (!(r.stress_net > 0)) why.push(`loses money once slippage is doubled (₹${r.stress_net.toLocaleString("en-IN")})`);
  else if (r.years_n >= 3 && r.stress_years_ok < need) why.push(`with slippage doubled, profitable in ${r.stress_years_ok} of ${r.years_n} years (needs ${need})`);
  if (r.trades < 100) why.push(`only ${r.trades} trades over the years tested (needs 100)`);
  if (!(r.top_cut.net > 0)) why.push(`the profit comes from a few trades: without its best ${r.top_cut.dropped} it ${r.top_cut.net < 0 ? `lost ₹${(-r.top_cut.net).toLocaleString("en-IN")}` : "made nothing"}`);
  const pNeed = Math.ceil(o.plateau.n * 0.75);
  if (o.plateau.ok < pNeed) why.push(`only ${o.plateau.ok} of the idea's ${o.plateau.n} settings made money (needs ${pNeed}): the result depends on the exact setting`);
  const mv = Object.values(r.months).map((v) => v / r.capital);
  const luck = { ...deflatedSharpe(mv, o.tries), tries: o.tries };
  if (luck.dsr < 0.95) why.push(`could be luck: ${Math.round(luck.dsr * 100)}% confidence it beats the best of ${o.tries} independent tries by chance (needs 95%)`);
  if (!(r.vault.n >= 1)) why.push("no trade in the held-back last 6 months, so it can't be confirmed");
  else if (!(r.vault.net > 0)) why.push(`lost money in the held-back last 6 months (₹${r.vault.net.toLocaleString("en-IN")} over ${r.vault.n} trades)`);
  const finalist = why.length === 0;
  if (finalist) why.push("passed every test so far: waiting for the shuffled-price and random-entry tests");
  const cl = (x: number) => Math.max(0, Math.min(1, x));
  const parts = {
    years: +(30 * cl(r.years_n ? r.years_ok / r.years_n : 0)).toFixed(1),
    return_risk: +(20 * cl(r.calmar)).toFixed(1),
    slippage: +(15 * cl(r.years_n ? r.stress_years_ok / r.years_n : 0)).toFixed(1),
    months: +(10 * cl(r.months_n ? r.months_pos / r.months_n : 0)).toFixed(1),
    settings: +(10 * cl(o.plateau.n ? o.plateau.ok / o.plateau.n : 0)).toFixed(1),
    luck: +(15 * cl(luck.dsr)).toFixed(1),
  };
  return { passed: false, finalist, why, luck, plateau: o.plateau, score: +Object.values(parts).reduce((a, b) => a + b, 0).toFixed(1), parts };
}

/** The ledger's count of independent tries: finished ideas by their effective count, the rest by their settings. */
export function ledgerTries(rows: { idea: string; status: string }[], eff: Record<string, number>): number {
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.idea, (per.get(r.idea) ?? 0) + 1);
  let n = 0;
  for (const [idea, m] of per) n += eff[idea] ?? m;
  return Math.max(2, Math.round(n));
}

/* ---------- the engine step ---------- */
const CPU_BUDGET = 900, WALL_BUDGET = 100000;
type Leg = { id: number; try_id: number; asset: string; win_from: string | null; win_to: string | null; config: LabConfig };

/** Daily candles of an asset (decoded from the stored file; kept between calls while the instance stays warm). */
const DAILY_MEMO = new Map<string, { at: number; bars: DayBar[] }>();
async function dailyOf(sb: SupabaseClient, key: string): Promise<DayBar[]> {
  const hit = DAILY_MEMO.get(key);
  if (hit && Date.now() - hit.at < 3600000) return hit.bars;
  const row = (await readCandles(sb, key, ["D"]))[0];
  const c = row?.bars as { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] } | undefined;
  const bars: DayBar[] = c ? c.t.map((t, i) => ({ t, o: c.o[i], h: c.h[i], l: c.l[i], c: c.c[i], day: ist(t).date } as DayBar)) : [];
  DAILY_MEMO.set(key, { at: Date.now(), bars });
  return bars;
}

/** Writes every idea's settings into the ledger (once; later settings are added, never changed). */
export async function registerIdeas(sb: SupabaseClient) {
  const { data } = await sb.from("idea_tries").select("idea, setting_key");
  const have = new Set((data ?? []).map((r) => `${r.idea}|${r.setting_key}`));
  const rows = IDEAS.flatMap((i) => i.settings.filter((s) => !have.has(`${i.key}|${s.key}`)).map((s) => ({
    idea: i.key, idea_order: i.order, setting_key: s.key, label: s.label, setting: s.p, status: i.kind === "later" ? "later" : "planned",
  })));
  if (rows.length) { const { error } = await sb.from("idea_tries").insert(rows); if (error) throw new Error(error.message); }
  return rows.length;
}

/** One instalment of the Ideas lab: one idea at a time, its backtests in small batches, then its verdict. */
export async function ideasStep(sb: SupabaseClient, started = Date.now()): Promise<Record<string, unknown>> {
  const { data: set } = await sb.from("lab_settings").select("ideas_enabled, ideas_capital").eq("id", 1).maybeSingle();
  if (!set?.ideas_enabled) return { idle: "Ideas lab is switched off" };
  if (!(await labQuiet(sb))) return { idle: "waiting for the markets to close" };
  if (!(await labMayWork(sb, true))) return { idle: "lab paused" };
  const { count: busy } = await sb.from("lab_runs").select("id", { count: "exact", head: true }).eq("status", "running");
  if ((busy ?? 0) > 0) return { idle: "a lab run is going" };
  const capital = Number(set.ideas_capital) || IDEA_CAPITAL;
  await registerIdeas(sb);
  const today = ist(Date.now() / 1000).date;
  const { data: tries } = await sb.from("idea_tries").select("id, idea, idea_order, setting_key, setting, status").neq("status", "later").order("idea_order").order("id");
  const open = (tries ?? []).filter((t) => t.status !== "done");
  if (!open.length) return { idle: "every idea is done" };
  const idea = ideaByKey(open[0].idea)!;
  const mine = (tries ?? []).filter((t) => t.idea === idea.key);
  // 1. Queue the backtests of the idea's settings.
  const planned = mine.filter((t) => t.status === "planned");
  if (planned.length) {
    const { data: cands } = await sb.from("lab_candles").select("asset, kind");
    const have = new Set((cands ?? []).filter((c) => c.kind === (idea.daily ? "D" : "I5") || (!idea.daily && /^I5Y/.test(c.kind))).map((c) => c.asset));
    for (const t of planned) {
      const s = idea.settings.find((x) => x.key === t.setting_key)!;
      const legs = legsFor(idea, s, today, have).map((l) => ({ try_id: t.id, ...l, status: "pending" }));
      if (legs.length) { const { error } = await sb.from("idea_legs").insert(legs); if (error) throw new Error(error.message); }
      await sb.from("idea_tries").update({ status: "running", started_at: new Date().toISOString() }).eq("id", t.id);
    }
  }
  // 2. Run pending backtests, one asset's candles at a time.
  const ids = mine.map((t) => t.id);
  const { data: pend } = await sb.from("idea_legs").select("id, try_id, asset, win_from, win_to, config").in("try_id", ids).eq("status", "pending").order("asset").order("id").limit(200);
  let ran = 0;
  if (pend?.length) {
    const asset = pend[0].asset;
    const rates = await loadMarginRates(sb);
    let cpu = 0;
    const ups: Promise<unknown>[] = [];
    const memo = new Map<string, unknown>();
    for (const leg of (pend as Leg[]).filter((l) => l.asset === asset)) {
      if (cpu > CPU_BUDGET || Date.now() - started > WALL_BUDGET) break;
      const t1 = performance.now();
      let result: LegResult;
      try { result = await runLeg(sb, leg, memo, rates, today, capital); } catch (e) { result = { n: 0, first: null, last: null, atr_med: {}, t: emptyTrades(), error: e instanceof Error ? e.message.slice(0, 160) : String(e) }; }
      cpu += performance.now() - t1;
      ups.push(sb.from("idea_legs").update({ status: "done", result, done_at: new Date().toISOString() }).eq("id", leg.id).then(() => {}));
      ran++;
    }
    await Promise.all(ups);
  }
  // 3. Settings whose backtests are all done become portfolios.
  const { data: left } = await sb.from("idea_legs").select("try_id").in("try_id", ids).eq("status", "pending").limit(5000);
  const waiting = new Set((left ?? []).map((l) => l.try_id));
  let combined = 0;
  for (const t of mine.filter((x) => x.status === "running" && !waiting.has(x.id))) {
    const { data: legs } = await sb.from("idea_legs").select("asset, result").eq("try_id", t.id).limit(1000);
    const result = combineTry((legs ?? []) as { asset: string; result: LegResult }[], { today, capital });
    await sb.from("idea_tries").update({ status: "combined", result }).eq("id", t.id);
    t.status = "combined"; (t as any).result = result; combined++;
  }
  // 4. All settings combined: the verdicts, with the luck test counting the ledger's tries.
  if (mine.every((t) => t.status === "combined" || t.status === "done")) {
    const { data: full } = await sb.from("idea_tries").select("id, idea, status, result").eq("idea", idea.key);
    const rs = (full ?? []).map((x) => x.result as TryResult).filter(Boolean);
    const eff = effectiveTries(rs.map((r) => r.months));
    const { data: ledger } = await sb.from("idea_tries").select("idea, status, verdict");
    const effByIdea: Record<string, number> = { [idea.key]: eff.n };
    for (const r of ledger ?? []) if (r.idea !== idea.key && r.status === "done" && r.verdict?.idea_tries != null) effByIdea[r.idea] = Number(r.verdict.idea_tries);
    const tries = ledgerTries(ledger ?? [], effByIdea);
    const plateau = { ok: rs.filter((r) => r.net > 0).length, n: rs.length };
    for (const t of full ?? []) {
      const v = ideaVerdict(t.result as TryResult, { tries, plateau });
      await sb.from("idea_tries").update({ status: "done", verdict: { ...v, idea_tries: eff.n, idea_rho: eff.rho }, done_at: new Date().toISOString() }).eq("id", t.id);
    }
    await sb.from("idea_legs").update({ result: null }).in("try_id", (full ?? []).map((t) => t.id)); // the trades live on in the settings' results
    return { idea: idea.key, decided: (full ?? []).length, tries };
  }
  return { idea: idea.key, ran, combined, more: true };
}

/** One backtest leg: a rule strategy on one asset's candles, or a custom idea over its assets' daily candles. */
async function runLeg(sb: SupabaseClient, leg: Leg, memo: Map<string, unknown>, rates: Record<string, any>, today: string, capital: number): Promise<LegResult> {
  const vaultFrom = addDays(today, -IDEA_VAULT_DAYS + 1);
  if (leg.asset === "*") {
    const c = leg.config, idea = ideaByKey(String(c.idea))!;
    const daily: DailySet = {};
    for (const k of idea.universe) if (LAB_ASSETS[k]) { const d = await dailyOf(sb, k); if (d.length) daily[k] = d; }
    const atrMed: Record<string, number> = {};
    for (const [k, d] of Object.entries(daily)) atrMed[k] = atrMedian(d, LAB_ASSETS[k].lot, vaultFrom);
    let t: LegTrades;
    if (idea.key === "relstrength") {
      const contracts = pickContracts(Object.keys(daily), atrMed, capital * RISK_PCT);
      t = relStrengthTrades(daily, c.p as { lb: number; k: number }, contracts);
    } else if (idea.key === "season") {
      t = emptyTrades();
      for (const [k, d] of Object.entries(daily)) { const x = seasonTrades(k, d.slice(20), c.p as any); for (const f of Object.keys(t) as (keyof LegTrades)[]) (t[f] as any[]).push(...(x[f] as any[])); }
    } else throw new Error(`No simulator for ${idea.key}`);
    // Sizing data: the daily ATR at each trade's entry.
    const atrBy = new Map(Object.entries(daily).map(([k, d]) => [k, { days: d.map((x) => x.day), m: atrRupees(d, LAB_ASSETS[k].lot) }]));
    t.a = t.e.map((e, i) => { const x = atrBy.get(t.k[i]); return x ? Math.trunc(before(x.days, x.m, e.slice(0, 10)) ?? 0) : 0; });
    const firsts = Object.values(daily).map((d) => d[0]?.day).filter(Boolean).sort();
    return { n: t.n.length, first: firsts[0] ? addDays(firsts[0], idea.key === "relstrength" ? 380 : 30) : null, last: today, atr_med: atrMed, t };
  }
  const data = await cachedAsset(sb, leg.asset, true);
  const daily = !!leg.config.rules?.daily, a = LAB_ASSETS[leg.asset];
  const first = daily ? data.daily[0]?.day : data.raw[0]?.day;
  if (!first) return { n: 0, first: null, last: null, atr_med: {}, t: emptyTrades(), skip: true, error: "no candles" };
  const warm = addDays(first, daily ? 300 : 20);
  const from = leg.win_from && leg.win_from > warm ? leg.win_from : warm, to = leg.win_to ?? today;
  if (from >= to) return { n: 0, first: null, last: null, atr_med: {}, t: emptyTrades(), skip: true, error: "before the history starts" };
  const { trades } = await screenOne(leg.config, data, memo, { from, split: from, to }, capital, rates);
  const atrM = atrRupees(data.daily, a.lot), days = data.daily.map((d) => d.day);
  const t = emptyTrades();
  for (const x of trades as any[]) {
    t.k.push(leg.asset); t.e.push(String(x.entry)); t.x.push(String(x.exit)); t.s.push(x.side === "SHORT" ? "S" : "L");
    t.n.push(Number(x.net) || 0); t.sl.push(Number(x.slip) || 0); t.a.push(Math.trunc(before(days, atrM, String(x.entry).slice(0, 10)) ?? 0));
  }
  return { n: t.n.length, first: from, last: to, atr_med: { [leg.asset]: atrMedian(data.daily, a.lot, vaultFrom) }, t };
}
