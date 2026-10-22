// Supertrend Algo Portal engine.
// Actions: "tick" (pg_cron, every minute in market hours), "refresh" and "flatten" (portal),
// "backtest" (portal; runs in the background). Every call must carry the x-engine-secret header.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Dhan } from "./dhan.ts";
import { type ChargeRates, newAcc, planBacktest, priceBatch, summarize, tradeCharges, validateParams, type Acc, type Plan } from "./backtest.ts";
import { lotsFor, marginPerLot, normaliseSizing } from "./sizing.ts";
import {
  addDays, aggregate, type DayBar, dayMinutes, fillTemplate, isCommodity, isComplete, isCrypto, ist, nextExpiry, nextMonthlyExpiry, partialDay,
  pickBaseInterval, sessionFor, setHolidays, signalSeries, strikeFor, supertrend, timeToMin, tradingSession,
} from "./logic.ts";
import { dataSecurity, syncMcx } from "./instruments.ts";
import { decide, describeCond, ruleSets, RuleBook, ruleTimeframes, validateRules, warmBarsFor } from "./rules.ts";
import { atr as atrSeries } from "./indicators.ts";
import { effectiveStop, hasLevels, normaliseRisk, riskInit, riskScan, type RiskState } from "./risk.ts";
import { LAB_ASSETS, labNext, labOptStep, labReverdict, labStart, labStep, loadCryptoAssets, refreshCryptoMargins, periodWindows, refreshAsset, TOKEN_ERR } from "./lab.ts";
import { contractsFor, CRYPTO, cryptoDaily, cryptoDailyDelta, cryptoFunding, cryptoLtp, cryptoProduct, deltaBalances, deltaCancel, deltaOrderChecked, deltaOrderState, deltaPositions, deltaStop, deltaStopMove, niceLot } from "./crypto.ts";
import {
  brokerQty, type BrokerStatus, brokerStopTrigger, chaseDecision, type Creds, dhanByTag, dhanCancel, dhanLtp, dhanModify, dhanPlace, dhanPositions, dhanStatus,
  positionDiff, productOf, resolveLeg, setDhanRpc, type Side, sideOf, stepFor, stopLimit, syncFno, toTick,
} from "./execution.ts";
import { loadMarginRates, refreshMargins } from "./margins.ts";
import { type Account, accountFor, adminAccount, credsOf, entryGate, withMasters } from "./accounts.ts";
import { billingDay, matches as matchesRef, syncUser } from "./billing.ts";
import { legsFor, legSign, structMargin, structName, structOf } from "./structures.ts";
import { auditStrategy } from "./audit.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
setDhanRpc(sb); // Dhan order calls from the database's fixed IP address

type Strategy = Record<string, any>;
type Settings = Account;
type Pos = "FLAT" | "LONG" | "SHORT";
type ChartBar = { t: number; o: number; h: number; l: number; c: number };

const CHART_BARS = 160;
const WARM_BARS = 500; // same Supertrend warm-up as the chart and the backtester

/** Intraday candles over more than Dhan's 90-day request limit. */
/**
 * Candles kept in memory between ticks (the engine stays warm between minute calls): after the first full download,
 * each tick asks Dhan only for candles from the last stored day on, instead of weeks of history every minute.
 */
type Row5 = { t: number; o: number; h: number; l: number; c: number };
const SPAN_CACHE = new Map<string, { rows: Map<number, Row5>; from: string; at: number }>();
async function intradaySpan(dhan: Dhan, s: Strategy, interval: number, days: number, nowSec: number) {
  const today = fmtIst(nowSec, false), want = addDays(today, -days);
  const key = `${s.data_security_id}|${s.data_segment}|${interval}`;
  const hit = SPAN_CACHE.get(key);
  if (hit && hit.from <= want && Date.now() - hit.at < 6 * 3600000 && hit.rows.size) {
    const lastT = Math.max(...hit.rows.keys());
    const fromDay = fmtIst(lastT, false);
    const rows = await dhan.intraday(s.data_security_id, s.data_segment, s.data_instrument, interval, `${fromDay} 00:00:00`, fmtIst(nowSec + 120, true));
    // The newest stored candle may have been incomplete when stored: everything from that day is replaced.
    const dayStart = Date.parse(`${fromDay}T00:00:00+05:30`) / 1000;
    for (const t of [...hit.rows.keys()]) if (t >= dayStart) hit.rows.delete(t);
    for (const r of rows) hit.rows.set(r.t, r);
    const lo = Date.parse(`${want}T00:00:00+05:30`) / 1000;
    return [...hit.rows.values()].filter((r) => r.t >= lo).sort((x, y) => x.t - y.t);
  }
  const all = await intradaySpanFull(dhan, s, interval, days, nowSec);
  const m = new Map<number, Row5>(); for (const r of all) m.set(r.t, r);
  SPAN_CACHE.set(key, { rows: m, from: want, at: Date.now() });
  return all;
}
async function intradaySpanFull(dhan: Dhan, s: Strategy, interval: number, days: number, nowSec: number) {
  const out = new Map<number, ReturnType<typeof Object>>();
  const today = fmtIst(nowSec, false);
  for (let back = days; back > 0; back -= 85) {
    const a = addDays(today, -back), z = back - 85 > 0 ? addDays(today, -(back - 85) - 1) : null;
    const rows = await dhan.intraday(s.data_security_id, s.data_segment, s.data_instrument, interval, `${a} 09:00:00`, z ? `${z} 23:59:00` : fmtIst(nowSec + 120, true));
    for (const r of rows) out.set(r.t, r);
  }
  return [...out.values()].sort((x: any, y: any) => x.t - y.t) as { t: number; o: number; h: number; l: number; c: number }[];
}
function warmDays(tf: number, atr: number, seg = "IDX_I", bars = WARM_BARS) {
  const dayMins = dayMinutes(seg);
  return Math.min(400, Math.max(5, Math.ceil(((Math.max(bars, atr * 10) * tf) / dayMins) * 1.5) + 4));
}
const FLAT_STATE = { position: "FLAT", pos_legs: null, pos_option_type: null, pos_option_side: null, pos_strike: null, pos_expiry: null, pos_qty: null, pos_entry_date: null, pos_risk: null,
  pos_entry_px: null, pos_entry_prem: null, pos_lots: null, pos_margin: null, pos_ltp: null, pos_ltp_at: null, pos_upnl: null, pos_broker: null };
const NO_PENDING = { pending_target: null, pending_trigger: null, pending_from: null, pending_to: null };
const hhmm = (sec: number) => fmtIst(sec, true).slice(11, 16);

function fmtIst(epochSec: number, withTime: boolean): string {
  const d = new Date((epochSec + 19800) * 1000).toISOString();
  return withTime ? `${d.slice(0, 10)} ${d.slice(11, 19)}` : d.slice(0, 10);
}

function dhanFor(set: Settings): Dhan {
  // Crypto strategies read Delta Exchange's public prices (the Dhan class routes the DELTA segment there).
  if (set.broker === "DELTA") return new Dhan("-", "-");
  if (!set.dhan_access_token || !set.dhan_client_id) throw new Error("Add your Dhan client ID and access token under Dhan connection.");
  return new Dhan(set.dhan_client_id, set.dhan_access_token);
}

async function saveChart(s: Strategy, bars: ChartBar[], st: number[], trend: number[]) {
  const from = Math.max(0, bars.length - CHART_BARS);
  const chart = bars.slice(from).map((b, k) => {
    const i = from + k;
    // A bought strategy's chart carries no indicator line (it would give away its settings).
    return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, st: s.locked || isNaN(st[i]) ? null : +st[i].toFixed(2), tr: trend[i] };
  });
  await sb.from("algo_chart").upsert({ strategy_id: s.id, bars: chart, updated_at: new Date().toISOString() });
}

/** Signal (Supertrend or Heikin Ashi colour) on the strategy's own candles (flip strategies). */
async function flipSeries(s: Strategy, dhan: Dhan) {
  const tf = s.timeframe_min;
  const baseInt = pickBaseInterval(tf);
  const now = Date.now() / 1000;
  const raw = await intradaySpan(dhan, s, baseInt, warmDays(tf, s.atr_period, s.data_segment), now);
  const bars = aggregate(raw, tf, s.data_segment).filter((b) => isComplete(b, baseInt, now));
  if (bars.length < s.atr_period + 2) throw new Error(`Only ${bars.length} completed candles came back from Dhan; need at least ${s.atr_period + 2}.`);
  const { st, trend } = signalSeries(s as any, bars);
  await saveChart(s, bars, st, trend);
  return { bars, st, trend };
}

/** Higher-timeframe bias for timed strategies, plus today's latest index price. */
async function biasSeries(s: Strategy, dhan: Dhan, nowSec: number) {
  const now = ist(nowSec);
  const today = (await dhan.intraday(s.data_security_id, s.data_segment, s.data_instrument, 1, `${now.date} 09:00:00`, fmtIst(nowSec + 120, true)))
    .filter((b) => ist(b.t).date === now.date && b.t + 60 <= nowSec);
  const spot = today.length ? today[today.length - 1].c : null;
  let bars: ChartBar[];
  if (String(s.bias_timeframe) === "D") {
    const daily = await dhan.daily(s.data_security_id, s.data_segment, s.data_instrument,
      addDays(now.date, -Math.ceil(Math.max(WARM_BARS, s.atr_period * 10) * 1.5)), addDays(now.date, 1));
    bars = daily.filter((d) => d.day < now.date);
    const part = s.bias_source === "LIVE" ? partialDay(today, now.date) : null;
    if (part) bars = [...bars, part];
  } else {
    const tf = Number(s.bias_timeframe);
    const baseInt = pickBaseInterval(tf);
    const raw = await intradaySpan(dhan, s, baseInt, warmDays(tf, s.atr_period, s.data_segment), nowSec);
    const agg = aggregate(raw, tf, s.data_segment);
    bars = s.bias_source === "LIVE" ? agg.filter((b) => b.t <= nowSec) : agg.filter((b) => isComplete(b, baseInt, nowSec));
  }
  if (bars.length < s.atr_period + 2) throw new Error(`Only ${bars.length} bias candles came back from Dhan; need at least ${s.atr_period + 2}.`);
  const { st, trend } = supertrend(bars, s.atr_period, Number(s.factor));
  await saveChart(s, bars, st, trend);
  return { bars, st, trend, spot, marketDay: today.length > 0 };
}

function qtyOf(s: Strategy): number {
  return s.qty_mode === "LOTS" ? s.lots : s.lots * s.lot_size;
}

/* ---------- multi-leg structures (spreads, straddles, condors, calendars, futures + option) ---------- */
type MLeg = { opt: "CE" | "PE" | "FUT"; act: "B" | "S"; strike: number | null; expiry: string | null; q: number; qty: number; x?: number; px?: number | null };
const isMulti = (s: Strategy) => !!structOf(s);
const asArr = <T>(x: T | T[]): T[] => Array.isArray(x) ? x : [x];
/** The expiry after a given one (for the far leg of a calendar spread). */
function expiryAfter(s: Strategy, exp: string): string {
  const t = ist(Date.parse(`${exp}T12:00:00+05:30`) / 1000 + 86400);
  return s.expiry_flag === "MONTH" ? nextMonthlyExpiry(t, Number(s.expiry_weekday), false) : nextExpiry(t, Number(s.expiry_weekday), false);
}
/** Orders for the legs: opening buys first (the margin benefit of a hedge needs it), closing buy-backs first. */
function orderLegs(s: Strategy, legs: MLeg[], closing: boolean, sort0: number) {
  const first = closing ? "S" : "B";
  return [...legs].sort((a, b) => (a.act === first ? 0 : 1) - (b.act === first ? 0 : 1)).map((l, i) => {
    const side = closing ? (l.act === "B" ? "S" : "B") : l.act;
    return l.opt === "FUT"
      ? fillTemplate(s.leg_template_fut, { side, qty: l.qty, exchange: s.exchange, product: s.product_type, sort: sort0 + i, symbol: s.futures_symbol })
      : fillTemplate(s.leg_template_opt, { side, qty: l.qty, exchange: s.exchange, product: s.product_type, sort: sort0 + i, symbol: s.dhan_symbol, option_type: l.opt, strike: l.strike ?? "", expiry: l.expiry ?? "" });
  });
}
const mlegText = (s: Strategy, l: MLeg) => `${l.act === "B" ? "Buy" : "Sell"} ${l.opt === "FUT" ? `${s.futures_symbol}` : `${s.dhan_symbol} ${l.strike} ${l.opt} (${l.expiry})`}`;
function multiEntry(s: Strategy, want: Pos, close: number, sort: number, lots: number) {
  const st = structOf(s)!, today = ist(Date.now() / 1000);
  const exp0 = s.expiry_override && s.expiry_override >= today.date ? s.expiry_override
    : s.expiry_flag === "MONTH" ? nextMonthlyExpiry(today, s.expiry_weekday, s.roll_on_expiry) : nextExpiry(today, s.expiry_weekday, s.roll_on_expiry);
  const exp1 = expiryAfter(s, exp0);
  const qty = s.qty_mode === "LOTS" ? lots : lots * Number(s.lot_size);
  const legs: MLeg[] = legsFor(st, want as "LONG" | "SHORT", close, Number(s.strike_step)).map((l) => ({
    opt: l.opt, act: l.act, strike: l.strike, expiry: l.opt === "FUT" ? null : l.x === 1 ? exp1 : exp0, q: l.q ?? 1, qty: qty * (l.q ?? 1), x: l.x ?? 0,
  }));
  return {
    leg: orderLegs(s, legs, false, sort),
    state: { pos_option_type: null, pos_option_side: "MULTI", pos_strike: null, pos_expiry: exp0, pos_qty: qty, pos_legs: legs, pos_entry_date: today.date, _px: close } as Record<string, any>,
    label: `${structName(st)}: ${legs.map((l) => mlegText(s, l)).join(" · ")} x ${qty}`,
  };
}
/** Prices of the open legs now (option premiums; a futures leg at the index / futures price). Null if any is missing. */
async function multiPx(dhan: Dhan, s: Strategy, legs: MLeg[]): Promise<number[] | null> {
  const out: number[] = [];
  for (const l of legs) {
    let px: number | null = null;
    try {
      px = l.opt === "FUT" ? await dhan.ltp(s.data_segment, String(s.data_security_id)) : await dhan.premium(s.data_security_id, s.data_segment, String(l.expiry), Number(l.strike), l.opt);
    } catch { px = null; }
    if (!(Number(px) > 0)) return null;
    out.push(Number(px));
  }
  return out;
}
/** Net premium of the structure per unit of quantity: paid (+) or received (−). */
const netPrem = (legs: MLeg[], px: number[]) => legs.reduce((a, l, i) => a + legSign(l) * (l.q ?? 1) * px[i], 0);

/** A crypto order leg: contracts on Delta Exchange (sent through Delta's API, not a webhook). */
const cryptoLeg = (s: Strategy, side: "B" | "S", qty: number, close: boolean) => ({ broker: "DELTA", symbol: s.futures_symbol || s.underlying, side, qty, reduce_only: close });
function exitLeg(s: Strategy, sort: number): Record<string, unknown> | Record<string, unknown>[] {
  if (isCrypto(String(s.data_segment))) return cryptoLeg(s, s.position === "LONG" ? "S" : "B", Number(s.pos_qty ?? qtyOf(s)), true);
  if (isMulti(s) && Array.isArray(s.pos_legs)) return orderLegs(s, s.pos_legs as MLeg[], true, sort);
  const opt = s.trade_type === "OPTIONS";
  return fillTemplate(opt ? s.leg_template_opt : s.leg_template_fut, {
    // An option bought is sold to close; an option written is bought back.
    side: opt ? (s.pos_option_side === "SELL" ? "B" : "S") : s.position === "LONG" ? "S" : "B",
    qty: s.pos_qty ?? qtyOf(s), exchange: s.exchange, product: s.product_type, sort,
    symbol: opt ? s.dhan_symbol : s.futures_symbol,
    option_type: s.pos_option_type ?? "", strike: s.pos_strike ?? "", expiry: s.pos_expiry ?? "",
  });
}

function entryLeg(s: Strategy, want: Pos, close: number, sort: number, lots = Number(s.lots)): { leg: Record<string, unknown> | Record<string, unknown>[]; state: Record<string, any>; label: string } {
  if (isMulti(s)) return multiEntry(s, want, close, sort, lots);
  const opt = s.trade_type === "OPTIONS";
  const qty = s.qty_mode === "LOTS" ? lots : lots * Number(s.lot_size);
  const today = ist(Date.now() / 1000);
  if (!opt) {
    return {
      leg: isCrypto(String(s.data_segment)) ? cryptoLeg(s, want === "LONG" ? "B" : "S", qty, false) : fillTemplate(s.leg_template_fut, {
        side: want === "LONG" ? "B" : "S", qty, exchange: s.exchange, product: s.product_type, sort, symbol: s.futures_symbol,
      }),
      state: { pos_option_type: null, pos_option_side: null, pos_strike: null, pos_expiry: null, pos_qty: qty, pos_entry_date: today.date, _px: close },
      label: `${want === "LONG" ? "Buy" : "Sell"} ${s.futures_symbol} x ${qty}`,
    };
  }
  // Buying: bullish → CE, bearish → PE. Writing: bullish → sell PE, bearish → sell CE.
  const selling = s.option_side === "SELL";
  const optType = (want === "LONG") !== selling ? "CE" : "PE";
  const strike = strikeFor(close, s.strike_step, s.strike_offset, optType);
  const expiry = s.expiry_override && s.expiry_override >= today.date
    ? s.expiry_override
    : s.expiry_flag === "MONTH" ? nextMonthlyExpiry(today, s.expiry_weekday, s.roll_on_expiry) : nextExpiry(today, s.expiry_weekday, s.roll_on_expiry);
  return {
    leg: fillTemplate(s.leg_template_opt, {
      side: selling ? "S" : "B", qty, exchange: s.exchange, product: s.product_type, sort, symbol: s.dhan_symbol,
      option_type: optType, strike, expiry,
    }),
    state: { pos_option_type: optType, pos_option_side: selling ? "SELL" : "BUY", pos_strike: strike, pos_expiry: expiry, pos_qty: qty, pos_entry_date: today.date, _px: close },
    label: `${selling ? "Sell" : "Buy"} ${s.dhan_symbol} ${strike} ${optType} (${expiry}) x ${qty}`,
  };
}

function exitLabel(s: Strategy): string {
  if (isMulti(s) && Array.isArray(s.pos_legs)) return `Close ${structName(structOf(s)!)}: ${(s.pos_legs as MLeg[]).map((l) => mlegText(s, { ...l, act: l.act === "B" ? "S" : "B" })).join(" · ")} x ${s.pos_qty}`;
  if (s.trade_type === "OPTIONS") return `${s.pos_option_side === "SELL" ? "Buy back" : "Sell"} ${s.dhan_symbol} ${s.pos_strike} ${s.pos_option_type} (${s.pos_expiry}) x ${s.pos_qty}`;
  return `${s.position === "LONG" ? "Sell" : "Buy"} ${s.futures_symbol} x ${s.pos_qty} to close ${String(s.position).toLowerCase()}`;
}

type Candle = { t?: number; trend?: number; c?: number; st?: number };

/* ---------- stop loss, target, trailing stop, daily loss limit (live) ---------- */
type PosRisk = Partial<RiskState> & { basis: string; entry?: number; entryPrem?: number | null };
const riskOf = (s: Strategy) => normaliseRisk(s.risk, s.trade_type === "OPTIONS" && !isMulti(s));
const unitsOf = (s: Strategy) => s.qty_mode === "LOTS" ? Number(s.pos_qty) * Number(s.lot_size) : Number(s.pos_qty);
const lotsOf = (s: Strategy) => s.qty_mode === "LOTS" ? Number(s.pos_qty) : Math.round(Number(s.pos_qty) / Number(s.lot_size));
const todayIst = () => ist(Date.now() / 1000).date;
/** False once today's closed trades have lost the strategy's daily limit. */
function canEnter(s: Strategy): boolean {
  const r = riskOf(s);
  return !(r?.max_day_loss && String(s.day_pnl_date) === todayIst() && Number(s.day_pnl) <= -r.max_day_loss);
}
async function premiumOf(dhan: Dhan, s: Strategy, st: Record<string, any>): Promise<number | null> {
  try { return await dhan.premium(s.data_security_id, s.data_segment, String(st.pos_expiry), Number(st.pos_strike), st.pos_option_type); } catch { return null; }
}
/** Stop / target levels for a position just entered (stored in pos_risk). */
async function armRisk(s: Strategy, set: Settings, st: Record<string, any>, px: number, atrNow: number, notes: string[]) {
  const r = riskOf(s);
  if (!r) return;
  const pr: PosRisk = { basis: r.basis, entry: px };
  const opt = s.trade_type === "OPTIONS";
  if (opt && !isMulti(s)) pr.entryPrem = st.pos_entry_prem ?? ((r.basis === "PREMIUM" || r.max_day_loss) ? await premiumOf(dhanFor(set), s, st) : null);
  if (hasLevels(r)) {
    const premium = r.basis === "PREMIUM";
    const dir = premium ? (st.pos_option_side === "SELL" ? -1 : 1) : (st.position === "LONG" ? 1 : -1);
    const ref = premium ? pr.entryPrem : px;
    const rs = ref ? riskInit(r, dir, ref, atrNow, Math.floor(Date.now() / 60000) * 60) : null;
    if (rs) {
      Object.assign(pr, rs);
      const f = (x: number | null | undefined) => x == null ? "–" : (+x.toFixed(2)).toString();
      notes.push(`${premium ? `Premium ${f(ref)}` : "Levels"}: stop ${f(rs.stop)}, target ${f(rs.tgt)}${rs.trail ? ", trailing" : ""}`);
    } else notes.push(premium ? "Stop not set: couldn't read the option's premium." : "Stop not set: ATR not available yet.");
  }
  st.pos_risk = pr;
}

/* ---------- capital: equity, money deployed, lots per entry, ledger of closed trades ---------- */
function ratesFor(s: Strategy): ChargeRates {
  // Delta Exchange India: 0.05% taker fee each side plus 18% GST on it.
  if (s.exchange === "DELTA" || isCrypto(String(s.data_segment))) return { brk_pct: 0, stt_fut: 0, stt_opt: 0, exch_fut: 0.05, exch_opt: 0.03, sebi: 0, gst: 18, stamp_fut: 0, stamp_opt: 0 };
  if (s.exchange === "MCX") return { brk_pct: 0.03, stt_fut: 0.01, stt_opt: 0.05, exch_fut: 0.0021, exch_opt: 0.0418, sebi: 0.0001, gst: 18, stamp_fut: 0.002, stamp_opt: 0.003 };
  const bse = s.exchange === "BSE";
  return { brk_pct: 0.03, stt_fut: 0.05, stt_opt: 0.15, exch_fut: bse ? 0 : 0.00183, exch_opt: bse ? 0.0325 : 0.03553, sebi: 0.0001, gst: 18, stamp_fut: 0.002, stamp_opt: 0.003 };
}
/** Equity (starting capital + realised P&L of this mode's closed trades) and the margin other open positions hold. */
async function capitalState(set: Settings, live: boolean, excludeId: string) {
  const { data: net } = await sb.rpc("ledger_net_user", { p_user: set.user_id, p_mode: live ? "LIVE" : "PAPER", p_since: set.capital_since ?? null });
  const { data: open } = await sb.from("algo_strategies").select("id, pos_margin").eq("owner_id", set.user_id).neq("position", "FLAT").eq("live", live).neq("id", excludeId);
  const used = (open ?? []).reduce((a, x) => a + (Number(x.pos_margin) || 0), 0);
  return { equity: Number(set.capital ?? 0) + Number(net ?? 0), used };
}
/**
 * Today's margin rate for a strategy's asset from Dhan's margin calculator (checked every morning): futures or option
 * writing, intraday or carry-forward. Null for option buying (that needs the premium) or when no check is stored.
 */
async function dhanRate(s: Strategy): Promise<number | null> {
  if (isMulti(s) || (s.trade_type === "OPTIONS" && s.option_side !== "SELL")) return null;
  const r = (await loadMarginRates(sb))[String(s.underlying)];
  if (!r) return null;
  const intraday = s.product_type === "I" || !!s.intraday;
  return s.trade_type === "OPTIONS" ? (intraday ? r.sellI ?? r.sell : r.sell ?? r.sellI) : (intraday ? r.futI ?? r.fut : r.fut ?? r.futI);
}
/**
 * Before an entry: reads the option premium (for the ledger, premium stops and option-buying margin) and, when the
 * strategy sizes from capital, works out the lots and rewrites the entry order. Returns false if the entry is skipped.
 */
async function sizeEntry(s: Strategy, set: Settings, legs: Record<string, unknown>[], newState: Record<string, any>, entryPx: number, notes: string[]): Promise<boolean> {
  const opt = s.trade_type === "OPTIONS", multi = isMulti(s);
  // A structure: every leg's price now; the margin for 1 lot from the legs (bought premium, spread widths, futures).
  const nLegs = multi ? (newState.pos_legs as MLeg[] ?? []).length : 1;
  let mpx: number[] | null = null;
  if (multi) {
    mpx = await multiPx(dhanFor(set), s, newState.pos_legs as MLeg[]);
    if (mpx) newState.pos_legs = (newState.pos_legs as MLeg[]).map((l, i) => ({ ...l, px: +mpx![i].toFixed(2) }));
    else notes.push("Couldn't read every leg's price; the ledger will show this trade without P&L.");
  }
  const premium = multi ? (mpx ? +netPrem(newState.pos_legs as MLeg[], mpx).toFixed(2) : null) : opt ? await premiumOf(dhanFor(set), s, newState) : null;
  // Margin per lot at today's Dhan rate (falls back to the strategy's own margin % when Dhan's isn't known).
  const rate = await dhanRate(s).catch(() => null);
  const sz0 = normaliseSizing(s.sizing, String(s.data_segment));
  const sz = sz0 && rate ? { ...sz0, margin_pct: rate * 100 } : sz0;
  let lots = Number(s.lots);
  let mLot = marginPerLot(s as any, sz ?? (rate ? { margin_pct: rate * 100 } as any : null), entryPx, premium);
  if (multi) {
    const mr = (await loadMarginRates(sb))[String(s.underlying)];
    const intra = s.product_type === "I" || !!s.intraday;
    const fr = (intra ? mr?.futI ?? mr?.fut : mr?.fut ?? mr?.futI) ?? 0.12, sr = (intra ? mr?.sellI ?? mr?.sell : mr?.sell ?? mr?.sellI) ?? 0.12;
    const per = (newState.pos_legs as MLeg[]).map((l, i) => ({ opt: l.opt, act: l.act, k: 0, x: (l.x ?? 0) as 0 | 1, q: l.q, strike: l.strike, px: mpx ? mpx[i] : 0 }));
    mLot = structMargin(per, entryPx, Number(s.lot_size), fr, sr);
  }
  const capMode = s.sizing?.mode === "CAPITAL" && Number(s.capital) > 0;
  if ((sz || capMode) && rate) notes.push(`Margin ${(rate * 100).toFixed(1)}% of contract value (Dhan, today)`);
  if (capMode) {
    // A bought strategy: the capital the user gave it, plus what it has made or lost since, decides the lots.
    const { data: own } = await sb.from("algo_trades").select("net").eq("strategy_id", s.id).eq("mode", s.live ? "LIVE" : "PAPER").eq("hidden", false);
    const eq = Number(s.capital) + (own ?? []).reduce((a, x) => a + (Number(x.net) || 0), 0);
    const cs = await capitalState(set, !!s.live, s.id);
    const max = Math.max(1, Math.trunc(Number(s.sizing.max_lots) || 1000));
    const byCap = mLot > 0 ? Math.floor(Math.max(0, eq) / mLot) : max;
    const acctEq = Number(set.capital ?? 0) > 0 ? cs.equity : null;
    const room = acctEq == null ? Infinity : acctEq * Number(set.deploy_pct ?? 100) / 100 - cs.used;
    const byRoom = mLot > 0 && room !== Infinity ? Math.floor(Math.max(0, room) / mLot) : max;
    const n = Math.max(0, Math.min(max, byCap, byRoom));
    const r0 = (x: number) => Math.trunc(x).toLocaleString("en-IN");
    const why = `capital ₹${r0(eq)} ÷ ₹${r0(mLot)} a lot → ${byCap}${byRoom < byCap ? `; account deployment cap → ${byRoom}` : ""}${max < Math.min(byCap, byRoom) ? `; max ${max}` : ""} ⇒ ${n} lot${n === 1 ? "" : "s"}`;
    if (n < 1) { notes.push(`Entry skipped: not enough capital for 1 lot (${why}).`); return false; }
    lots = n;
    const e = entryLeg(s, newState.position, entryPx, legs.length - nLegs + 1, lots);
    legs.splice(legs.length - nLegs, nLegs, ...asArr(e.leg));
    Object.assign(newState, e.state, multi && mpx ? { pos_legs: (e.state.pos_legs as MLeg[]).map((l, i) => ({ ...l, px: +mpx![i].toFixed(2) })) } : {});
    const last = notes.length - 1;
    if (last >= 0) notes[last] = notes[last].replace(/ x \d+$/, ` x ${e.state.pos_qty}`);
    notes.push(`Size: ${why}`);
  } else if (sz) {
    const cs = await capitalState(set, !!s.live, s.id);
    const res = lotsFor(sz, cs.equity, mLot, cs.used, Number(set.deploy_pct ?? 100));
    if (res.lots < 1) { notes.push(`Entry skipped: not enough capital for 1 lot (${res.why}).`); return false; }
    lots = res.lots;
    const e = entryLeg(s, newState.position, entryPx, legs.length - nLegs + 1, lots);
    legs.splice(legs.length - nLegs, nLegs, ...asArr(e.leg));
    Object.assign(newState, e.state, multi && mpx ? { pos_legs: (e.state.pos_legs as MLeg[]).map((l, i) => ({ ...l, px: +mpx![i].toFixed(2) })) } : {});
    const last = notes.length - 1;
    if (last >= 0) notes[last] = notes[last].replace(/ x \d+$/, ` x ${e.state.pos_qty}`);
    notes.push(`Size: ${res.why}`);
  }
  Object.assign(newState, { pos_entry_px: entryPx, pos_entry_prem: premium, pos_lots: lots, pos_margin: Math.trunc(mLot * lots) });
  return true;
}
/**
 * Records the position being closed in the trade ledger (estimated from the index / futures price or the option's
 * premium, with charges at current rates) and adds it to today's total for the daily loss limit.
 */
async function bookPnl(s: Strategy, set: Settings, update: Record<string, unknown>, exitPx: number | undefined, why: string, exitPrem?: number | null): Promise<number | null> {
  if (s.position === "FLAT") return null;
  if (isMulti(s) && Array.isArray(s.pos_legs)) return bookMulti(s, set, update, why);
  const r = riskOf(s), pr = (s.pos_risk ?? {}) as PosRisk;
  const opt = s.trade_type === "OPTIONS";
  const inPx = opt ? Number(s.pos_entry_prem ?? pr.entryPrem ?? 0) : Number(s.pos_entry_px ?? pr.entry ?? 0);
  let outPx: number | null = null;
  if (opt) outPx = exitPrem ?? (inPx ? await premiumOf(dhanFor(set), s, s) : null);
  else outPx = exitPx ?? null;
  if (!(inPx > 0) || !(Number(outPx) > 0)) return Number(outPx) > 0 ? outPx : null;
  const units = unitsOf(s);
  const dir = opt ? (s.pos_option_side === "SELL" ? -1 : 1) : (s.position === "LONG" ? 1 : -1);
  const gross = (outPx! - inPx) * dir * units;
  const buyVal = (dir === 1 ? inPx : outPx!) * units, sellVal = (dir === 1 ? outPx! : inPx) * units;
  const costs = tradeCharges({ from: "", to: "", capital: 0, brokerage: 20, charges: ratesFor(s), near_code: 1 }, opt, buyVal, sellVal).total;
  const net = Math.trunc(gross - costs);
  const contract = opt ? `${s.pos_option_side === "SELL" ? "Sell " : ""}${s.dhan_symbol} ${s.pos_strike} ${s.pos_option_type} (${s.pos_expiry})` : `${s.futures_symbol} ${s.position === "LONG" ? "long" : "short"}`;
  const entryAt = s.pos_entry_date ? `${s.pos_entry_date}` : null;
  await sb.from("algo_trades").insert({
    strategy_id: s.id, user_id: s.owner_id ?? null, broker_ref: brokerRef(s), mode: s.live ? "LIVE" : "PAPER", entry_day: entryAt, exit_at: new Date().toISOString(), side: s.position, contract,
    lots: lotsOf(s), units, entry_px: +inPx.toFixed(2), exit_px: +outPx!.toFixed(2), gross: Math.trunc(gross), costs: Math.trunc(costs), net, exit_why: why.slice(0, 200),
  });
  if (r?.max_day_loss) {
    const today = todayIst();
    const base = String(s.day_pnl_date) === today ? Number(s.day_pnl) || 0 : 0;
    update.day_pnl = Math.trunc(base + net); update.day_pnl_date = today;
  }
  return outPx;
}
/** A structure closed: each leg's price now against its entry, charges per leg, booked as one trade. Returns the net premium. */
async function bookMulti(s: Strategy, set: Settings, update: Record<string, unknown>, why: string): Promise<number | null> {
  const legs = s.pos_legs as MLeg[];
  const px = await multiPx(dhanFor(set), s, legs);
  if (!px || legs.some((l) => !(Number(l.px) > 0))) return px ? +netPrem(legs, px).toFixed(2) : null;
  const units = unitsOf(s);
  let gross = 0, costs = 0;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i], u = units * (l.q ?? 1), sg = legSign(l), a = Number(l.px), b = px[i];
    gross += (b - a) * sg * u;
    costs += tradeCharges({ from: "", to: "", capital: 0, brokerage: 20, charges: ratesFor(s), near_code: 1 }, l.opt !== "FUT", (sg === 1 ? a : b) * u, (sg === 1 ? b : a) * u).total;
  }
  const net = Math.trunc(gross - costs), inNet = netPrem(legs, legs.map((l) => Number(l.px))), outNet = netPrem(legs, px);
  await sb.from("algo_trades").insert({
    strategy_id: s.id, user_id: s.owner_id ?? null, broker_ref: brokerRef(s), mode: s.live ? "LIVE" : "PAPER", entry_day: s.pos_entry_date ?? null, exit_at: new Date().toISOString(), side: s.position,
    contract: `${structName(structOf(s)!)}: ${legs.map((l) => mlegText(s, l)).join(" · ")}`.slice(0, 300), lots: lotsOf(s), units,
    entry_px: +inNet.toFixed(2), exit_px: +outNet.toFixed(2), gross: Math.trunc(gross), costs: Math.trunc(costs), net, exit_why: why.slice(0, 200),
  });
  const r = riskOf(s);
  if (r?.max_day_loss) {
    const today = todayIst();
    const base = String(s.day_pnl_date) === today ? Number(s.day_pnl) || 0 : 0;
    update.day_pnl = Math.trunc(base + net); update.day_pnl_date = today;
  }
  return +outNet.toFixed(2);
}
/** Key used to match a desk trade with the broker's position: OPT|symbol|strike|CE/PE|expiry or FUT|symbol. */
function brokerRef(s: Strategy): string {
  if (isMulti(s) && Array.isArray(s.pos_legs)) return `MULTI|${s.dhan_symbol}|${(s.pos_legs as MLeg[]).map((l) => `${l.act}${l.opt}${l.strike ?? ""}@${l.expiry ?? ""}`).join(",")}`.slice(0, 200);
  return s.trade_type === "OPTIONS" ? `OPT|${s.dhan_symbol}|${s.pos_strike}|${s.pos_option_type}|${s.pos_expiry}` : `FUT|${s.futures_symbol}`;
}
/** Checks an open position against its stop / target every minute. Returns the strategy as it stands afterwards. */
async function liveRisk(s: Strategy, set: Settings): Promise<Strategy> {
  const r = riskOf(s), pr = s.pos_risk as PosRisk | null;
  if (s.position === "FLAT" || !pr || !hasLevels(r) || pr.dir === undefined) return s;
  const nowSec = Date.now() / 1000, now = ist(nowSec), sess = tradingSession(s.data_segment, now.date);
  // Crypto never closes: an open position's stop is watched round the clock (other markets only in their hours).
  if (!isCrypto(String(s.data_segment)) && (now.min < sess.open || now.min >= sess.close)) return s;
  const dhan = dhanFor(set);
  let rows: { t: number; o: number; h: number; l: number }[] = [];
  const minuteNow = Math.floor(nowSec / 60) * 60;
  if (pr.basis === "PREMIUM") {
    const p = await premiumOf(dhan, s, s);
    if (p) rows = [{ t: minuteNow, o: p, h: p, l: p }];
  } else {
    const from1 = isCrypto(String(s.data_segment)) ? fmtIst(Math.max(Number(pr.scanFrom) || 0, nowSec - 6 * 3600), true) : `${now.date} 09:00:00`;
    const mins = await dhan.intraday(s.data_security_id, s.data_segment, s.data_instrument, 1, from1, fmtIst(nowSec + 120, true));
    rows = mins.filter((m) => m.t >= Number(pr.scanFrom) && m.t + 60 <= nowSec);
    try { const l = await dhan.ltp(s.data_segment, s.data_security_id); if (l) rows.push({ t: minuteNow, o: l, h: l, l }); } catch { /* LTP optional */ }
  }
  if (!rows.length) return s;
  const rs = { dir: pr.dir!, stop: pr.stop ?? null, tgt: pr.tgt ?? null, trail: pr.trail ?? null, trailAtr: pr.trailAtr ?? 0, best: Number(pr.best), scanFrom: Number(pr.scanFrom) } as RiskState;
  const hit = riskScan(rs, rows);
  const update: Record<string, unknown> = { last_run_at: new Date().toISOString() };
  if (!hit) {
    update.pos_risk = { ...pr, best: rs.best, scanFrom: minuteNow };
    await sb.from("algo_strategies").update(update).eq("id", s.id);
    return { ...s, ...update };
  }
  return actLocked(() => riskExit(s, set, pr, hit, update));
}
async function riskExit(s: Strategy, set: Settings, pr: PosRisk, hit: { px: number; t: number; why: string }, update: Record<string, unknown>): Promise<Strategy> {
  const event = /Target/.test(hit.why) ? "TARGET" : /Trailing/.test(hit.why) ? "TRAIL_STOP" : "STOP_LOSS";
  const under = pr.basis === "PREMIUM" ? undefined : hit.px;
  const ok = await sendOrders(s, set, event, asArr(exitLeg(s, 1)), `${hit.why}${pr.basis === "PREMIUM" ? " (premium)" : ""}: ${exitLabel(s)}`, { t: hit.t, c: under });
  if (!ok) {
    update.last_error = `Stop-loss exit failed to send, so the strategy was paused. Close the position in ${isCrypto(String(s.data_segment)) ? "Delta Exchange" : "Dhan"}.`;
    update.active = false;
    await sb.from("algo_strategies").update(update).eq("id", s.id);
    return { ...s, ...update };
  }
  const crFill = s.live && isCrypto(String(s.data_segment)) ? deltaFill.exit : null;
  const out = await bookPnl(s, set, update, crFill ?? under, hit.why, pr.basis === "PREMIUM" ? hit.px : undefined);
  await saveFills([fillOf(s, "Exit", out ?? (s.trade_type === "OPTIONS" ? null : hit.px))]);
  Object.assign(update, FLAT_STATE);
  await sb.from("algo_strategies").update(update).eq("id", s.id);
  return { ...s, ...update };
}

async function sendOrders(s: Strategy, set: Settings, event: string, legs: Record<string, unknown>[], description: string, candle: Candle): Promise<boolean> {
  if (isCrypto(String(s.data_segment))) return sendDelta(s, set, event, legs, description, candle);
  if (s.live) return queueDhan(s, set, event, legs, description, candle);
  const payload = { secret: set.webhook_secret ?? "", alertType: "multi_leg_order", order_legs: legs };
  const mode = s.live ? "LIVE" : "PAPER";
  let status = "LOGGED";
  let response: string | null = null;
  if (s.live) {
    if (!set.webhook_url) {
      status = "FAILED";
      response = "No webhook URL under Dhan connection.";
    } else {
      try {
        const r = await fetch(set.webhook_url, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        response = `HTTP ${r.status} ${(await r.text()).slice(0, 500)}`;
        status = r.ok ? "SENT" : "FAILED";
      } catch (e) {
        status = "FAILED";
        response = String(e);
      }
    }
  }
  await logSignal(s, event, description, candle, status, payload, response);
  return status !== "FAILED";
}

/**
 * Crypto orders: market orders on Delta Exchange, one per leg, in order (a reversal closes first, then opens). Each is
 * checked until Delta reports it filled; one left unfilled stops the rest. Before an exit the stop order resting at
 * Delta is cancelled (if it already filled, the position is already closed and no exit order is sent).
 */
async function sendDelta(s: Strategy, set: Settings, event: string, legs: Record<string, unknown>[], description: string, candle: Candle): Promise<boolean> {
  // Lots → Delta contracts (a lot is a set number of coins, e.g. 0.05 BTC = 50 contracts).
  const payload = { broker: "DELTA", orders: legs.map((l) => ({ symbol: l.symbol, side: l.side === "B" ? "buy" : "sell", lots: l.qty, size: contractsFor(String(l.symbol), Number(s.lot_size), Number(l.qty)), reduce_only: !!l.reduce_only })) };
  let status = "LOGGED", response: string | null = null;
  deltaFill = { exit: null, entry: null };
  if (s.live) {
    if (!set.dhan_client_id || !set.dhan_access_token) { status = "FAILED"; response = "Add your Delta Exchange API key and secret under Delta Exchange connection."; }
    else {
      const out: string[] = [];
      const pb = (s.pos_broker ?? null) as PosBroker | null;
      let stopClosed = false;
      if (pb?.stopId && payload.orders.some((o) => o.reduce_only)) {
        try {
          const st = await deltaOrderState(sb, set.user_id, pb.stopId);
          if (st.state === "closed" && st.unfilled === 0) { stopClosed = true; deltaFill.exit = st.avg; out.push(`already closed by the stop order at Delta${st.avg ? ` at ${st.avg}` : ""}`); }
          else await deltaCancel(sb, set.user_id, String(pb.symbol ?? pb.legs[0]?.sec), pb.stopId).catch(() => {});
          await sb.from("live_orders").update({ state: stopClosed ? "filled" : "cancelled", avg_px: stopClosed ? st.avg : null, done_at: nowIso(), note: stopClosed ? "filled (desk exit came after)" : "cancelled before the desk's exit" })
            .eq("broker_order_id", pb.stopId).eq("state", "resting");
        } catch (e) { out.push(`stop order check failed: ${e instanceof Error ? e.message : e}`); }
      }
      status = "SENT";
      let opened: PosBroker | null = null;
      for (const o of payload.orders) {
        if (o.reduce_only && stopClosed) continue;
        try {
          const st = await deltaOrderChecked(sb, set.user_id, { symbol: String(o.symbol), size: Number(o.size), side: o.side as "buy" | "sell", reduceOnly: o.reduce_only });
          const filled = st.size - st.unfilled;
          out.push(`${o.side} ${o.size} ${o.symbol}: order ${st.id || "?"} ${st.state}${st.avg ? ` filled at ${st.avg}` : ""}${st.unfilled ? `, ${st.unfilled} unfilled` : ""}`);
          if (o.reduce_only) deltaFill.exit = st.avg ?? deltaFill.exit;
          else {
            deltaFill.entry = st.avg;
            if (filled > 0) opened = { broker: "DELTA", symbol: String(o.symbol), legs: [{ sec: String(o.symbol), seg: "DELTA", qty: (o.side === "buy" ? 1 : -1) * filled }],
              tick: Number(CRYPTO[String(o.symbol)]?.tick_size) || 0.5, step: 0, option: false, offset: 0, fill: st.avg };
          }
          if (st.unfilled > 0 || !(filled > 0)) { status = "FAILED"; out.push(`only ${filled} of ${st.size} contracts filled`); break; }
        } catch (e) {
          status = "FAILED"; out.push(`${o.side} ${o.size} ${o.symbol}: ${e instanceof Error ? e.message : String(e)}`);
          break; // don't open a new position if closing the old one failed
        }
      }
      if (opened) opened.step = stepFor(Number(opened.fill) || 0, opened.tick, false);
      // The position as Delta holds it (read by the stop order and the 5-minute check); a closed one has none.
      if (opened || payload.orders.some((o) => o.reduce_only)) await sb.from("algo_strategies").update({ pos_broker: opened }).eq("id", s.id);
      response = out.join(" | ").slice(0, 1000);
    }
  }
  await logSignal(s, event, description, candle, status, payload, response);
  return status !== "FAILED";
}

/**
 * A bought strategy's log must not give away its rules: keep the orders, sizing and stop levels, drop the condition
 * text that explains why the signal fired.
 */
function plainLog(event: string, description: string): string {
  const keep: string[] = [];
  for (const raw of description.split(" | ")) {
    const n = raw.trim();
    const order = n.match(/((?:Buy back|Buy|Sell) .+? x \d+(?: to close \w+)?)$/);
    if (/^(Size:|Margin |Entry skipped|Levels:|Premium |Stop not set|Manual exit)/.test(n)) keep.push(n);
    else if (/^(Stop loss|Target|Trailing)/i.test(n)) keep.push(n.replace(/:.*$/, "") + (order ? `: ${order[1]}` : ""));
    else if (order) keep.push(order[1]);
  }
  const lead: Record<string, string> = { ENTRY: "Entry signal", EXIT: "Exit signal", REVERSE: "Reversal signal", SQUARE_OFF: "Square-off", INFO: "Update" };
  return [lead[event] ?? event, ...keep].join(" | ").slice(0, 1000);
}
/* ---------- prices on orders: market price when sent (paper), Dhan's fill price (live) ---------- */
let lastSignalId: number | null = null;
type Fill = { leg: "Entry" | "Exit"; side: "BUY" | "SELL"; ref: string; qty: number; px: number | null; basis: string; broker_px?: number; broker_qty?: number; broker_ids?: string[]; broker_at?: string };
/** One leg of an order with the price it went at. st: the strategy with the position's fields (entry: the new position). */
function fillOf(st: Strategy, leg: "Entry" | "Exit", px: number | null | undefined): Fill {
  const opt = st.trade_type === "OPTIONS";
  const buyEntry = opt ? st.pos_option_side !== "SELL" : st.position === "LONG";
  if (isMulti(st)) {
    const lots = st.qty_mode === "LOTS" ? Number(st.pos_qty) : Math.round(Number(st.pos_qty) / Number(st.lot_size));
    return { leg, side: leg === "Entry" ? "BUY" : "SELL", ref: brokerRef(st), qty: st.qty_mode === "LOTS" ? lots * Number(st.lot_size) : Number(st.pos_qty), px: px != null && Number.isFinite(Number(px)) ? +Number(px).toFixed(2) : null, basis: "net premium (all legs)" };
  }
  const buy = leg === "Entry" ? buyEntry : !buyEntry;
  const lots = st.qty_mode === "LOTS" ? Number(st.pos_qty) : Math.round(Number(st.pos_qty) / Number(st.lot_size));
  const cr = isCrypto(String(st.data_segment));
  return { leg, side: buy ? "BUY" : "SELL", ref: brokerRef(st), qty: st.exchange === "MCX" || cr ? lots : (st.qty_mode === "LOTS" ? Number(st.pos_qty) * Number(st.lot_size) : Number(st.pos_qty)),
    px: px != null && Number(px) > 0 ? +Number(px).toFixed(4) : null, basis: opt ? "premium" : cr ? "Delta perpetual" : isCommodity(String(st.data_segment)) ? "futures" : "index" };
}
async function saveFills(fills: Fill[]) {
  if (lastSignalId && fills.length) await sb.from("algo_signals").update({ fills }).eq("id", lastSignalId);
}
/** Price of the open position now (option premium, or the futures / index price) and its unrealised P&L. */
async function markPrice(s: Strategy, set: Settings): Promise<Strategy> {
  if (s.position === "FLAT") return s;
  if (s.pos_ltp_at && Date.now() - Date.parse(s.pos_ltp_at) < 50000) return s;
  const opt = s.trade_type === "OPTIONS";
  if (isMulti(s) && Array.isArray(s.pos_legs)) {
    const legs = s.pos_legs as MLeg[], mp = await multiPx(dhanFor(set), s, legs);
    if (!mp) return s;
    const units = unitsOf(s);
    const upnl = legs.every((l) => Number(l.px) > 0) ? Math.trunc(legs.reduce((a, l, i) => a + (mp[i] - Number(l.px)) * legSign(l) * units * (l.q ?? 1), 0)) : null;
    const upd = { pos_ltp: +netPrem(legs, mp).toFixed(2), pos_ltp_at: new Date().toISOString(), pos_upnl: upnl };
    await sb.from("algo_strategies").update(upd).eq("id", s.id);
    return { ...s, ...upd };
  }
  let px: number | null = null;
  try { px = opt ? await premiumOf(dhanFor(set), s, s) : await dhanFor(set).ltp(s.data_segment, String(s.data_security_id)); } catch { px = null; }
  if (!(Number(px) > 0)) return s;
  const pr = (s.pos_risk ?? {}) as PosRisk;
  const inPx = opt ? Number(s.pos_entry_prem ?? pr.entryPrem ?? 0) : Number(s.pos_entry_px ?? pr.entry ?? 0);
  const dir = opt ? (s.pos_option_side === "SELL" ? -1 : 1) : (s.position === "LONG" ? 1 : -1);
  const upd = { pos_ltp: +Number(px).toFixed(2), pos_ltp_at: new Date().toISOString(), pos_upnl: inPx > 0 ? Math.trunc((Number(px) - inPx) * dir * unitsOf(s)) : null };
  await sb.from("algo_strategies").update(upd).eq("id", s.id);
  return { ...s, ...upd };
}
/**
 * Live orders: reads the account's Dhan trade book and writes the actual fill price on each order leg still waiting
 * for one (same contract, same side, traded within 30 minutes of the order, quantity complete).
 */
async function brokerFills(set: Settings, strategyIds: string[]) {
  if (!strategyIds.length || !set.dhan_access_token) return;
  const since = new Date(Date.now() - 6 * 3600000).toISOString();
  const { data: sigs } = await sb.from("algo_signals").select("id, created_at, fills").in("strategy_id", strategyIds).eq("mode", "LIVE").eq("status", "SENT")
    .not("fills", "is", null).gte("created_at", since).order("id");
  const open = (sigs ?? []).filter((g) => (g.fills as Fill[]).some((f) => f.broker_px == null && Date.now() - Date.parse(g.created_at) < 35 * 60000));
  if (!open.length) return;
  const r = await fetch("https://api.dhan.co/v2/trades", { headers: { "access-token": set.dhan_access_token, "client-id": set.dhan_client_id ?? "", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  const book = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(book)) return;
  const used = new Set<string>((sigs ?? []).flatMap((g) => (g.fills as Fill[]).flatMap((f) => f.broker_ids ?? [])));
  const tOf = (x: any) => Date.parse(String(x.exchangeTime || x.createTime || x.updateTime).replace(" ", "T") + "+05:30");
  const trades = book.filter((x: any) => Number(x.tradedQuantity) > 0).sort((a: any, b: any) => tOf(a) - tOf(b));
  for (const g of open) {
    const fills = g.fills as Fill[];
    const at = Date.parse(g.created_at);
    let changed = false;
    for (const f of fills) {
      if (f.broker_px != null) continue;
      const pick: any[] = []; let q = 0;
      for (const x of trades) {
        const id = String(x.exchangeTradeId ?? x.orderId + ":" + tOf(x));
        if (used.has(id) || String(x.transactionType).toUpperCase() !== f.side || !matchesRef(f.ref, x)) continue;
        const t = tOf(x); if (!(t >= at - 60000 && t <= at + 30 * 60000)) continue;
        pick.push({ id, x }); q += Number(x.tradedQuantity);
        if (q >= f.qty) break;
      }
      if (q < f.qty || !pick.length) continue;
      const val = pick.reduce((a, p) => a + Number(p.x.tradedPrice) * Number(p.x.tradedQuantity), 0);
      f.broker_px = +(val / q).toFixed(2); f.broker_qty = q; f.broker_ids = pick.map((p) => p.id);
      f.broker_at = new Date(tOf(pick[pick.length - 1].x)).toISOString();
      pick.forEach((p) => used.add(p.id)); changed = true;
    }
    if (changed) await sb.from("algo_signals").update({ fills }).eq("id", g.id);
  }
}
async function logSignal(s: Strategy, event: string, description: string, candle: Candle, status = "LOGGED", payload: unknown = null, response: string | null = null) {
  if (s.locked) { description = plainLog(event, description); candle = { t: candle.t, c: candle.c }; }
  lastSignalId = null;
  const { data: ins } = await sb.from("algo_signals").insert({
    strategy_id: s.id, event, description, mode: s.live ? "LIVE" : "PAPER", status, payload, response, lag_ms: tickT0 ? Date.now() - tickT0 : null,
    candle_time: candle.t ? new Date(candle.t * 1000).toISOString() : null,
    trend: candle.trend ?? null, close: candle.c ?? null, supertrend: candle.st ?? null,
  }).select("id").single();
  lastSignalId = ins?.id ?? null;
}

/**
 * Strategies are worked side by side within a tick (fetching prices and candles is the slow part), but anything that
 * books a trade or sends orders runs one at a time: sizing reads the capital in use, and the order path keeps a little
 * shared state (the last signal's id, Delta's fill prices).
 */
let actChain: Promise<unknown> = Promise.resolve();
function actLocked<T>(fn: () => Promise<T>): Promise<T> {
  const run = actChain.then(fn, fn);
  actChain = run.then(() => {}, () => {});
  return run;
}
/** Start of the current tick, rounded down to the minute (when the candles closed); for the decision delay. */
let tickT0: number | null = null;
const flatten = (s: Strategy, set: Settings, update: Record<string, unknown>, candle: Candle) => actLocked(() => flattenNow(s, set, update, candle));
async function flattenNow(s: Strategy, set: Settings, update: Record<string, unknown>, candle: Candle) {
  if (s.position === "FLAT") return;
  const ok = await sendOrders(s, set, "FLATTEN", asArr(exitLeg(s, 1)), `Manual exit: ${exitLabel(s)}`, candle);
  if (ok) { const out = await bookPnl(s, set, update, (s.live && isCrypto(String(s.data_segment)) ? deltaFill.exit : null) ?? candle.c, "Manual exit"); await saveFills([fillOf(s, "Exit", out)]); Object.assign(update, FLAT_STATE); }
  else Object.assign(update, { last_error: "Exit order failed to send. Check the log and close the position in Dhan.", active: false });
}

const finish = (s: Strategy, set: Settings, update: Record<string, unknown>, legs: Record<string, unknown>[], event: string, notes: string[], newState: Record<string, unknown>, candle: Candle, atrNow = 0) =>
  actLocked(() => finishNow(s, set, update, legs, event, notes, newState, candle, atrNow));
async function finishNow(s: Strategy, set: Settings, update: Record<string, unknown>, legs: Record<string, unknown>[], event: string, notes: string[], newState: Record<string, unknown>, candle: Candle, atrNow = 0) {
  if (legs.length) {
    const entryPx = newState._px as number | undefined;
    delete newState._px;
    const entering = (newState.position === "LONG" || newState.position === "SHORT") && entryPx !== undefined;
    const exiting = s.position !== "FLAT" && ["EXIT", "REVERSE", "SQUARE_OFF"].includes(event);
    if (entering && s._block) notes.push(`Entry skipped: ${s._block}`);
    if (entering && (s._block || !(await sizeEntry(s, set, legs, newState, entryPx!, notes)))) {
      // Not enough capital: drop the entry; an exit in the same signal still goes out.
      legs.pop();
      if (!legs.length) { await logSignal(s, "INFO", notes.join(" | "), candle); await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
      newState = { ...FLAT_STATE }; event = "EXIT";
    } else if (entering) await armRisk(s, set, newState, entryPx!, atrNow, notes);
    const ok = await sendOrders(s, set, event, legs, notes.join(" | "), candle);
    const fills: Fill[] = [];
    const crLive = s.live && isCrypto(String(s.data_segment));
    if (ok && exiting) fills.push(fillOf(s, "Exit", await bookPnl(s, set, update, (crLive ? deltaFill.exit : null) ?? candle.c, notes[0] ?? event)));
    if (ok && entering && newState.position !== "FLAT") {
      if (crLive && deltaFill.entry) newState.pos_entry_px = deltaFill.entry;
      const st = { ...s, ...newState };
      fills.push(fillOf(st, "Entry", s.trade_type === "OPTIONS" ? (newState.pos_entry_prem as number | null) : entryPx));
      Object.assign(newState, { pos_ltp: null, pos_ltp_at: null, pos_upnl: null });
    }
    if (ok) await saveFills(fills);
    if (ok) Object.assign(update, newState);
    else Object.assign(update, { last_error: `Order failed to send, so the strategy was paused. Check the log and your ${isCrypto(String(s.data_segment)) ? "Delta Exchange" : "Dhan"} positions.`, active: false });
  } else if (event === "INFO") {
    await logSignal(s, event, notes.join(" "), candle);
  }
  await sb.from("algo_strategies").update(update).eq("id", s.id);
}

async function processFlip(s: Strategy, set: Settings, action: string) {
  const dhan = dhanFor(set);
  const { bars, st, trend } = await flipSeries(s, dhan);
  const n = bars.length;
  const last = bars[n - 1];
  const tNow = trend[n - 1], tPrev = trend[n - 2];
  const stNow = isNaN(st[n - 1]) ? undefined : +st[n - 1].toFixed(2);
  const update: Record<string, unknown> = {
    last_trend: tNow, last_close: last.c, last_supertrend: s.locked ? null : stNow ?? null, last_run_at: new Date().toISOString(), last_error: null,
  };
  const candle = { t: last.t, trend: tNow, c: last.c, st: stNow };
  if (action === "refresh") { await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
  if (action === "flatten") {
    Object.assign(update, NO_PENDING);
    await flatten(s, set, update, candle); await sb.from("algo_strategies").update(update).eq("id", s.id); return;
  }

  const nowSec = Date.now() / 1000;
  const now = ist(nowSec);
  const sqOff = timeToMin(String(s.square_off));
  const sigName = s.strategy_kind === "HA" ? "Heikin Ashi" : "Supertrend";
  const breakout = s.entry_trigger === "BREAKOUT";
  const buf = Number(s.buffer_points) || 0;
  const halted = !canEnter(s); // daily loss limit reached: exits only
  const atrNow = (() => { const r = riskOf(s); if (!r) return 0; const a = atrSeries(bars, r.atr_len ?? 14); return a[a.length - 1] || 0; })();
  let position: Pos = s.position;
  const legs: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let event = "";
  let newState: Record<string, unknown> = {};
  let pendingPatch: Record<string, unknown> | null = null;

  if (s.intraday && now.min >= sqOff) {
    if (s.pending_target) pendingPatch = NO_PENDING;
    if (position !== "FLAT") {
      legs.push(...asArr(exitLeg(s, 1)));
      notes.push(`Square-off: ${exitLabel(s)}`);
      event = "SQUARE_OFF";
      newState = FLAT_STATE;
    }
  } else {
    // Stop-and-reverse on the signal (Supertrend, or Heikin Ashi colour), decided when a candle closes inside the window.
    //   Entry at close (CLOSE): trade straight away.
    //   Breakout (BREAKOUT): arm a trigger at the signal candle's high + buffer (buy) or low - buffer (sell). It fills only if
    //   the next candle trades through it (checked every minute); otherwise it is re-armed from that candle, and so on.
    // A flip after "no new trades after" is not traded that day. Next day it is acted on either
    //   FIRST_CLOSE (default): at the close of the first candle in the window, using the signal as it stands then, or
    //   OPEN: at the session start, from the previous day's last candle.
    const ss = timeToMin(String(s.session_start)), le = timeToMin(String(s.last_entry));
    const okMin = (m: number) => m >= ss && m < le && (!s.intraday || m < sqOff);
    const openMode = s.after_hours_flip === "OPEN";
    const newCandle = last.t !== s.last_candle_ts;
    const fresh = (last.day === now.date || isCrypto(String(s.data_segment))) && nowSec - last.endT <= Math.max(600, s.timeframe_min * 120);
    const candleInWindow = last.endMin >= ss && last.endMin < le && (!s.intraday || last.endMin < sqOff);
    const CLOSE_MIN = sessionFor(s.data_segment, now.date).close;
    const nowInWindow = now.min >= ss && now.min < le && (!s.intraday || now.min < sqOff) && now.min < CLOSE_MIN;
    const recent = nowSec - last.endT <= 5 * 86400; // stale-data guard (weekends and holidays allowed)
    const atOpen = openMode && nowInWindow && recent && !(last.day === now.date && last.endMin >= ss);
    const desiredFor = (t: number): Pos => t === 1 ? (s.direction === "SHORT_ONLY" ? "FLAT" : "LONG") : (s.direction === "LONG_ONLY" ? "FLAT" : "SHORT");

    // 1) Breakout: has the armed trigger been traded through?
    let pend = breakout && s.pending_target && s.pending_trigger != null
      ? { target: s.pending_target as Pos, trig: Number(s.pending_trigger), from: Number(s.pending_from), to: Number(s.pending_to) }
      : null;
    if (pend && nowSec >= pend.from && now.min <= CLOSE_MIN + 5) {
      const pd = pend;
      const up = pd.target === "LONG" || (pd.target === "FLAT" && position === "SHORT");
      const mins = await dhan.intraday(s.data_security_id, s.data_segment, s.data_instrument, 1, `${now.date} 09:00:00`, fmtIst(nowSec + 120, true));
      let hit = mins.find((m) => m.t >= pd.from && m.t < pd.to && okMin(ist(m.t).min) && (up ? m.h >= pd.trig : m.l <= pd.trig)) != null;
      if (!hit && nowSec < pd.to && okMin(now.min)) {
        try { const ltp = await dhan.ltp(s.data_segment, s.data_security_id); if (ltp && (up ? ltp >= pd.trig : ltp <= pd.trig)) hit = true; } catch { /* LTP is optional */ }
      }
      if (hit) {
        if (position !== "FLAT" && position !== pd.target) {
          legs.push(...asArr(exitLeg(s, legs.length + 1)));
          notes.push(`${sigName} breakout ${up ? "above" : "below"} ${pd.trig}: ${exitLabel(s)}`);
          event = "EXIT"; position = "FLAT"; newState = FLAT_STATE;
        }
        if (pd.target !== "FLAT" && position === "FLAT" && !halted) {
          const e = entryLeg(s, pd.target, pd.trig, legs.length + 1);
          legs.push(...asArr(e.leg));
          notes.push(`${sigName} breakout ${up ? "above" : "below"} ${pd.trig}: ${e.label}`);
          event = event === "EXIT" ? "REVERSE" : "ENTRY";
          newState = { position: pd.target, ...e.state };
          position = pd.target;
        }
        pendingPatch = NO_PENDING; pend = null;
      }
    }

    // 2) Decision on a candle close inside the window (or at the open in OPEN mode).
    if (s.last_candle_ts == null) {
      notes.push(`Started tracking. ${sigName} is ${tNow === 1 ? "up" : "down"}; waiting for the next candle.`);
      if (!event) event = "INFO";
    } else if ((newCandle && fresh && candleInWindow && now.min < CLOSE_MIN) || atOpen) {
      const desired = desiredFor(tNow);
      const flipped = !atOpen && tNow !== tPrev;
      if (breakout) {
        const mism = position !== "FLAT" && position !== desired;
        if (mism || (position === "FLAT" && desired !== "FLAT" && !halted && (s.entry_mode === "JOIN" || flipped || pend?.target === desired))) {
          const up = desired === "LONG" || (desired === "FLAT" && position === "SHORT");
          const trig = +(up ? last.h + buf : last.l - buf).toFixed(2);
          const sess = sessionFor(s.data_segment, now.date);
          const midnight = Date.parse(`${now.date}T00:00:00+05:30`) / 1000;
          const dayStart = midnight + sess.open * 60, dayEnd = midnight + sess.close * 60;
          const from = atOpen ? dayStart : last.endT;
          const to = Math.min(from + s.timeframe_min * 60, dayEnd);
          if (!(atOpen && Number(s.pending_from) === from)) {
            pendingPatch = { pending_target: desired, pending_trigger: trig, pending_from: from, pending_to: to };
            const action = desired === "FLAT" ? `exit ${String(position).toLowerCase()}` : position !== "FLAT" ? `reverse to ${desired.toLowerCase()}` : desired === "LONG" ? "buy" : "sell";
            notes.push(`${sigName} ${tNow === 1 ? "up" : "down"}${atOpen ? " (turned after hours)" : ""}: ${action} if price goes ${up ? "above" : "below"} ${trig} ` +
              `(${up ? "high" : "low"} ${up ? last.h : last.l} ${up ? "+" : "−"} ${buf}) between ${hhmm(from)} and ${hhmm(to)}.`);
            if (!event) event = "INFO";
          }
        } else if (s.pending_target && !pendingPatch) pendingPatch = NO_PENDING;
      } else {
        let reversing = false;
        if (position !== "FLAT" && position !== desired) {
          legs.push(...asArr(exitLeg(s, legs.length + 1)));
          const why = flipped ? "turned" : atOpen ? "turned after hours, so reversing at the open:" : "turned after hours; first candle close confirms, reversing:";
          notes.push(`${sigName} ${why} ${tNow === 1 ? "up" : "down"}: ${exitLabel(s)}`);
          event = "EXIT";
          position = "FLAT";
          newState = FLAT_STATE;
          reversing = true;
        }
        if (desired !== "FLAT" && position === "FLAT" && !halted && (s.entry_mode === "JOIN" || flipped || reversing)) {
          const e = entryLeg(s, desired, last.c, legs.length + 1);
          legs.push(...asArr(e.leg));
          notes.push(`${flipped ? `${sigName} flipped` : reversing ? "Reversing" : "Joining trend"} ${tNow === 1 ? "up" : "down"}: ${e.label}`);
          event = event === "EXIT" ? "REVERSE" : "ENTRY";
          newState = { position: desired, ...e.state };
        }
      }
    }
    update.last_candle_ts = last.t;
  }
  if (pendingPatch) { Object.assign(update, pendingPatch); newState = { ...newState, ...pendingPatch }; }
  await finish(s, set, update, legs, event, notes, newState, candle, atrNow);
}

/** Candles for every timeframe a rule book needs, plus daily candles and base candles by day (for opening ranges). */
async function rulesData(s: Strategy, dhan: Dhan, nowSec: number) {
  const rules = validateRules(s.rules);
  const seg = String(s.data_segment);
  const tfs = ruleTimeframes(rules, s.timeframe_min);
  const warm = warmBarsFor(rules);
  const spans = new Map<number, number>(); // base interval -> days of history
  for (const tf of tfs.intraday) {
    const bi = pickBaseInterval(tf);
    spans.set(bi, Math.max(spans.get(bi) ?? 0, warmDays(tf, 0, seg, warm)));
  }
  const rawBy = new Map<number, Awaited<ReturnType<typeof intradaySpan>>>();
  for (const [bi, days] of [...spans].sort((a, b) => a[0] - b[0])) rawBy.set(bi, await intradaySpan(dhan, s, bi, days, nowSec));
  const frames = new Map<number, ReturnType<typeof aggregate>>();
  for (const tf of tfs.intraday) {
    const bi = pickBaseInterval(tf);
    frames.set(tf, aggregate(rawBy.get(bi)!, tf, seg).filter((b) => isComplete(b, bi, nowSec)));
  }
  const today = ist(nowSec).date;
  const daily: DayBar[] = tfs.daily ? await dailyBefore(dhan, s, Math.ceil(warm * 1.5), today) : [];
  const smallest = Math.min(...rawBy.keys());
  const baseByDay = new Map<string, { min: number; h: number; l: number }[]>();
  for (const r of rawBy.get(smallest) ?? []) {
    const p = ist(r.t);
    const a = baseByDay.get(p.date) ?? []; a.push({ min: p.min, h: r.h, l: r.l }); baseByDay.set(p.date, a);
  }
  return { rules, book: new RuleBook(rules, s.timeframe_min, frames, daily, baseByDay, seg, undefined, await cryptoExt(s, rules, today)), bars: frames.get(s.timeframe_min)! };
}
/** Completed daily candles before today; they don't change during the day, so they are fetched once a day. */
const DAILY_CACHE = new Map<string, { day: string; from: string; rows: DayBar[] }>();
async function dailyBefore(dhan: Dhan, s: Strategy, days: number, today: string): Promise<DayBar[]> {
  const key = `${s.data_security_id}|${s.data_segment}|${s.data_instrument}`, from = addDays(today, -days);
  const hit = DAILY_CACHE.get(key);
  if (hit && hit.day === today && hit.from <= from) return hit.rows.filter((d) => d.day >= from);
  const rows = (await dhan.daily(s.data_security_id, String(s.data_segment), s.data_instrument, from, addDays(today, 1))).filter((d) => d.day < today);
  if (rows.length) DAILY_CACHE.set(key, { day: today, from, rows });
  return rows;
}
/** Crypto rules that read Bitcoin's trend or the funding rate get those series (other strategies: none). */
async function cryptoExt(s: Strategy, rules: ReturnType<typeof validateRules>, today: string) {
  if (!isCrypto(String(s.data_segment))) return undefined;
  const cs = [rules.long, rules.short, rules.exitLong, rules.exitShort].flatMap((x) => x?.conds ?? []);
  const ext: { btc?: DayBar[]; funding?: Map<string, number> } = {};
  if (cs.some((c) => c.ind === "BTC") && s.underlying !== "BTCUSD") ext.btc = (await cryptoDaily("BTCUSD", addDays(today, -500), addDays(today, 1))).filter((d) => d.day < today);
  if (cs.some((c) => c.ind === "FUND")) ext.funding = await cryptoFunding(String(s.underlying), addDays(today, -10), addDays(today, 1));
  return ext;
}

/** Once-a-day condition strategies: decided at the session open from completed daily candles, like the backtest. */
async function processRulesDaily(s: Strategy, set: Settings, action: string) {
  const rules = validateRules(s.rules);
  const dhan = dhanFor(set);
  const nowSec = Date.now() / 1000, now = ist(nowSec), seg = String(s.data_segment);
  const all = await dhan.daily(s.data_security_id, seg, s.data_instrument, addDays(now.date, -Math.ceil(warmBarsFor(rules) * 1.5)), addDays(now.date, 1));
  const days = all.filter((d) => d.day < now.date);
  if (days.length < 3) throw new Error(`Only ${days.length} daily candles came back from Dhan.`);
  const book = new RuleBook(rules, s.timeframe_min, new Map(), days, new Map(), seg, undefined, await cryptoExt(s, rules, now.date));
  const openT = (day: string) => Date.parse(`${day}T00:00:00+05:30`) / 1000 + sessionFor(seg, day).open * 60 + 60;
  const last = days[days.length - 1];
  const sig = book.at(openT(now.date)), prev = book.at(openT(last.day));
  let spot: number | null = null;
  try { spot = await dhan.ltp(seg, s.data_security_id); } catch { spot = null; }
  const tNow = sig.long && !sig.short ? 1 : sig.short && !sig.long ? -1 : 0;
  const update: Record<string, unknown> = { last_trend: tNow, last_close: spot ?? last.c, last_supertrend: null, last_run_at: new Date().toISOString(), last_error: null };
  const candle = { t: last.t, trend: tNow, c: spot ?? last.c };
  await saveChart(s, days, days.map(() => NaN), days.map(() => 0));
  if (action === "refresh") { await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
  if (action === "flatten") { await flatten(s, set, update, candle); await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
  const sess = tradingSession(seg, now.date);
  const legs: Record<string, unknown>[] = [], notes: string[] = [];
  let event = "", newState: Record<string, unknown> = {};
  let position: Pos = s.position;
  // Decide once, in the first half hour after the open (a strategy switched on later waits for tomorrow's open).
  if (String(s.last_entry_day) !== now.date && now.min >= sess.open + 1 && now.min < sess.open + 30 && spot) {
    update.last_entry_day = now.date;
    const dirOk = (side: Pos) => s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
    const d = decide(position === "FLAT" ? "FLAT" : position, sig, prev, { join: s.entry_mode === "JOIN", longOk: dirOk("LONG"), shortOk: dirOk("SHORT"), sets: ruleSets(rules) });
    const label = (k: "long" | "short") => rules[k]!.conds.map(describeCond).join(rules[k]!.mode === "ANY" ? " or " : " & ");
    if (d.exit && position !== "FLAT") { legs.push(...asArr(exitLeg(s, 1))); notes.push(`${d.why}: ${exitLabel(s)}`); event = "EXIT"; position = "FLAT"; newState = FLAT_STATE; }
    if (d.enter && position === "FLAT" && canEnter(s)) {
      const e = entryLeg(s, d.enter, spot, legs.length + 1);
      legs.push(...asArr(e.leg)); notes.push(`${d.enter === "LONG" ? "Buy" : "Sell"} rules met on yesterday's daily candle (${label(d.enter === "LONG" ? "long" : "short")}): ${e.label}`);
      event = event === "EXIT" ? "REVERSE" : "ENTRY"; newState = { position: d.enter, ...e.state };
    }
  }
  // One-time catch-up asked for from the desk: a flat strategy takes the side its own rules have held since their last
  // signal (it was added after that signal, so it would otherwise wait for the next one). Cleared once used.
  if (s.catch_up && (position !== "FLAT" || event)) update.catch_up = null;
  else if (s.catch_up && spot && now.min >= sess.open + 1 && now.min < sess.close) {
    const side = String(s.catch_up) as Pos;
    const okDir = s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
    if ((side === "LONG" || side === "SHORT") && okDir && canEnter(s)) {
      const e = entryLeg(s, side, spot, legs.length + 1);
      legs.push(...asArr(e.leg)); notes.push(`Catch-up (one time): ${s.catch_note ? `${s.catch_note}; ` : ""}${e.label}`);
      event = "ENTRY"; newState = { position: side, ...e.state };
    }
    update.catch_up = null;
  }
  update.last_candle_ts = last.t;
  const r = riskOf(s);
  await finish(s, set, update, legs, event, notes, newState, candle, r ? (atrSeries(days, r.atr_len ?? 14).at(-1) || 0) : 0);
}

/** Condition-based strategies: decided at each close of a candle of the strategy's own timeframe. */
async function processRules(s: Strategy, set: Settings, action: string) {
  if (s.rules?.daily) return processRulesDaily(s, set, action);
  const dhan = dhanFor(set);
  const nowSec = Date.now() / 1000;
  const now = ist(nowSec);
  const { rules, book, bars } = await rulesData(s, dhan, nowSec);
  const n = bars.length;
  if (n < 3) throw new Error(`Only ${n} completed candles came back from Dhan.`);
  const last = bars[n - 1];
  const sig = book.at(last.endT), prev = book.at(bars[n - 2].endT);
  const tNow = sig.long && !sig.short ? 1 : sig.short && !sig.long ? -1 : 0;
  const update: Record<string, unknown> = { last_trend: tNow, last_close: last.c, last_supertrend: null, last_run_at: new Date().toISOString(), last_error: null };
  const candle = { t: last.t, trend: tNow, c: last.c };
  await saveChart(s, bars, bars.map(() => NaN), bars.map(() => 0));
  if (action === "refresh") { await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
  if (action === "flatten") { await flatten(s, set, update, candle); await sb.from("algo_strategies").update(update).eq("id", s.id); return; }

  const sess = sessionFor(s.data_segment, now.date);
  const sqOff = timeToMin(String(s.square_off)), ss = timeToMin(String(s.session_start)), le = timeToMin(String(s.last_entry));
  let position: Pos = s.position;
  const legs: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let event = "";
  let newState: Record<string, unknown> = {};
  const label = (k: "long" | "short") => rules[k]!.conds.map(describeCond).join(rules[k]!.mode === "ANY" ? " or " : " & ");

  if (s.intraday && now.min >= sqOff) {
    if (position !== "FLAT") {
      legs.push(...asArr(exitLeg(s, 1))); notes.push(`Square-off: ${exitLabel(s)}`); event = "SQUARE_OFF"; newState = FLAT_STATE;
    }
  } else if (last.t !== s.last_candle_ts) {
    const fresh = (last.day === now.date || isCrypto(String(s.data_segment))) && nowSec - last.endT <= Math.max(600, s.timeframe_min * 120);
    const allDay = isCrypto(String(s.data_segment)) && !s.intraday; // crypto never closes: positional ones decide on every candle
    const candleInWindow = last.endMin >= ss && (allDay || last.endMin < le) && (!s.intraday || last.endMin < sqOff) && (allDay || now.min < sess.close);
    if (s.last_candle_ts == null) {
      notes.push("Started tracking. Waiting for the next candle to close."); event = "INFO";
    } else if (fresh && candleInWindow) {
      const dirOk = (side: Pos) => s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
      const d = decide(position === "FLAT" ? "FLAT" : position, sig, prev, { join: s.entry_mode === "JOIN", longOk: dirOk("LONG"), shortOk: dirOk("SHORT"), sets: ruleSets(rules) });
      if (d.exit && position !== "FLAT") {
        legs.push(...asArr(exitLeg(s, legs.length + 1))); notes.push(`${d.why}: ${exitLabel(s)}`);
        event = "EXIT"; position = "FLAT"; newState = FLAT_STATE;
      }
      if (d.enter && position === "FLAT" && canEnter(s)) {
        const e = entryLeg(s, d.enter, last.c, legs.length + 1);
        legs.push(...asArr(e.leg)); notes.push(`${d.enter === "LONG" ? "Buy" : "Sell"} rules met (${label(d.enter === "LONG" ? "long" : "short")}): ${e.label}`);
        event = event === "EXIT" ? "REVERSE" : "ENTRY";
        newState = { position: d.enter, ...e.state };
      }
    }
    update.last_candle_ts = last.t;
  }
  const r = riskOf(s);
  const atrNow = r ? (atrSeries(bars, r.atr_len ?? 14).at(-1) || 0) : 0;
  await finish(s, set, update, legs, event, notes, newState, candle, atrNow);
}

async function processTimed(s: Strategy, set: Settings, action: string) {
  const nowSec = Date.now() / 1000;
  const now = ist(nowSec);
  const { bars, st, trend, spot, marketDay } = await biasSeries(s, dhanFor(set), nowSec);
  const n = bars.length;
  const tNow = trend[n - 1];
  const stNow = isNaN(st[n - 1]) ? undefined : +st[n - 1].toFixed(2);
  const update: Record<string, unknown> = {
    last_trend: tNow, last_close: spot ?? bars[n - 1].c, last_supertrend: s.locked ? null : stNow ?? null, last_run_at: new Date().toISOString(), last_error: null,
  };
  const candle = { t: bars[n - 1].t, trend: tNow, c: spot ?? bars[n - 1].c, st: stNow };
  if (action === "refresh") { await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
  if (action === "flatten") { await flatten(s, set, update, candle); await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
  if (!marketDay) { await sb.from("algo_strategies").update(update).eq("id", s.id); return; } // holiday or no data yet

  const entryMin = timeToMin(String(s.entry_time)), exitMin = timeToMin(String(s.exit_time));
  let position: Pos = s.position;
  const legs: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let event = "";
  let newState: Record<string, unknown> = {};

  if (position !== "FLAT") {
    const entered = s.pos_entry_date ? String(s.pos_entry_date) : null;
    const due = s.exit_next_day ? (entered !== null && now.date > entered && now.min >= exitMin) : now.min >= exitMin;
    if (due) {
      legs.push(...asArr(exitLeg(s, 1)));
      notes.push(`Timed exit: ${exitLabel(s)}`);
      event = "EXIT";
      position = "FLAT";
      newState = FLAT_STATE;
    }
  }

  const lastEntryDay = s.last_entry_day ? String(s.last_entry_day) : null;
  if (position === "FLAT" && canEnter(s) && lastEntryDay !== now.date && now.min >= entryMin && now.min < entryMin + 10 && spot) {
    update.last_entry_day = now.date;
    const label = `${String(s.bias_timeframe) === "D" ? "Daily" : s.bias_timeframe + "-min"} Supertrend is ${tNow === 1 ? "up" : "down"}`;
    const desired: Pos = tNow === 1 ? (s.direction === "SHORT_ONLY" ? "FLAT" : "LONG") : (s.direction === "LONG_ONLY" ? "FLAT" : "SHORT");
    if (desired === "FLAT") {
      if (!legs.length) { event = "INFO"; notes.push(`${label}; your direction setting skips today's trade.`); }
    } else {
      const e = entryLeg(s, desired, spot, legs.length + 1);
      legs.push(...asArr(e.leg));
      notes.push(`${label}: ${e.label}`);
      event = event === "EXIT" ? "REVERSE" : "ENTRY";
      newState = { position: desired, ...e.state };
    }
  }
  await finish(s, set, update, legs, event, notes, newState, candle);
}

/* ---------- Dhan access token: renewed before it expires ---------- */
/** Expiry (epoch seconds) inside a Dhan access token (a JWT). */
function jwtExp(tok: string | null): number | null {
  try {
    const part = (tok ?? "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
    return Number(j.exp) || null;
  } catch { return null; }
}
/**
 * Dhan tokens last 24 hours. Dhan's RenewToken call swaps a still-valid token for a fresh 24-hour one, so this runs
 * every hour and renews when under 4 hours are left (or each morning at 08:xx IST, before the market opens).
 */
async function tokenCheck(force: boolean, userId?: string) {
  // Every connected account (or one), each with its own token.
  let q = sb.from("broker_accounts").select("id, user_id, client_id, access_token").eq("broker", "DHAN").not("access_token", "is", null);
  if (userId) q = q.eq("user_id", userId);
  const { data: rows } = await q;
  const out: Record<string, unknown> = {};
  for (const r of rows ?? []) out[r.user_id] = await tokenCheckOne(force, r).catch((e) => ({ renewed: false, reason: String(e) }));
  const mine = userId ? out[userId] as Record<string, unknown> | undefined : undefined;
  return userId ? (mine ?? { renewed: false, reason: "no token" }) : { accounts: Object.keys(out).length, results: out };
}
async function tokenCheckOne(force: boolean, set: { id: number; client_id: string | null; access_token: string | null }) {
  const tok = set?.access_token ?? "", client = set?.client_id ?? "";
  const now = Date.now() / 1000, note = (t: string, extra: Record<string, unknown> = {}) =>
    sb.from("broker_accounts").update({ token_note: t, token_checked_at: new Date().toISOString(), ...extra }).eq("id", set.id);
  if (!tok || !client) { await note("No token saved."); return { renewed: false, reason: "no token" }; }
  const exp = jwtExp(tok);
  const expIso = exp ? new Date(exp * 1000).toISOString() : null;
  if (exp && exp <= now) { await note("The token has expired. Generate a new one on Dhan Web (My Profile → Access DhanHQ APIs) and paste it here; it will then be renewed automatically.", { token_expires_at: expIso }); return { renewed: false, reason: "expired" }; }
  const left = exp ? exp - now : 0, hour = Math.floor(ist(now).min / 60);
  if (!force && exp && !(left < 4 * 3600 || (hour === 8 && left < 22 * 3600))) { await note(`OK. Next renewal when under 4 hours are left.`, { token_expires_at: expIso }); return { renewed: false, reason: "not due", left }; }
  try {
    const r = await fetch("https://api.dhan.co/v2/RenewToken", { method: "GET", headers: { "access-token": tok, dhanClientId: client, "client-id": client, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let j: any = {}; try { j = JSON.parse(text); } catch { /* not JSON */ }
    const fresh = [j.token, j.accessToken, j.access_token, j.data?.token, j.data?.accessToken].find((x) => typeof x === "string" && x.split(".").length === 3);
    if (!r.ok || !fresh) {
      await note(`Renewal failed (HTTP ${r.status}${j.errorMessage || j.message ? ": " + String(j.errorMessage || j.message).slice(0, 120) : ""}). It is retried every hour; if it keeps failing, paste a new token.`, { token_expires_at: expIso });
      return { renewed: false, reason: `HTTP ${r.status}` };
    }
    const fexp = jwtExp(fresh) ?? (j.expiryTime ? Date.parse(j.expiryTime) / 1000 : null);
    await sb.from("broker_accounts").update({
      access_token: fresh, token_expires_at: fexp ? new Date(fexp * 1000).toISOString() : null, token_renewed_at: new Date().toISOString(),
      token_checked_at: new Date().toISOString(), token_note: "Renewed automatically.",
    }).eq("id", set.id);
    return { renewed: true };
  } catch (e) {
    await note(`Renewal failed (${e instanceof Error ? e.message : String(e)}). Retrying next hour.`, { token_expires_at: expIso });
    return { renewed: false, reason: "network" };
  }
}
/** Funds in the Dhan account (available balance, margin in use), shown next to the desk's own capital figures. */
async function refreshFunds(userId: string) {
  const { data: set } = await sb.from("broker_accounts").select("id, client_id, access_token").eq("user_id", userId).eq("broker", "DHAN").maybeSingle();
  if (!set?.access_token) return { ok: false };
  const r = await fetch("https://api.dhan.co/v2/fundlimit", { headers: { "access-token": set.access_token, "client-id": set.client_id ?? "", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) { await sb.from("broker_accounts").update({ funds_error: `Dhan funds request failed (HTTP ${r.status}).`, funds_at: new Date().toISOString() }).eq("id", set.id); return { ok: false }; }
  const pickN = (...k: string[]) => { for (const x of k) if (j[x] !== undefined && j[x] !== null) return Number(j[x]); return null; };
  const funds = {
    available: pickN("availabelBalance", "availableBalance"), sod: pickN("sodLimit"), collateral: pickN("collateralAmount"),
    utilized: pickN("utilizedAmount"), withdrawable: pickN("withdrawableBalance"), receivable: pickN("receiveableAmount", "receivableAmount"),
  };
  await sb.from("broker_accounts").update({ funds, funds_at: new Date().toISOString(), funds_error: null }).eq("id", set.id);
  return { ok: true };
}

/** Checks a user's Delta Exchange API key by reading the wallet; the result shows under the connection form. */
async function deltaCheck(userId: string) {
  const a = await accountFor(sb, userId, "DELTA");
  if (!a?.dhan_client_id || !a?.dhan_access_token) return { ok: false };
  let note: string, ok = false;
  try {
    const bal = await deltaBalances(sb, userId);
    const main = bal.filter((b) => b.balance > 0 || b.asset === "USD" || b.asset === "INR");
    note = `Connected. Wallet: ${main.length ? main.map((b) => `${b.asset} ${b.balance.toFixed(2)}${b.inr != null ? ` (₹${Math.trunc(b.inr).toLocaleString("en-IN")})` : ""}`).join(", ") : "empty"}.`;
    ok = true;
  } catch (e) { note = e instanceof Error ? e.message.slice(0, 300) : String(e); }
  await sb.from("broker_accounts").update({ token_checked_at: new Date().toISOString(), token_note: note }).eq("user_id", userId).eq("broker", "DELTA");
  return { ok, note };
}
/**
 * The first day a coin traded properly on Delta India: the 30-day average turnover reaches $5 million a day (newly
 * listed contracts trade thinly, with flat candles that would mislead a backtest). Today if it never has.
 */
async function liquidFrom(symbol: string, launched: string, cv: number): Promise<string> {
  const today = ist(Date.now() / 1000).date;
  const days = await cryptoDailyDelta(symbol, launched, addDays(today, 1));
  const usd = days.map((d) => (d.v ?? 0) * d.c); // volume is already in coins
  for (let i = 29; i < days.length; i++) {
    const avg = usd.slice(i - 29, i + 1).reduce((a, b) => a + b, 0) / 30;
    if (avg >= 5e6) return days[i].day; // the day the month behind it reached that level
  }
  void cv;
  return today;
}
/** Delta's contract details (product id, coins per contract, tick) for every coin in crypto_assets. */
async function cryptoSync() {
  const { data: rows } = await sb.from("crypto_assets").select("key, lot_coins, cutover");
  let n = 0;
  for (const r of rows ?? []) {
    try {
      const p = await cryptoProduct(r.key);
      const ok = p.type === "perpetual_futures" && p.state === "live";
      // A coin added without a lot gets a round amount worth about $5,000.
      let lot: number | null = r.lot_coins == null ? null : Number(r.lot_coins);
      if (lot == null) { const px = await cryptoLtp(r.key).catch(() => null); if (px) lot = niceLot(px, p.contract_value); }
      await sb.from("crypto_assets").update({ product_id: p.product_id, contract_value: p.contract_value, tick_size: p.tick_size, synced_at: new Date().toISOString(), ...(lot ? { lot_coins: lot } : {}),
        // Delta's own candles once the coin trades properly there; older days from the Binance pair.
        ...(!r.cutover && /^\d{4}-\d{2}-\d{2}$/.test(p.launched) ? { cutover: await liquidFrom(r.key, p.launched, p.contract_value).catch(() => addDays(p.launched, 30)) } : {}),
        note: ok ? `${p.name}; 1 contract = ${p.contract_value} ${p.underlying || r.key.replace(/USD$/, "")}; settles in ${p.settles}; on Delta India since ${p.launched}` : `Not a live perpetual on Delta India (${p.type}, ${p.state}).` }).eq("key", r.key);
      n++;
    } catch (e) {
      await sb.from("crypto_assets").update({ note: e instanceof Error ? e.message.slice(0, 200) : String(e), synced_at: new Date().toISOString() }).eq("key", r.key);
    }
  }
  await loadCryptoAssets(sb).catch(() => null);
  return { synced: n };
}

const MAX_ROUNDS = 40; // safety stop for the self-chaining backtest
const MAX_BUSY = 12; // after this many waits for Dhan, pause the backtest for a manual resume

/** Ask the engine to continue this backtest in a fresh invocation (each one has its own time budget). */
async function chainBacktest(id: number) {
  const { data: sec } = await sb.from("engine_secret").select("secret").single();
  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/engine`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-engine-secret": sec!.secret },
    body: JSON.stringify({ action: "backtest", backtest_id: id }),
  });
}

/**
 * Daily self-check: every strategy with paper or live trades in the last 30 days is replayed with the backtest engine
 * and its trades matched one by one (see audit.ts). Two strategies per call (the 2-second limit); the rest chain on.
 */
async function runAudit(batch: string, offset: number) {
  const today = ist(Date.now() / 1000).date, days = 30;
  const { data: tr } = await sb.from("algo_trades").select("strategy_id, mode").eq("hidden", false).gte("entry_day", addDays(today, -days));
  const pairs = [...new Set((tr ?? []).map((t) => `${t.strategy_id}|${t.mode}`))].sort();
  const creds = credsOf(await adminAccount(sb));
  const t0 = Date.now();
  let i = offset;
  for (; i < pairs.length && (i === offset || Date.now() - t0 < 20000) && i < offset + 2; i++) {
    const [sid, mode] = pairs[i].split("|");
    const { data: s } = await sb.from("algo_strategies").select("*").eq("id", sid).maybeSingle();
    if (!s) continue;
    try {
      const r = await auditStrategy(sb, creds, s, mode as "PAPER" | "LIVE", days, today);
      if (r) await sb.from("desk_audit").insert({ batch, ...r });
    } catch (e) {
      await sb.from("desk_audit").insert({ batch, strategy_id: sid, user_id: s.owner_id, mode, name: s.name, verdict: "skipped", note: `Couldn't replay: ${(e as Error).message}`.slice(0, 300), trades: [] });
    }
  }
  if (i < pairs.length) {
    const { data: sec } = await sb.from("engine_secret").select("secret").single();
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/engine`, { method: "POST", headers: { "Content-Type": "application/json", "x-engine-secret": sec!.secret }, body: JSON.stringify({ action: "audit", batch, offset: i }) });
    return { batch, done: i, of: pairs.length };
  }
  // All done: one note per owner with the strategies that showed a gap.
  const { data: rows } = await sb.from("desk_audit").select("user_id, name, mode, verdict, issues, missed, extra").eq("batch", batch);
  const byUser = new Map<string, typeof rows>();
  for (const r of rows ?? []) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  for (const [uid, list] of byUser) {
    const gaps = (list ?? []).filter((r) => r.verdict === "gap");
    const ok = (list ?? []).filter((r) => r.verdict === "ok").length;
    await sb.from("notifications").insert({ user_id: uid, kind: "audit", url: "/?trades=1",
      title: gaps.length ? `Daily self-check: ${gaps.length} strateg${gaps.length === 1 ? "y" : "ies"} with gaps` : `Daily self-check: all ${ok} strategies match the backtest`,
      body: gaps.length ? gaps.slice(0, 4).map((g) => `${g.name.slice(0, 40)} (${g.mode.toLowerCase()}): ${g.issues} issue${g.issues === 1 ? "" : "s"}`).join(" · ") : `${ok} checked, no gaps.` });
  }
  return { batch, done: i, of: pairs.length };
}
/** Strategy lab: run one instalment, then hand over to a fresh invocation if there is more to do. */
async function labLoop() {
  const creds = credsOf(await adminAccount(sb));
  const chain = async () => {
    const { data: sec } = await sb.from("engine_secret").select("secret").single();
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/engine`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-engine-secret": sec!.secret }, body: JSON.stringify({ action: "lab" }),
    });
  };
  const more = await labStep({ sb, creds, started: Date.now(), chain });
  if (more) await chain();
  // The lab is free: start the held-back nightly run or the next variation run.
  else if (await labNext(sb)) await chain();
}

async function runBacktestJob(id: number) {
  const started = Date.now();
  const { data: bt } = await sb.from("algo_backtests").select("*").eq("id", id).single();
  if (!bt || !["queued", "running"].includes(bt.status)) return;
  if (bt.status === "queued" && bt.plans) await sb.from("algo_backtests").update({ status: "running", error: null, progress: "Resuming" }).eq("id", id);
  const setRow = (fields: Record<string, unknown>) => sb.from("algo_backtests").update(fields).eq("id", id);
  try {
    // The strategy owner's Dhan account (the admin's for marketplace results, or when the owner has none).
    const own = bt.user_id ? await accountFor(sb, bt.user_id) : null;
    const creds = credsOf(own?.dhan_access_token ? own : await adminAccount(sb));
    let params = bt.params;
    let plans: Plan[] | null = bt.plans;
    let acc: Acc = bt.acc ?? newAcc(Number(params.capital));
    let cursor: number = bt.cursor ?? 0;
    let trades: Record<string, unknown>[] = bt.trades ?? [];

    if (!plans) {
      await setRow({ status: "running", progress: "Starting" });
      validateParams(params);
      const { data: s } = await sb.from("algo_strategies").select("*").eq("id", bt.strategy_id).single();
      if (!s) throw new Error("Strategy not found.");
      // Freeze the strategy settings so every instalment uses the same rules.
      const snapshot = { ...s };
      for (const k of ["position", "pos_option_type", "pos_strike", "pos_expiry", "pos_qty", "pos_entry_date", "last_candle_ts", "last_trend",
        "last_close", "last_supertrend", "last_run_at", "last_error", "last_entry_day", "leg_template_fut", "leg_template_opt", "pos_risk", "day_pnl",
        "day_pnl_date", "pos_option_side", "pos_entry_px", "pos_entry_prem", "pos_lots", "pos_margin", "pos_legs"]) delete snapshot[k];
      if (isCommodity(String(snapshot.data_segment))) {
        const r = await dataSecurity(sb, creds, String(snapshot.data_segment), String(snapshot.data_security_id), ist(Date.now() / 1000).date);
        snapshot.data_sec_resolved = r.sec;
      }
      const res = await planBacktest(snapshot, creds, params, async (m) => { await setRow({ progress: m }); });
      // Crypto: Delta's daily funding rates over the test, for the funding each trade pays or receives.
      if (isCrypto(String(snapshot.data_segment))) {
        try { params = { ...params, funding: Object.fromEntries(await cryptoFunding(String(snapshot.underlying), addDays(String(params.from), -3), addDays(String(params.to), 3))) }; } catch { /* default rate */ }
      }
      plans = res.plans; acc = newAcc(Number(params.capital)); acc.calls = res.calls; acc.notes = res.notes; cursor = 0; trades = [];
      if (params.lab_period) await sb.from("lab_periods").update({ status: "running", updated_at: new Date().toISOString() }).eq("id", params.lab_period);
      // Structures: futures and option-writing margin rates for the legs (Dhan's figures from the morning check).
      const mr = isMulti(snapshot) ? (await loadMarginRates(sb).catch(() => ({} as Record<string, any>)))[String(snapshot.underlying)] : null;
      const intra = snapshot.product_type === "I" || !!snapshot.intraday;
      params = { ...params, strategy: snapshot,
        margin_rate: mr ? ((intra ? mr.futI ?? mr.fut : mr.fut ?? mr.futI) ?? null) : await dhanRate(snapshot).catch(() => null),
        sell_rate: mr ? ((intra ? mr.sellI ?? mr.sell : mr.sell ?? mr.sellI) ?? null) : null };
      await setRow({ params, plans, acc, cursor, trades, progress: `Planned ${plans.length} trades. Pricing them now.` });
    }

    const s = params.strategy;
    acc.rounds = (acc.rounds ?? 0) + 1;
    const deadline = started + 110000;
    const busyBefore = acc.busy ?? 0;
    const res = await priceBatch(s, creds, params, plans!, cursor, acc, deadline, async (m) => { await setRow({ progress: m }); });
    trades = trades.concat(res.trades);
    cursor = res.next; acc = res.acc;

    if ((acc.busy ?? 0) > busyBefore && cursor < plans!.length) {
      // Dhan's option-data server didn't answer. Keep the work done; wait, then carry on, or pause for a manual resume.
      if ((acc.busy ?? 0) > MAX_BUSY) {
        await setRow({ status: "paused", acc, cursor, trades, summary: summarize(s, params, plans!.length, trades.length, acc, true),
          progress: `Dhan's option-data server kept timing out. ${cursor} of ${plans!.length} trades are priced and saved; press Resume to continue from there.` });
        return;
      }
      await setRow({ acc, cursor, trades, progress: `Dhan's server is slow to answer. Priced ${cursor} of ${plans!.length} trades; retrying in 30 seconds…` });
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(30000, started + 140000 - Date.now()))));
      acc.rounds -= 1; // a wait for Dhan doesn't count towards the round limit
      await setRow({ acc });
      await chainBacktest(id);
      return;
    }
    if (cursor < plans!.length && acc.rounds < (params.lab_period ? MAX_ROUNDS * 4 : MAX_ROUNDS)) {
      await setRow({ acc, cursor, trades, progress: `Priced ${cursor} of ${plans!.length} trades. Continuing…` });
      await chainBacktest(id);
      return;
    }
    const partial = cursor < plans!.length;
    if (params.lab_period) {
      // A lab long test: cut the trades into 3M … 10Y windows for the Strategy Lab.
      // A test that stopped early only covers up to its last finished day.
      const windows = periodWindows(trades as any, String(params.from), partial && acc.lastDone ? String(acc.lastDone) : String(params.to), Number(params.capital));
      await sb.from("lab_periods").update({ status: partial ? "partial" : "done", windows, summary: summarize(s, params, plans!.length, trades.length, acc, partial), updated_at: new Date().toISOString() }).eq("id", params.lab_period);
    }
    await setRow({
      status: partial ? "partial" : "done", acc, cursor, trades, plans: null,
      summary: summarize(s, params, plans!.length, trades.length, acc, partial), finished_at: new Date().toISOString(),
      progress: partial ? `Stopped after ${trades.length} trades (up to ${acc.lastDone}). Run the remaining dates as a separate backtest.` : "Finished",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The access token was renewed mid-run: carry on from the saved point with the new token (a few times at most).
    const { data: cur } = await sb.from("algo_backtests").select("plans, acc").eq("id", id).single();
    if (TOKEN_ERR.test(msg) && cur?.plans && Number(cur.acc?.tokenRetries ?? 0) < 3) {
      await setRow({ acc: { ...cur.acc, tokenRetries: Number(cur.acc?.tokenRetries ?? 0) + 1 }, progress: "Dhan token was renewed; continuing…" });
      await new Promise((r) => setTimeout(r, 3000));
      await chainBacktest(id);
      return;
    }
    await setRow({ status: "failed", error: msg, finished_at: new Date().toISOString() });
    const lp = (bt.params as any)?.lab_period;
    if (lp) await sb.from("lab_periods").update({ status: "failed", error: msg.slice(0, 300), updated_at: new Date().toISOString() }).eq("id", lp);
  }
}

/**
 * Prices of open positions for the signed-in app, every few seconds while it is open: price now and unrealised P&L of
 * each open position (own strategies; the admin also sees clients'). Prices are read here with the broker connection,
 * so no broker token ever reaches the browser. Each position is re-priced at most every 3 seconds, whoever asks.
 */
async function liveMarks(userId: string, admin: boolean) {
  let q = sb.from("algo_strategies").select("*").neq("position", "FLAT").eq("archived", false);
  if (!admin) q = q.eq("owner_id", userId);
  const { data: rows0 } = await q;
  const rows = await withMasters(sb, rows0 ?? []);
  const accounts = new Map<string, Account | null>(), today = ist(Date.now() / 1000).date;
  const out: Record<string, { ltp: number | null; upnl: number | null; at: string | null }> = {};
  await Promise.all(rows.map(async (row: Strategy) => {
    try {
      let s = row;
      const isCr = isCrypto(String(s.data_segment));
      let set = s.owner_id ? await accountFor(sb, s.owner_id, isCr ? "DELTA" : "DHAN", accounts) : null;
      if (isCr) set = set ?? { user_id: s.owner_id, broker: "DELTA", dhan_client_id: null, dhan_access_token: null, webhook_url: null, webhook_secret: null, capital: null, capital_since: null, deploy_pct: null, funds_at: null };
      else if (!set?.dhan_access_token) { out[s.id] = { ltp: s.pos_ltp ?? null, upnl: s.pos_upnl ?? null, at: s.pos_ltp_at ?? null }; return; }
      // Outside the market's hours (including the 09:00–09:15 pre-open on NSE/BSE) the last price from the session stays:
      // pre-open prices are only indicative, and the desk takes no decision on them either.
      const nowI = ist(Date.now() / 1000), sess = sessionFor(String(s.data_segment), nowI.date);
      if (!isCr && (nowI.min < sess.open || nowI.min > sess.close)) { out[s.id] = { ltp: s.pos_ltp ?? null, upnl: s.pos_upnl ?? null, at: s.pos_ltp_at ?? null }; return; }
      if (isCommodity(String(s.data_segment))) s = { ...s, data_security_id: (await dataSecurity(sb, credsOf(set!), s.data_segment, String(s.data_security_id), today)).sec };
      const fresh = s.pos_ltp_at && Date.now() - Date.parse(s.pos_ltp_at) < 3000;
      const m = fresh ? s : await markPrice({ ...s, pos_ltp_at: null }, set!).catch(() => s);
      out[s.id] = { ltp: m.pos_ltp ?? null, upnl: m.pos_upnl ?? null, at: m.pos_ltp_at ?? null };
    } catch { /* leave this one out */ }
  }));
  return out;
}
/**
 * Phone notifications: sends every notification not yet sent (entries, exits with P&L, errors, going live, lab results,
 * token problems) to the user's registered phones. Each phone keeps its own choice of kinds; phones that the push
 * service says are gone are forgotten. Notifications are claimed first, so two senders never send the same one twice.
 */
async function pushOut() {
  const { data: keys } = await sb.from("push_keys").select("public_key, private_key, subject").eq("id", 1).maybeSingle();
  if (!keys) return { sent: 0, why: "no keys" };
  webpush.setVapidDetails(keys.subject, keys.public_key, keys.private_key);
  const { data: list } = await sb.rpc("claim_notifications", { p_limit: 50 });
  const ns = (list ?? []) as { id: number; user_id: string; kind: string; title: string; body: string | null; url: string | null; tag: string | null }[];
  if (!ns.length) return { sent: 0 };
  const users = [...new Set(ns.map((n) => n.user_id))];
  const { data: subs } = await sb.from("push_subs").select("id, user_id, endpoint, p256dh, auth, prefs").in("user_id", users);
  let sent = 0;
  for (const n of ns) {
    const mine = (subs ?? []).filter((x) => x.user_id === n.user_id && (n.kind === "test" || (x.prefs ?? {})[n.kind] !== false));
    const notes: string[] = [];
    await Promise.all(mine.map(async (x) => {
      try {
        await webpush.sendNotification({ endpoint: x.endpoint, keys: { p256dh: x.p256dh, auth: x.auth } },
          JSON.stringify({ title: n.title, body: n.body ?? "", url: n.url ?? "/", tag: n.tag ?? `n${n.id}`, kind: n.kind }),
          { TTL: 6 * 3600, urgency: n.kind === "error" || n.kind === "account" ? "high" : "normal" });
        sent++; notes.push("ok");
        await sb.from("push_subs").update({ last_ok_at: new Date().toISOString(), fail_count: 0 }).eq("id", x.id);
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode ?? 0;
        notes.push(String(code || (e instanceof Error ? e.message : e)).slice(0, 60));
        // 404 / 410: the phone unsubscribed or the app was removed.
        if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("id", x.id);
        else await sb.from("push_subs").update({ fail_count: 1 }).eq("id", x.id);
      }
    }));
    await sb.from("notifications").update({ push_note: mine.length ? notes.join(", ") : "no phone registered" }).eq("id", n.id);
  }
  return { sent, notifications: ns.length };
}

/**
 * Supervised first live test: one lot, long, through the full live path (worked limit order, fill check, stop order at
 * the broker 1.5% below). It is closed with the strategy's normal "Exit now" (flatten). Only for a live, flat, futures strategy.
 */
async function liveTest(id: string) {
  const { data: row } = await sb.from("algo_strategies").select("*").eq("id", id).single();
  if (!row) return { error: "no such strategy" };
  const [s0] = await withMasters(sb, [row]);
  if (!s0.live || s0.position !== "FLAT" || s0.trade_type !== "FUTURES" || isMulti(s0) || s0.exec_state === "working") return { error: "needs a live, flat, single-leg futures strategy" };
  const set = await accountFor(sb, s0.owner_id, isCrypto(String(s0.data_segment)) ? "DELTA" : "DHAN");
  if (!set?.dhan_access_token) return { error: "no broker account" };
  let s = s0;
  if (isCommodity(String(s.data_segment))) s = { ...s, data_security_id: (await dataSecurity(sb, credsOf(set), s.data_segment, String(s.data_security_id), todayIst())).sec };
  const px = await dhanFor(set).ltp(s.data_segment, String(s.data_security_id));
  if (!(Number(px) > 0)) return { error: "no price" };
  const e = entryLeg({ ...s, lots: 1 }, "LONG", px!, 1, 1);
  const stop = +(px! * 0.985).toFixed(2);
  const newState = { ...e.state, position: "LONG", pos_lots: 1, pos_entry_px: px, pos_risk: { basis: "UNDERLYING", entry: px, dir: 1, stop, tgt: null, trail: null, trailAtr: 0, best: px, scanFrom: Math.floor(Date.now() / 60000) * 60 } };
  delete (newState as any)._px;
  const ok = await sendOrders(s, set, "ENTRY", asArr(e.leg), `Live test (supervised): ${e.label} | Levels: stop ${stop}`, { t: Math.floor(Date.now() / 1000), c: px! });
  if (!ok) return { error: "the order didn't go", detail: (await sb.from("algo_strategies").select("last_error").eq("id", id).single()).data };
  await sb.from("algo_strategies").update(newState).eq("id", id);
  return { ok: true, price: px, stop };
}
/* ================================================================ live orders (Dhan: worked limit orders; both: broker stops, reconciliation)
 * Only strategies switched to live use any of this; paper strategies keep logging orders as before.
 */
type LiveRow = Record<string, any>;
type BrokerLeg = { sec: string; seg: string; qty: number; product?: string };
type PosBroker = { broker: "DHAN" | "DELTA"; legs: BrokerLeg[]; tick: number; step: number; option: boolean; offset: number; fill: number | null;
  stopId?: string | null; stopTrig?: number | null; stopRow?: number | null; stopErrAt?: string | null; symbol?: string };
const EXIT_EVENTS = new Set(["EXIT", "STOP_LOSS", "TRAIL_STOP", "TARGET", "SQUARE_OFF", "FLATTEN"]);
const nowIso = () => new Date().toISOString();
/** Crypto fills of the order just sent (for the ledger). */
let deltaFill: { exit: number | null; entry: number | null } = { exit: null, entry: null };

/** How many of an order's legs close the current position (they go first; the rest open the new one). */
function exitCount(s: Strategy, event: string, legs: Record<string, unknown>[]): number {
  if (s.position === "FLAT") return 0;
  if (EXIT_EVENTS.has(event)) return legs.length;
  if (event === "REVERSE") return Math.min(legs.length, asArr(exitLeg(s, 1)).length);
  return 0;
}
async function alert(s: Strategy, title: string, body: string, tag?: string) {
  if (tag) {
    const { data } = await sb.from("notifications").select("id").eq("tag", tag).gte("created_at", new Date(Date.now() - 6 * 3600000).toISOString()).limit(1);
    if (data?.length) return;
  }
  await sb.rpc("notify_tagged", { p_user: s.owner_id, p_kind: "error", p_title: `${title} · ${String(s.name ?? "").slice(0, 50)}`, p_body: body.slice(0, 400), p_url: `/?s=${s.id}`, p_strategy: s.id, p_tag: tag ?? null });
}
const brokerKey = (seg: string, sec: string) => `${seg}|${sec}`;

/**
 * A live Dhan order: each leg resolved to its contract, written to live_orders and worked by the order manager.
 * The exit legs go first; an entry leg is placed only once the exit before it has filled. Before an exit, the stop
 * order resting at Dhan is cancelled (if it has already filled, it is the exit) and Dhan's positions are checked, so an
 * exit is never sent for a position the account doesn't hold (it would open a position the wrong way).
 */
async function queueDhan(s: Strategy, set: Settings, event: string, legs: Record<string, unknown>[], description: string, candle: Candle): Promise<boolean> {
  const c = credsOf(set), today = todayIst();
  const nExit = exitCount(s, event, legs);
  const payload = { broker: "DHAN", legs };
  const pb = (s.pos_broker ?? null) as PosBroker | null;
  const notes: string[] = [];
  let rows: LiveRow[] = [];
  try {
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i], purpose = i < nExit ? "exit" : "entry";
      const k = await resolveLeg(sb, c, s, leg, today);
      const q = Number(leg.quantity ?? 0);
      const lots = s.qty_mode === "LOTS" ? q : q / (k.lot || 1);
      const ref = k.option ? null : Number(candle.c) || null; // an option is priced from its own last trade
      rows.push({ user_id: s.owner_id, strategy_id: s.id, broker: "DHAN", seq: i, purpose, event, side: sideOf(leg.transactionType), sec: k.sec, seg: k.seg,
        product: productOf(leg.productType), qty: brokerQty(k.seg, lots, k.lot), lots, lot: k.lot, tick: k.tick, option: k.option, label: k.label, ref_px: ref });
    }
  } catch (e) {
    await logSignal(s, event, description, candle, "FAILED", payload, e instanceof Error ? e.message : String(e));
    return false;
  }
  // Exits: the broker's stop first, then what the account actually holds.
  const exits = rows.filter((r) => r.purpose === "exit");
  if (exits.length) {
    if (pb?.stopId) {
      try {
        const st = await dhanStatus(c, pb.stopId);
        if (String(st.status).toUpperCase() === "TRADED") {
          // The stop at Dhan already closed the position: that's the exit (its fill is recorded when the order manager sees it).
          for (const r of exits) { r.state = "filled"; r.note = "closed by the stop-loss order at Dhan"; r.avg_px = st.avg; r.filled_qty = st.filled; r.done_at = nowIso(); r.broker_order_id = pb.stopId; }
          await sb.from("live_orders").update({ state: "filled", done_at: nowIso(), avg_px: st.avg, filled_qty: st.filled, note: "filled (desk exit came after)" }).eq("broker_order_id", pb.stopId).eq("state", "resting");
        } else {
          await dhanCancel(c, pb.stopId).catch(() => {});
          await sb.from("live_orders").update({ state: "cancelled", done_at: nowIso(), note: "cancelled before the desk's exit" }).eq("broker_order_id", pb.stopId).eq("state", "resting");
        }
      } catch (e) { notes.push(`Couldn't check the stop order at Dhan: ${e instanceof Error ? e.message : e}`); }
    }
    const open = exits.filter((r) => r.state !== "filled");
    if (open.length) {
      const held = await dhanPositions(c).catch(() => null);
      for (const r of open) {
        if (!pb) { r.state = "cancelled"; r.note = "not sent: the desk has no record of this position being opened at Dhan"; continue; }
        if (!held) continue; // positions couldn't be read: send the exit anyway
        const h = held.get(brokerKey(r.seg, r.sec)) ?? 0, want = r.side === "SELL" ? 1 : -1; // selling closes a long
        if (Math.sign(h) !== want) { r.state = "cancelled"; r.note = `not sent: Dhan shows no ${want === 1 ? "long" : "short"} position in ${r.label}`; continue; }
        if (Math.abs(h) < r.qty) { r.note = `Dhan holds ${Math.abs(h)} of ${r.qty}; closing what it holds`; r.qty = Math.abs(h); }
      }
      for (const r of open.filter((r) => r.state === "cancelled")) {
        await alert(s, "Exit not sent", `${r.label}: ${r.note}. The desk is now flat; check your Dhan positions.`);
      }
    }
  }
  const batch = crypto.randomUUID();
  await logSignal(s, event, description, candle, "SENT", payload, `Worked at Dhan: ${rows.map((r) => `${r.purpose} ${r.side} ${r.qty} ${r.label}${r.state === "cancelled" ? " (not sent)" : ""}`).join(" | ")}${notes.length ? " | " + notes.join(" | ") : ""}`.slice(0, 1000));
  rows = rows.map((r) => ({ ...r, batch, signal_id: lastSignalId, state: r.state ?? "queued" }));
  const { data: ins, error } = await sb.from("live_orders").insert(rows).select("*");
  if (error) { console.error("live_orders", error); return false; }
  await sb.from("algo_strategies").update({ exec_state: "working", ...(nExit ? { pos_broker: null } : {}) }).eq("id", s.id);
  // The first leg goes straight away (the order manager places the rest, in order, as each fills).
  const first = (ins ?? []).sort((a, b) => a.seq - b.seq).find((r) => r.state === "queued");
  if (first) {
    const ok = await placeRow(first, c);
    if (!ok && first.purpose === "entry" && !(ins ?? []).some((r) => r.purpose === "exit")) {
      await sb.from("algo_strategies").update({ exec_state: null }).eq("id", s.id);
      return false; // a plain entry Dhan wouldn't take: nothing changed, the strategy is paused by the caller
    }
  } else await afterRow(s.id, batch);
  return true;
}

/** Places (or re-places) one order at the last traded price. Returns false when Dhan wouldn't take it. */
async function placeRow(r: LiveRow, c: Creds): Promise<boolean> {
  const ltp = await dhanLtp(c, r.seg, r.sec);
  const px = ltp ?? (Number(r.ref_px) > 0 ? Number(r.ref_px) : null);
  const market = r.market_retry || (px == null && r.purpose === "exit");
  if (px == null && !market) return failRow(r, "no price to place the order at");
  const limit = market ? null : toTick(px!, Number(r.tick), r.side);
  const tag = `ag${r.id}x${r.market_retry ? "m" : ""}${Date.now() % 100000}`;
  try {
    let id: string;
    try {
      id = (await dhanPlace(c, { sec: r.sec, seg: r.seg, product: r.product, side: r.side, qty: r.qty, type: market ? "MARKET" : "LIMIT", price: limit ?? undefined, tag })).id;
    } catch (e) {
      // The reply may have been lost: look the order up by its tag before calling it failed.
      const found = /timed? ?out|abort|network|fetch/i.test(String(e)) ? await dhanByTag(c, tag).catch(() => null) : null;
      if (!found) throw e;
      id = found.id;
    }
    await sb.from("live_orders").update({ state: "working", broker_order_id: id, correlation_id: tag, limit_px: limit, ref_px: r.ref_px ?? px, step: stepFor(px ?? 0, Number(r.tick), !!r.option),
      placed_at: nowIso(), updated_at: nowIso(), note: market ? "market order" : null }).eq("id", r.id);
    return true;
  } catch (e) {
    return failRow(r, e instanceof Error ? e.message : String(e));
  }
}
/** Dhan wouldn't take or rejected an order. An exit is tried once more at market; anything else stops here. */
async function failRow(r: LiveRow, reason: string): Promise<boolean> {
  if (r.purpose === "exit" && !r.market_retry) {
    await sb.from("live_orders").update({ market_retry: true, note: `rejected (${reason.slice(0, 120)}); retrying at market`, updated_at: nowIso() }).eq("id", r.id);
    const set = await accountFor(sb, r.user_id, "DHAN");
    if (set) return placeRow({ ...r, market_retry: true }, credsOf(set));
  }
  await sb.from("live_orders").update({ state: "failed", note: reason.slice(0, 300), done_at: nowIso(), updated_at: nowIso() }).eq("id", r.id);
  await sb.from("live_orders").update({ state: "cancelled", note: "not sent: an earlier leg failed", done_at: nowIso() }).eq("batch", r.batch).eq("state", "queued");
  const s = (await sb.from("algo_strategies").select("*").eq("id", r.strategy_id).single()).data as Strategy | null;
  if (s) {
    const anyFilled = (await sb.from("live_orders").select("id").eq("batch", r.batch).eq("state", "filled").eq("purpose", "entry")).data?.length;
    const upd: Record<string, unknown> = { exec_state: null, active: false };
    if (r.purpose === "exit") {
      upd.last_error = `Exit order rejected by Dhan (${reason.slice(0, 150)}), also at market. The strategy is paused: close ${r.label} in Dhan.`;
    } else {
      // The desk takes back the entry it assumed (a structure partly opened is flagged to close by hand).
      Object.assign(upd, FLAT_STATE);
      upd.last_error = anyFilled ? `Part of the entry filled, then Dhan rejected ${r.label} (${reason.slice(0, 120)}). The strategy is paused: close the filled legs in Dhan.`
        : `Entry order rejected by Dhan: ${reason.slice(0, 160)}. The desk stays flat and the strategy is paused.`;
    }
    await sb.from("algo_strategies").update(upd).eq("id", s.id);
  }
  return false;
}

/** After a leg finishes: the next queued leg of the same order goes out; when none are left the strategy is free. */
async function afterRow(strategyId: string, batch: string) {
  const { data: next } = await sb.from("live_orders").select("*").eq("batch", batch).eq("state", "queued").order("seq").limit(1);
  if (next?.length) {
    const set = await accountFor(sb, next[0].user_id, "DHAN");
    if (set) { await placeRow(next[0], credsOf(set)); return; }
  }
  const { data: busy } = await sb.from("live_orders").select("id").eq("strategy_id", strategyId).in("state", ["queued", "working"]).limit(1);
  if (!busy?.length) await sb.from("algo_strategies").update({ exec_state: null }).eq("id", strategyId);
}

/** An order filled: its price goes on the signal, the position's broker record and (for an exit) the ledger. */
async function onFilled(r: LiveRow, st: BrokerStatus) {
  const avg = st.avg ?? Number(r.limit_px) ?? null;
  await sb.from("live_orders").update({ state: "filled", avg_px: avg, filled_qty: st.filled || r.qty, done_at: nowIso(), updated_at: nowIso() }).eq("id", r.id);
  if (r.signal_id && avg) {
    const { data: g } = await sb.from("algo_signals").select("fills").eq("id", r.signal_id).single();
    const fills = (g?.fills ?? []) as Fill[];
    const f = fills.find((x) => x.leg === (r.purpose === "exit" ? "Exit" : "Entry") && x.broker_px == null && x.side === r.side);
    if (f) { f.broker_px = +Number(avg).toFixed(2); f.broker_qty = st.filled || r.qty; f.broker_ids = [String(r.broker_order_id)]; f.broker_at = nowIso(); await sb.from("algo_signals").update({ fills }).eq("id", r.signal_id); }
  }
  const s = (await sb.from("algo_strategies").select("*").eq("id", r.strategy_id).single()).data as Strategy | null;
  if (!s) return;
  if (r.purpose === "entry") {
    const pb = ((s.pos_broker ?? null) as PosBroker | null) ?? { broker: "DHAN", legs: [], tick: Number(r.tick), step: Number(r.step) || stepFor(avg ?? 0, Number(r.tick), !!r.option), option: !!r.option, offset: 0, fill: null };
    pb.legs.push({ sec: r.sec, seg: r.seg, qty: (r.side === "BUY" ? 1 : -1) * Number(st.filled || r.qty), product: r.product });
    pb.fill = avg;
    // Index futures trade above / below the index the desk watches: the gap at the fill moves the broker stop with it.
    const indexFut = !r.option && r.seg !== "MCX_COMM";
    pb.offset = indexFut && avg && Number(r.ref_px) > 0 ? +(avg - Number(r.ref_px)).toFixed(2) : 0;
    const upd: Record<string, unknown> = { pos_broker: pb };
    if (!isMulti(s) && avg) {
      if (s.trade_type === "OPTIONS") upd.pos_entry_prem = +Number(avg).toFixed(2);
      else if (!indexFut) upd.pos_entry_px = +Number(avg).toFixed(2);
    }
    await sb.from("algo_strategies").update(upd).eq("id", s.id);
  } else if (avg) await fixLedger(s, r, avg);
  await afterRow(s.id, r.batch);
}
/** The closed trade at the prices Dhan actually filled (entry and exit), with charges and the day's total corrected. */
async function fixLedger(s: Strategy, r: LiveRow, exitAvg: number) {
  const { data: ent } = await sb.from("live_orders").select("avg_px, qty, lot, option, seg").eq("strategy_id", s.id).eq("sec", r.sec).in("purpose", ["entry"]).eq("state", "filled")
    .lt("created_at", r.created_at).order("created_at", { ascending: false }).limit(1);
  const e = ent?.[0];
  const { data: tr } = await sb.from("algo_trades").select("*").eq("strategy_id", s.id).eq("mode", "LIVE").gte("exit_at", new Date(Date.parse(r.created_at) - 10 * 60000).toISOString())
    .order("exit_at", { ascending: false }).limit(1);
  const t = tr?.[0];
  if (!t || !e?.avg_px || isMulti(s)) return;
  const inPx = Number(e.avg_px), outPx = exitAvg, units = Number(t.units);
  const dir = r.side === "SELL" ? 1 : -1; // the exit sells what was bought
  const gross = (outPx - inPx) * dir * units;
  const buyVal = (dir === 1 ? inPx : outPx) * units, sellVal = (dir === 1 ? outPx : inPx) * units;
  const costs = tradeCharges({ from: "", to: "", capital: 0, brokerage: 20, charges: ratesFor(s), near_code: 1 }, !!r.option, buyVal, sellVal).total;
  const net = Math.trunc(gross - costs);
  await sb.from("algo_trades").update({ entry_px: +inPx.toFixed(2), exit_px: +outPx.toFixed(2), gross: Math.trunc(gross), costs: Math.trunc(costs), net,
    exit_why: `${String(t.exit_why ?? "").slice(0, 150)} · Dhan fills`.slice(0, 200) }).eq("id", t.id);
  if (String(s.day_pnl_date) === todayIst() && s.day_pnl != null) await sb.from("algo_strategies").update({ day_pnl: Math.trunc(Number(s.day_pnl) + net - Number(t.net)) }).eq("id", s.id);
}

/**
 * The order manager (every minute; looks at each working order every 15 seconds within the minute):
 * filled → recorded, next leg placed; rejected → handled (failRow); price beyond the limit → one step towards it,
 * an exit at market after 3 steps, an entry given up after 4 (the desk goes back to flat); a quiet market → wait.
 * Stop orders resting at the broker are checked once a minute: one that filled closes the desk's position.
 */
async function runOrders(passes = 4) {
  const until = new Date(Date.now() + 75000).toISOString();
  const { data: lock } = await sb.from("live_lock").update({ until }).eq("id", 1).lt("until", nowIso()).select("id");
  if (!lock?.length) return { skipped: "another order manager is running" };
  const done: string[] = [];
  try {
    for (let pass = 0; pass < passes; pass++) {
      if (pass) await new Promise((res) => setTimeout(res, 15000));
      const { data: rows } = await sb.from("live_orders").select("*").in("state", pass === 0 ? ["working", "resting"] : ["working"]).order("id");
      if (!rows?.length) break;
      const accts = new Map<string, Account | null>();
      for (const r of rows) {
        try {
          const set = await accountFor(sb, r.user_id, r.broker, accts);
          if (!set?.dhan_access_token) continue;
          if (r.state === "resting") { await checkStop(r, set); continue; }
          const c = credsOf(set);
          const st = await dhanStatus(c, r.broker_order_id);
          const ltp = await dhanLtp(c, r.seg, r.sec);
          const d = chaseDecision({ purpose: r.purpose, side: r.side, limit: r.limit_px == null ? null : Number(r.limit_px), steps: Number(r.steps), step: Number(r.step), tick: Number(r.tick) }, st, ltp);
          done.push(`${r.id}:${d.kind}`);
          if (d.kind === "filled") await onFilled(r, st);
          else if (d.kind === "failed") await failRow(r, d.reason);
          else if (d.kind === "modify") {
            await dhanModify(c, r.broker_order_id, { type: "LIMIT", qty: r.qty, price: d.price });
            await sb.from("live_orders").update({ limit_px: d.price, steps: Number(r.steps) + 1, updated_at: nowIso() }).eq("id", r.id);
          } else if (d.kind === "market") {
            await dhanModify(c, r.broker_order_id, { type: "MARKET", qty: r.qty });
            await sb.from("live_orders").update({ limit_px: null, note: `price ran ${r.steps} steps away: sent at market`, updated_at: nowIso() }).eq("id", r.id);
          } else if (d.kind === "give_up") {
            await dhanCancel(c, r.broker_order_id).catch(() => {});
            const again = await dhanStatus(c, r.broker_order_id).catch(() => null);
            if (again && (String(again.status).toUpperCase() === "TRADED" || again.filled > 0)) { if (String(again.status).toUpperCase() === "TRADED") await onFilled(r, again); continue; }
            await giveUp(r, ltp);
          }
        } catch (e) {
          done.push(`${r.id}:error ${e instanceof Error ? e.message : e}`);
          await sb.from("live_orders").update({ note: `check failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`, updated_at: nowIso() }).eq("id", r.id);
        }
      }
    }
    // A position that has just filled gets its stop order at the broker straight away (not at the next minute's tick).
    const { data: open } = await sb.from("algo_strategies").select("*").eq("live", true).neq("position", "FLAT").is("exec_state", null).not("pos_broker", "is", null);
    for (const r of (open ?? []).filter((x) => !x.pos_broker?.stopId)) {
      try {
        const set = await accountFor(sb, r.owner_id, isCrypto(String(r.data_segment)) ? "DELTA" : "DHAN");
        if (set?.dhan_access_token) { const [s] = await withMasters(sb, [r]); await syncStop(s, set); done.push(`${r.id}:stop`); }
      } catch (e) { console.error("stop", e); }
    }
  } finally {
    await sb.from("live_lock").update({ until: nowIso() }).eq("id", 1);
  }
  return { done };
}
/** The price ran away from an entry: the order is cancelled, the desk goes back to flat and you are told. */
async function giveUp(r: LiveRow, ltp: number | null) {
  await sb.from("live_orders").update({ state: "gave_up", note: `price moved away (last ${ltp ?? "?"}, limit ${r.limit_px}); cancelled after ${r.steps} steps`, done_at: nowIso() }).eq("id", r.id);
  await sb.from("live_orders").update({ state: "cancelled", note: "not sent: the entry before it wasn't filled", done_at: nowIso() }).eq("batch", r.batch).eq("state", "queued");
  const s = (await sb.from("algo_strategies").select("*").eq("id", r.strategy_id).single()).data as Strategy | null;
  if (!s) return;
  const partial = (await sb.from("live_orders").select("id").eq("batch", r.batch).eq("purpose", "entry").eq("state", "filled")).data?.length;
  await sb.from("algo_strategies").update({ ...FLAT_STATE, exec_state: null, ...(partial ? { active: false, last_error: `Part of the entry filled, then the price ran away from ${r.label}. The strategy is paused: close the filled legs in Dhan.` } : {}) }).eq("id", s.id);
  await logSignal({ ...s, live: true }, "INFO", `Entry not filled: ${r.label} moved away from the limit (${r.steps} steps). The order was cancelled and the desk is flat again.`, { c: ltp ?? undefined });
  if (!partial) await alert(s, "Entry not filled", `${r.label} moved away from the limit; the order was cancelled after ${r.steps} steps and the desk is flat again. It enters on the next signal.`);
}

/* ---------- the stop-loss order resting at the broker ---------- */
/** Where the broker stop should be now (null: none for this position). Moves only in the position's favour. */
function wantedStop(s: Strategy, pb: PosBroker): { trig: number; long: boolean; limit: number } | null {
  const r = riskOf(s), pr = s.pos_risk as PosRisk | null;
  if (!r || !pr || pr.dir === undefined || isMulti(s) || pb.legs.length !== 1) return null;
  if (s.trade_type === "OPTIONS" && pr.basis !== "PREMIUM") return null; // an index-level stop can't be put on the option itself
  const eff = effectiveStop({ dir: pr.dir!, stop: pr.stop ?? null, tgt: pr.tgt ?? null, trail: pr.trail ?? null, trailAtr: pr.trailAtr ?? 0, best: Number(pr.best), scanFrom: 0 } as RiskState).px;
  if (eff == null || !(eff > 0)) return null;
  const long = pb.legs[0].qty > 0;
  const trig = brokerStopTrigger(eff, pb.offset || 0, long, pb.step || stepFor(eff, pb.tick, pb.option), pb.tick);
  return trig > 0 ? { trig, long, limit: stopLimit(trig, long, pb.tick, pb.option) } : null;
}
/** Places the broker stop after an entry fills, and moves it as the trailing stop moves (every minute, live strategies). */
async function syncStop(s: Strategy, set: Settings): Promise<Strategy> {
  const pb = s.pos_broker as PosBroker | null;
  if (!s.live || s.position === "FLAT" || !pb || s.exec_state === "working") return s;
  if (pb.stopErrAt && Date.now() - Date.parse(pb.stopErrAt) < 10 * 60000) return s;
  const w = wantedStop(s, pb);
  if (!w) return s;
  if (pb.stopId && pb.stopTrig != null && (w.long ? w.trig <= pb.stopTrig : w.trig >= pb.stopTrig)) return s; // not tighter
  const leg = pb.legs[0], side: Side = w.long ? "SELL" : "BUY", qty = Math.abs(leg.qty);
  const next: PosBroker = { ...pb, stopErrAt: null };
  try {
    if (pb.broker === "DELTA") {
      const sym = String(pb.symbol ?? leg.sec);
      if (pb.stopId) await deltaStopMove(sb, set.user_id, sym, pb.stopId, w.trig);
      else next.stopId = await deltaStop(sb, set.user_id, { symbol: sym, size: qty, side: side === "BUY" ? "buy" : "sell", stop: w.trig });
    } else {
      const c = credsOf(set);
      if (pb.stopId) await dhanModify(c, pb.stopId, { type: "STOP_LOSS", qty, price: w.limit, trigger: w.trig });
      else next.stopId = (await dhanPlace(c, { sec: leg.sec, seg: leg.seg, product: leg.product ?? productOf(s.product_type), side, qty, type: "STOP_LOSS", price: w.limit, trigger: w.trig, tag: `ag${String(s.id).slice(0, 8)}s${Date.now() % 100000}` })).id;
    }
    if (!pb.stopId) {
      const { data: row } = await sb.from("live_orders").insert({ user_id: s.owner_id, strategy_id: s.id, batch: crypto.randomUUID(), broker: pb.broker, purpose: "stop", event: "STOP_LOSS", side,
        sec: leg.sec, seg: leg.seg, product: leg.product ?? null, qty, tick: pb.tick, option: pb.option, label: `${s.name} stop`, trigger_px: w.trig, limit_px: pb.broker === "DHAN" ? w.limit : null,
        state: "resting", broker_order_id: next.stopId, placed_at: nowIso() }).select("id").single();
      next.stopRow = row?.id ?? null;
    } else await sb.from("live_orders").update({ trigger_px: w.trig, limit_px: pb.broker === "DHAN" ? w.limit : null, updated_at: nowIso() }).eq("broker_order_id", pb.stopId).eq("state", "resting");
    next.stopTrig = w.trig;
  } catch (e) {
    next.stopErrAt = nowIso();
    await alert(s, "Stop order not placed", `The stop-loss order at ${pb.broker === "DELTA" ? "Delta Exchange" : "Dhan"} couldn't be ${pb.stopId ? "moved" : "placed"} (${e instanceof Error ? e.message : e}). The desk still watches its own stop every minute.`, `stoperr-${s.id}`);
  }
  await sb.from("algo_strategies").update({ pos_broker: next }).eq("id", s.id);
  return { ...s, pos_broker: next };
}
/** A resting stop order: filled → the desk books the exit at its price; cancelled / rejected by the broker → you are told. */
async function checkStop(r: LiveRow, set: Settings) {
  let state = "", avg: number | null = null, filled = 0;
  if (r.broker === "DELTA") {
    const st = await deltaOrderState(sb, r.user_id, r.broker_order_id);
    state = st.state === "closed" && st.unfilled === 0 ? "TRADED" : st.state === "cancelled" ? "CANCELLED" : "PENDING"; avg = st.avg; filled = st.size - st.unfilled;
  } else {
    const st = await dhanStatus(credsOf(set), r.broker_order_id);
    state = String(st.status).toUpperCase(); avg = st.avg; filled = st.filled;
  }
  if (state !== "TRADED" && !["REJECTED", "CANCELLED", "EXPIRED"].includes(state)) return;
  const s0 = (await sb.from("algo_strategies").select("*").eq("id", r.strategy_id).single()).data as Strategy | null;
  if (state !== "TRADED") {
    await sb.from("live_orders").update({ state: "failed", note: `${state.toLowerCase()} at the broker`, done_at: nowIso() }).eq("id", r.id);
    if (s0?.pos_broker?.stopId === r.broker_order_id) {
      await sb.from("algo_strategies").update({ pos_broker: { ...s0.pos_broker, stopId: null, stopTrig: null, stopErrAt: nowIso() } }).eq("id", s0.id);
      if (state !== "EXPIRED") await alert(s0, "Stop order cancelled", `The stop-loss order at the broker was ${state.toLowerCase()}. A new one is placed within 10 minutes; the desk keeps watching its own stop.`, `stopgone-${r.id}`);
    }
    return;
  }
  await sb.from("live_orders").update({ state: "filled", avg_px: avg, filled_qty: filled, done_at: nowIso() }).eq("id", r.id);
  if (!s0 || s0.position === "FLAT" || s0.pos_broker?.stopId !== r.broker_order_id) return;
  const [s] = await withMasters(sb, [s0]);
  const pb = s.pos_broker as PosBroker;
  const update: Record<string, unknown> = { last_run_at: nowIso() };
  const opt = s.trade_type === "OPTIONS";
  const under = opt ? undefined : avg != null ? avg - (pb.offset || 0) : undefined;
  await logSignal(s, "STOP_LOSS", `Stop-loss order filled at ${r.broker === "DELTA" ? "Delta Exchange" : "Dhan"} at ${avg ?? "?"}: ${exitLabel(s)}`, { t: Math.floor(Date.now() / 1000), c: under }, "SENT", null, `order ${r.broker_order_id}`);
  const out = await bookPnl(s, set, update, under, `Stop-loss order at the broker${avg ? ` (${avg})` : ""}`, opt ? avg : undefined);
  await saveFills([{ ...fillOf(s, "Exit", out), broker_px: avg ?? undefined, broker_qty: filled, broker_ids: [String(r.broker_order_id)], broker_at: nowIso() }]);
  Object.assign(update, FLAT_STATE);
  await sb.from("algo_strategies").update(update).eq("id", s.id);
  if (r.broker === "DHAN" && avg) await fixLedger(s, { ...r, created_at: nowIso() }, avg);
}

/* ---------- desk vs broker, every 5 minutes ---------- */
async function reconcile() {
  const { data: live } = await sb.from("algo_strategies").select("id, name, owner_id, data_segment, position, pos_broker, exec_state, futures_symbol").eq("live", true).eq("active", true);
  const byUser = new Map<string, Strategy[]>();
  for (const s of live ?? []) byUser.set(s.owner_id, [...(byUser.get(s.owner_id) ?? []), s]);
  const out: Record<string, string> = {};
  for (const [u, list] of byUser) {
    for (const broker of ["DHAN", "DELTA"] as const) {
      const mine = list.filter((s) => (broker === "DELTA") === isCrypto(String(s.data_segment)));
      if (!mine.length) continue;
      const nowMin = ist(Date.now() / 1000);
      if (broker === "DHAN" && !mine.some((s) => { const ss = tradingSession(s.data_segment, nowMin.date); return nowMin.min >= ss.open + 2 && nowMin.min <= ss.close; })) continue;
      if (mine.some((s) => s.exec_state === "working")) { out[`${u}|${broker}`] = "orders working: next time"; continue; }
      try {
        const set = await accountFor(sb, u, broker);
        if (!set?.dhan_access_token) continue;
        const held = broker === "DHAN" ? await dhanPositions(credsOf(set)) : await deltaPositions(sb, u);
        const desk = new Map<string, number>(), who = new Map<string, Strategy>();
        for (const s of mine) for (const l of ((s.pos_broker as PosBroker | null)?.legs ?? [])) {
          if (s.position === "FLAT") continue;
          const k = brokerKey(l.seg, l.sec); desk.set(k, (desk.get(k) ?? 0) + l.qty); who.set(k, s);
        }
        // Only contracts the desk has traded are compared (the account may hold other positions of your own).
        const { data: traded } = await sb.from("live_orders").select("seg, sec, strategy_id").eq("user_id", u).eq("broker", broker).gte("created_at", new Date(Date.now() - 40 * 86400000).toISOString());
        const known = new Map<string, string>((traded ?? []).map((t) => [brokerKey(t.seg, t.sec), t.strategy_id]));
        const brk = new Map<string, number>([...held].filter(([k]) => desk.has(k) || known.has(k)));
        const diffs = positionDiff(desk, brk);
        out[`${u}|${broker}`] = diffs.length ? diffs.map((d) => `${d.key} desk ${d.desk} broker ${d.broker}`).join("; ") : "match";
        for (const d of diffs) {
          const s = who.get(d.key) ?? mine.find((x) => x.id === known.get(d.key)) ?? mine[0];
          await alert(s, "Positions don't match", `${broker === "DELTA" ? "Delta Exchange" : "Dhan"} holds ${d.broker} in ${d.key.split("|")[1]} but the desk expects ${d.desk}. Check the position at the broker.`, `recon-${d.key}-${d.desk}-${d.broker}`);
        }
      } catch (e) { out[`${u}|${broker}`] = `error: ${e instanceof Error ? e.message : e}`; }
    }
  }
  return out;
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const secret = req.headers.get("x-engine-secret");
  // The signed-in app may ask for one thing only: current prices of its open positions.
  if (!secret && req.headers.get("Authorization")) {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await sb.auth.getUser(jwt);
    const reply = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
    if (!u?.user) return reply(401, { error: "Sign in again." });
    const b = await req.json().catch(() => ({}));
    if (b.action !== "marks") return reply(403, { error: "Not allowed." });
    const [{ data: prof }, { data: own }] = await Promise.all([
      sb.from("profiles").select("role, status").eq("user_id", u.user.id).maybeSingle(),
      sb.from("app_owner").select("user_id").eq("user_id", u.user.id).maybeSingle(),
    ]);
    const admin = (prof?.role === "admin" && prof?.status === "active") || !!own;
    await loadCryptoAssets(sb).catch(() => {});
    return reply(200, { marks: await liveMarks(u.user.id, admin), at: new Date().toISOString() });
  }
  const { data: sec } = await sb.from("engine_secret").select("secret").single();
  if (!secret || !sec || secret !== sec.secret) return new Response("Forbidden", { status: 403 });

  let body: { action?: string; strategy_id?: string; backtest_id?: number; user_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = body.action ?? "tick";
  // Coins from crypto_assets join the asset list (lab, backtests and live trading).
  await loadCryptoAssets(sb).catch((e) => console.error("crypto assets", e));

  if (action === "backtest") {
    if (!body.backtest_id) return Response.json({ error: "backtest_id missing" }, { status: 400 });
    // When a run ends, the next waiting backtest (queued by users or the marketplace) starts.
    EdgeRuntime.waitUntil(runBacktestJob(Number(body.backtest_id)).finally(async () => { await sb.rpc("kick_backtests"); }));
    return Response.json({ accepted: true });
  }

  // Option-pricing queue: one instalment per call (the schedule paces it), only while no lab run is going.
  if (action === "push") return Response.json({ action, ...(await pushOut()) });
  if (action === "live_test" && body.strategy_id) return Response.json({ action, ...(await liveTest(String(body.strategy_id))) });
  if (action === "orders") return Response.json({ action, ...(await runOrders(Math.min(4, Math.max(1, Number(body.passes) || 4)))) });
  if (action === "reconcile") { const { data: hol } = await sb.from("market_holidays").select("day, exch, opens_at").eq("day", ist(Date.now() / 1000).date); setHolidays(hol ?? []); }
  if (action === "reconcile") return Response.json({ action, ...(await reconcile()) });
  if (action === "audit") {
    const b = body as { batch?: string; offset?: number };
    const batch = b.batch || `${ist(Date.now() / 1000).date}-${Date.now().toString(36)}`;
    EdgeRuntime.waitUntil(runAudit(batch, Number(b.offset) || 0).catch((e) => console.error("audit", e)));
    return Response.json({ action, accepted: true, batch });
  }
  if (action === "lab_reverdict") return Response.json({ action, ...(await labReverdict(sb, Math.min(300, Number((body as any).limit) || 120), !!(body as any).short)) });
  if (action === "marks" && body.user_id) return Response.json({ action, marks: await liveMarks(body.user_id, false) });
  if (action === "lab_opt") {
    EdgeRuntime.waitUntil((async () => {
      const creds = credsOf(await adminAccount(sb));
      await labOptStep({ sb, creds, started: Date.now(), chain: async () => {} });
    })().catch((e) => console.error("lab_opt", e)));
    return Response.json({ action, accepted: true });
  }
  if (action === "lab_next") {
    const id = await labNext(sb);
    if (id) EdgeRuntime.waitUntil(labLoop().catch((e) => console.error("lab", e)));
    return Response.json({ action, started: id });
  }
  if (action === "lab_start" || action === "lab_start_manual" || action === "lab_start_focus" || action === "lab") {
    if (action !== "lab") {
      const id = action === "lab_start_focus" ? await labStart(sb, true, "focus") : await labStart(sb, action === "lab_start_manual");
      if (!id) return Response.json({ action, started: false, reason: "The lab is switched off." });
    }
    EdgeRuntime.waitUntil(labLoop().catch((e) => console.error("lab", e)));
    return Response.json({ action, accepted: true });
  }

  if (action === "delta_check") {
    if (!body.user_id) return Response.json({ error: "user_id missing" }, { status: 400 });
    return Response.json({ action, ...(await deltaCheck(body.user_id)) });
  }
  if (action === "crypto_sync") return Response.json({ action, ...(await cryptoSync()) });
  if (action === "crypto_candles" || action === "crypto_rebuild") {
    // The lab's candle cache for every coin (the lab also does this at the start of each run), in the background.
    // crypto_rebuild first clears the coins' cached candles (after a change of history source or cutover day).
    const keys = Object.values(LAB_ASSETS).filter((x) => x.crypto).map((x) => x.key);
    const today = ist(Date.now() / 1000).date;
    if (action === "crypto_rebuild" && keys.length) await sb.from("lab_candles").delete().in("asset", keys);
    EdgeRuntime.waitUntil((async () => {
      for (const k of keys) {
        const t0 = Date.now();
        try { await refreshAsset(sb, { client: "-", token: "-" }, k, today); console.log("crypto candles", k, Date.now() - t0, "ms"); }
        catch (e) { console.error("crypto candles", k, e); }
      }
      await refreshCryptoMargins(sb, keys);
    })());
    return Response.json({ action, coins: keys });
  }
  if (action === "token" || action === "token_renew") return Response.json({ action, ...(await tokenCheck(action === "token_renew", body.user_id)) });
  if (action === "funds") {
    if (body.user_id) return Response.json({ action, ...(await refreshFunds(body.user_id)) });
    const admin = await adminAccount(sb);
    return Response.json({ action, ...(admin ? await refreshFunds(admin.user_id) : { ok: false }) });
  }
  if (action === "sync") {
    if (!body.user_id) return Response.json({ error: "user_id missing" }, { status: 400 });
    return Response.json({ action, ...(await syncUser(sb, body.user_id, false)) });
  }
  if (action === "billing_day") return Response.json({ action, ...(await billingDay(sb)) });
  if (action === "margins") {
    const admin = await adminAccount(sb);
    const { data: ls } = await sb.from("lab_settings").select("assets").eq("id", 1).maybeSingle();
    // The lab's assets plus every asset a strategy trades, checked each morning before the market opens.
    const { data: strats } = await sb.from("algo_strategies").select("underlying").eq("archived", false);
    const keys: string[] = [...new Set([...(ls?.assets ?? []), ...(strats ?? []).map((x) => String(x.underlying))])].filter((k: string) => LAB_ASSETS[k] && !LAB_ASSETS[k].crypto);
    await cryptoSync().catch(() => null); // Delta's contract details, once a day
    const n = await refreshMargins(sb, credsOf(admin), keys.map((k) => LAB_ASSETS[k]));
    return Response.json({ action, priced: n, of: keys.length });
  }

  if (!["tick", "tick_crypto", "refresh", "flatten", "sync_instruments"].includes(action)) return Response.json({ error: `Unknown action ${action}` }, { status: 400 });
  const nowIst = ist(Date.now() / 1000);
  // Exchange holidays today (no session, or MCX's evening session only).
  { const { data: hol } = await sb.from("market_holidays").select("day, exch, opens_at").eq("day", nowIst.date); setHolidays(hol ?? []); }
  // Crypto trades every day: its own minute tick (tick_crypto) runs round the clock, the market tick on weekdays.
  const cryptoTick = action === "tick_crypto";
  if (action === "tick" && (nowIst.wd === 0 || nowIst.wd === 6)) return Response.json({ skipped: "weekend" });

  if (action === "sync_instruments") {
    const c = credsOf(await adminAccount(sb));
    const n = await syncMcx(sb, c.client, c.token);
    const fno = await syncFno(sb, c).catch((e) => `F&O list failed: ${e instanceof Error ? e.message : e}`);
    return Response.json({ action, contracts: n, fno });
  }
  let q = sb.from("algo_strategies").select("*");
  q = body.strategy_id ? q.eq("id", body.strategy_id) : q.eq("active", true).eq("is_master", false);
  const { data: rows0, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  // Bought strategies run on their publisher's rules.
  const strategies = await withMasters(sb, rows0 ?? []);

  const accounts = new Map<string, Account | null>();
  const gates = new Map<string, unknown>();
  const fundsDone = new Set<string>();
  const liveIds = new Map<string, string[]>();
  const results: Record<string, string> = {};
  // Market data fetched during this tick is shared between strategies (one request per asset and timeframe), and
  // last prices are fetched in batches.
  const tickMode = action === "tick" || cryptoTick;
  if (tickMode) { Dhan.memo = new Map(); Dhan.ltpSeed = new Map(); tickT0 = Math.floor(Date.now() / 60000) * 60000; }
  const runOne = async (row: Strategy) => {
    let s = row;
    try {
      const isCr = isCrypto(String(s.data_segment));
      if (action === "tick" && isCr) return; // crypto runs on tick_crypto
      if (cryptoTick && !isCr) return;
      const tick = action === "tick" || cryptoTick;
      // Each market has its own hours (NSE/BSE 09:15–15:30, MCX 09:00–23:30/23:55, crypto 05:30–24:00); ticks outside
      // them are skipped (a crypto position's stop is still watched).
      const sess = tradingSession(s.data_segment, nowIst.date); // holidays: no session, or the evening session only
      const outside = nowIst.min < sess.open || nowIst.min > sess.close + 5;
      if (action === "tick" && outside) return;
      if (!s.owner_id) throw new Error("This strategy has no owner.");
      const broker = isCr ? "DELTA" : "DHAN";
      let set = await accountFor(sb, s.owner_id, broker, accounts);
      if (isCr) {
        // Paper trading on crypto needs no account (prices are public); live trading needs the Delta API key.
        if (s.live && !(set?.dhan_client_id && set?.dhan_access_token)) throw new Error("Add your Delta Exchange API key and secret (Delta Exchange connection) to trade this strategy live.");
        set = set ?? { user_id: s.owner_id, broker: "DELTA", dhan_client_id: null, dhan_access_token: null, webhook_url: null, webhook_secret: null, capital: null, capital_since: null, deploy_pct: null, funds_at: null };
        if (cryptoTick && outside) {
          s = await liveRisk(s, set);
          if (s.live) s = await syncStop(s, set).catch(() => s);
          s = await markPrice(s, set).catch(() => s);
          results[s.id] = "ok (outside the crypto session: stops only)";
          return;
        }
      } else if (!set?.dhan_access_token) throw new Error("Connect your Dhan account (client ID and access token) to run this strategy.");
      if (!set) throw new Error("No broker account.");
      // Dhan funds, every 10 minutes while the market ticks run.
      if (action === "tick" && !fundsDone.has(set.user_id) && (!set.funds_at || Date.now() - Date.parse(set.funds_at) > 600000)) {
        fundsDone.add(set.user_id); await refreshFunds(set.user_id).catch(() => {});
      }
      if (isCommodity(String(s.data_segment))) {
        const r = await dataSecurity(sb, credsOf(set), s.data_segment, String(s.data_security_id), nowIst.date);
        s = { ...s, data_security_id: r.sec };
      }
      // A live strategy whose orders are still being worked waits for them (the order manager finishes them first).
      if (s.live && s.exec_state === "working" && action !== "refresh") {
        if (action === "flatten") throw new Error("Orders for this strategy are still being worked at the broker. Try again in a minute.");
        results[s.id] = "orders working"; return;
      }
      // New trades need the account in good standing; exits always go through.
      s = { ...s, _block: await entryGate(sb, s, gates).catch(() => null) };
      if (tick) s = await liveRisk(s, set);
      if (tick && s.live) { const s0 = s; s = await actLocked(() => syncStop(s0, set)).catch((e) => { console.error("stop", e); return s0; }); }
      // A manual refresh outside market hours (or in the NSE/BSE pre-open) keeps the session's last price.
      if (tick || (action === "refresh" && !(outside && !isCr))) s = await markPrice(s, set).catch(() => s);
      if (s.live && action === "tick") liveIds.set(set.user_id, [...(liveIds.get(set.user_id) ?? []), s.id]);
      const act = cryptoTick ? "tick" : action;
      if (s.strategy_kind === "TIMED") await processTimed(s, set, act);
      else if (s.strategy_kind === "RULES") await processRules(s, set, act);
      else await processFlip(s, set, act);
      results[s.id] = "ok";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results[s.id] = msg;
      await sb.from("algo_strategies").update({ last_error: msg, last_run_at: new Date().toISOString() }).eq("id", s.id);
    }
  };
  // Up to 8 strategies at a time (Dhan's request pacing is shared, per account).
  const queue = [...strategies];
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => { for (let r = queue.shift(); r; r = queue.shift()) await runOne(r); }));
  if (tickMode) { Dhan.memo = null; Dhan.ltpSeed = null; tickT0 = null; }
  // Actual fill prices from each account's Dhan trade book for recent live orders.
  for (const [u, ids] of liveIds) { try { const a = accounts.get(`${u}|DHAN`); if (a) await brokerFills(a, ids); } catch (e) { console.error("fills", e); } }
  return Response.json({ action, results });
});
