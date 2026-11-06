// Supertrend Algo Portal engine.
// Actions: "tick" (pg_cron, every minute in market hours), "refresh" and "flatten" (portal),
// "backtest" (portal; runs in the background). Every call must carry the x-engine-secret header.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Dhan } from "./dhan.ts";
import { type ChargeRates, newAcc, planBacktest, priceBatch, summarize, tradeCharges, validateParams, type Acc, type Plan } from "./backtest.ts";
import { runSpreads } from "./spreads.ts";
import { fixedLotsFit, lotsFor, marginPerLot, moveLots, normaliseSizing } from "./sizing.ts";
import {
  addDays, aggregate, type DayBar, dayMinutes, fillTemplate, isCommodity, isComplete, isCrypto, isStockSeg, ist, nextExpiry, nextMonthlyExpiry, partialDay,
  pickBaseInterval, sessionFor, setHolidays, signalSeries, strikeFor, supertrend, timeToMin, tradingSession,
} from "./logic.ts";
import { dataSecurity, syncMcx } from "./instruments.ts";
import { decide, describeCond, ruleSets, RuleBook, ruleTimeframes, validateRules, warmBarsFor } from "./rules.ts";
import { atr as atrSeries } from "./indicators.ts";
import { effectiveStop, hasLevels, normaliseRisk, riskInit, riskScan, type RiskState } from "./risk.ts";
import { fromCol, LAB_ASSETS, labNext, labOptStep, labReverdict, labStart, labStep, loadCryptoAssets, pagedRows, refreshCryptoMargins, periodWindows, refreshAsset, TOKEN_ERR } from "./lab.ts";
import { runCombos } from "./combos.ts";
import { contractsFor, CRYPTO, cryptoDaily, cryptoDailyDelta, cryptoFunding, cryptoLtp, cryptoProduct, deltaBalances, deltaCancel, deltaOrderChecked, deltaOrderState, deltaPositions, deltaStop, deltaStopMove, niceLot } from "./crypto.ts";
import {
  brokerQty, type BrokerStatus, brokerStopTrigger, chaseDecision, type Creds, dhanByTag, dhanCancel, dhanLtp, dhanModify, dhanPlace, dhanPositions, dhanStatus,
  positionDiff, productOf, resolveLeg, setDhanRpc, type Side, sideOf, stepFor, stopLimit, syncFno, toTick,
} from "./execution.ts";
import { loadMarginRates, refreshDayMoves, refreshMargins } from "./margins.ts";
import { type Account, accountFor, adminAccount, credsOf, dataAccount, dataUid, entryGate, withMasters } from "./accounts.ts";
import { billingDay, matches as matchesRef, syncUser } from "./billing.ts";
import { legsFor, legSign, structMargin, structName, structOf } from "./structures.ts";
import { auditStrategy } from "./audit.ts";
import { ownDaily, ownIntraday } from "./owncandles.ts";
import { KILL_EARLY, KILL_FULL, killVerdict } from "./kill.ts";
import { ideasStep } from "./ideas.ts";
import { actionsFor, adjustPosition, daysOf, loadStockActions, splitFactor, STOCK_KEYS, stockLots } from "./stocks.ts";
import { readCandles } from "./candles.ts";
import { findListed, isListedOpt, optRows, pickListed } from "./listedopts.ts";
import { githubOidcOk, predFeed, predKeyOk, predPull, predPush } from "./prediction.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
setDhanRpc(sb); // Dhan order calls from the database's fixed IP address
Dhan.own = { intraday: (sec, seg, i, a, z) => ownIntraday(sb, sec, seg, i, a, z), daily: (sec, seg, a, z) => ownDaily(sb, sec, seg, a, z) };

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
  const d = new Dhan(set.dhan_client_id, set.dhan_access_token);
  d.useOwn = true; // Dhan refusing candle requests: stored history + own minute candles from the per-second prices
  return d;
}

async function saveChart(s: Strategy, bars: ChartBar[], st: number[], trend: number[]) {
  // Rewritten only when a bar closed (or every 5 minutes for the bar in progress): the same chart used to be written
  // every tick for every strategy (394 k rewrites of a 10 KB blob, 6 Nov 2026 audit).
  const lastT = bars.at(-1)?.t ?? 0, prev = chartLast.get(s.id);
  if (prev && prev.t === lastT && Date.now() - prev.at < 300000) return;
  chartLast.set(s.id, { t: lastT, at: Date.now() });
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
  // A stock / MCX option: the listed strike picked in sizeEntry (`_strike`, from Dhan's list); indices: price ± steps.
  const strike = Number((s as any)._strike) > 0 ? Number((s as any)._strike) : strikeFor(close, s.strike_step, s.strike_offset, optType);
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
  try {
    // Stocks and MCX (6 Nov 2026): the held contract's own last price (exact expiry, strike and type, never another).
    if (isListedOpt(s)) {
      const k = findListed(await optRows(sb, s, todayIst()), String(st.pos_expiry), Number(st.pos_strike), String(st.pos_option_type));
      return k ? await dhan.ltp(k.seg, k.sec_id) : null;
    }
    return await dhan.premium(s.data_security_id, s.data_segment, String(st.pos_expiry), Number(st.pos_strike), st.pos_option_type);
  } catch { return null; }
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
  // An option entry goes to an expiry Dhan really lists (4 Nov 2026): the date worked out from the expiry weekday can
  // miss a holiday-shifted or changed expiry day; the next listed one on or after it is used instead.
  if (opt && isListedOpt(s)) {
    // Options on a stock or an MCX commodity (6 Nov 2026): the next listed expiry and the listed strike nearest the price,
    // "strikes away" counted in listed strikes (Dhan's list, fno_contracts); never a contract Dhan doesn't list.
    if (multi) { notes.push("Entry skipped: option structures aren't available on stocks or MCX commodities yet; use a single option."); return false; }
    const type = String(newState.pos_option_type) as "CE" | "PE";
    const k = pickListed(await optRows(sb, s, todayIst()).catch(() => []), entryPx, Number(s.strike_offset) || 0, type, todayIst(), !!s.roll_on_expiry);
    if (!k) { notes.push(`Entry skipped: no ${s.underlying} ${type} options listed at Dhan.`); return false; }
    s = { ...s, expiry_override: k.expiry, _strike: k.strike } as Strategy;
    const lots0 = Number(newState.pos_lots) || (s.qty_mode === "LOTS" ? Number(newState.pos_qty) : Number(newState.pos_qty) / Number(s.lot_size)) || Number(s.lots);
    const ne = entryLeg(s, newState.position, entryPx, legs.length, lots0);
    legs.splice(legs.length - 1, 1, ...asArr(ne.leg));
    Object.assign(newState, ne.state);
    delete newState._px;
    const last = notes.length - 1;
    if (last >= 0) notes[last] = notes[last].replace(/(Buy|Sell) \S+ [\d.]+ (CE|PE) \([\d-]+\)/, `$1 ${s.dhan_symbol} ${k.strike} ${type} (${k.expiry})`);
  } else if (opt && !multi && newState.pos_expiry) {
    const list = await dhanFor(set).expiries(String(s.data_security_id), String(s.data_segment)).catch(() => null);
    const want = String(newState.pos_expiry);
    const e = list?.length && !list.includes(want) ? list.find((x) => x >= want) : null;
    if (e) {
      s = { ...s, expiry_override: e };
      const lots0 = Number(newState.pos_lots) || (s.qty_mode === "LOTS" ? Number(newState.pos_qty) : Number(newState.pos_qty) / Number(s.lot_size)) || Number(s.lots);
      const ne = entryLeg(s, newState.position, entryPx, legs.length, lots0);
      legs.splice(legs.length - 1, 1, ...asArr(ne.leg));
      Object.assign(newState, ne.state);
      delete newState._px;
      const last = notes.length - 1;
      if (last >= 0) notes[last] = notes[last].replace(`(${want})`, `(${e})`);
      notes.push(`Expiry ${want} isn't listed at Dhan: ${e} used`);
    }
  }
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
  } else if (s.sizing?.mode === "MOVE" && !multi && !opt) {
    // Same ₹ on a typical day (Papa, 4 Nov 2026): the lots follow the asset's typical day's move at every new entry
    // (changes of 20% or less ignored); the new lots are saved so the pages show them.
    const { data: mr } = await sb.from("lab_margins").select("day_move").eq("asset", String(s.underlying)).maybeSingle();
    const dm = Number(mr?.day_move) || 0, perLot = entryPx * Number(s.lot_size) * dm;
    const mv = moveLots(lots, Number(s.sizing.move_amt) || 0, perLot);
    if (!dm) notes.push("Size: no typical day's move stored for this asset yet; the saved lots are used");
    else if (mv.lots < 1) { notes.push(`Entry skipped: one lot moves ₹${Math.trunc(perLot).toLocaleString("en-IN")} on a typical day, far more than the ₹${Math.trunc(Number(s.sizing.move_amt)).toLocaleString("en-IN")} target.`); return false; }
    else if (mv.why) {
      lots = mv.lots;
      await sb.from("algo_strategies").update({ lots }).eq("id", s.id);
      const e = entryLeg(s, newState.position, entryPx, legs.length, lots);
      legs.splice(legs.length - 1, 1, ...asArr(e.leg));
      Object.assign(newState, e.state); delete newState._px;
      const last = notes.length - 1;
      if (last >= 0) notes[last] = notes[last].replace(/ x \d+$/, ` x ${e.state.pos_qty}`);
      notes.push(`Size: ${mv.why}`);
    }
    if (Number(set.capital ?? 0) > 0 && mLot > 0) {
      const cs = await capitalState(set, !!s.live, s.id);
      const fit = fixedLotsFit(lots, mLot, cs.equity, cs.used, Number(set.deploy_pct ?? 100), true);
      if (fit.lots < 1) { notes.push(`Entry skipped: ${fit.why}.`); return false; }
      if (fit.lots < lots) {
        lots = fit.lots;
        const e = entryLeg(s, newState.position, entryPx, legs.length, lots);
        legs.splice(legs.length - 1, 1, ...asArr(e.leg));
        Object.assign(newState, e.state); delete newState._px;
        notes.push(`Size: ${fit.why} ⇒ ${lots} lot${lots === 1 ? "" : "s"}`);
      }
    }
  } else if (Number(set.capital ?? 0) > 0 && mLot > 0) {
    // Fixed lots: still kept inside the account's "never use more than" limit (other open positions of this mode).
    const cs = await capitalState(set, !!s.live, s.id);
    const fit = fixedLotsFit(lots, mLot, cs.equity, cs.used, Number(set.deploy_pct ?? 100), true);
    if (fit.lots < 1) { notes.push(`Entry skipped: ${fit.why}.`); return false; }
    if (fit.lots < lots) {
      // Trade what fits (e.g. 36 of 40 lots) instead of skipping.
      lots = fit.lots;
      const e = entryLeg(s, newState.position, entryPx, legs.length - nLegs + 1, lots);
      legs.splice(legs.length - nLegs, nLegs, ...asArr(e.leg));
      Object.assign(newState, e.state, multi && mpx ? { pos_legs: (e.state.pos_legs as MLeg[]).map((l, i) => ({ ...l, px: +mpx![i].toFixed(2) })) } : {});
      const last = notes.length - 1;
      if (last >= 0) notes[last] = notes[last].replace(/ x \d+$/, ` x ${e.state.pos_qty}`);
      notes.push(`Size: ${fit.why} ⇒ ${lots} lot${lots === 1 ? "" : "s"}`);
    }
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
  if (!(inPx > 0) || !(Number(outPx) > 0)) {
    if (opt && inPx > 0) await alert(s, "Option exit not priced", `Dhan gave no price for ${s.dhan_symbol} ${s.pos_strike} ${s.pos_option_type} (${s.pos_expiry}) at the exit, so this trade isn't in the ledger yet. ${s.live ? "Its fill at Dhan is the real figure." : "Check the option's price for the day."}`, `optnopx-${s.id}-${todayIst()}`);
    return Number(outPx) > 0 ? outPx : null;
  }
  const units = unitsOf(s);
  const dir = opt ? (s.pos_option_side === "SELL" ? -1 : 1) : (s.position === "LONG" ? 1 : -1);
  const gross = (outPx! - inPx) * dir * units;
  const buyVal = (dir === 1 ? inPx : outPx!) * units, sellVal = (dir === 1 ? outPx! : inPx) * units;
  const costs = tradeCharges({ from: "", to: "", capital: 0, brokerage: 20, charges: ratesFor(s), near_code: 1 }, opt, buyVal, sellVal).total;
  const net = Math.trunc(gross - costs);
  const contract = opt ? `${s.pos_option_side === "SELL" ? "Sell " : ""}${s.dhan_symbol} ${s.pos_strike} ${s.pos_option_type} (${s.pos_expiry})` : `${s.futures_symbol} ${s.position === "LONG" ? "long" : "short"}`;
  const entryAt = s.pos_entry_date ? `${s.pos_entry_date}` : null;
  await must(() => sb.from("algo_trades").insert({
    strategy_id: s.id, user_id: s.owner_id ?? null, broker_ref: brokerRef(s), mode: s.live ? "LIVE" : "PAPER", entry_day: entryAt, exit_at: new Date().toISOString(), side: s.position, contract,
    lots: lotsOf(s), units, entry_px: +inPx.toFixed(2), exit_px: +outPx!.toFixed(2), gross: Math.trunc(gross), costs: Math.trunc(costs), net, exit_why: why.slice(0, 200), ...ledgerTag(s),
  }), "ledger row");
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
  await must(() => sb.from("algo_trades").insert({
    strategy_id: s.id, user_id: s.owner_id ?? null, broker_ref: brokerRef(s), mode: s.live ? "LIVE" : "PAPER", entry_day: s.pos_entry_date ?? null, exit_at: new Date().toISOString(), side: s.position,
    contract: `${structName(structOf(s)!)}: ${legs.map((l) => mlegText(s, l)).join(" · ")}`.slice(0, 300), lots: lotsOf(s), units,
    entry_px: +inNet.toFixed(2), exit_px: +outNet.toFixed(2), gross: Math.trunc(gross), costs: Math.trunc(costs), net, exit_why: why.slice(0, 200), ...ledgerTag(s),
  }), "ledger row (structure)");
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
  // The per-second price check and the minute tick can both see the same stop: whichever claims the position first
  // exits it; the other leaves it alone.
  const { data: claim } = await sb.from("algo_strategies").update({ exec_state: "stopping", exec_at: nowIso() }).eq("id", s.id).eq("position", s.position)
    .or(`exec_state.is.null,and(exec_state.eq.stopping,exec_at.lt.${new Date(Date.now() - 90000).toISOString()})`).select("id");
  if (!claim?.length) return s;
  try { return await riskExitNow(s, set, pr, hit, update); }
  finally { await sb.from("algo_strategies").update({ exec_state: null }).eq("id", s.id).eq("exec_state", "stopping"); }
}
async function riskExitNow(s: Strategy, set: Settings, pr: PosRisk, hit: { px: number; t: number; why: string }, update: Record<string, unknown>): Promise<Strategy> {
  const event = /Target/.test(hit.why) ? "TARGET" : /Trailing/.test(hit.why) ? "TRAIL_STOP" : "STOP_LOSS";
  const under = pr.basis === "PREMIUM" ? undefined : hit.px;
  const ok = await sendOrders(s, set, event, asArr(exitLeg(s, 1)), `${hit.why}${pr.basis === "PREMIUM" ? " (premium)" : ""}: ${exitLabel(s)}`, { t: hit.t, c: under });
  if (!ok) {
    await exitFailed(s, update, hit.why, "the stop-loss exit didn't go");
    await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "exit retry state");
    return { ...s, ...update };
  }
  const crFill = s.live && isCrypto(String(s.data_segment)) ? deltaFill.exit : null;
  const out = await bookPnl(s, set, update, crFill ?? under, hit.why, pr.basis === "PREMIUM" ? hit.px : undefined);
  await saveFills([fillOf(s, "Exit", out ?? (s.trade_type === "OPTIONS" ? null : hit.px))]);
  Object.assign(update, FLAT_STATE);
  await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "position after the stop");
  return { ...s, ...update };
}

async function sendOrders(s: Strategy, set: Settings, event: string, legs: Record<string, unknown>[], description: string, candle: Candle): Promise<boolean> {
  lastLiveBatch = null;
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
  // The webhook secret goes only to Dhan, never into the signal log the browser reads.
  await logSignal(s, event, description, candle, status, { alertType: payload.alertType, order_legs: payload.order_legs }, response);
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
          else {
            // The stop must really be gone before the exit goes — one filling after the exit opens a position the
            // other way (Dhan got this check on 4 Nov, Delta on 6 Nov 2026).
            try { await deltaCancel(sb, set.user_id, String(pb.symbol ?? pb.legs[0]?.sec), pb.stopId); }
            catch (e) {
              const again = await deltaOrderState(sb, set.user_id, pb.stopId).catch(() => null);
              if (again?.state === "closed" && again.unfilled === 0) { stopClosed = true; deltaFill.exit = again.avg; out.push(`already closed by the stop order at Delta${again.avg ? ` at ${again.avg}` : ""}`); }
              else if (again?.state !== "cancelled") {
                const msg = e instanceof Error ? e.message : String(e);
                await logSignal(s, event, description, candle, "FAILED", payload, `Couldn't cancel the stop order ${pb.stopId} at Delta Exchange (${msg.slice(0, 160)}); the exit waits for it.`);
                await alert(s, "Stop order couldn't be cancelled", `Before the exit the desk couldn't cancel the stop order at Delta Exchange (${msg.slice(0, 160)}). Nothing was sent; the desk tries again in a minute.`, `stopcancel-${s.id}`);
                return false;
              }
            }
          }
          await sb.from("live_orders").update({ state: stopClosed ? "filled" : "cancelled", avg_px: stopClosed ? st.avg : null, done_at: nowIso(), note: stopClosed ? "filled (desk exit came after)" : "cancelled before the desk's exit" })
            .eq("broker_order_id", pb.stopId).eq("state", "resting");
        } catch (e) { out.push(`stop order check failed: ${e instanceof Error ? e.message : e}`); }
      }
      status = "SENT";
      let opened: PosBroker | null = null;
      let partExit: { symbol: string; size: number; filled: number; avg: number; id: string } | null = null;
      // Delta holds one net position per coin: when another live strategy of the account holds the same coin (one long,
      // one short), a reduce-only exit would be refused (there may be nothing to reduce). Then the exit goes as a plain
      // order for this strategy's own part, after checking that part is really there (31 Oct 2026).
      const others = payload.orders.some((o) => o.reduce_only) ? await othersHolding(s) : new Map<string, number>();
      let held: Map<string, number> | null | undefined;
      for (const o of payload.orders) {
        if (o.reduce_only && stopClosed) continue;
        let reduceOnly = o.reduce_only;
        if (o.reduce_only) {
          const key = brokerKey("DELTA", String(o.symbol)), theirs = others.get(key) ?? 0;
          if (theirs) {
            if (held === undefined) held = await deltaPositions(sb, set.user_id).catch(() => null);
            // A coin Delta doesn't list is a net of 0; positions that couldn't be read count as this strategy's own.
            const want = o.side === "sell" ? 1 : -1, mine = held ? (held.get(key) ?? 0) - theirs : want * Number(o.size);
            if (held && Math.sign(mine) !== want) {
              out.push(`${o.side} ${o.size} ${o.symbol}: not sent, Delta's net ${held.get(key) ?? 0} less ${theirs} held by your other strategies leaves no ${want === 1 ? "long" : "short"} of this strategy`);
              await alert(s, "Exit not sent", `${o.symbol}: Delta's position after your other strategies' holdings shows nothing of this strategy to close. The desk is now flat; check your Delta positions.`);
              continue;
            }
            if (held && Math.abs(mine) < Number(o.size)) o.size = Math.abs(mine);
            reduceOnly = false;
          }
        }
        try {
          const st = await deltaOrderChecked(sb, set.user_id, { symbol: String(o.symbol), size: Number(o.size), side: o.side as "buy" | "sell", reduceOnly });
          const filled = st.size - st.unfilled;
          out.push(`${o.side} ${o.size} ${o.symbol}: order ${st.id || "?"} ${st.state}${st.avg ? ` filled at ${st.avg}` : ""}${st.unfilled ? `, ${st.unfilled} unfilled` : ""}`);
          if (o.reduce_only) { deltaFill.exit = st.avg ?? deltaFill.exit; if (filled > 0 && st.unfilled > 0) partExit = { symbol: String(o.symbol), size: Number(o.size), filled, avg: Number(st.avg) || 0, id: String(st.id ?? "") }; }
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
      // An exit that filled only in part (6 Nov 2026 audit): that part is booked at Delta's price and the position
      // shrinks to the rest, so the retry closes only what is still open instead of the whole quantity again.
      if (partExit && status === "FAILED" && partExit.avg > 0 && s.position !== "FLAT") {
        const perLot = contractsFor(partExit.symbol, Number(s.lot_size), 1) || 1;
        const upd = await bookPart(s, set, { seg: "DELTA", sec: partExit.symbol, lot: perLot, option: false, id: partExit.id }, partExit.filled, partExit.size, partExit.avg,
          `${description.split(" | ")[0]} — part closed at Delta before the rest failed`);
        await must(() => sb.from("algo_strategies").update(upd).eq("id", s.id), "part exit");
        Object.assign(s, upd); // the caller's retry works from the smaller position
        out.push(`${partExit.filled} of ${partExit.size} closed and booked; ${partExit.size - partExit.filled} still open`);
      }
      // The position as Delta holds it (read by the stop order and the 5-minute check); a closed one has none.
      if (opened || (payload.orders.some((o) => o.reduce_only) && !(partExit && status === "FAILED"))) await must(() => sb.from("algo_strategies").update({ pos_broker: opened }).eq("id", s.id), "Delta position record");
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
  const lead: Record<string, string> = { ENTRY: "Entry signal", EXIT: "Exit signal", REVERSE: "Reversal signal", SQUARE_OFF: "Square-off", ROLL: "Roll to the next month", INFO: "Update" };
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
    px: px != null && Number(px) > 0 ? +Number(px).toFixed(4) : null, basis: opt ? "premium" : cr ? "Delta perpetual" : isCommodity(String(st.data_segment)) ? "futures" : isStockSeg(String(st.data_segment)) ? "share price" : "index" };
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
  if (!(Number(px) > 0)) {
    // An option without a price for 10 minutes: its premium stop can't run either (never priced from another expiry).
    if (opt && (!s.pos_ltp_at || Date.now() - Date.parse(s.pos_ltp_at) > 600000) && inSessionNow(String(s.data_segment)))
      await alert(s, "Option not priced", `Dhan gives no price for ${s.dhan_symbol} ${s.pos_strike} ${s.pos_option_type} (${s.pos_expiry}) at the moment, so its running P&L and any premium stop wait. The desk keeps asking every minute.`, `optmark-${s.id}-${todayIst()}`);
    return s;
  }
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
  if (Dhan.ownUsed.has(`${s.data_segment}|${s.data_security_id}`)) description += " · on the desk's own candles (Dhan's candle data was unavailable)";
  lastSignalId = null;
  const row = {
    strategy_id: s.id, event, description, mode: s.live ? "LIVE" : "PAPER", status, payload, response, lag_ms: tickT0 ? Date.now() - tickT0 : null,
    candle_time: candle.t ? new Date(candle.t * 1000).toISOString() : null,
    trend: candle.trend ?? null, close: candle.c ?? null, supertrend: candle.st ?? null,
  };
  // The signal claimed for this candle before its orders went out (claimSignal) is filled in, not logged a second time.
  const cl = claimed;
  claimed = null;
  if (cl && cl.sid === s.id) {
    await sb.from("algo_signals").update(row).eq("id", cl.id);
    lastSignalId = cl.id;
    return;
  }
  const { data: ins } = await sb.from("algo_signals").insert(row).select("id").single();
  lastSignalId = ins?.id ?? null;
}
/**
 * One decision per candle (open item from the 23 Oct outage; 4 Nov 2026): before a signal's orders go out, its row is
 * written first. The database allows one row of an event per strategy, candle and mode (migration 66), so when a slow
 * position update lets a second run see the same candle again, its claim fails and it sends nothing, books nothing and
 * changes nothing. Returns false for such a repeat.
 */
let claimed: { id: number; sid: string } | null = null;
async function claimSignal(s: Strategy, event: string, candle: Candle): Promise<boolean> {
  claimed = null;
  if (!candle.t) return true;
  const { data, error } = await sb.from("algo_signals").insert({
    strategy_id: s.id, event, description: "sending…", mode: s.live ? "LIVE" : "PAPER", status: "PENDING", candle_time: new Date(candle.t * 1000).toISOString(),
    close: candle.c ?? null, lag_ms: tickT0 ? Date.now() - tickT0 : null,
  }).select("id").single();
  if (error) {
    if (String((error as { code?: string }).code) === "23505" || /duplicate key|once_per_candle/i.test(error.message)) {
      // A claim left behind by a worker that died between claiming and sending (CPU limit, a restart) must not block
      // this candle for good — for a square-off the candle is the same every minute (6 Nov 2026 audit): after two
      // minutes a claim still "sending" is taken over.
      const { data: old } = await sb.from("algo_signals").select("id, status, created_at").eq("strategy_id", s.id).eq("event", event).eq("mode", s.live ? "LIVE" : "PAPER")
        .eq("candle_time", new Date(candle.t * 1000).toISOString()).maybeSingle();
      if (old?.status === "PENDING" && Date.now() - Date.parse(old.created_at) > 120000) {
        const { data: took } = await sb.from("algo_signals").update({ description: "sending… (taken over from a run that never finished)", created_at: nowIso() }).eq("id", old.id).eq("status", "PENDING").select("id");
        if (took?.length) { claimed = { id: Number(old.id), sid: s.id }; return true; }
      }
      return false;
    }
    return true; // any other trouble writing the log must not stop a real exit or entry
  }
  claimed = { id: Number(data!.id), sid: s.id };
  return true;
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
/**
 * A database write on the order / position path has to succeed (6 Nov 2026 audit): one that failed quietly left the
 * desk's record and the broker apart (a stop order placed twice, a position re-entered, a ledger row missing). Tried
 * three times; then it throws, which the caller turns into last_error, the breaker and an alert.
 */
async function must<T extends { error: { message: string } | null }>(write: () => PromiseLike<T>, what: string): Promise<T> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    const r = await write();
    if (!r.error) return r;
    last = r.error.message;
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  throw new Error(`Database write failed (${what}): ${last}`);
}
/** The engine calling itself for the next instalment of a long job (audit, kill rule, ideas, lab). */
async function selfCall(body: Record<string, unknown>) {
  const { data: sec } = await sb.from("engine_secret").select("secret").single();
  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/engine`, { method: "POST", headers: { "Content-Type": "application/json", "x-engine-secret": sec!.secret }, body: JSON.stringify(body) });
}
/** Start of the current tick, rounded down to the minute (when the candles closed); for the decision delay. */
let tickT0: number | null = null;
const flatten = (s: Strategy, set: Settings, update: Record<string, unknown>, candle: Candle, why = "Manual exit", event = "FLATTEN") => actLocked(() => flattenNow(s, set, update, candle, why, event));
async function flattenNow(s: Strategy, set: Settings, update: Record<string, unknown>, candle: Candle, why = "Manual exit", event = "FLATTEN") {
  if (s.position === "FLAT") return;
  const ok = await sendOrders(s, set, event, asArr(exitLeg(s, 1)), `${why}: ${exitLabel(s)}`, candle);
  if (ok) {
    const out = await bookPnl(s, set, update, (s.live && isCrypto(String(s.data_segment)) ? deltaFill.exit : null) ?? candle.c, why);
    await saveFills([fillOf(s, "Exit", out)]);
    Object.assign(update, FLAT_STATE);
    if (s.exec_state === "exit_retry" && (!s.live || isCrypto(String(s.data_segment)))) Object.assign(update, { exec_state: null, last_error: null });
    else if (s.exec_state === "exit_retry") update.last_error = null;
  } else await exitFailed(s, update, why, "the exit order didn't go");
}

const finish = (s: Strategy, set: Settings, update: Record<string, unknown>, legs: Record<string, unknown>[], event: string, notes: string[], newState: Record<string, unknown>, candle: Candle, atrNow = 0) =>
  actLocked(() => finishNow(s, set, update, legs, event, notes, newState, candle, atrNow));
async function finishNow(s: Strategy, set: Settings, update: Record<string, unknown>, legs: Record<string, unknown>[], event: string, notes: string[], newState: Record<string, unknown>, candle: Candle, atrNow = 0) {
  if (legs.length) {
    // The position may have changed since this tick read the row (the per-second stop watcher exits under this same
    // lock, a partly filled entry shrinks it): decide on what the row says now, not on a copy up to a minute old
    // (6 Nov 2026 audit — the old copy booked a second exit or re-entered on top of a position already closed).
    const { data: cur } = await sb.from("algo_strategies").select("position, exec_state, pos_qty, pos_lots, pos_broker, pos_entry_px, pos_entry_prem, pos_risk, pos_legs, pos_margin, day_pnl, day_pnl_date").eq("id", s.id).maybeSingle();
    if (cur && (cur.position !== s.position || (cur.exec_state && cur.exec_state !== s.exec_state))) {
      await logSignal(s, "INFO", `Skipped: the position changed while this candle was being worked (now ${cur.position}${cur.exec_state ? `, ${cur.exec_state}` : ""}); nothing sent for ${event}.`, candle);
      await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "indicator state");
      return;
    }
    if (cur) s = { ...s, ...cur };
    const entryPx = newState._px as number | undefined;
    delete newState._px;
    const entering = (newState.position === "LONG" || newState.position === "SHORT") && entryPx !== undefined;
    const exiting = s.position !== "FLAT" && ["EXIT", "REVERSE", "SQUARE_OFF"].includes(event);
    if (entering && s._block) notes.push(`Entry skipped: ${s._block}`);
    if (entering && (s._block || !(await sizeEntry(s, set, legs, newState, entryPx!, notes)))) {
      // Not enough capital: drop the entry; an exit in the same signal still goes out.
      legs.pop();
      if (!legs.length) { await logSignal(s, "INFO", notes.join(" | "), candle); await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "indicator state"); return; }
      newState = { ...FLAT_STATE }; event = "EXIT";
    } else if (entering) await armRisk(s, set, newState, entryPx!, atrNow, notes);
    // A second run that sees the same candle again (a slow position update) sends nothing and changes nothing.
    if (!(await claimSignal(s, event, candle))) { console.warn(`signal for ${s.id} at ${candle.t} already handled`); return; }
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
    else if (exiting) await exitFailed(s, update, notes[0] ?? event, "the exit order didn't go");
    else Object.assign(update, { last_error: `Order failed to send, so the strategy was paused. Check the log and your ${isCrypto(String(s.data_segment)) ? "Delta Exchange" : "Dhan"} positions.`, active: false });
  } else if (event === "INFO") {
    await logSignal(s, event, notes.join(" "), candle);
  }
  await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), legs.length ? "position after the signal" : "strategy state");
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
  const days = await dailyBefore(dhan, s, Math.ceil(warmBarsFor(rules) * 1.5), now.date);
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
  for (const r of rows ?? []) {
    out[r.user_id] = await tokenCheckOne(force, r).catch((e) => ({ renewed: false, reason: String(e) }));
    await dataPlanCheck(r.id).catch((e) => console.error("data plan", e));
  }
  if (!userId) await tickerRefresh(true).catch((e) => console.error("ticker", e)); // assets added since the morning
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
/** The Desk's quotes strip (Papa, 6 Nov 2026): Nifty 50, Sensex, Bank Nifty, Fin Nifty and Midcap Nifty always, plus every asset an active
 *  strategy trades. Each instrument's previous close (from the lab's stored daily candles, else Dhan's / Delta's) goes into
 *  ticker_ref; the page divides the live price (live_prices) by it for today's %. `missing`: only instruments not yet
 *  done today. The per-second prices also fetch these indices (`TICKER_FIXED`). */
export const TICKER_FIXED = [{ seg: "IDX_I", sec: "13", asset: "NIFTY" }, { seg: "IDX_I", sec: "51", asset: "SENSEX" }, { seg: "IDX_I", sec: "25", asset: "BANKNIFTY" },
  { seg: "IDX_I", sec: "27", asset: "FINNIFTY" }, { seg: "IDX_I", sec: "442", asset: "MIDCPNIFTY" }]; // Fin Nifty and Bank Nifty: Papa, 6 Nov
/** Every tradable asset in the quotes strip (Papa, 6 Nov 2026: "add the new assets"): all indices, all stocks, every coin,
 *  and one quote per MCX commodity (the big contract; its mini moves with it). */
export const TICKER_MCX = ["GOLD", "SILVER", "CRUDEOIL", "NATURALGAS", "COPPER", "ZINC", "LEAD", "ALUMINIUM", "NICKEL"];
const tickerWatch = () => Object.values(LAB_ASSETS).filter((a) => !a.commodity || TICKER_MCX.includes(a.key))
  .map((a) => ({ seg: a.seg, sec: a.sec, asset: a.key, instr: a.instr }));
async function tickerRefresh(missing: boolean) {
  const today = todayIst(), adm = await adminAccount(sb), creds = credsOf(adm);
  const { data: rows } = await sb.from("algo_strategies").select("underlying, data_segment, data_security_id, data_instrument").eq("archived", false).eq("active", true).eq("is_master", false);
  const items = new Map<string, { seg: string; sec: string; asset: string; instr: string }>();
  for (const f of TICKER_FIXED) items.set(`${f.seg}|${f.sec}`, { ...f, instr: "INDEX" });
  for (const w of tickerWatch()) {
    let sec = w.sec;
    if (isCommodity(w.seg) && !/^\d+$/.test(sec)) sec = (await dataSecurity(sb, creds, w.seg, sec, today).catch(() => ({ sec: "" }))).sec;
    if (sec && !items.has(`${w.seg}|${sec}`)) items.set(`${w.seg}|${sec}`, { ...w, sec });
  }
  for (const r of rows ?? []) {
    const seg = String(r.data_segment); let sec = String(r.data_security_id);
    if (isCommodity(seg) && !/^\d+$/.test(sec)) sec = (await dataSecurity(sb, creds, seg, sec, today).catch(() => ({ sec: "" }))).sec;
    if (sec && !items.has(`${seg}|${sec}`)) items.set(`${seg}|${sec}`, { seg, sec, asset: String(r.underlying), instr: String(r.data_instrument || "") });
  }
  let done: Set<string> = new Set();
  if (missing) { const { data: have } = await sb.from("ticker_ref").select("seg, sec").eq("ref_day", today); done = new Set((have ?? []).map((x) => `${x.seg}|${x.sec}`)); }
  const prevMemo = new Map<string, number | null>();
  const prevOf = async (it: { seg: string; sec: string; asset: string; instr: string }) => {
    if (prevMemo.has(it.asset)) return prevMemo.get(it.asset)!;
    let pc: number | null = null;
    try {
      const [d] = await readCandles(sb, it.asset, ["D"]);
      const t = d?.bars?.t ?? [], c = d?.bars?.c ?? [];
      for (let j = t.length - 1; j >= 0; j--) if (ist(Number(t[j])).date < today && Number(c[j]) > 0) { pc = Number(c[j]); break; }
    } catch { /* not a lab asset */ }
    if (pc == null) try {
      const bars = isCrypto(it.seg) ? await cryptoDailyDelta(it.sec, addDays(today, -10), today)
        : await dhanFor(adm!).daily(it.sec, it.seg, it.instr || (it.seg === "IDX_I" ? "INDEX" : isCommodity(it.seg) ? "FUTCOM" : "EQUITY"), addDays(today, -10), today);
      const prev = bars.filter((b) => b.day < today).at(-1); pc = prev ? Number(prev.c) : null;
    } catch { pc = null; }
    prevMemo.set(it.asset, pc); return pc;
  };
  let n = 0;
  for (const [k, it] of items) {
    if (done.has(k)) continue;
    const pc = await prevOf(it);
    await sb.from("ticker_ref").upsert({ seg: it.seg, sec: it.sec, asset: it.asset, prev_close: pc, ref_day: today, at: new Date().toISOString() }); n++;
  }
  return n;
}
/** Warnings before the Dhan Data API plan ends (Papa, 6 Nov 2026): days left at which the owner is told. */
export const DATA_WARN_DAYS = [7, 5, 3, 1];
/** Which warning is due: "off" while Dhan reports the plan inactive, else the smallest step of DATA_WARN_DAYS the days
 *  left have reached (null when none); `warned` (the last one sent for this validity) stops repeats. */
export function dataWarnDue(plan: string | null, validity: string | null, today: string, warned: string | null): { key: string; days: number | null } | null {
  if (plan && !/^active$/i.test(plan)) return warned === "off" ? null : { key: "off", days: null };
  if (!validity) return null;
  const days = Math.round((Date.parse(validity) - Date.parse(today)) / 86400000);
  const step = [...DATA_WARN_DAYS].sort((a, b) => a - b).find((d) => days <= d);
  if (step == null) return null;
  const [wv, wd] = String(warned ?? "").split("|");
  if (wv === validity && Number(wd) <= step) return null;
  return { key: `${validity}|${step}`, days: Math.max(0, days) };
}
async function dataPlanCheck(id: number) {
  const { data: a } = await sb.from("broker_accounts").select("id, user_id, client_id, access_token, data_warned").eq("id", id).maybeSingle();
  if (!a?.access_token || !a.client_id) return;
  const r = await fetch("https://api.dhan.co/v2/profile", { headers: { "access-token": a.access_token, "client-id": a.client_id, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return;
  const j = await r.json().catch(() => null);
  if (!j || typeof j.dataPlan !== "string") return;
  const m = String(j.dataValidity ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  const validity = m ? m[0] : null;
  const due = dataWarnDue(j.dataPlan, validity, todayIst(), a.data_warned);
  // Back to active on a new validity: the warning record restarts for it.
  const warned = due ? due.key : (a.data_warned === "off" && /^active$/i.test(j.dataPlan) ? null : a.data_warned);
  await sb.from("broker_accounts").update({ data_plan: j.dataPlan, data_valid_until: validity, data_checked_at: new Date().toISOString(), data_warned: warned }).eq("id", a.id);
  if (!due) return;
  const fmt = validity ? new Date(validity + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
  const where = "Renew it on web.dhan.co → My Profile → DhanHQ Trading APIs → Data APIs.";
  const title = due.key === "off" ? "Dhan Data API plan is inactive" : due.days! <= 1 ? `Dhan Data API plan ends ${due.days === 0 ? "today" : "tomorrow"} (${fmt})` : `Dhan Data API plan ends in ${due.days} days (${fmt})`;
  const body = due.key === "off"
    ? `Dhan reports your Data API plan as inactive: prices and candles are refused, so market strategies can't run (crypto is not affected). ${where}`
    : `Without it, prices and candles stop and market strategies can't run. ${where}`;
  await sb.from("notifications").insert({ user_id: a.user_id, kind: "error", url: "/?conn=1", title, body });
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
/**
 * Kill rule (daily, with the self-check): every running lab strategy's own trades against its backtest's. Far below the
 * normal range (under the worst 1% after 10 trades, the worst 5% after 20), new trades stop and the owner is told.
 * After "Allow new trades again" it is judged only on the trades made since.
 */
async function killCheck(offset = 0, perCall = 3) {
  // Three strategies per call (each reads a whole backtest trade list), the rest chain on — a single call used to read
  // every one before the self-check wrote its first row, and the 2-second CPU limit killed both (6 Nov 2026 audit).
  const { data: all } = await sb.from("algo_strategies").select("id, owner_id, name, lab_id, lots, kill_at, kill_override_trades").eq("active", true).eq("archived", false).not("lab_id", "is", null).is("kill_at", null).order("id");
  const rows = (all ?? []).slice(offset, offset + perCall);
  if ((all ?? []).length > offset + perCall) await selfCall({ action: "kill", offset: offset + perCall });
  for (const s of rows) {
    const { data: lr } = await sb.from("lab_results").select("config, trades_long").eq("id", s.lab_id).maybeSingle();
    const bt = ((lr?.trades_long?.n ?? []) as number[]).map(Number), btLots = Number(lr?.config?.lots) || 1;
    const { data: tr } = await sb.from("algo_trades").select("net, lots, exit_at").eq("strategy_id", s.id).eq("hidden", false).order("exit_at");
    const desk = (tr ?? []).slice(Number(s.kill_override_trades) || 0).map((t) => Number(t.net) / (Number(t.lots) || 1));
    const v = killVerdict(desk, bt.map((x) => x / btLots), Number(s.lab_id));
    if (!v.flag) continue;
    const rule = v.n >= KILL_FULL.trades ? `worst ${KILL_FULL.pct * 100}%` : `worst ${KILL_EARLY.pct * 100}%`;
    const amt = (x: number) => x < 0 ? `a loss of ₹${Math.abs(x).toLocaleString("en-IN")}` : `₹${x.toLocaleString("en-IN")}`;
    const note = `its last ${v.n} trades made ${amt(v.real)} per lot, below the ${rule} of what its backtest gives for ${v.n} trades (${amt(Number(v.n >= KILL_FULL.trades ? v.p5 : v.p1))})`;
    await sb.from("algo_strategies").update({ kill_at: new Date().toISOString(), kill_note: note }).eq("id", s.id).is("kill_at", null);
    await sb.rpc("notify_tagged", { p_user: s.owner_id, p_kind: "error", p_title: `Kill rule: new trades stopped · ${String(s.name ?? "").slice(0, 50)}`,
      p_body: `Far worse than its backtest: ${note}. Open positions are still managed. Allow new trades again from the strategy page if you want it to carry on.`.slice(0, 400),
      p_url: `/?s=${s.id}`, p_strategy: s.id, p_tag: `kill-${s.id}` });
  }
}
async function runAudit(batch: string, offset: number) {
  const today = ist(Date.now() / 1000).date, days = 30;
  const { data: tr } = await sb.from("algo_trades").select("strategy_id, mode").eq("hidden", false).gte("entry_day", addDays(today, -days));
  // Also every running strategy without trades in the window (checked for trades the desk should have taken).
  const { data: run } = await sb.from("algo_strategies").select("id, live").eq("active", true).eq("archived", false).eq("strategy_kind", "RULES");
  const traded = new Set((tr ?? []).map((t) => t.strategy_id));
  const pairs = [...new Set([...(tr ?? []).map((t) => `${t.strategy_id}|${t.mode}`),
    ...(run ?? []).filter((r) => !traded.has(r.id)).map((r) => `${r.id}|${r.live ? "LIVE" : "PAPER"}`)])].sort();
  const creds = credsOf(await adminAccount(sb));
  const t0 = Date.now();
  let i = offset;
  // One strategy per call: a replay is a cold gunzip + parse of years of candles, close to the CPU limit by itself.
  for (; i < pairs.length && (i === offset || Date.now() - t0 < 20000) && i < offset + 1; i++) {
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
    await selfCall({ action: "audit", batch, offset: i });
    return { batch, done: i, of: pairs.length };
  }
  // All replayed: the kill rule runs after, in its own calls.
  await selfCall({ action: "kill", offset: 0 }).catch((e) => console.error("kill", e));
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
/**
 * Prices every second (cron "live-prices"): one batched quote request per account for every running strategy's
 * instrument and every live order being worked, plus Delta's tickers for crypto. The prices go to live_prices (the
 * minute tick and the order manager read them from there instead of asking Dhan again) and the running P&L of each
 * open futures / crypto position to live_marks, which the app receives through Realtime.
 */
let priceHolDay = "";
const mcxSecMemo = new Map<string, string>();
const rowWriteAt = new Map<string, number>();
let lastMarkAt = "";
/**
 * One engine run per minute (cron) that prices every second until the next run takes over. A lock row keeps a
 * single loop going; the strategy list is re-read every 5 seconds (positions change), prices every second.
 */
const PRICE_COLS = "id, owner_id, data_segment, data_security_id, position, trade_type, structure, pos_entry_px, pos_risk, pos_qty, qty_mode, lot_size, pos_ltp_at, active, archived, ca_day";
async function pricesLoop() {
  // A fresh engine run every 10 seconds (cron) prices once a second for 10 seconds: each run stays well inside the
  // ~2 seconds of computing an engine run may use, and if one run dies the next takes over within 10 seconds.
  // Light mode: one price round per run (prices and per-second stops every 10 seconds instead of every second). It
  // switches on by itself whenever the database answers slowly (its disk allowance running low), and back off once
  // it is quick again; ENGINE_LIGHT=1 forces it on.
  const t0 = Date.now();
  const { data: lk } = await sb.from("price_lock").update({ at: new Date(Date.now() + 9800).toISOString() }).eq("id", 1).lt("at", new Date(Date.now() + 700).toISOString()).select("id");
  if (!lk?.length) return { skipped: "another price loop is running" };
  const slowDb = Date.now() - t0 > 800;
  const light = Deno.env.get("ENGINE_LIGHT") === "1" || slowDb;
  const end = light ? t0 + 1500 : t0 + 9800;
  let rounds = 0, rows: Strategy[] = [], rowsAt = 0;
  // A round starts every second on the second, without waiting for a slow one to finish (at most 2 at once), so a
  // slow answer from one price source doesn't stretch the rhythm.
  const inflight = new Set<Promise<unknown>>();
  while (Date.now() < end - 700) {
    const t = Date.now();
    try {
      if (Date.now() - rowsAt > 5000) {
        rows = await pagedRows<Strategy>((a, z) => sb.from("algo_strategies").select(PRICE_COLS).eq("archived", false).or("active.eq.true,position.neq.FLAT").order("id").range(a, z)); rowsAt = Date.now();
        await priceHolidays(ist(Date.now() / 1000).date);
        // Nothing open and no Dhan strategy inside its trading hours: no need to price.
        if (!rows.some((x) => x.position !== "FLAT" || (x.active && !isCrypto(String(x.data_segment)) && inSessionNow(String(x.data_segment))))) break;
      }
      if (inflight.size < 2) {
        const p = pricesTick(rows).then(() => { rounds++; }, (e) => console.error("prices", e)).finally(() => inflight.delete(p));
        inflight.add(p);
      }
    } catch (e) { console.error("prices", e); }
    const wait = 1000 - (Date.now() - t);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await Promise.all(inflight);
  await flushBars();
  return { rounds };
}
/** Minute candles built from this run's prices, written in one go (merged with what earlier runs wrote). */
const barBuf = new Map<string, { seg: string; sec: string; t: number; o: number; h: number; l: number; c: number; at: string }>();
async function flushBars() {
  if (!barBuf.size) return;
  const rows = [...barBuf.values()]; barBuf.clear();
  const { error } = await sb.rpc("price_bars_merge", { p_rows: rows });
  if (error) console.error("price bars", error.message);
}
async function priceHolidays(today: string) {
  if (priceHolDay !== today) { const { data: hol } = await sb.from("market_holidays").select("day, exch, opens_at").eq("day", today); setHolidays(hol ?? []); priceHolDay = today; mcxSecMemo.clear(); }
}
function inSessionNow(seg: string) {
  const nowI = ist(Date.now() / 1000), sess = tradingSession(seg, nowI.date);
  return nowI.min >= sess.open && nowI.min <= sess.close;
}
let tickerTicks = 0; const tickerRefs: { at: number; rows: { seg: string; sec: string }[] } = { at: 0, rows: [] };
const priceAcc = { at: 0, map: new Map<string, Account | null>() };
let adminMemo: { at: number; acc: Account | null } | null = null;
/** The admin's account for the quotes strip, read once a minute. */
async function adminCached(): Promise<Account | null> {
  if (!adminMemo || Date.now() - adminMemo.at > 60000) adminMemo = { at: Date.now(), acc: await adminAccount(sb).catch(() => null) };
  return adminMemo.acc;
}
/** The last price written per open position (live_marks is written only when it moves, or every 15 s). */
const lastMarkPx = new Map<string, { ltp: number; at: number }>();
/** The last chart bar written per strategy (algo_chart is written on a new bar, or every 5 minutes). */
const chartLast = new Map<string, { t: number; at: number }>();
async function pricesTick(rows: Strategy[]) {
  const nowI = ist(Date.now() / 1000), today = nowI.date;
  const at = nowIso(); // the round's start: of two overlapping rounds, the later-started one's prices are the newer
  await priceHolidays(today);
  // Accounts are read once a minute, not once a second (6 Nov 2026 audit: 2.7 M reads of broker_accounts a month).
  if (Date.now() - priceAcc.at > 60000) { priceAcc.map = new Map(); priceAcc.at = Date.now(); }
  const accounts = priceAcc.map;
  const bySeg = new Map<string, Record<string, string[]>>(); // owner -> seg -> secs
  const coins = new Set<string>();
  const want = new Map<string, { s: Strategy; key: string }>();
  const add = (owner: string, seg: string, sec: string) => { const m = bySeg.get(owner) ?? {}; const l = (m[seg] ??= []); if (!l.includes(sec)) l.push(sec); bySeg.set(owner, m); };
  await Promise.all(rows.map(async (s) => {
    const seg = String(s.data_segment);
    if (!s.owner_id) return;
    if (isCrypto(seg)) { coins.add(String(s.data_security_id)); want.set(s.id, { s, key: `${seg}|${s.data_security_id}` }); return; }
    const sess = tradingSession(seg, today);
    if (nowI.min < sess.open || nowI.min > sess.close) return;
    let sec = String(s.data_security_id);
    if (isCommodity(seg) && !/^\d+$/.test(sec)) {
      let r = mcxSecMemo.get(sec);
      if (!r) {
        const set = await dataAccount(sb, s.owner_id, accounts).catch(() => null);
        if (!set?.dhan_access_token) return;
        r = (await dataSecurity(sb, credsOf(set), seg, sec, today).catch(() => ({ sec: "" }))).sec;
        if (r) mcxSecMemo.set(sec, r);
      }
      if (!r) return;
      sec = r;
    }
    add(await dataUid(sb, s.owner_id, accounts), seg, sec);
    want.set(s.id, { s, key: `${seg}|${sec}` });
  }));
  // Live orders being worked: their own contracts (the order manager chases them with these prices).
  // The Desk's quotes strip: the fixed indices, in the admin's batched request (no extra Dhan call).
  if (inSessionNow("IDX_I")) { const adm = await adminCached(); if (adm?.dhan_access_token) for (const f of TICKER_FIXED) add(adm.user_id, f.seg, f.sec); }
  // The rest of the strip (every stock, MCX commodity and coin): every 5th round, in the same batched requests.
  if ((tickerTicks = (tickerTicks + 1) % 5) === 0) {
    const adm = await adminCached();
    if (!tickerRefs.at || Date.now() - tickerRefs.at > 300000) { const { data } = await sb.from("ticker_ref").select("seg, sec"); tickerRefs.rows = data ?? []; tickerRefs.at = Date.now(); }
    for (const r of tickerRefs.rows) {
      if (r.seg === "DELTA") coins.add(String(r.sec));
      else if (adm?.dhan_access_token && inSessionNow(String(r.seg))) add(adm.user_id, String(r.seg), String(r.sec));
    }
  }
  const { data: work } = await sb.from("live_orders").select("user_id, seg, sec").eq("broker", "DHAN").in("state", ["queued", "working"]);
  for (const w of work ?? []) add(w.user_id, w.seg, String(w.sec));
  const px = new Map<string, number>();
  await Promise.all([
    ...[...bySeg].map(async ([uid, segs]) => {
      const set = await accountFor(sb, uid, "DHAN", accounts).catch(() => null);
      if (!set?.dhan_access_token) return;
      try { for (const [k, v] of await dhanFor(set).ltpMany(segs, true)) px.set(k, v); } catch { /* rate-limited or busy: the next round is a second away */ }
    }),
    ...[...coins].map(async (c) => { const v = await cryptoLtp(c).catch(() => null); if (v) px.set(`DELTA|${c}`, v); }),
  ]);
  if (!px.size) return { prices: 0 };
  const pxRows = [...px].map(([k, v]) => { const [seg, sec] = k.split("|"); return { seg, sec, px: v, at }; });
  // The same prices make the desk's own 1-minute candles (used when Dhan's candle API refuses requests), built here and
  // written once per run (flushBars) to keep the database's disk use low.
  const t = Math.floor(Date.parse(at) / 60000) * 60;
  for (const r of pxRows) {
    if (isCrypto(r.seg)) continue;
    const k = `${r.seg}|${r.sec}|${t}`, b = barBuf.get(k);
    if (!b) barBuf.set(k, { seg: r.seg, sec: r.sec, t, o: r.px, h: r.px, l: r.px, c: r.px, at });
    else { b.h = Math.max(b.h, r.px); b.l = Math.min(b.l, r.px); if (at >= b.at) { b.c = r.px; b.at = at; } }
  }
  await sb.from("live_prices").upsert(pxRows);
  // Running P&L of open positions priced on one instrument (futures, index basis, crypto). Option positions are
  // priced by the minute tick (their premium comes from the option chain, allowed once every 3 seconds).
  const marks: { strategy_id: string; owner_id: string; ltp: number; upnl: number | null; at: string }[] = [];
  const checks: Promise<unknown>[] = [];
  const slow: PromiseLike<unknown>[] = [];
  for (const { s: s0, key } of want.values()) {
    if (s0.position === "FLAT" || s0.trade_type === "OPTIONS" || isMulti(s0)) continue;
    const p = px.get(key); if (!(Number(p) > 0)) continue;
    // A stock future on its split / bonus ex-date is adjusted before its stop is looked at.
    let s: Strategy;
    try { s = await stockExDate(s0, p!); }
    catch (e) {
      // Not knowing whether today is an ex-date, the price can't be trusted against the stop: this strategy sits out
      // this second (the pre-split stop would meet the post-split price), and the owner is told once a day.
      console.error("ex-date", e);
      await alert(s0, "Split check failed", `The desk couldn't check ${s0.underlying} for a split / bonus today (${e instanceof Error ? e.message : e}); its stop isn't judged on live prices until the check works.`, `exdate-${s0.id}-${today}`).catch(() => {});
      continue;
    }
    const pr = (s.pos_risk ?? {}) as PosRisk;
    const inPx = Number(s.pos_entry_px ?? pr.entry ?? 0), dir = s.position === "LONG" ? 1 : -1;
    const upnl = inPx > 0 ? Math.trunc((p! - inPx) * dir * unitsOf(s)) : null;
    marks.push({ strategy_id: s.id, owner_id: s.owner_id, ltp: +p!.toFixed(2), upnl, at });
    checks.push(secondRisk(s, p!, at));
    // The strategy row itself (lists, capital, alerts) every 10 seconds.
    if (Date.now() - (rowWriteAt.get(s.id) ?? (s.pos_ltp_at ? Date.parse(s.pos_ltp_at) : 0)) > 10000) rowWriteAt.set(s.id, Date.now()), slow.push(sb.from("algo_strategies").update({ pos_ltp: +p!.toFixed(2), pos_upnl: upnl, pos_ltp_at: at }).eq("id", s.id).eq("position", s.position));
  }
  // Realtime decodes every write of live_marks (18% of all database time, 6 Nov 2026 audit): unchanged prices are
  // written only every 15 seconds, so the row never looks stale but a flat market costs nothing.
  const moved = marks.filter((m) => { const l = lastMarkPx.get(m.strategy_id); return !l || l.ltp !== m.ltp || Date.now() - l.at > 15000; });
  if (moved.length && at >= lastMarkAt) {
    lastMarkAt = at;
    const { error } = await sb.from("live_marks").upsert(moved);
    if (!error) for (const m of moved) lastMarkPx.set(m.strategy_id, { ltp: m.ltp, at: Date.now() });
  }
  await Promise.all(checks);
  await Promise.all(slow);
  return { prices: px.size, marks: marks.length };
}
/* ---------- stock futures across a split / bonus ex-date ---------- */
// On the ex-date the exchange gives a held stock future 1/f times the shares at f times the price (Kotak 5:1: f = 0.2).
// The desk sees it in the day's first price against the last one it saw (the strategy's own price from before today,
// else Dhan's raw close of the day before), records it in stock_actions (with whether Dhan's candles already carry it),
// and adjusts every strategy on that stock once (ca_day): quantity, prices, stops, the broker stop order. This runs
// before any stop is checked, so the jump can never look like a stop being hit.
const stockDayMemo = new Map<string, number | null>(); // "STOCK|day" -> factor (null: checked, nothing today)
/** A stock future's current lot in Dhan's list (the same 60-second copy the request's asset list uses). */
const stockLotNow = async (key: string, fresh = false): Promise<number | null> => (await stockLots(sb, fresh).catch(() => ({} as Record<string, number>)))[key] ?? null;
const istDay = (iso: string | null | undefined) => iso ? ist(Date.parse(iso) / 1000).date : null;
async function stockActionToday(s: Strategy, px: number, today: string, set0?: Settings | null): Promise<number | null | undefined> {
  const key = String(s.underlying), mk = `${key}|${today}`;
  const known = actionsFor(key).find((a) => a.day === today);
  if (known) return known.factor;
  if (stockDayMemo.has(mk)) return stockDayMemo.get(mk)!;
  // The strategy's own last price from an earlier day (as seen live, never re-adjusted by anyone). A price already from
  // today means today's check ran before it was written (both loops check before they write), so Dhan isn't asked again.
  const refAt = s.position !== "FLAT" ? s.pos_ltp_at : s.last_run_at, refDay = istDay(refAt);
  if (refDay === today) return null;
  const own = refDay && refDay < today ? Number(s.position !== "FLAT" ? s.pos_ltp : s.last_close) : 0;
  let f = own > 0 ? splitFactor(px / own) : null;
  // Dhan's raw candles of the days before (also tells whether Dhan has already adjusted its history).
  let rawD: number | null = null, rawI: number | null = null;
  const set = set0 ?? (s.owner_id ? await accountFor(sb, s.owner_id, "DHAN", new Map()).catch(() => null) : null);
  const raw = set?.dhan_access_token ? dhanFor(set) : null;
  if (raw) raw.adjust = false;
  if (raw && (f || !(own > 0))) {
    try { rawD = (await raw.daily(String(s.data_security_id), "NSE_EQ", "EQUITY", addDays(today, -10), today)).filter((d) => d.day < today).at(-1)?.c ?? null; } catch { rawD = null; }
    if (!f && rawD) f = splitFactor(px / rawD);
  }
  // Nothing found: remembered for the stock only when Dhan's raw close was compared (a stock-wide answer); a strategy
  // that only compared its own price is settled for itself, and one that could compare nothing asks again later.
  if (!f) { if (rawD) stockDayMemo.set(mk, null); return own > 0 || rawD ? null : undefined; }
  // A 1:2 or 1:3 bonus (a 25–33% gap) could also be a real crash: it counts only when Dhan's F&O list shows the
  // exchange's new lot (the list is downloaded again to make sure). A gap of half or more is never a real move here.
  if (f > 0.6) {
    const oldLot = Number(s.lot_size) || 0, want = Math.round(oldLot / f);
    const near = (x: number | null) => !!x && want > 0 && Math.abs(x / want - 1) < 0.02; // the exchange rounds the new lot
    let lot = await stockLotNow(key);
    if (!near(lot) && set?.dhan_access_token) { await syncFno(sb, credsOf(set)).catch(() => {}); lot = await stockLotNow(key, true); }
    if (!near(lot)) {
      await alert(s, `${key}: price gapped ${Math.round((1 - f) * 100)}% at the open`, `That matches a bonus (${Math.round(1 / f * 100) / 100}× shares), but Dhan's F&O list still shows a lot of ${lot ?? "?"} (a bonus would make it ${want}), so the desk treats it as a real price move. Check the stock's news.`, `cagap-${key}-${today}`);
      return null;
    }
  }
  // Whether Dhan's own candles still show the jump; when Dhan didn't answer, assume they do (not adjusted yet) — the
  // nightly download re-judges it from the raw candles.
  if (raw) try { rawI = (await raw.intraday(String(s.data_security_id), "NSE_EQ", "EQUITY", 5, `${addDays(today, -6)} 09:00:00`, `${addDays(today, -1)} 23:59:00`)).at(-1)?.c ?? null; } catch { rawI = null; }
  const jump = (ref: number | null) => ref == null || splitFactor(px / ref) === f;
  await must(() => sb.from("stock_actions").upsert({ asset: key, day: today, factor: f, in_daily: jump(rawD), in_intraday: jump(rawI), seen_at: nowIso() }, { onConflict: "asset,day" }), "stock action");
  await loadStockActions(sb, 0);
  // Candles kept in memory were adjusted with the actions known when they were fetched: dropped, so the next read sees
  // the whole series at today's basis (6 Nov 2026 audit — a 50% step inside the series flipped every indicator).
  for (const k of [...SPAN_CACHE.keys()]) if (k.startsWith(`${s.data_security_id}|`)) SPAN_CACHE.delete(k);
  for (const k of [...DAILY_CACHE.keys()]) if (k.startsWith(`${s.data_security_id}|`)) DAILY_CACHE.delete(k);
  stockDayMemo.set(mk, f);
  return f;
}
/** Adjusts one stock strategy for today's split / bonus (once; ca_day). Returns the strategy as it stands afterwards. */
// Per strategy: the IST day its ex-date check settled, and what that day's adjustment wrote (the price loop keeps its
// rows for up to 5 seconds, and a row read before the adjustment — ca_day not today — must not meet the old stop).
const exChecked = new Map<string, { day: string; upd?: Record<string, unknown> }>();
async function stockExDate(s0: Strategy, px: number, set?: Settings | null): Promise<Strategy> {
  if (!isStockSeg(String(s0.data_segment)) || s0.trade_type === "OPTIONS" || isMulti(s0) || !(px > 0)) return s0;
  const today = todayIst();
  const seen = exChecked.get(String(s0.id));
  if (seen?.day === today) return seen.upd && String(s0.ca_day ?? "").slice(0, 10) !== today ? { ...s0, ...seen.upd } as Strategy : s0;
  // The per-second loop passes short rows: read the whole row once (position, broker legs, lot, last prices).
  let s = s0;
  if (!("underlying" in s0) || !("pos_broker" in s0) || !("ca_day" in s0)) {
    const { data } = await sb.from("algo_strategies").select("*").eq("id", s0.id).maybeSingle();
    if (!data) return s0;
    s = { ...s0, ...data } as Strategy;
  }
  if (s.ca_day && String(s.ca_day).slice(0, 10) >= today) { exChecked.set(String(s.id), { day: today }); return s; }
  const f = await stockActionToday(s, px, today, set);
  if (f === undefined) return s; // couldn't decide yet (Dhan didn't answer): asked again on the next price
  exChecked.set(String(s.id), { day: today });
  if (!f) return s;
  // Only state from before the ex-date is adjusted (a position opened today is already in the new prices).
  if (s.position !== "FLAT" && String(s.pos_entry_date ?? "") >= today) { await sb.from("algo_strategies").update({ ca_day: today }).eq("id", s.id); return { ...s, ca_day: today }; }
  const upd = { ...adjustPosition(s as any, f, await stockLotNow(String(s.underlying)), px), ca_day: today, ...(s.position !== "FLAT" ? { pos_ltp_at: nowIso() } : {}) };
  const { data: done } = await sb.from("algo_strategies").update(upd).eq("id", s.id).eq("position", s.position).or(`ca_day.is.null,ca_day.lt.${today}`).select("id");
  if (!done?.length) { const { data } = await sb.from("algo_strategies").select("*").eq("id", s.id).maybeSingle(); return data ? { ...s, ...data } as Strategy : s; }
  exChecked.set(String(s.id), { day: today, upd });
  const pb = s.pos_broker as PosBroker | null;
  if (s.live && pb?.stopId && pb.broker === "DHAN") {
    // The exchange normally cancels resting orders of the stock before an ex-date; if this one is still there it goes too,
    // and the order manager places a new stop for the new quantity and price on its next round.
    const set = await accountFor(sb, s.owner_id, "DHAN", new Map()).catch(() => null);
    const gone = set ? await dhanCancel(credsOf(set), pb.stopId).then(() => true, async () => {
      // Already cancelled by the exchange (usual before an ex-date) counts as gone; anything else is left to a person.
      const st = await dhanStatus(credsOf(set), pb.stopId!).catch(() => null);
      return !!st && /CANCEL|REJECT|EXPIRE/i.test(String(st.status));
    }) : false;
    if (gone) await sb.from("live_orders").update({ state: "cancelled", done_at: nowIso(), note: "split / bonus ex-date: replaced by a stop for the adjusted quantity" }).eq("broker_order_id", pb.stopId).eq("state", "resting");
    else await alert(s, `${s.underlying}: check the stop order at Dhan`, `After today's split / bonus the desk couldn't cancel the old stop order (${pb.stopId}) at Dhan. Please cancel it in Dhan; the desk places a new stop for the adjusted quantity.`, `castop-${s.id}-${today}`);
  }
  if (s.position !== "FLAT") {
    const what = f === 0.5 ? "1:1 bonus or 1:2 split" : `${Math.round(1 / f * 100) / 100}× shares (split / bonus)`;
    await alert(s, `${s.underlying}: position adjusted for the ex-date`, `${what} today. The desk now holds ${upd.pos_qty ?? s.pos_qty} (was ${s.pos_qty}) at an entry price of ${upd.pos_entry_px} (was ${s.pos_entry_px}); stop, target and trailing stop moved the same way, so the position's value and P&L are unchanged.${s.live ? " The stop order at Dhan is placed again for the new quantity." : ""}`, `ca-${s.id}-${today}`);
  }
  return { ...s, ...upd } as Strategy;
}
/** Flat stock strategies take the lot size in Dhan's current list (NSE revisions; after a split the new lot). */
async function stockLotSync(s: Strategy): Promise<Strategy> {
  if (!isStockSeg(String(s.data_segment)) || s.position !== "FLAT") return s;
  if (actionsFor(String(s.underlying)).some((a) => a.day === todayIst())) return s; // ex-date: the adjustment set the lot
  const lot = await stockLotNow(String(s.underlying));
  if (!lot || lot === Number(s.lot_size)) return s;
  await sb.from("algo_strategies").update({ lot_size: lot }).eq("id", s.id).eq("position", "FLAT");
  return { ...s, lot_size: lot };
}
/**
 * Stop loss, target and trailing stop on every second's price (the minute tick also checks completed 1-minute
 * candles, which catch a spike between two seconds). A new best price moves the trailing stop at once.
 */
const bestMemo = new Map<string, { best: number; at: string }>();
async function secondRisk(s: Strategy, px: number, at: string) {
  const pr = s.pos_risk as PosRisk | null;
  // Paused strategies too (4 Nov 2026): pausing stops new trades, never the stop of a position still open.
  if (!pr || pr.dir === undefined || pr.basis === "PREMIUM" || !(pr.stop || pr.tgt || pr.trail)) return;
  const m = bestMemo.get(s.id);
  const best0 = Number(pr.best), best = m && m.at > (s.pos_ltp_at ?? "") ? (pr.dir === 1 ? Math.max(best0, m.best) : Math.min(best0, m.best)) : best0;
  const rs = { dir: pr.dir!, stop: pr.stop ?? null, tgt: pr.tgt ?? null, trail: pr.trail ?? null, trailAtr: pr.trailAtr ?? 0, best, scanFrom: 0 } as RiskState;
  const t = Math.floor(Date.parse(at) / 1000);
  const hit = riskScan(rs, [{ t, o: px, h: px, l: px }]);
  if (!hit) {
    if (rs.best !== best) { // new best price: the trailing stop moves now
      bestMemo.set(s.id, { best: rs.best, at });
      await sb.from("algo_strategies").update({ pos_risk: { ...pr, best: rs.best } }).eq("id", s.id).eq("position", s.position);
    }
    return;
  }
  // Hit: the full strategy row and its account, then the same exit path as the minute tick.
  const { data: full } = await sb.from("algo_strategies").select("*").eq("id", s.id).maybeSingle();
  if (!full || full.position !== s.position) return;
  const st = (await withMasters(sb, [full]))[0] as Strategy;
  const isCr = isCrypto(String(st.data_segment));
  let set = await accountFor(sb, st.owner_id, isCr ? "DELTA" : "DHAN", new Map()).catch(() => null);
  if (isCr && !set) set = { user_id: st.owner_id, broker: "DELTA", dhan_client_id: null, dhan_access_token: null, webhook_url: null, webhook_secret: null, capital: null, capital_since: null, deploy_pct: null, funds_at: null };
  if (!set) return;
  if (isCommodity(String(st.data_segment)) && !/^\d+$/.test(String(st.data_security_id))) st.data_security_id = mcxSecMemo.get(String(st.data_security_id)) ?? st.data_security_id;
  const fpr = (full.pos_risk ?? pr) as PosRisk;
  bestMemo.delete(s.id);
  await actLocked(() => riskExit(st, set!, fpr, hit, { last_run_at: nowIso() }));
}
async function ownCandlesAlert(assets: string[]) {
  const { data: fresh, error } = await sb.rpc("engine_alert", { p_key: "own_candles", p_detail: { assets } });
  if (error) throw new Error(error.message);
  if (!fresh) return;
  const admin = await adminAccount(sb).catch(() => null);
  if (!admin?.user_id) return;
  await sb.rpc("notify_tagged", { p_user: admin.user_id, p_kind: "error", p_title: "Engine on fallback candles: check with Dhan",
    p_body: `Dhan refused candle requests, so ${assets.join(", ")} ${assets.length === 1 ? "is" : "are"} running on the desk's own candles built from live prices. Ask Dhan API support about the candle (charts) API.`,
    p_url: "/", p_strategy: null, p_tag: "own_candles" });
}
/** True when a flat rule strategy has already been checked since its latest candle closed (nothing new to decide). */
function quietNow(s: Strategy, sess: { open: number; close: number }): boolean {
  if (s.position !== "FLAT" || s.strategy_kind !== "RULES" || s.pending_target != null || !s.last_run_at || s.last_error) return false;
  const now = ist(Date.now() / 1000), tf = Number(s.timeframe_min) || 0;
  const daily = !!(s.rules && (s.rules as { daily?: boolean }).daily) || tf >= 375;
  const dayStart = Date.parse(`${now.date}T00:00:00+05:30`);
  let closeMin: number;
  if (daily) closeMin = sess.open; // decided once a day, at the session open
  else { if (!(tf > 0) || now.min < sess.open + tf) return false; closeMin = sess.open + Math.floor((now.min - sess.open) / tf) * tf; }
  if (now.min < closeMin) return false;
  return Date.parse(s.last_run_at) >= dayStart + closeMin * 60000 + 20000;
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
  // Served from the per-second prices (live_marks) and the strategy rows: no Dhan request from here, since the quote
  // API allows one request a second per account and the price loop uses it.
  let q = sb.from("algo_strategies").select("id, pos_ltp, pos_upnl, pos_ltp_at").neq("position", "FLAT").eq("archived", false);
  if (!admin) q = q.eq("owner_id", userId);
  const { data: rows } = await q;
  const ids = (rows ?? []).map((r) => r.id);
  const { data: lm } = ids.length ? await sb.from("live_marks").select("strategy_id, ltp, upnl, at").in("strategy_id", ids) : { data: [] };
  const live = new Map((lm ?? []).map((m) => [m.strategy_id, m]));
  const out: Record<string, { ltp: number | null; upnl: number | null; at: string | null }> = {};
  for (const r of rows ?? []) {
    const m = live.get(r.id);
    out[r.id] = m && (!r.pos_ltp_at || Date.parse(m.at) > Date.parse(r.pos_ltp_at))
      ? { ltp: Number(m.ltp), upnl: m.upnl == null ? null : Number(m.upnl), at: m.at }
      : { ltp: r.pos_ltp ?? null, upnl: r.pos_upnl ?? null, at: r.pos_ltp_at ?? null };
  }
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
  stopId?: string | null; stopTrig?: number | null; stopRow?: number | null; stopErrAt?: string | null; symbol?: string; stopRO?: boolean;
  /** Exit attempts that failed in a row and why the exit was wanted (exitFailed; cleared when the position closes). */
  exitTries?: number; exitWhy?: string };
const EXIT_EVENTS = new Set(["EXIT", "STOP_LOSS", "TRAIL_STOP", "TARGET", "SQUARE_OFF", "FLATTEN"]);
const nowIso = () => new Date().toISOString();
/** Crypto fills of the order just sent (for the ledger). */
let deltaFill: { exit: number | null; entry: number | null } = { exit: null, entry: null };
/**
 * The Dhan order batch of the exit being booked (set by queueDhan, cleared by sendOrders): its ledger row is an estimate
 * at the desk's price (provisional) until fixLedger puts Dhan's fills on it, and is hidden if Dhan rejects the exit.
 */
let lastLiveBatch: string | null = null;
const ledgerTag = (s: Strategy) => s.live && !isCrypto(String(s.data_segment)) && lastLiveBatch ? { provisional: true, order_batch: lastLiveBatch } : {};

/** How many of an order's legs close the current position (they go first; the rest open the new one). */
function exitCount(s: Strategy, event: string, legs: Record<string, unknown>[]): number {
  if (s.position === "FLAT") return 0;
  if (EXIT_EVENTS.has(event)) return legs.length;
  if (event === "REVERSE" || event === "ROLL") return Math.min(legs.length, asArr(exitLeg(s, 1)).length);
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

/** What the account's other live strategies hold at Dhan, contract by contract (their own broker records). */
async function othersHolding(s: Strategy): Promise<Map<string, number>> {
  const { data } = await sb.from("algo_strategies").select("id, position, pos_broker").eq("owner_id", s.owner_id).eq("live", true).neq("id", s.id);
  const out = new Map<string, number>();
  for (const o of data ?? []) {
    if (o.position === "FLAT") continue;
    for (const l of ((o.pos_broker as PosBroker | null)?.legs ?? [])) out.set(brokerKey(l.seg, l.sec), (out.get(brokerKey(l.seg, l.sec)) ?? 0) + Number(l.qty));
  }
  return out;
}

/**
 * Matching opposite orders inside the desk (31 Oct 2026, Papa: pairs of strategies that are often on opposite sides).
 * When two live strategies of the same account want opposite orders in the same contract at the same time (both act at
 * the session open, for example), sending both to Dhan would put a buy and a sell of the same client against each other:
 * the exchange's self-trade check cancels one, and the desk would treat it as a rejection. Instead, before an order goes
 * to Dhan, an opposite order of another strategy still resting there unfilled is cancelled and the two are matched here
 * at the last traded price: no order at Dhan for the matched part, the same net position as if both had traded. A
 * bigger order sends only what is left to Dhan, and its fill price becomes the average of the matched part and Dhan's.
 * Returns true when the whole order was matched.
 */
async function crossInside(r: LiveRow, c: Creds, px: number | null): Promise<boolean> {
  if (r.broker !== "DHAN" || r.market_retry) return false;
  const { data: opp } = await sb.from("live_orders").select("*").eq("user_id", r.user_id).eq("broker", "DHAN").eq("seg", r.seg).eq("sec", r.sec)
    .eq("state", "working").neq("side", r.side).neq("strategy_id", r.strategy_id).order("id");
  const { data: names } = await sb.from("algo_strategies").select("id, name").in("id", [r.strategy_id, ...(opp ?? []).map((o) => o.strategy_id)]);
  const nameOf = (id: string) => String((names ?? []).find((x) => x.id === id)?.name ?? "another strategy").slice(0, 60);
  for (const o of opp ?? []) {
    if (Number(r.qty) <= 0) break;
    if (String(o.product ?? "") !== String(r.product ?? "") || !o.broker_order_id) continue;
    // Only an order that hasn't traded at all is taken back; one already (partly) at the exchange is left alone.
    const st = await dhanStatus(c, o.broker_order_id).catch(() => null);
    if (!st || Number(st.filled) > 0 || /TRADED|REJECT|CANCEL/i.test(String(st.status))) continue;
    try { await dhanCancel(c, o.broker_order_id); } catch { continue; }
    const again = await dhanStatus(c, o.broker_order_id).catch(() => null);
    if (!again || Number(again.filled) > 0 || /TRADED/i.test(String(again.status))) {
      if (again && /TRADED/i.test(String(again.status))) await onFilled(o, again); // it filled just before the cancel
      continue;
    }
    const P = Number(px ?? o.limit_px ?? r.ref_px), m = Math.min(Number(r.qty), Number(o.qty));
    if (!(P > 0) || !(m > 0)) continue;
    const note = (x: LiveRow, y: LiveRow) => `${m} matched inside the desk with ${nameOf(y.strategy_id)} (${y.side.toLowerCase()} ${y.label}) at ${P}: no order at Dhan for it`;
    for (const [x, y] of [[r, o], [o, r]] as const) {
      const cq = Number(x.cross_qty) || 0;
      x.cross_px = +((cq * (Number(x.cross_px) || 0) + m * P) / (cq + m)).toFixed(4);
      x.cross_qty = cq + m; x.qty = Number(x.qty) - m; x.note = note(x, y);
    }
    const crossedSt: BrokerStatus = { status: "TRADED", filled: 0, qty: 0, avg: null, reason: null, price: null, orderType: null };
    // The other strategy's order: done if fully matched, otherwise what is left goes back to Dhan.
    await sb.from("live_orders").update({ qty: o.qty, cross_qty: o.cross_qty, cross_px: o.cross_px, note: o.note, updated_at: nowIso(),
      ...(o.qty > 0 ? { state: "queued", broker_order_id: null } : {}) }).eq("id", o.id);
    if (o.qty > 0) await placeRow({ ...o, state: "queued", broker_order_id: null }, c);
    else await onFilled(o, crossedSt);
    await sb.from("live_orders").update({ qty: r.qty, cross_qty: r.cross_qty, cross_px: r.cross_px, note: r.note, updated_at: nowIso() }).eq("id", r.id);
  }
  if (Number(r.cross_qty) > 0 && Number(r.qty) <= 0) {
    await onFilled(r, { status: "TRADED", filled: 0, qty: 0, avg: null, reason: null, price: null, orderType: null });
    return true;
  }
  return false;
}

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
  const heldUsed = new Set<number>();
  try {
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i], purpose = i < nExit ? "exit" : "entry";
      // An exit closes the contract the position actually holds (4 Nov 2026): looked up "for today" a futures leg
      // would be the next month's contract once the held one is in its expiry week / tender period, and that
      // exit would open a new position instead of closing the old one.
      const held = purpose === "exit" ? heldLeg(pb, leg, heldUsed) : null;
      let k: Awaited<ReturnType<typeof resolveLeg>>;
      // A roll's new leg goes to the contract after the one expiring (_after = its expiry).
      try { k = await resolveLeg(sb, c, s, leg, leg._after ? addDays(String(leg._after), 1) : today); }
      catch (e) { if (!held) throw e; k = { sec: held.sec, seg: held.seg, lot: Number(s.lot_size) || 1, tick: pb!.tick || 0.05, label: "", option: false }; }
      if (held && (k.sec !== held.sec || !k.label)) {
        const info = await contractInfo(held.seg, held.sec);
        k = { ...k, sec: held.sec, seg: held.seg, lot: info?.lot ?? k.lot, tick: info?.tick ?? pb!.tick ?? k.tick, label: info?.label ?? `${s.futures_symbol ?? s.dhan_symbol} (contract ${held.sec}, held)` };
        notes.push(`exit goes to the contract held: ${k.label}`);
      }
      const q = Number(leg.quantity ?? 0);
      const lots = s.qty_mode === "LOTS" ? q : q / (k.lot || 1);
      const ref = k.option ? null : Number(candle.c) || null; // an option is priced from its own last trade
      // The quantity held at Dhan (it can be less than the lots asked for after a partly filled entry).
      const qty = held ? Math.abs(Number(held.qty)) : brokerQty(k.seg, lots, k.lot);
      rows.push({ user_id: s.owner_id, strategy_id: s.id, broker: "DHAN", seq: i, purpose, event, side: sideOf(leg.transactionType), sec: k.sec, seg: k.seg,
        product: held?.product ?? productOf(leg.productType), qty, lots, lot: k.lot, tick: k.tick, option: k.option, label: k.label, ref_px: ref });
    }
  } catch (e) {
    await logSignal(s, event, description, candle, "FAILED", payload, e instanceof Error ? e.message : String(e));
    return false;
  }
  // Exits: the broker's stop first, then what the account actually holds.
  const exits = rows.filter((r) => r.purpose === "exit");
  if (exits.length) {
    if (pb?.stopId) {
      const gone = await cancelStop(c, pb.stopId);
      if (gone === "traded") {
        // The stop at Dhan already closed the position: that's the exit (its fill is recorded when the order manager sees it).
        const st = await dhanStatus(c, pb.stopId).catch(() => null);
        for (const r of exits) { r.state = "filled"; r.note = "closed by the stop-loss order at Dhan"; r.avg_px = st?.avg ?? null; r.filled_qty = st?.filled ?? r.qty; r.done_at = nowIso(); r.broker_order_id = pb.stopId; }
        await sb.from("live_orders").update({ state: "filled", done_at: nowIso(), avg_px: st?.avg ?? null, filled_qty: st?.filled ?? null, note: "filled (desk exit came after)" }).eq("broker_order_id", pb.stopId).eq("state", "resting");
      } else if (gone === "cancelled") {
        await sb.from("live_orders").update({ state: "cancelled", done_at: nowIso(), note: "cancelled before the desk's exit" }).eq("broker_order_id", pb.stopId).eq("state", "resting");
      } else {
        // The stop is still resting at Dhan (it couldn't be cancelled): an exit now could fill and then the stop too,
        // opening a position the other way. Nothing is sent; the exit is tried again in a minute (exitFailed).
        await logSignal(s, event, description, candle, "FAILED", payload, `Couldn't cancel the stop-loss order ${pb.stopId} at Dhan (${gone}); the exit waits for it.`);
        await alert(s, "Stop order couldn't be cancelled", `Before the exit the desk couldn't cancel the stop-loss order at Dhan (${String(gone).slice(0, 160)}). Nothing was sent; the desk tries again in a minute. If it keeps failing, cancel the stop and close the position in Dhan.`, `stopcancel-${s.id}`);
        return false;
      }
    }
    const open = exits.filter((r) => r.state !== "filled");
    if (open.length) {
      const held = await dhanPositions(c).catch(() => null);
      // Other live strategies of the same account may hold the same contract: Dhan shows one net position (a long and a
      // short net to nothing), so only what is left after theirs is this strategy's (31 Oct 2026).
      const others = held ? await othersHolding(s) : new Map<string, number>();
      for (const r of open) {
        if (!pb) { r.state = "cancelled"; r.note = "not sent: the desk has no record of this position being opened at Dhan"; continue; }
        if (!held) continue; // positions couldn't be read: send the exit anyway
        const key = brokerKey(r.seg, r.sec), theirs = others.get(key) ?? 0;
        const h = (held.get(key) ?? 0) - theirs, want = r.side === "SELL" ? 1 : -1; // selling closes a long
        const after = theirs ? ` (Dhan's net ${held.get(key) ?? 0} less ${theirs} held by your other strategies)` : "";
        if (Math.sign(h) !== want) { r.state = "cancelled"; r.note = `not sent: Dhan shows no ${want === 1 ? "long" : "short"} position in ${r.label}${after}`; continue; }
        if (Math.abs(h) < r.qty) { r.note = `Dhan holds ${Math.abs(h)} of ${r.qty}${after}; closing what it holds`; r.qty = Math.abs(h); }
      }
      for (const r of open.filter((r) => r.state === "cancelled")) {
        await alert(s, "Exit not sent", `${r.label}: ${r.note}. The desk is now flat; check your Dhan positions.`);
      }
    }
    // What to put back if Dhan rejects the exit (failRow): the position as it was, its broker record without the stop
    // just cancelled (a new one is placed), and the day's total before this trade was booked.
    const restore: Record<string, unknown> = { pos_broker: pb ? { ...pb, stopId: null, stopTrig: null, stopRow: null, stopErrAt: null, exitWhy: pb.exitWhy ?? description.split(" | ")[0].slice(0, 150) } : null, day_pnl: s.day_pnl ?? null, day_pnl_date: s.day_pnl_date ?? null };
    for (const f of Object.keys(FLAT_STATE)) if (f !== "pos_broker") restore[f] = s[f] ?? null;
    for (const r of exits) r.restore = restore;
  }
  const batch = crypto.randomUUID();
  lastLiveBatch = batch;
  await logSignal(s, event, description, candle, "SENT", payload, `Worked at Dhan: ${rows.map((r) => `${r.purpose} ${r.side} ${r.qty} ${r.label}${r.state === "cancelled" ? " (not sent)" : ""}`).join(" | ")}${notes.length ? " | " + notes.join(" | ") : ""}`.slice(0, 1000));
  rows = rows.map((r) => ({ ...r, batch, signal_id: lastSignalId, state: r.state ?? "queued" }));
  const { data: ins, error } = await sb.from("live_orders").insert(rows).select("*");
  if (error) { console.error("live_orders", error); lastLiveBatch = null; return false; }
  await must(() => sb.from("algo_strategies").update({ exec_state: "working", exec_at: nowIso(), ...(nExit ? { pos_broker: null } : {}) }).eq("id", s.id), "order state");
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
/**
 * The broker leg of the held position an exit leg closes: a futures leg (not an option, whose exact strike and
 * expiry already name the contract) of a single-leg position. Null when there's no record.
 */
function heldLeg(pb: PosBroker | null, leg: Record<string, unknown>, used: Set<number>): BrokerLeg | null {
  // Single-leg futures positions only: a structure's legs can't be told apart from their broker record alone.
  if (!pb || pb.broker !== "DHAN" || pb.legs?.length !== 1 || pb.option || used.has(0)) return null;
  if (/^OPT/i.test(String(leg.instrument ?? "")) || leg.option_type) return null;
  used.add(0);
  return pb.legs[0];
}
/** Name, lot and tick of a contract by its security id (kept in the contract lists while it trades). */
async function contractInfo(seg: string, sec: string): Promise<{ label: string; lot: number | null; tick: number | null } | null> {
  if (seg === "MCX_COMM") {
    const { data } = await sb.from("mcx_contracts").select("display, lot, tick").eq("sec_id", sec).maybeSingle();
    return data ? { label: String(data.display ?? sec), lot: Number(data.lot) || null, tick: Number(data.tick) || null } : null;
  }
  const { data } = await sb.from("fno_contracts").select("display, lot, tick").eq("seg", seg).eq("sec_id", sec).maybeSingle();
  return data ? { label: String(data.display ?? sec), lot: Number(data.lot) || null, tick: Number(data.tick) || null } : null;
}
/**
 * Cancels a stop order resting at Dhan and makes sure it is gone (4 Nov 2026: a failed cancel used to be recorded as
 * cancelled, and the stop could fill after the desk's own exit and open a position the other way). Tried twice.
 * "cancelled" / "traded" (it filled first: that is the exit) / otherwise the reason it is still there.
 */
async function cancelStop(c: Creds, id: string): Promise<"cancelled" | "traded" | string> {
  let why = "";
  for (let i = 0; i < 2; i++) {
    const st0 = await dhanStatus(c, id).catch(() => null);
    const s0 = String(st0?.status ?? "").toUpperCase();
    if (s0 === "TRADED") return "traded";
    if (/CANCEL|REJECT|EXPIRE/.test(s0)) return "cancelled";
    try { await dhanCancel(c, id); } catch (e) { why = e instanceof Error ? e.message : String(e); }
    const st = await dhanStatus(c, id).catch(() => null);
    const s1 = String(st?.status ?? "").toUpperCase();
    if (s1 === "TRADED") return "traded";
    if (/CANCEL|REJECT|EXPIRE/.test(s1)) return "cancelled";
    if (!st) why = why || "couldn't read the order's state";
    else why = why || `still ${s1.toLowerCase() || "open"}`;
  }
  return why;
}

/** Places (or re-places) one order at the last traded price. Returns false when Dhan wouldn't take it. */
async function placeRow(r: LiveRow, c: Creds): Promise<boolean> {
  const ltp = await dhanLtp(c, r.seg, r.sec);
  const px = ltp ?? (Number(r.ref_px) > 0 ? Number(r.ref_px) : null);
  const market = r.market_retry || (px == null && r.purpose === "exit");
  if (px == null && !market) return failRow(r, "no price to place the order at");
  if (!market && await crossInside(r, c, px)) return true;
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
      placed_at: nowIso(), updated_at: nowIso(), note: market ? "market order" : Number(r.cross_qty) > 0 ? `${r.note ?? ""}; the other ${r.qty} sent to Dhan`.slice(0, 300) : null }).eq("id", r.id);
    return true;
  } catch (e) {
    return failRow(r, e instanceof Error ? e.message : String(e));
  }
}
/**
 * Dhan wouldn't take or rejected an order. An exit is tried once more at market; if that is rejected too, the desk puts
 * the position back as it was (it is still open at Dhan), hides the trade it had booked, and tries the exit again in a
 * minute (exitFailed). An entry rejected after part of it filled keeps the part that filled (partEntry).
 */
async function failRow(r: LiveRow, reason: string): Promise<boolean> {
  if (r.purpose === "exit" && !r.market_retry) {
    const set = await accountFor(sb, r.user_id, "DHAN");
    // Part of the exit may have traded before the rest was refused (6 Nov 2026 audit): only the rest goes again.
    const st = set && r.broker_order_id ? await dhanStatus(credsOf(set), r.broker_order_id).catch(() => null) : null;
    const done = Math.min(Number(r.qty), Number(st?.filled) || 0);
    if (st && done >= Number(r.qty)) { await onFilled(r, st); return true; }
    if (st && done > 0) {
      await must(() => sb.from("live_orders").update({ state: "filled", avg_px: st.avg ?? null, filled_qty: done, done_at: nowIso(), updated_at: nowIso(),
        note: `${done} of ${r.qty} filled; the rest (${reason.slice(0, 80)}) goes again at market` }).eq("id", r.id), "part of an exit");
      const copy: Record<string, unknown> = { ...r, qty: Number(r.qty) - done, market_retry: true, state: "queued", broker_order_id: null, correlation_id: null, limit_px: null, avg_px: null,
        filled_qty: null, placed_at: null, done_at: null, steps: 0, cross_qty: null, cross_px: null, note: `the rest of order ${r.id}`, updated_at: nowIso() };
      delete copy.id; delete copy.created_at;
      const { data: rest } = await must(() => sb.from("live_orders").insert(copy).select("*").single(), "exit remainder");
      return set ? placeRow(rest as LiveRow, credsOf(set)) : false;
    }
    await sb.from("live_orders").update({ market_retry: true, note: `rejected (${reason.slice(0, 120)}); retrying at market`, updated_at: nowIso() }).eq("id", r.id);
    if (set) return placeRow({ ...r, market_retry: true }, credsOf(set));
  }
  // An entry the exchange cancelled or rejected after part of it traded: that part is the position.
  if (r.purpose === "entry" && r.broker_order_id) {
    const set = await accountFor(sb, r.user_id, "DHAN");
    const st = set ? await dhanStatus(credsOf(set), r.broker_order_id).catch(() => null) : null;
    if (st && Number(st.filled) > 0) { await partEntry(r, st, `the rest was ${reason.slice(0, 80)}`); return false; }
  }
  await sb.from("live_orders").update({ state: "failed", note: reason.slice(0, 300), done_at: nowIso(), updated_at: nowIso() }).eq("id", r.id);
  await sb.from("live_orders").update({ state: "cancelled", note: "not sent: an earlier leg failed", done_at: nowIso() }).eq("batch", r.batch).eq("state", "queued");
  const s = (await sb.from("algo_strategies").select("*").eq("id", r.strategy_id).single()).data as Strategy | null;
  if (s) {
    const anyFilled = (await sb.from("live_orders").select("id").eq("batch", r.batch).eq("state", "filled").eq("purpose", "entry")).data?.length;
    const upd: Record<string, unknown> = { exec_state: null, active: false };
    if (r.purpose === "exit") {
      const exRows = (await sb.from("live_orders").select("sec, qty, filled_qty, avg_px, state").eq("batch", r.batch).eq("purpose", "exit")).data ?? [];
      const filledRows = exRows.filter((x) => x.state === "filled");
      // One contract closed in part, the rest refused: the part is a real trade, the rest is still open at Dhan.
      const single = !isMulti(s) && exRows.every((x) => x.sec === r.sec);
      const partQty = single ? filledRows.reduce((a, x) => a + (Number(x.filled_qty) || Number(x.qty)), 0) : 0;
      const fullQty = Math.max(0, ...exRows.map((x) => Number(x.qty) || 0));
      if (r.restore && s.exec_state === "working" && (!filledRows.length || (single && partQty > 0 && partQty < fullQty))) {
        // Still open at Dhan (all of it, or the rest): the desk holds it again, with its stops; the booked trade was never real.
        const back: Record<string, unknown> = { ...(r.restore as Record<string, unknown>), exec_state: null, pos_ltp_at: null };
        await sb.from("algo_trades").update({ hidden: true, provisional: false, exit_why: `Not executed: Dhan rejected the exit (${reason.slice(0, 80)})` }).eq("order_batch", r.batch).eq("provisional", true);
        if (partQty > 0) {
          const set = await accountFor(sb, r.user_id, "DHAN");
          const wavg = filledRows.reduce((a, x) => a + Number(x.avg_px) * (Number(x.filled_qty) || Number(x.qty)), 0) / partQty;
          if (set && wavg > 0) Object.assign(back, await bookPart({ ...s, ...back } as Strategy, set, { seg: r.seg, sec: r.sec, lot: r.lot, option: !!r.option, id: r.broker_order_id },
            partQty, fullQty, wavg, `${String((back.pos_broker as PosBroker | null)?.exitWhy ?? r.event ?? "exit")} — part closed at Dhan before the rest was rejected`));
        }
        await exitFailed({ ...s, ...back } as Strategy, back, String((back.pos_broker as PosBroker | null)?.exitWhy ?? r.event ?? "exit"),
          `Dhan rejected the exit for ${r.label} (${reason.slice(0, 120)}), also at market${partQty > 0 ? `; ${partQty} of ${fullQty} had already closed` : ""}`);
        await must(() => sb.from("algo_strategies").update(back).eq("id", s.id), "position put back");
        return false;
      }
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
/** Exit attempts after a failure before the desk stops trying by itself (one a minute). */
const EXIT_TRIES = 5;
/**
 * An exit that didn't go, or that Dhan / Delta refused (4 Nov 2026): the desk keeps the position with its stops (the
 * broker stop is placed again), tells the owner and tries the exit again on the next minute (exec_state 'exit_retry').
 * After EXIT_TRIES attempts in a row it stops trying, stops new trades and asks for the position to be closed by hand.
 * Writes into `update` (the caller saves it).
 */
async function exitFailed(s: Strategy, update: Record<string, unknown>, why: string, what: string) {
  const pb0 = (update.pos_broker !== undefined ? update.pos_broker : s.pos_broker) as PosBroker | null;
  const tries = (Number(pb0?.exitTries) || 0) + 1;
  const where = isCrypto(String(s.data_segment)) ? "Delta Exchange" : "Dhan";
  if (pb0) update.pos_broker = { ...pb0, exitTries: tries, exitWhy: String(pb0.exitWhy ?? why).slice(0, 150) };
  if (tries >= EXIT_TRIES) {
    Object.assign(update, { exec_state: null, exec_at: null, active: false,
      last_error: `The exit failed ${tries} times (${what}). The desk has stopped trying and stopped new trades: close the position in ${where}.` });
    await alert(s, "Exit failed: close it by hand", `${what}. After ${tries} attempts the desk has stopped trying. The position is still open: close it in ${where}. Its stop-loss stays in place.`, `exitfail-${s.id}-${tries}`);
    return;
  }
  Object.assign(update, { exec_state: "exit_retry", exec_at: nowIso(),
    last_error: `Exit not done (${what}). The position is still open with its stop; the desk tries the exit again every minute (attempt ${tries} of ${EXIT_TRIES}).` });
  await alert(s, "Exit not done yet", `${what}. The position is still open and keeps its stop-loss; the desk tries the exit again in a minute (attempt ${tries} of ${EXIT_TRIES}).`, `exitfail-${s.id}-${tries}`);
}
/**
 * Part of an entry filled and the rest is gone (cancelled after the price ran away, or rejected by the exchange): the
 * desk holds what filled, at Dhan's price, with its quantity, margin and stop for that part (4 Nov 2026; it used to go
 * flat while the filled part stayed open at Dhan). Structures can't be held in part: those are left to close by hand.
 */
async function partEntry(r: LiveRow, st: BrokerStatus, rest: string) {
  const filled = Number(st.filled) || 0;
  await sb.from("live_orders").update({ state: "filled", avg_px: st.avg ?? null, filled_qty: filled, done_at: nowIso(), updated_at: nowIso(),
    note: `${filled} of ${r.qty} filled; ${rest}` }).eq("id", r.id);
  await sb.from("live_orders").update({ state: "cancelled", note: "not sent: the entry before it filled only in part", done_at: nowIso() }).eq("batch", r.batch).eq("state", "queued");
  const s = (await sb.from("algo_strategies").select("*").eq("id", r.strategy_id).single()).data as Strategy | null;
  if (!s) return;
  if (isMulti(s)) {
    await sb.from("algo_strategies").update({ ...FLAT_STATE, exec_state: null, active: false, last_error: `Part of ${r.label} filled (${filled} of ${r.qty}), then ${rest}. The strategy is paused: close the filled legs in Dhan.` }).eq("id", s.id);
    await alert(s, "Entry filled in part", `${filled} of ${r.qty} of ${r.label} filled; ${rest}. A structure can't be held in part: close the filled legs in Dhan.`);
    return;
  }
  const avg = st.avg ?? (r.limit_px != null ? Number(r.limit_px) : null);
  const lotsFilled = r.seg === "MCX_COMM" ? filled : filled / (Number(r.lot) || 1);
  const lotsAsked = Number(s.pos_lots) || lotsOf(s) || lotsFilled;
  const pb: PosBroker = { broker: "DHAN", legs: [{ sec: r.sec, seg: r.seg, qty: (r.side === "BUY" ? 1 : -1) * filled, product: r.product }], tick: Number(r.tick),
    step: Number(r.step) || stepFor(avg ?? 0, Number(r.tick), !!r.option), option: !!r.option, offset: 0, fill: avg };
  const indexFut = !r.option && r.seg !== "MCX_COMM";
  pb.offset = indexFut && avg && Number(r.ref_px) > 0 ? +(avg - Number(r.ref_px)).toFixed(2) : 0;
  const upd: Record<string, unknown> = {
    pos_broker: pb, exec_state: null, pos_lots: +lotsFilled.toFixed(4),
    pos_qty: s.qty_mode === "LOTS" ? +lotsFilled.toFixed(4) : Math.round(lotsFilled * Number(s.lot_size)),
    pos_margin: s.pos_margin != null && lotsAsked > 0 ? Math.trunc(Number(s.pos_margin) * lotsFilled / lotsAsked) : s.pos_margin,
    last_error: null,
  };
  if (avg) { if (s.trade_type === "OPTIONS") upd.pos_entry_prem = +Number(avg).toFixed(2); else if (!indexFut) upd.pos_entry_px = +Number(avg).toFixed(2); }
  await must(() => sb.from("algo_strategies").update(upd).eq("id", s.id), "part entry");
  await alert(s, "Entry filled in part", `${filled} of ${r.qty} of ${r.label} filled at ${avg ?? "?"}; ${rest}. The desk holds the part that filled and places its stop-loss for it.`);
}

/** Lots a broker quantity stands for (MCX orders are in lots, NSE / BSE in units, Delta in contracts per lot). */
const lotsOfQty = (seg: string, qty: number, lot: number) => seg === "MCX_COMM" ? qty : qty / (lot || 1);
/**
 * Part of an exit traded before the rest of it was refused (6 Nov 2026 audit — the desk used to send the whole quantity
 * again, over-closing the position and opening one the other way). That part is a real trade at the broker's price, and
 * the position shrinks to what is still open. Returns the fields to write on the strategy (the caller writes them).
 */
async function bookPart(s: Strategy, set: Settings, leg: { seg: string; sec: string; lot: number | null; option: boolean; id: string | null }, filledQty: number, ofQty: number, avg: number, why: string): Promise<Record<string, unknown>> {
  const pb = s.pos_broker as PosBroker | null;
  const lotsDone = lotsOfQty(leg.seg, filledQty, Number(leg.lot) || Number(s.lot_size) || 1);
  const part: Strategy = { ...s, pos_lots: lotsDone, pos_qty: s.qty_mode === "LOTS" ? lotsDone : Math.round(lotsDone * Number(s.lot_size)) };
  const indexFut = !leg.option && leg.seg !== "MCX_COMM" && leg.seg !== "DELTA";
  const px = indexFut ? avg - (pb?.offset || 0) : avg; // index futures are booked on the index basis, like their entry
  const update: Record<string, unknown> = {};
  lastLiveBatch = null; // this part is final (the broker's own price), not provisional
  await bookPnl(part, set, update, px, `${why} (${filledQty} of ${ofQty})`.slice(0, 200), s.trade_type === "OPTIONS" ? avg : undefined);
  await saveFills([{ ...fillOf(part, "Exit", px), broker_px: +Number(avg).toFixed(2), broker_qty: filledQty, broker_ids: [String(leg.id ?? "")], broker_at: nowIso() }]);
  const left = Math.max(0, Number(s.pos_qty) - Number(part.pos_qty));
  const legs = (pb?.legs ?? []).map((l) => l.sec === leg.sec ? { ...l, qty: Math.sign(l.qty) * Math.max(0, Math.abs(l.qty) - filledQty) } : l);
  Object.assign(update, {
    pos_qty: left, pos_lots: s.qty_mode === "LOTS" ? left : Math.round(left / (Number(s.lot_size) || 1)),
    pos_margin: s.pos_margin != null && Number(s.pos_qty) > 0 ? Math.trunc(Number(s.pos_margin) * left / Number(s.pos_qty)) : s.pos_margin,
    pos_broker: pb ? { ...pb, legs } : pb,
  });
  return update;
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
  // Part (or all) of the order may have been matched inside the desk with another strategy's opposite order.
  const cq = Number(r.cross_qty) || 0, cp = Number(r.cross_px) || 0;
  const exch = Number(r.qty) > 0 ? (st.filled || Number(r.qty)) : 0, exAvg = st.avg ?? (r.limit_px != null ? Number(r.limit_px) : null);
  const avg = cq ? (exch && exAvg ? +((cq * cp + exch * exAvg) / (cq + exch)).toFixed(4) : cp) : exAvg;
  const total = cq + exch;
  st = { ...st, filled: total, avg };
  await must(() => sb.from("live_orders").update({ state: "filled", avg_px: avg, filled_qty: total, done_at: nowIso(), updated_at: nowIso() }).eq("id", r.id), "order filled");
  if (r.signal_id && avg) {
    const { data: g } = await sb.from("algo_signals").select("fills").eq("id", r.signal_id).single();
    const fills = (g?.fills ?? []) as Fill[];
    const f = fills.find((x) => x.leg === (r.purpose === "exit" ? "Exit" : "Entry") && x.broker_px == null && x.side === r.side);
    if (f) { f.broker_px = +Number(avg).toFixed(2); f.broker_qty = st.filled || r.qty; f.broker_ids = [String(r.broker_order_id ?? "matched inside the desk")]; f.broker_at = nowIso(); await sb.from("algo_signals").update({ fills }).eq("id", r.signal_id); }
  }
  const s = (await sb.from("algo_strategies").select("*").eq("id", r.strategy_id).single()).data as Strategy | null;
  if (!s) return;
  if (r.purpose === "entry") {
    const pb = ((s.pos_broker ?? null) as PosBroker | null) ?? { broker: "DHAN", legs: [], tick: Number(r.tick), step: Number(r.step) || stepFor(avg ?? 0, Number(r.tick), !!r.option), option: !!r.option, offset: 0, fill: null };
    pb.legs.push({ sec: r.sec, seg: r.seg, qty: (r.side === "BUY" ? 1 : -1) * Number(st.filled), product: r.product });
    pb.fill = avg;
    // Index futures trade above / below the index the desk watches: the gap at the fill moves the broker stop with it.
    const indexFut = !r.option && r.seg !== "MCX_COMM";
    pb.offset = indexFut && avg && Number(r.ref_px) > 0 ? +(avg - Number(r.ref_px)).toFixed(2) : 0;
    const upd: Record<string, unknown> = { pos_broker: pb };
    if (!isMulti(s) && avg) {
      if (s.trade_type === "OPTIONS") upd.pos_entry_prem = +Number(avg).toFixed(2);
      else if (!indexFut) upd.pos_entry_px = +Number(avg).toFixed(2);
    }
    await must(() => sb.from("algo_strategies").update(upd).eq("id", s.id), "fill record");
  } else if (avg) await fixLedger(s, r, avg);
  await afterRow(s.id, r.batch);
}
/**
 * The closed trade at the prices Dhan actually filled (entry and exit), with charges and the day's total corrected.
 * Found by its order batch (4 Nov 2026; before that, the latest live trade within 10 minutes) and marked confirmed
 * (provisional = false). A structure is corrected once its last exit leg has filled, leg by leg.
 */
async function fixLedger(s: Strategy, r: LiveRow, exitAvg: number) {
  let t: Record<string, any> | undefined = r.batch ? (await sb.from("algo_trades").select("*").eq("order_batch", r.batch).eq("hidden", false).limit(1)).data?.[0] : undefined;
  if (!t) {
    const { data: tr } = await sb.from("algo_trades").select("*").eq("strategy_id", s.id).eq("mode", "LIVE").gte("exit_at", new Date(Date.parse(r.created_at) - 10 * 60000).toISOString())
      .order("exit_at", { ascending: false }).limit(1);
    t = tr?.[0];
  }
  if (!t) return;
  const entryOf = async (sec: string) => (await sb.from("live_orders").select("avg_px, qty, filled_qty, lot, option, seg").eq("strategy_id", s.id).eq("sec", sec).eq("purpose", "entry").eq("state", "filled")
    .lt("created_at", r.created_at).order("created_at", { ascending: false }).limit(1)).data?.[0];
  const cfg = { from: "", to: "", capital: 0, brokerage: 20, charges: ratesFor(s), near_code: 1 };
  let gross = 0, costs = 0, inPx: number | null = null, outPx: number | null = null;
  if (isMulti(s)) {
    const { data: ex } = await sb.from("live_orders").select("*").eq("batch", r.batch).eq("purpose", "exit");
    if (!ex?.length || ex.some((x) => x.state !== "filled" || !(Number(x.avg_px) > 0))) return; // the other legs aren't in yet
    for (const x of ex) {
      const e = await entryOf(String(x.sec));
      if (!e?.avg_px) return; // an entry fill is missing: the estimate stays
      const u = Number(x.filled_qty) || Number(x.qty), a = Number(e.avg_px), b = Number(x.avg_px), dir = x.side === "SELL" ? 1 : -1;
      gross += (b - a) * dir * u;
      costs += tradeCharges(cfg, !!x.option, (dir === 1 ? a : b) * u, (dir === 1 ? b : a) * u).total;
    }
  } else {
    const e = await entryOf(String(r.sec));
    if (!e?.avg_px) return;
    // An exit that went in two orders (a part filled before the rest was re-sent at market) is priced on all its fills.
    const { data: exRows } = await sb.from("live_orders").select("avg_px, filled_qty, qty").eq("batch", r.batch).eq("purpose", "exit").eq("sec", r.sec).eq("state", "filled");
    const tot = (exRows ?? []).reduce((a, x) => a + (Number(x.filled_qty) || Number(x.qty)), 0);
    const wavg = tot > 0 && (exRows ?? []).length > 1 && (exRows ?? []).every((x) => Number(x.avg_px) > 0)
      ? (exRows ?? []).reduce((a, x) => a + Number(x.avg_px) * (Number(x.filled_qty) || Number(x.qty)), 0) / tot : exitAvg;
    inPx = Number(e.avg_px); outPx = +wavg.toFixed(4);
    const units = Number(t.units), dir = r.side === "SELL" ? 1 : -1; // the exit sells what was bought
    gross = (outPx - inPx) * dir * units;
    costs = tradeCharges(cfg, !!r.option, (dir === 1 ? inPx : outPx) * units, (dir === 1 ? outPx : inPx) * units).total;
  }
  const net = Math.trunc(gross - costs);
  await sb.from("algo_trades").update({ ...(inPx != null ? { entry_px: +inPx.toFixed(2), exit_px: +outPx!.toFixed(2) } : {}), gross: Math.trunc(gross), costs: Math.trunc(costs), net, provisional: false,
    exit_why: `${String(t.exit_why ?? "").replace(/ · Dhan fills$/, "").slice(0, 150)} · Dhan fills`.slice(0, 200) }).eq("id", t.id);
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
          // Booking a stop fill goes through the same lock as every other booking (it shares the signal / ledger state).
          if (r.state === "resting") { await actLocked(() => checkStop(r, set)); continue; }
          // An order matched inside the desk earlier in this pass (crossInside) has moved on: never judge it on old data.
          const { data: fresh } = await sb.from("live_orders").select("state, broker_order_id").eq("id", r.id).maybeSingle();
          if (!fresh || fresh.state !== r.state || fresh.broker_order_id !== r.broker_order_id) continue;
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
            const ss = String(again?.status ?? "").toUpperCase();
            if (ss === "TRADED") { await onFilled(r, again!); continue; }
            // Still open at Dhan (the cancel didn't take, or its state couldn't be read): never call it given up while
            // it can still fill; the next pass tries again.
            if (!again || !/CANCEL|REJECT|EXPIRE/.test(ss)) { done.push(`${r.id}:cancel pending`); continue; }
            // Cancelled with part of it traded: the desk holds what filled.
            if (again.filled > 0) { await partEntry(r, again, `the rest was cancelled after the price moved away (last ${ltp ?? "?"})`); continue; }
            await giveUp(r, ltp);
          }
        } catch (e) {
          done.push(`${r.id}:error ${e instanceof Error ? e.message : e}`);
          await sb.from("live_orders").update({ note: `check failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`, updated_at: nowIso() }).eq("id", r.id);
        }
      }
    }
    // Strategies still marked as having orders worked long after they went out (4 Nov 2026).
    await stuckWorking(done);
    // A position that has just filled gets its stop order at the broker straight away (not at the next minute's tick);
    // so does one whose exit is being retried, and one whose stop expired at yesterday's close (at the session open).
    const { data: open } = await sb.from("algo_strategies").select("*").eq("live", true).neq("position", "FLAT").or("exec_state.is.null,exec_state.eq.exit_retry").not("pos_broker", "is", null);
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
/**
 * A strategy marked "orders working" for over STUCK_MIN minutes (4 Nov 2026: while it is, no stop of the desk runs
 * and no broker stop is placed): its orders are read again from Dhan. A fill is booked, a final rejection handled; an
 * order still queued behind a finished leg is sent; a flag with nothing left to work is cleared. An order still open
 * at Dhan is left working (it may fill) and the owner is told once.
 */
const STUCK_MIN = 10;
async function stuckWorking(done: string[]) {
  const { data: st } = await sb.from("algo_strategies").select("*").eq("exec_state", "working");
  for (const s of st ?? []) {
    const { data: rows } = await sb.from("live_orders").select("*").eq("strategy_id", s.id).in("state", ["queued", "working"]).order("seq");
    const last = Math.max(Date.parse(s.exec_at ?? "") || 0, ...(rows ?? []).map((r) => Date.parse(r.updated_at ?? r.placed_at ?? r.created_at) || 0));
    if (last && Date.now() - last < STUCK_MIN * 60000) continue;
    try {
      if (!rows?.length) {
        await sb.from("algo_strategies").update({ exec_state: null }).eq("id", s.id).eq("exec_state", "working");
        await alert(s, "Order state cleared", `The strategy was still marked as having orders worked at the broker, but none were left. The flag is cleared so its stops run again. Check its position at ${isCrypto(String(s.data_segment)) ? "Delta Exchange" : "Dhan"}.`, `stuck-${s.id}`);
        done.push(`${s.id}:stuck cleared`);
        continue;
      }
      const set = await accountFor(sb, s.owner_id, "DHAN");
      if (!set?.dhan_access_token) {
        await alert(s, "Orders can't be checked", "Orders of this strategy are open at Dhan but the desk can't reach your Dhan account (no access token). Reconnect Dhan, and check the orders in Dhan meanwhile.", `stuck-${s.id}`);
        continue;
      }
      const c = credsOf(set);
      let stillOpen = false;
      for (const r of rows) {
        if (r.state === "queued") {
          const before = (await sb.from("live_orders").select("id").eq("batch", r.batch).lt("seq", r.seq).in("state", ["queued", "working"])).data?.length;
          if (!before) { await placeRow(r, c); done.push(`${r.id}:queued sent`); }
          continue;
        }
        if (!r.broker_order_id) { await placeRow(r, c); continue; }
        const b = await dhanStatus(c, r.broker_order_id).catch(() => null);
        const ss = String(b?.status ?? "").toUpperCase();
        if (b && (ss === "TRADED" || (b.qty > 0 && b.filled >= b.qty))) { await onFilled(r, b); done.push(`${r.id}:stuck filled`); }
        else if (b && /CANCEL|REJECT|EXPIRE/.test(ss)) { await failRow(r, b.reason || ss.toLowerCase()); done.push(`${r.id}:stuck failed`); }
        else stillOpen = true;
      }
      if (stillOpen) await alert(s, "Order still open at Dhan", `An order of this strategy has been open at Dhan for over ${STUCK_MIN} minutes. The desk keeps checking it; meanwhile its own stops wait. Check the order in Dhan.`, `stuck-${s.id}`);
    } catch (e) { done.push(`${s.id}:stuck check failed ${e instanceof Error ? e.message : e}`); }
  }
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
  // Dhan takes stop orders only while the market is open (they are day orders and expire at the close): a position
  // held overnight gets its stop again at the next session's open (4 Nov 2026).
  if (pb.broker === "DHAN" && !inSessionNow(String(s.data_segment))) return s;
  const w = wantedStop(s, pb);
  if (!w) return s;
  // Delta: a reduce-only stop can't work while another strategy of the account holds the same coin (the net position
  // may be nothing, or the other way): then the stop is a plain one, and it is re-placed whenever that changes.
  let ro = true;
  if (pb.broker === "DELTA") {
    const sym0 = String(pb.symbol ?? pb.legs[0]?.sec);
    ro = !((await othersHolding(s)).get(brokerKey("DELTA", sym0)) ?? 0);
    if (pb.stopId && (pb.stopRO ?? true) !== ro) {
      // The old stop must be gone before a new one goes in (two stops could both fill).
      try { await deltaCancel(sb, set.user_id, sym0, pb.stopId); }
      catch (e) {
        const st = await deltaOrderState(sb, set.user_id, pb.stopId).catch(() => null);
        if (!st || st.state !== "cancelled") { console.error("stop replace", e); return s; }
      }
      await sb.from("live_orders").update({ state: "cancelled", done_at: nowIso(), note: ro ? "replaced by a reduce-only stop (no other strategy holds this coin now)" : "replaced by a plain stop (another strategy holds this coin)" })
        .eq("broker_order_id", pb.stopId).eq("state", "resting");
      pb.stopId = null; pb.stopTrig = null;
    }
  }
  if (pb.stopId && pb.stopTrig != null && (w.long ? w.trig <= pb.stopTrig : w.trig >= pb.stopTrig)) return s; // not tighter
  const leg = pb.legs[0], side: Side = w.long ? "SELL" : "BUY", qty = Math.abs(leg.qty);
  const next: PosBroker = { ...pb, stopErrAt: null };
  try {
    if (pb.broker === "DELTA") {
      const sym = String(pb.symbol ?? leg.sec);
      if (pb.stopId) await deltaStopMove(sb, set.user_id, sym, pb.stopId, w.trig);
      else { next.stopId = await deltaStop(sb, set.user_id, { symbol: sym, size: qty, side: side === "BUY" ? "buy" : "sell", stop: w.trig, reduceOnly: ro }); next.stopRO = ro; }
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
  try { await must(() => sb.from("algo_strategies").update({ pos_broker: next }).eq("id", s.id), "stop order record"); }
  catch (e) {
    // The record of the stop just placed couldn't be saved: without it a second stop would go in next minute, so the
    // new one is taken back and the owner told (6 Nov 2026 audit).
    if (next.stopId && !pb.stopId) {
      try { if (pb.broker === "DELTA") await deltaCancel(sb, set.user_id, String(pb.symbol ?? leg.sec), next.stopId); else await dhanCancel(credsOf(set), next.stopId); }
      catch (e2) { console.error("stop take-back", e2); }
      await sb.from("live_orders").update({ state: "cancelled", done_at: nowIso(), note: "taken back: its record couldn't be saved" }).eq("broker_order_id", next.stopId).eq("state", "resting");
    }
    await alert(s, "Stop order record not saved", `The stop-loss order was placed but the desk couldn't save its record (${e instanceof Error ? e.message : e}), so it was cancelled again (two stops must never rest at once). The desk still watches its own stop and tries again in a minute.`, `stoprec-${s.id}`);
    throw e;
  }
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
      // A day order expiring at the close is normal for a position held overnight (a new stop goes in at the next open);
      // one that expires or is cancelled while the market is open is not.
      const expected = state === "EXPIRED" && !inSessionNow(String(s0.data_segment));
      if (!expected) await alert(s0, "Stop order cancelled", `The stop-loss order at the broker was ${state.toLowerCase()}. A new one is placed within 10 minutes; the desk keeps watching its own stop.`, `stopgone-${r.id}`);
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
  lastLiveBatch = r.broker === "DHAN" ? r.batch : null; // corrected to Dhan's prices just below (fixLedger)
  const out = await bookPnl(s, set, update, under, `Stop-loss order at the broker${avg ? ` (${avg})` : ""}`, opt ? avg : undefined);
  lastLiveBatch = null;
  await saveFills([{ ...fillOf(s, "Exit", out), broker_px: avg ?? undefined, broker_qty: filled, broker_ids: [String(r.broker_order_id)], broker_at: nowIso() }]);
  Object.assign(update, FLAT_STATE);
  await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "position after the broker stop");
  if (r.broker === "DHAN" && avg) await fixLedger(s, { ...r, created_at: nowIso() }, avg);
}

/* ---------- desk vs broker, every 5 minutes ---------- */
async function reconcile() {
  // Paused strategies too (4 Nov 2026): the ones most likely to be out of step with the broker.
  const { data: live0 } = await sb.from("algo_strategies").select("*").eq("live", true).not("archived", "is", true);
  const live = await withMasters(sb, live0 ?? []);
  // An open live position with a stop of its own but no stop order at the broker, 5 minutes into its session.
  for (const s of live) {
    const pb = s.pos_broker as PosBroker | null;
    if (s.position === "FLAT" || !pb || pb.stopId || s.exec_state === "working") continue;
    const nowI = ist(Date.now() / 1000), ss = tradingSession(String(s.data_segment), nowI.date);
    if (!isCrypto(String(s.data_segment)) && !(nowI.min >= ss.open + 5 && nowI.min <= ss.close)) continue;
    if (!wantedStop(s as Strategy, pb)) continue;
    await alert(s as Strategy, "No stop order at the broker", `This live position has a stop-loss but no stop order is resting at ${pb.broker === "DELTA" ? "Delta Exchange" : "Dhan"}. The desk keeps trying to place it and watches its own stop every second meanwhile.`, `nostop-${s.id}-${nowI.date}`);
  }
  const byUser = new Map<string, Strategy[]>();
  for (const s of live) byUser.set(s.owner_id, [...(byUser.get(s.owner_id) ?? []), s]);
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

/* ---------- error circuit breaker per account (Phase 2, 4 Nov 2026; migration 72) ---------- */
/** Failed minutes in a row (every strategy run of the account failed) before new trades stop for the account. */
const BREAKER_TICKS = 5;
type Breaker = { user_id: string; err_ticks: number; last_error: string | null; halted_at: string | null; halt_reason: string | null };
const tickMode0 = (action: string, body: { strategy_id?: string }) => (action === "tick" || action === "tick_crypto") && !body.strategy_id;
async function loadBreakers(rows: Strategy[]): Promise<Map<string, Breaker>> {
  const ids = [...new Set(rows.map((x) => String(x.owner_id ?? "")).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data } = await sb.from("risk_state").select("*").in("user_id", ids);
  return new Map((data ?? []).map((b) => [String(b.user_id), b as Breaker]));
}
/**
 * After a tick: an account where at least one strategy run worked starts counting again from 0; one where every run
 * failed (Dhan, token or engine errors) counts one more. At BREAKER_TICKS in a row new trades stop for the whole
 * account, paper and live (exits, stops and square-off keep running), and the owner is told. Only "Allow new trades
 * again" (breaker_allow) clears it. Strategies that were only waiting for their candle don't count either way.
 */
async function breakerAfterTick(ok: Set<string>, err: Map<string, string>, known: Map<string, Breaker>) {
  for (const u of new Set([...ok, ...err.keys()])) {
    const b = known.get(u);
    if (ok.has(u)) { if (b && b.err_ticks) await sb.from("risk_state").update({ err_ticks: 0, updated_at: nowIso() }).eq("user_id", u); continue; }
    // An account counts as failing only when none of its active strategies last ran cleanly (6 Nov 2026 audit: one
    // strategy with a bad contract next to quiet 15-minute ones used to stop the whole account's trades).
    const { data: fine } = await sb.from("algo_strategies").select("id").eq("owner_id", u).eq("active", true).eq("archived", false).is("last_error", null).limit(1);
    if (fine?.length) continue;
    const msg = String(err.get(u) ?? "").slice(0, 300), n = (b?.err_ticks ?? 0) + 1;
    const halt = n >= BREAKER_TICKS && !b?.halted_at;
    await sb.from("risk_state").upsert({ user_id: u, err_ticks: n, last_error: msg, updated_at: nowIso(),
      ...(halt ? { halted_at: nowIso(), halt_reason: msg } : { halted_at: b?.halted_at ?? null, halt_reason: b?.halt_reason ?? null }) }, { onConflict: "user_id" });
    if (halt) await sb.rpc("notify_tagged", { p_user: u, p_kind: "error", p_title: "New trades stopped: repeated errors",
      p_body: `Every strategy run of your account failed ${n} minutes in a row (${msg.slice(0, 160)}). New trades are stopped, paper and live; open positions keep their stops and exits. Fix the cause, then tap "Allow new trades again".`.slice(0, 400),
      p_url: "/", p_strategy: null, p_tag: `breaker-${u}-${todayIst()}` });
  }
}
/* ---------- positional futures across their expiry: roll the day before (Papa, 4 Nov 2026) ---------- */
/** The futures symbol the contract lists use ("GOLD1!" → GOLD). */
const futSym = (s: Strategy) => String(s.futures_symbol ?? "").replace(/[1-9]!$/, "").toUpperCase() || String(s.underlying);
/** Expiry of the first futures contract after a day (MCX: expiring after it; NSE / BSE: on or after it, as resolveLeg picks). */
async function futExpiryAfter(s: Strategy, onDate: string, strict = false): Promise<string | null> {
  if (String(s.exchange).toUpperCase() === "MCX" || isCommodity(String(s.data_segment))) {
    const { data } = await sb.from("mcx_contracts").select("expiry").eq("underlying", futSym(s)).gt("expiry", onDate).order("expiry").limit(1);
    return data?.[0]?.expiry ? String(data[0].expiry).slice(0, 10) : null;
  }
  const seg = String(s.exchange).toUpperCase() === "BSE" ? "BSE_FNO" : "NSE_FNO";
  let q = sb.from("fno_contracts").select("expiry").eq("seg", seg).eq("underlying", futSym(s)).eq("instrument", isStockSeg(String(s.data_segment)) ? "FUTSTK" : "FUTIDX");
  q = strict ? q.gt("expiry", onDate) : q.gte("expiry", onDate);
  const { data } = await q.order("expiry").limit(1);
  return data?.[0]?.expiry ? String(data[0].expiry).slice(0, 10) : null;
}
/** The expiry of the futures contract a position holds: kept in pos_expiry after a roll, else the near month on its entry day. */
async function heldFutExpiry(s: Strategy): Promise<string | null> {
  if (s.pos_expiry) return String(s.pos_expiry).slice(0, 10);
  const pb = s.pos_broker as PosBroker | null;
  if (pb?.broker === "DHAN" && pb.legs?.length === 1) {
    const l = pb.legs[0];
    const { data } = l.seg === "MCX_COMM" ? await sb.from("mcx_contracts").select("expiry").eq("sec_id", l.sec).maybeSingle()
      : await sb.from("fno_contracts").select("expiry").eq("seg", l.seg).eq("sec_id", l.sec).maybeSingle();
    if (data?.expiry) return String(data.expiry).slice(0, 10);
  }
  return s.pos_entry_date ? futExpiryAfter(s, String(s.pos_entry_date).slice(0, 10)) : null;
}
/** The last weekday before a day (holidays aren't known that far ahead; a holiday makes the roll a day later at worst). */
function dayBefore(d: string): string {
  let x = addDays(d, -1);
  for (let i = 0; i < 4; i++) { const wd = new Date(`${x}T12:00:00+05:30`).getUTCDay(); if (wd !== 0 && wd !== 6) break; x = addDays(x, -1); }
  return x;
}
/** Roll time on the day before expiry (risk.roll_time, default 15:00 IST). */
const rollTime = (s: Strategy) => /^\d{2}:\d{2}$/.test(String(s.risk?.roll_time ?? "")) ? String(s.risk.roll_time) : "15:00";
/**
 * The expiry to roll away from now, or null: a positional (carried overnight) futures position, from the roll time on
 * the trading day before its contract's expiry (and at once on expiry day if that was missed). risk.roll = false opts out.
 */
async function rollDue(s: Strategy): Promise<string | null> {
  if (s.position === "FLAT" || s.trade_type !== "FUTURES" || isMulti(s) || isCrypto(String(s.data_segment))) return null;
  if (s.intraday || /^(I|INTRA|INTRADAY|MIS)$/i.test(String(s.product_type ?? "")) || s.risk?.roll === false) return null;
  if (s.exec_state === "working" || s.exec_state === "exit_retry") return null;
  const exp = await heldFutExpiry(s);
  if (!exp) return null;
  const now = ist(Date.now() / 1000), d = dayBefore(exp);
  if (now.date > d) return exp;
  const [h, m] = rollTime(s).split(":").map(Number);
  return now.date === d && now.min >= h * 60 + m ? exp : null;
}
/**
 * Rolls a futures position: one order closes the expiring contract, the next opens the same side, same lots, in the
 * contract after it (live: worked as a reversal is, the entry only after the exit fills). The closed part is booked as a
 * trade ("Rolled to the next month"); the position goes on with its stops, entry price = the price now, and pos_expiry =
 * the new contract's expiry so it isn't rolled twice.
 */
async function rollFutures(s: Strategy, set: Settings, exp: string) {
  await actLocked(async () => {
    const update: Record<string, unknown> = { last_run_at: nowIso() };
    let px: number | null = null;
    try { px = await dhanFor(set).ltp(String(s.data_segment), String(s.data_security_id)); } catch { px = null; }
    px = px ?? (Number(s.pos_ltp) || null);
    const next = await futExpiryAfter(s, exp, true);
    if (!px || !next) {
      await alert(s, "Roll not done", `The position's contract expires on ${exp}, but ${!next ? "the next month's contract isn't in the contract list yet" : "there is no price now"}. The desk tries again in a minute; close or roll it in ${s.live ? "Dhan" : "the desk"} if this keeps failing.`, `rollfail-${s.id}-${exp}`);
      return;
    }
    const exitL = asArr(exitLeg(s, 1)), lots = lotsOf(s);
    const e = entryLeg({ ...s, lots }, s.position as Pos, px, exitL.length + 1, lots);
    const entryL = asArr(e.leg).map((l) => ({ ...l, _after: exp }));
    const why = `Rolled to the next month before the ${exp} expiry`;
    const ok = await sendOrders(s, set, "ROLL", [...exitL, ...entryL], `${why}: ${exitLabel(s)} → ${e.label} (${next} contract)`, { c: px });
    if (!ok) { await exitFailed(s, update, why, "the roll's exit didn't go"); await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "roll retry state"); return; }
    const out = await bookPnl(s, set, update, px, why);
    await saveFills([fillOf(s, "Exit", out), fillOf({ ...s, ...e.state, position: s.position }, "Entry", px)]);
    Object.assign(update, { pos_entry_px: px, pos_entry_date: todayIst(), pos_expiry: next, pos_ltp: null, pos_ltp_at: null, pos_upnl: null });
    await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "position after the roll");
  });
}
/** Tries an exit that failed before (exec_state 'exit_retry') again, once a minute. True when it handled the strategy. */
async function retryExit(s: Strategy, set: Settings): Promise<boolean> {
  if (s.exec_state !== "exit_retry" || s.position === "FLAT") return false;
  if (s.exec_at && Date.now() - Date.parse(s.exec_at) < 50000) return true; // its minute isn't up yet
  const pb = s.pos_broker as PosBroker | null;
  let px: number | null = null;
  if (s.trade_type !== "OPTIONS" && !isMulti(s)) { try { px = await dhanFor(set).ltp(String(s.data_segment), String(s.data_security_id)); } catch { px = null; } }
  const update: Record<string, unknown> = { last_run_at: nowIso() };
  const n = (Number(pb?.exitTries) || 0) + 1;
  await flatten(s, set, update, { c: px ?? (Number(s.pos_ltp) || undefined) }, `Exit retried (attempt ${n} of ${EXIT_TRIES}): ${String(pb?.exitWhy ?? "exit")}`.slice(0, 190), "EXIT");
  await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "position after the exit retry");
  return true;
}
/** When an option position is closed on its expiry day (risk.expiry_exit_time, default 14:30 IST). */
const expiryExitTime = (s: Strategy) => /^\d{2}:\d{2}$/.test(String(s.risk?.expiry_exit_time ?? "")) ? String(s.risk.expiry_exit_time) : "14:30";
/**
 * An option (or a structure with a leg) expiring today, past the expiry-day exit time (4 Nov 2026): closed instead of
 * being left to the exchange's settlement. A strategy can opt out with risk.expiry_exit = false.
 */
function expiryExitDue(s: Strategy): boolean {
  if (s.position === "FLAT" || s.risk?.expiry_exit === false) return false;
  const opt = s.trade_type === "OPTIONS" || isMulti(s);
  if (!opt || isCrypto(String(s.data_segment))) return false;
  const now = ist(Date.now() / 1000);
  const legs = Array.isArray(s.pos_legs) ? (s.pos_legs as MLeg[]) : [];
  const today = String(s.pos_expiry ?? "").slice(0, 10) === now.date || legs.some((l) => l.opt !== "FUT" && String(l.expiry ?? "").slice(0, 10) === now.date);
  if (!today) return false;
  const [h, m] = expiryExitTime(s).split(":").map(Number);
  return now.min >= h * 60 + m;
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
  // The prediction server (Papa's AWS machine): its own key opens pred_pull and pred_push only.
  const predKey = req.headers.get("x-pred-key");
  if (!secret && predKey) {
    if (!(await predKeyOk(sb, predKey))) return new Response("Forbidden", { status: 403 });
    const b = await req.json().catch(() => ({}));
    await loadCryptoAssets(sb).catch(() => {});
    try {
      if (b.action === "pred_pull") return Response.json(await predPull(sb, b));
      if (b.action === "pred_push") return Response.json(await predPush(sb, b));
    } catch (e) { return Response.json({ error: String((e as Error)?.message ?? e) }, { status: 500 }); }
    return new Response("Not allowed", { status: 403 });
  }
  // The fine-tuning workflow on GitHub, vouched for by GitHub's signature: reads candles, sends its results, nothing else.
  const ghToken = req.headers.get("x-gh-oidc");
  if (!secret && !predKey && ghToken) {
    if (!(await githubOidcOk(ghToken))) return new Response("Forbidden", { status: 403 });
    const b = await req.json().catch(() => ({}));
    await loadCryptoAssets(sb).catch(() => {});
    try {
      if (b.action === "pred_pull") return Response.json(await predPull(sb, b));
      if (b.action === "pred_push" && b.model_run) return Response.json(await predPush(sb, { model_run: b.model_run }));
    } catch (e) { return Response.json({ error: String((e as Error)?.message ?? e) }, { status: 500 }); }
    return new Response("Not allowed", { status: 403 });
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
    EdgeRuntime.waitUntil(runBacktestJob(Number(body.backtest_id)).finally(async () => { await sb.rpc("kick_backtests"); }).catch((e) => console.error("backtest", e)));
    return Response.json({ accepted: true });
  }

  // Option-pricing queue: one instalment per call (the schedule paces it), only while no lab run is going.
  if (action === "push") return Response.json({ action, ...(await pushOut()) });
  if (action === "live_test" && body.strategy_id) return Response.json({ action, ...(await liveTest(String(body.strategy_id))) });
  if (action === "orders") return Response.json({ action, ...(await runOrders(Math.min(4, Math.max(1, Number(body.passes) || 4)))) });
  if (action === "reconcile") { const { data: hol } = await sb.from("market_holidays").select("day, exch, opens_at").eq("day", ist(Date.now() / 1000).date); setHolidays(hol ?? []); }
  if (action === "reconcile") return Response.json({ action, ...(await reconcile()) });
  if (action === "prices") { EdgeRuntime.waitUntil(pricesLoop().catch((e) => console.error("price loop", e))); return Response.json({ action, accepted: true }); }
  if (action === "audit") {
    const b = body as { batch?: string; offset?: number };
    const batch = b.batch || `${ist(Date.now() / 1000).date}-${Date.now().toString(36)}`;
    EdgeRuntime.waitUntil(runAudit(batch, Number(b.offset) || 0).catch((e) => console.error("audit", e)));
    return Response.json({ action, accepted: true, batch });
  }
  if (action === "kill") {
    EdgeRuntime.waitUntil(killCheck(Number((body as { offset?: number }).offset) || 0).catch((e) => console.error("kill", e)));
    return Response.json({ action, accepted: true });
  }
  if (action === "pred_feed") return Response.json({ action, ...(await predFeed(sb, credsOf(await adminAccount(sb)))) });
  if (action === "combos") return Response.json({ action, ...(await runCombos(sb)) });
  if (action === "spreads") return Response.json({ action, ...(await runSpreads(sb, credsOf(await adminAccount(sb)))) });
  // Read-only check of the stocks' stored candles: the biggest overnight moves in Dhan's raw prices (a split / bonus
  // shows as a jump of a half, a fifth …; none means Dhan's candles are already adjusted).
  if (action === "stock_gaps" || action.startsWith("stock_gaps:")) { // "stock_gaps:KOTAKBANK" for one stock
    const out: Record<string, unknown> = {};
    await loadStockActions(sb, 0);
    for (const k of STOCK_KEYS.filter((x) => !action.includes(":") || x === action.split(":")[1])) {
      const sets = await readCandles(sb, k, "long", true).catch(() => []);
      const row: Record<string, unknown> = {};
      for (const x of sets) {
        if (!(x.kind === "D" || x.kind === "I5" || x.kind.startsWith("I5Y:"))) continue;
        const days = daysOf(fromCol(x.bars)); // a daily candle is its own day
        const gaps = days.slice(1).map((d, i) => ({ day: d.day, r: +(d.o / days[i].c).toFixed(3) })).sort((a, b) => Math.abs(Math.log(b.r)) - Math.abs(Math.log(a.r))).slice(0, 2);
        row[x.kind] = { first: days[0] && [days[0].day, days[0].c], last: days.at(-1) && [days.at(-1)!.day, days.at(-1)!.c], gaps };
      }
      out[k] = { actions: actionsFor(k), ...row };
    }
    return Response.json({ action, stocks: out });
  }
  if (action === "lab_reverdict") return Response.json({ action, ...(await labReverdict(sb, Math.min(200, Number((body as any).limit) || 50))) });
  if (action === "marks" && body.user_id) return Response.json({ action, marks: await liveMarks(body.user_id, false) });
  if (action === "lab_opt") {
    EdgeRuntime.waitUntil((async () => {
      const creds = credsOf(await adminAccount(sb));
      await labOptStep({ sb, creds, started: Date.now(), chain: async () => {} });
    })().catch((e) => console.error("lab_opt", e)));
    return Response.json({ action, accepted: true });
  }
  // Ideas lab: one instalment per call (the schedule paces it, every minute while the markets are closed).
  if (action === "ideas") {
    EdgeRuntime.waitUntil((async () => {
      const creds = credsOf(await adminAccount(sb).catch(() => null));
      const r = await ideasStep(sb, Date.now(), creds);
      console.log("ideas", JSON.stringify(r));
      // Option pricing works in short slices: hand over to a fresh call straight away while there is more.
      if (r.chain) {
        const { data: sec } = await sb.from("engine_secret").select("secret").single();
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/engine`, { method: "POST", headers: { "Content-Type": "application/json", "x-engine-secret": sec!.secret }, body: JSON.stringify({ action: "ideas" }) });
      }
    })().catch((e) => console.error("ideas", e)));
    return Response.json({ action, accepted: true });
  }
  if (action === "lab_next") {
    const id = await labNext(sb);
    if (id) EdgeRuntime.waitUntil(labLoop().catch((e) => console.error("lab", e)));
    return Response.json({ action, started: id });
  }
  if (action === "lab_start" || action === "lab_start_manual" || action === "lab_start_focus" || action === "lab_start_retest" || action === "lab") {
    if (action !== "lab") {
      const id = action === "lab_start_focus" ? await labStart(sb, true, "focus") : action === "lab_start_retest" ? await labStart(sb, true, "retest") : await labStart(sb, action === "lab_start_manual");
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
    })().catch((e) => console.error("crypto candles", e)));
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
  // Each asset's typical day's move (the lots wizard's "same ₹ on a typical day"), every morning (cron day-moves).
  if (action === "day_moves") return Response.json({ action, assets: await refreshDayMoves(sb), quotes: await tickerRefresh(false).catch((e) => String(e)) });
  if (action === "ticker") return Response.json({ action, quotes: await tickerRefresh(!!body.missing) });
  // Admin look-up in one of Dhan's instrument lists (6 Nov 2026, adding assets): rows whose underlying / symbol match q.
  if (action === "instr_find") {
    const b2 = body as { seg?: string; q?: string; ins?: string; limit?: number };
    const seg = String(b2.seg || "NSE_FNO"), q = String(b2.q || "").toUpperCase(), adm = credsOf(await adminAccount(sb));
    if (!/^[A-Z_]+$/.test(seg) || !q) return Response.json({ error: "seg and q needed" }, { status: 400 });
    const r = await fetch(`https://api.dhan.co/v2/instrument/${seg}`, { headers: { Accept: "text/csv", "access-token": adm.token, "client-id": adm.client }, signal: AbortSignal.timeout(45000) });
    if (!r.ok) return Response.json({ error: `HTTP ${r.status}` });
    const lines = (await r.text()).split(/\r?\n/), head = lines[0].split(","), pick = ["SECURITY_ID", "INSTRUMENT", "UNDERLYING_SECURITY_ID", "UNDERLYING_SYMBOL", "SYMBOL_NAME", "DISPLAY_NAME", "SM_EXPIRY_DATE", "STRIKE_PRICE", "OPTION_TYPE", "LOT_SIZE", "TICK_SIZE", "EXPIRY_FLAG"];
    const ix = pick.map((k) => head.indexOf(k)), out: Record<string, string>[] = [], counts: Record<string, number> = {};
    for (const line of lines.slice(1)) {
      const a2 = line.split(",");
      const hay = [a2[head.indexOf("UNDERLYING_SYMBOL")], a2[head.indexOf("SYMBOL_NAME")], a2[head.indexOf("DISPLAY_NAME")]].join(" ").toUpperCase();
      if (!hay.includes(q)) continue;
      if (b2.ins && a2[head.indexOf("INSTRUMENT")] !== b2.ins) continue;
      const ins = a2[head.indexOf("INSTRUMENT")]; counts[ins] = (counts[ins] ?? 0) + 1;
      if (out.length < Math.min(60, Number(b2.limit) || 25)) out.push(Object.fromEntries(pick.map((k, i) => [k, ix[i] >= 0 ? a2[ix[i]] : ""])));
    }
    return Response.json({ action, seg, q, counts, rows: out });
  }
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
  if ((action === "flatten" || action === "refresh") && !body.strategy_id) return Response.json({ error: `${action} needs a strategy_id` }, { status: 400 });
  const cryptoTick = action === "tick_crypto";
  if (action === "tick" && (nowIst.wd === 0 || nowIst.wd === 6)) return Response.json({ skipped: "weekend" });

  if (action === "sync_instruments") {
    const c = credsOf(await adminAccount(sb));
    const n = await syncMcx(sb, c.client, c.token);
    const fno = await syncFno(sb, c).catch((e) => `F&O list failed: ${e instanceof Error ? e.message : e}`);
    return Response.json({ action, contracts: n, fno });
  }
  // One tick of each kind at a time: when the database is slow, a new minute's tick doesn't pile onto the last one.
  const lockName = action === "tick" ? "tick" : cryptoTick ? "tick_crypto" : null;
  if (lockName && !body.strategy_id) {
    const { data: got } = await sb.from("engine_lock").update({ until: new Date(Date.now() + 110000).toISOString() }).eq("name", lockName).lt("until", nowIso()).select("name");
    if (!got?.length) return Response.json({ action, skipped: "previous tick still running" });
  }
  // Active strategies, and paused ones still holding a position (their stops, exits and square-off keep running).
  // Read in pages: the database answers at most 1,000 rows a request (6 Nov 2026 audit — strategy 1,001 would never tick).
  const strategyQ = () => { const q0 = sb.from("algo_strategies").select("*"); return body.strategy_id ? q0.eq("id", body.strategy_id) : q0.or("active.eq.true,position.neq.FLAT").eq("is_master", false); };
  let rows0: Strategy[];
  try { rows0 = await pagedRows<Strategy>((a, z) => strategyQ().order("id").range(a, z)); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
  // A lab run whose worker never came back blocks every later run (the one-running index); after an hour without a
  // lease it is closed as failed (the lab's own watchdog job is paused since the 6 Nov outage).
  if (action === "tick" && !body.strategy_id) {
    const { error: we } = await sb.from("lab_runs").update({ status: "failed", error: "stopped: the worker never came back (engine watchdog)", finished_at: nowIso() })
      .eq("status", "running").lt("lease_until", new Date(Date.now() - 3600000).toISOString());
    if (we) console.error("lab watchdog", we.message);
  }
  // Bought strategies run on their publisher's rules.
  const strategies = await withMasters(sb, rows0 ?? []);

  const accounts = new Map<string, Account | null>();
  const gates = new Map<string, unknown>();
  // The error circuit breaker of each account in this tick (paper and live; breakerAfterTick).
  const breakers = tickMode0(action, body) ? await loadBreakers(strategies) : new Map<string, Breaker>();
  const okUsers = new Set<string>(), errUsers = new Map<string, string>();
  const fundsDone = new Set<string>();
  const liveIds = new Map<string, string[]>();
  const results: Record<string, string> = {};
  // Market data fetched during this tick is shared between strategies (one request per asset and timeframe), and
  // last prices are fetched in batches.
  const tickMode = action === "tick" || cryptoTick;
  if (tickMode) { Dhan.memo = new Map(); Dhan.ltpSeed = new Map(); Dhan.ownUsed.clear(); tickT0 = Math.floor(Date.now() / 60000) * 60000; }
  // Every strategy's last price in one request per account at the start of the tick (Dhan's quote API allows one
  // request a second, so separate requests would queue up behind each other).
  if (action === "tick") {
    const byOwner = new Map<string, Record<string, string[]>>();
    await Promise.all(strategies.map(async (x) => {
      const seg = String(x.data_segment);
      if (isCrypto(seg) || !x.owner_id) return;
      const sess = tradingSession(seg, nowIst.date);
      if (nowIst.min < sess.open || nowIst.min > sess.close + 5) return;
      let sec = String(x.data_security_id);
      if (isCommodity(seg)) {
        const set = await dataAccount(sb, x.owner_id, accounts).catch(() => null);
        if (!set?.dhan_access_token) return;
        sec = (await dataSecurity(sb, credsOf(set), seg, sec, nowIst.date).catch(() => ({ sec: "" }))).sec;
      }
      if (!sec) return;
      const du = await dataUid(sb, x.owner_id, accounts);
      const m = byOwner.get(du) ?? {}; (m[seg] ??= []).push(sec); byOwner.set(du, m);
    }));
    // Prices the per-second updater fetched in the last 10 seconds are used as they are (it skips a second now and
    // then when Dhan rate-limits; asking Dhan again here would only collide with it).
    const { data: fresh } = await sb.from("live_prices").select("seg, sec, px").gt("at", new Date(Date.now() - 10000).toISOString());
    for (const f of fresh ?? []) Dhan.ltpSeed!.set(`${f.seg}|${f.sec}`, Number(f.px));
    for (const [uid, m] of byOwner) {
      for (const seg of Object.keys(m)) { m[seg] = m[seg].filter((sec) => !Dhan.ltpSeed!.has(`${seg}|${sec}`)); if (!m[seg].length) delete m[seg]; }
      if (!Object.keys(m).length) byOwner.delete(uid);
    }
    await Promise.all([...byOwner].map(async ([uid, bySeg]) => {
      const set = await accountFor(sb, uid, "DHAN", accounts).catch(() => null);
      if (!set?.dhan_access_token) return;
      try { for (const [k, v] of await dhanFor(set).ltpMany(bySeg, true)) Dhan.ltpSeed!.set(k, v); } catch { /* rate-limited: strategies ask again (batched) */ }
    }));
  }
  const runOne = async (row: Strategy) => {
    let s = row;
    const t1 = Date.now();
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
      // Between its candle closes a flat rule strategy has nothing to decide: skipped, so a busy database only does
      // the work that can change something (open positions, and strategies whose candle just closed).
      if (tick && !outside && quietNow(s, sess)) { results[s.id] = "waiting for its candle"; return; }
      if (!s.owner_id) throw new Error("This strategy has no owner.");
      const broker = isCr ? "DELTA" : "DHAN";
      let set = isCr ? await accountFor(sb, s.owner_id, broker, accounts) : await dataAccount(sb, s.owner_id, accounts);
      if (isCr) {
        // Paper trading on crypto needs no account (prices are public); live trading needs the Delta API key.
        if (s.live && !(set?.dhan_client_id && set?.dhan_access_token)) throw new Error("Add your Delta Exchange API key and secret (Delta Exchange connection) to trade this strategy live.");
        set = set ?? { user_id: s.owner_id, broker: "DELTA", dhan_client_id: null, dhan_access_token: null, webhook_url: null, webhook_secret: null, capital: null, capital_since: null, deploy_pct: null, funds_at: null };
        if (cryptoTick && outside) {
          if (await retryExit(s, set)) { results[s.id] = "exit retried"; okUsers.add(String(s.owner_id)); return; }
          s = await liveRisk(s, set);
          if (s.live) s = await syncStop(s, set).catch(() => s);
          s = await markPrice(s, set).catch(() => s);
          results[s.id] = "ok (outside the crypto session: stops only)"; okUsers.add(String(s.owner_id));
          return;
        }
      } else if (!set?.dhan_access_token) throw new Error("Connect your Dhan account (client ID and access token) to run this strategy.");
      if (!set) throw new Error("No broker account.");
      // Shared paper data (temporary): prices only, never orders.
      if (set.shared_data && s.live) throw new Error("Connect your own Dhan account (client ID and access token) to trade this strategy live. Paper trading uses the desk's shared prices for now.");
      // Dhan funds, every 10 minutes while the market ticks run.
      if (action === "tick" && !fundsDone.has(set.user_id) && (!set.funds_at || Date.now() - Date.parse(set.funds_at) > 600000)) {
        fundsDone.add(set.user_id); await refreshFunds(set.user_id).catch(() => {});
      }
      if (isCommodity(String(s.data_segment))) {
        const r = await dataSecurity(sb, credsOf(set), s.data_segment, String(s.data_security_id), nowIst.date);
        s = { ...s, data_security_id: r.sec };
      }
      // A live strategy whose orders are still being worked waits for them (the order manager finishes them first).
      if (s.exec_state === "stopping" && s.exec_at && Date.now() - Date.parse(s.exec_at) < 90000) { results[s.id] = "stop being handled"; return; }
      if (s.live && s.exec_state === "working" && action !== "refresh") {
        if (action === "flatten") throw new Error("Orders for this strategy are still being worked at the broker. Try again in a minute.");
        results[s.id] = "orders working"; return;
      }
      // An exit that didn't go is tried again once a minute (exitFailed) before anything else is decided.
      if (tick && await retryExit(s, set)) { results[s.id] = "exit retried"; okUsers.add(String(s.owner_id)); return; }
      // New trades need the account in good standing; exits always go through.
      // The kill rule stops new trades of a strategy doing far worse than its backtest (exits still run).
      // A paused strategy is here only while it holds a position: it runs its stops and exits, never a new entry.
      const brk = breakers.get(String(s.owner_id));
      s = { ...s, _block: !s.active ? "the strategy is paused (its open position keeps its stop and exit rules)" : s.kill_at ? `the kill rule stopped new trades (${String(s.kill_note ?? "").slice(0, 160)})`
        : brk?.halted_at ? `new trades stopped after ${BREAKER_TICKS} failed minutes in a row (${String(brk.halt_reason ?? "").slice(0, 160)}); "Allow new trades again" restarts them` : await entryGate(sb, s, gates).catch(() => null) };
      if (tick && isStockSeg(String(s.data_segment))) {
        // Stock futures: a split / bonus ex-date first (before any stop is checked), then the lot size in Dhan's list.
        const l = await dhanFor(set).ltp("NSE_EQ", String(s.data_security_id)).catch(() => null);
        if (l) s = await stockExDate(s, l, set).catch((e) => { console.error("ex-date", e); return s; });
        s = await stockLotSync(s).catch(() => s);
      }
      if (tick) s = await liveRisk(s, set);
      // Options are closed on their expiry day (14:30 IST unless the strategy says otherwise).
      if (tick && expiryExitDue(s)) {
        const update: Record<string, unknown> = { last_run_at: nowIso() };
        await flatten(s, set, update, { c: Number(s.pos_ltp) || undefined }, `Expiry day: ${s.pos_expiry ?? "a leg"} expires today, closed at ${expiryExitTime(s)}`, "SQUARE_OFF");
        await must(() => sb.from("algo_strategies").update(update).eq("id", s.id), "position after the expiry exit");
        results[s.id] = "closed on its expiry day"; okUsers.add(String(s.owner_id)); return;
      }
      // Positional futures roll to the next month on the trading day before expiry (Papa, 4 Nov 2026).
      if (tick && !isCr) {
        const exp = await rollDue(s).catch(() => null);
        if (exp) { await rollFutures(s, set, exp); results[s.id] = `rolled before the ${exp} expiry`; okUsers.add(String(s.owner_id)); return; }
      }
      if (tick && s.live) { const s0 = s; s = await actLocked(() => syncStop(s0, set)).catch((e) => { console.error("stop", e); return s0; }); }
      // A manual refresh outside market hours (or in the NSE/BSE pre-open) keeps the session's last price.
      if (tick || (action === "refresh" && !(outside && !isCr))) s = await markPrice(s, set).catch(() => s);
      if (s.live && action === "tick") liveIds.set(set.user_id, [...(liveIds.get(set.user_id) ?? []), s.id]);
      const act = cryptoTick ? "tick" : action;
      if (s.strategy_kind === "TIMED") await processTimed(s, set, act);
      else if (s.strategy_kind === "RULES") await processRules(s, set, act);
      else await processFlip(s, set, act);
      if (Dhan.ownUsed.has(`${s.data_segment}|${s.data_security_id}`)) ownAssets.add(String(s.underlying ?? s.data_security_id));
      results[s.id] = `ok ${Date.now() - t1}ms (done ${tickT0 ? Date.now() - tickT0 : 0}ms after the minute)`;
      if (s.owner_id) okUsers.add(String(s.owner_id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results[s.id] = msg;
      if (s.owner_id) errUsers.set(String(s.owner_id), msg);
      await sb.from("algo_strategies").update({ last_error: msg, last_run_at: new Date().toISOString() }).eq("id", s.id);
    }
  };
  const ownAssets = new Set<string>();
  // Up to 8 strategies at a time (Dhan's request pacing is shared, per account).
  const queue = [...strategies];
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => { for (let r = queue.shift(); r; r = queue.shift()) await runOne(r); }));
  if (tickMode) { Dhan.memo = null; Dhan.ltpSeed = null; tickT0 = null; }
  if (tickMode0(action, body)) await breakerAfterTick(okUsers, errUsers, breakers).catch((e) => console.error("breaker", e));
  // Strategies ran on own candles (Dhan refused candle requests): the warning at the top of every page, and the
  // owner is notified once when it starts.
  if (ownAssets.size) await ownCandlesAlert([...ownAssets].sort()).catch((e) => console.error("alert", e));
  // Actual fill prices from each account's Dhan trade book for recent live orders.
  for (const [u, ids] of liveIds) { try { const a = accounts.get(`${u}|DHAN`); if (a) await brokerFills(a, ids); } catch (e) { console.error("fills", e); } }
  if (lockName && !body.strategy_id) await sb.from("engine_lock").update({ until: nowIso() }).eq("name", lockName);
  return Response.json({ action, results });
});
