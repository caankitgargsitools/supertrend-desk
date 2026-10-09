// Supertrend Algo Portal engine.
// Actions: "tick" (pg_cron, every minute in market hours), "refresh" and "flatten" (portal),
// "backtest" (portal; runs in the background). Every call must carry the x-engine-secret header.
import { createClient } from "npm:@supabase/supabase-js@2";
import { Dhan } from "./dhan.ts";
import { type ChargeRates, newAcc, planBacktest, priceBatch, summarize, tradeCharges, validateParams, type Acc, type Plan } from "./backtest.ts";
import { lotsFor, marginPerLot, normaliseSizing } from "./sizing.ts";
import {
  addDays, aggregate, type DayBar, fillTemplate, isCommodity, isComplete, ist, nextExpiry, nextMonthlyExpiry, partialDay,
  pickBaseInterval, sessionFor, signalSeries, strikeFor, supertrend, timeToMin,
} from "./logic.ts";
import { dataSecurity, syncMcx } from "./instruments.ts";
import { decide, describeCond, ruleSets, RuleBook, ruleTimeframes, validateRules, warmBarsFor } from "./rules.ts";
import { atr as atrSeries } from "./indicators.ts";
import { hasLevels, normaliseRisk, riskInit, riskScan, type RiskState } from "./risk.ts";
import { LAB_ASSETS, labStart, labStep, TOKEN_ERR } from "./lab.ts";
import { loadMarginRates, refreshMargins } from "./margins.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Strategy = Record<string, any>;
type Settings = {
  dhan_client_id: string | null; dhan_access_token: string | null; webhook_url: string | null; webhook_secret: string | null;
  capital?: number | null; capital_since?: string | null; deploy_pct?: number | null;
};
type Pos = "FLAT" | "LONG" | "SHORT";
type ChartBar = { t: number; o: number; h: number; l: number; c: number };

const CHART_BARS = 160;
const WARM_BARS = 500; // same Supertrend warm-up as the chart and the backtester

/** Intraday candles over more than Dhan's 90-day request limit. */
async function intradaySpan(dhan: Dhan, s: Strategy, interval: number, days: number, nowSec: number) {
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
  const dayMins = isCommodity(seg) ? 860 : 375;
  return Math.min(400, Math.max(5, Math.ceil(((Math.max(bars, atr * 10) * tf) / dayMins) * 1.5) + 4));
}
const FLAT_STATE = { position: "FLAT", pos_option_type: null, pos_option_side: null, pos_strike: null, pos_expiry: null, pos_qty: null, pos_entry_date: null, pos_risk: null,
  pos_entry_px: null, pos_entry_prem: null, pos_lots: null, pos_margin: null };
const NO_PENDING = { pending_target: null, pending_trigger: null, pending_from: null, pending_to: null };
const hhmm = (sec: number) => fmtIst(sec, true).slice(11, 16);

function fmtIst(epochSec: number, withTime: boolean): string {
  const d = new Date((epochSec + 19800) * 1000).toISOString();
  return withTime ? `${d.slice(0, 10)} ${d.slice(11, 19)}` : d.slice(0, 10);
}

function dhanFor(set: Settings): Dhan {
  if (!set.dhan_access_token || !set.dhan_client_id) throw new Error("Add your Dhan client ID and access token under Dhan connection.");
  return new Dhan(set.dhan_client_id, set.dhan_access_token);
}

async function saveChart(s: Strategy, bars: ChartBar[], st: number[], trend: number[]) {
  const from = Math.max(0, bars.length - CHART_BARS);
  const chart = bars.slice(from).map((b, k) => {
    const i = from + k;
    return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, st: isNaN(st[i]) ? null : +st[i].toFixed(2), tr: trend[i] };
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

function exitLeg(s: Strategy, sort: number) {
  const opt = s.trade_type === "OPTIONS";
  return fillTemplate(opt ? s.leg_template_opt : s.leg_template_fut, {
    // An option bought is sold to close; an option written is bought back.
    side: opt ? (s.pos_option_side === "SELL" ? "B" : "S") : s.position === "LONG" ? "S" : "B",
    qty: s.pos_qty ?? qtyOf(s), exchange: s.exchange, product: s.product_type, sort,
    symbol: opt ? s.dhan_symbol : s.futures_symbol,
    option_type: s.pos_option_type ?? "", strike: s.pos_strike ?? "", expiry: s.pos_expiry ?? "",
  });
}

function entryLeg(s: Strategy, want: Pos, close: number, sort: number, lots = Number(s.lots)) {
  const opt = s.trade_type === "OPTIONS";
  const qty = s.qty_mode === "LOTS" ? lots : lots * Number(s.lot_size);
  const today = ist(Date.now() / 1000);
  if (!opt) {
    return {
      leg: fillTemplate(s.leg_template_fut, {
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
  if (s.trade_type === "OPTIONS") return `${s.pos_option_side === "SELL" ? "Buy back" : "Sell"} ${s.dhan_symbol} ${s.pos_strike} ${s.pos_option_type} (${s.pos_expiry}) x ${s.pos_qty}`;
  return `${s.position === "LONG" ? "Sell" : "Buy"} ${s.futures_symbol} x ${s.pos_qty} to close ${String(s.position).toLowerCase()}`;
}

type Candle = { t?: number; trend?: number; c?: number; st?: number };

/* ---------- stop loss, target, trailing stop, daily loss limit (live) ---------- */
type PosRisk = Partial<RiskState> & { basis: string; entry?: number; entryPrem?: number | null };
const riskOf = (s: Strategy) => normaliseRisk(s.risk, s.trade_type === "OPTIONS");
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
  if (opt) pr.entryPrem = st.pos_entry_prem ?? ((r.basis === "PREMIUM" || r.max_day_loss) ? await premiumOf(dhanFor(set), s, st) : null);
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
  if (s.exchange === "MCX") return { brk_pct: 0.03, stt_fut: 0.01, stt_opt: 0.05, exch_fut: 0.0021, exch_opt: 0.0418, sebi: 0.0001, gst: 18, stamp_fut: 0.002, stamp_opt: 0.003 };
  const bse = s.exchange === "BSE";
  return { brk_pct: 0.03, stt_fut: 0.05, stt_opt: 0.15, exch_fut: bse ? 0 : 0.00183, exch_opt: bse ? 0.0325 : 0.03553, sebi: 0.0001, gst: 18, stamp_fut: 0.002, stamp_opt: 0.003 };
}
/** Equity (starting capital + realised P&L of this mode's closed trades) and the margin other open positions hold. */
async function capitalState(set: Settings, live: boolean, excludeId: string) {
  const { data: net } = await sb.rpc("ledger_net", { p_mode: live ? "LIVE" : "PAPER", p_since: set.capital_since ?? null });
  const { data: open } = await sb.from("algo_strategies").select("id, pos_margin").neq("position", "FLAT").eq("live", live).neq("id", excludeId);
  const used = (open ?? []).reduce((a, x) => a + (Number(x.pos_margin) || 0), 0);
  return { equity: Number(set.capital ?? 0) + Number(net ?? 0), used };
}
/**
 * Today's margin rate for a strategy's asset from Dhan's margin calculator (checked every morning): futures or option
 * writing, intraday or carry-forward. Null for option buying (that needs the premium) or when no check is stored.
 */
async function dhanRate(s: Strategy): Promise<number | null> {
  if (s.trade_type === "OPTIONS" && s.option_side !== "SELL") return null;
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
  const opt = s.trade_type === "OPTIONS";
  const premium = opt ? await premiumOf(dhanFor(set), s, newState) : null;
  // Margin per lot at today's Dhan rate (falls back to the strategy's own margin % when Dhan's isn't known).
  const rate = await dhanRate(s).catch(() => null);
  const sz0 = normaliseSizing(s.sizing, String(s.data_segment));
  const sz = sz0 && rate ? { ...sz0, margin_pct: rate * 100 } : sz0;
  let lots = Number(s.lots);
  const mLot = marginPerLot(s as any, sz ?? (rate ? { margin_pct: rate * 100 } as any : null), entryPx, premium);
  if (sz && rate) notes.push(`Margin ${(rate * 100).toFixed(1)}% of contract value (Dhan, today)`);
  if (sz) {
    const cs = await capitalState(set, !!s.live, s.id);
    const res = lotsFor(sz, cs.equity, mLot, cs.used, Number(set.deploy_pct ?? 100));
    if (res.lots < 1) { notes.push(`Entry skipped: not enough capital for 1 lot (${res.why}).`); return false; }
    lots = res.lots;
    const e = entryLeg(s, newState.position, entryPx, legs.length, lots);
    legs[legs.length - 1] = e.leg;
    Object.assign(newState, e.state);
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
async function bookPnl(s: Strategy, set: Settings, update: Record<string, unknown>, exitPx: number | undefined, why: string, exitPrem?: number | null) {
  if (s.position === "FLAT") return;
  const r = riskOf(s), pr = (s.pos_risk ?? {}) as PosRisk;
  const opt = s.trade_type === "OPTIONS";
  const inPx = opt ? Number(s.pos_entry_prem ?? pr.entryPrem ?? 0) : Number(s.pos_entry_px ?? pr.entry ?? 0);
  let outPx: number | null = null;
  if (opt) outPx = exitPrem ?? (inPx ? await premiumOf(dhanFor(set), s, s) : null);
  else outPx = exitPx ?? null;
  if (!(inPx > 0) || !(Number(outPx) > 0)) return;
  const units = unitsOf(s);
  const dir = opt ? (s.pos_option_side === "SELL" ? -1 : 1) : (s.position === "LONG" ? 1 : -1);
  const gross = (outPx! - inPx) * dir * units;
  const buyVal = (dir === 1 ? inPx : outPx!) * units, sellVal = (dir === 1 ? outPx! : inPx) * units;
  const costs = tradeCharges({ from: "", to: "", capital: 0, brokerage: 20, charges: ratesFor(s), near_code: 1 }, opt, buyVal, sellVal).total;
  const net = Math.trunc(gross - costs);
  const contract = opt ? `${s.pos_option_side === "SELL" ? "Sell " : ""}${s.dhan_symbol} ${s.pos_strike} ${s.pos_option_type} (${s.pos_expiry})` : `${s.futures_symbol} ${s.position === "LONG" ? "long" : "short"}`;
  const entryAt = s.pos_entry_date ? `${s.pos_entry_date}` : null;
  await sb.from("algo_trades").insert({
    strategy_id: s.id, mode: s.live ? "LIVE" : "PAPER", entry_day: entryAt, exit_at: new Date().toISOString(), side: s.position, contract,
    lots: lotsOf(s), units, entry_px: +inPx.toFixed(2), exit_px: +outPx!.toFixed(2), gross: Math.trunc(gross), costs: Math.trunc(costs), net, exit_why: why.slice(0, 200),
  });
  if (r?.max_day_loss) {
    const today = todayIst();
    const base = String(s.day_pnl_date) === today ? Number(s.day_pnl) || 0 : 0;
    update.day_pnl = Math.trunc(base + net); update.day_pnl_date = today;
  }
}
/** Checks an open position against its stop / target every minute. Returns the strategy as it stands afterwards. */
async function liveRisk(s: Strategy, set: Settings): Promise<Strategy> {
  const r = riskOf(s), pr = s.pos_risk as PosRisk | null;
  if (s.position === "FLAT" || !pr || !hasLevels(r) || pr.dir === undefined) return s;
  const nowSec = Date.now() / 1000, now = ist(nowSec), sess = sessionFor(s.data_segment, now.date);
  if (now.min < sess.open || now.min >= sess.close) return s;
  const dhan = dhanFor(set);
  let rows: { t: number; o: number; h: number; l: number }[] = [];
  const minuteNow = Math.floor(nowSec / 60) * 60;
  if (pr.basis === "PREMIUM") {
    const p = await premiumOf(dhan, s, s);
    if (p) rows = [{ t: minuteNow, o: p, h: p, l: p }];
  } else {
    const mins = await dhan.intraday(s.data_security_id, s.data_segment, s.data_instrument, 1, `${now.date} 09:00:00`, fmtIst(nowSec + 120, true));
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
  const event = /Target/.test(hit.why) ? "TARGET" : /Trailing/.test(hit.why) ? "TRAIL_STOP" : "STOP_LOSS";
  const under = pr.basis === "PREMIUM" ? undefined : hit.px;
  const ok = await sendOrders(s, set, event, [exitLeg(s, 1)], `${hit.why}${pr.basis === "PREMIUM" ? " (premium)" : ""}: ${exitLabel(s)}`, { t: hit.t, c: under });
  if (!ok) {
    update.last_error = "Stop-loss exit failed to send, so the strategy was paused. Close the position in Dhan.";
    update.active = false;
    await sb.from("algo_strategies").update(update).eq("id", s.id);
    return { ...s, ...update };
  }
  await bookPnl(s, set, update, under, hit.why, pr.basis === "PREMIUM" ? hit.px : undefined);
  Object.assign(update, FLAT_STATE);
  await sb.from("algo_strategies").update(update).eq("id", s.id);
  return { ...s, ...update };
}

async function sendOrders(s: Strategy, set: Settings, event: string, legs: Record<string, unknown>[], description: string, candle: Candle): Promise<boolean> {
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

async function logSignal(s: Strategy, event: string, description: string, candle: Candle, status = "LOGGED", payload: unknown = null, response: string | null = null) {
  await sb.from("algo_signals").insert({
    strategy_id: s.id, event, description, mode: s.live ? "LIVE" : "PAPER", status, payload, response,
    candle_time: candle.t ? new Date(candle.t * 1000).toISOString() : null,
    trend: candle.trend ?? null, close: candle.c ?? null, supertrend: candle.st ?? null,
  });
}

async function flatten(s: Strategy, set: Settings, update: Record<string, unknown>, candle: Candle) {
  if (s.position === "FLAT") return;
  const ok = await sendOrders(s, set, "FLATTEN", [exitLeg(s, 1)], `Manual exit: ${exitLabel(s)}`, candle);
  if (ok) { await bookPnl(s, set, update, candle.c, "Manual exit"); Object.assign(update, FLAT_STATE); }
  else Object.assign(update, { last_error: "Exit order failed to send. Check the log and close the position in Dhan.", active: false });
}

async function finish(s: Strategy, set: Settings, update: Record<string, unknown>, legs: Record<string, unknown>[], event: string, notes: string[], newState: Record<string, unknown>, candle: Candle, atrNow = 0) {
  if (legs.length) {
    const entryPx = newState._px as number | undefined;
    delete newState._px;
    const entering = (newState.position === "LONG" || newState.position === "SHORT") && entryPx !== undefined;
    const exiting = s.position !== "FLAT" && ["EXIT", "REVERSE", "SQUARE_OFF"].includes(event);
    if (entering && !(await sizeEntry(s, set, legs, newState, entryPx!, notes))) {
      // Not enough capital: drop the entry; an exit in the same signal still goes out.
      legs.pop();
      if (!legs.length) { await logSignal(s, "INFO", notes.join(" | "), candle); await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
      newState = { ...FLAT_STATE }; event = "EXIT";
    } else if (entering) await armRisk(s, set, newState, entryPx!, atrNow, notes);
    const ok = await sendOrders(s, set, event, legs, notes.join(" | "), candle);
    if (ok && exiting) await bookPnl(s, set, update, candle.c, notes[0] ?? event);
    if (ok) Object.assign(update, newState);
    else Object.assign(update, { last_error: "Order failed to send, so the strategy was paused. Check the log and your Dhan positions.", active: false });
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
    last_trend: tNow, last_close: last.c, last_supertrend: stNow ?? null, last_run_at: new Date().toISOString(), last_error: null,
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
      legs.push(exitLeg(s, 1));
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
    const fresh = last.day === now.date && nowSec - last.endT <= Math.max(600, s.timeframe_min * 120);
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
          legs.push(exitLeg(s, legs.length + 1));
          notes.push(`${sigName} breakout ${up ? "above" : "below"} ${pd.trig}: ${exitLabel(s)}`);
          event = "EXIT"; position = "FLAT"; newState = FLAT_STATE;
        }
        if (pd.target !== "FLAT" && position === "FLAT" && !halted) {
          const e = entryLeg(s, pd.target, pd.trig, legs.length + 1);
          legs.push(e.leg);
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
          legs.push(exitLeg(s, legs.length + 1));
          const why = flipped ? "turned" : atOpen ? "turned after hours, so reversing at the open:" : "turned after hours; first candle close confirms, reversing:";
          notes.push(`${sigName} ${why} ${tNow === 1 ? "up" : "down"}: ${exitLabel(s)}`);
          event = "EXIT";
          position = "FLAT";
          newState = FLAT_STATE;
          reversing = true;
        }
        if (desired !== "FLAT" && position === "FLAT" && !halted && (s.entry_mode === "JOIN" || flipped || reversing)) {
          const e = entryLeg(s, desired, last.c, legs.length + 1);
          legs.push(e.leg);
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
  const daily: DayBar[] = tfs.daily
    ? (await dhan.daily(s.data_security_id, seg, s.data_instrument, addDays(today, -Math.ceil(warm * 1.5)), addDays(today, 1))).filter((d) => d.day < today)
    : [];
  const smallest = Math.min(...rawBy.keys());
  const baseByDay = new Map<string, { min: number; h: number; l: number }[]>();
  for (const r of rawBy.get(smallest) ?? []) {
    const p = ist(r.t);
    const a = baseByDay.get(p.date) ?? []; a.push({ min: p.min, h: r.h, l: r.l }); baseByDay.set(p.date, a);
  }
  return { rules, book: new RuleBook(rules, s.timeframe_min, frames, daily, baseByDay, seg), bars: frames.get(s.timeframe_min)! };
}

/** Once-a-day condition strategies: decided at the session open from completed daily candles, like the backtest. */
async function processRulesDaily(s: Strategy, set: Settings, action: string) {
  const rules = validateRules(s.rules);
  const dhan = dhanFor(set);
  const nowSec = Date.now() / 1000, now = ist(nowSec), seg = String(s.data_segment);
  const all = await dhan.daily(s.data_security_id, seg, s.data_instrument, addDays(now.date, -Math.ceil(warmBarsFor(rules) * 1.5)), addDays(now.date, 1));
  const days = all.filter((d) => d.day < now.date);
  if (days.length < 3) throw new Error(`Only ${days.length} daily candles came back from Dhan.`);
  const book = new RuleBook(rules, s.timeframe_min, new Map(), days, new Map(), seg);
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
  const sess = sessionFor(seg, now.date);
  const legs: Record<string, unknown>[] = [], notes: string[] = [];
  let event = "", newState: Record<string, unknown> = {};
  let position: Pos = s.position;
  // Decide once, in the first half hour after the open (a strategy switched on later waits for tomorrow's open).
  if (String(s.last_entry_day) !== now.date && now.min >= sess.open + 1 && now.min < sess.open + 30 && spot) {
    update.last_entry_day = now.date;
    const dirOk = (side: Pos) => s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
    const d = decide(position === "FLAT" ? "FLAT" : position, sig, prev, { join: s.entry_mode === "JOIN", longOk: dirOk("LONG"), shortOk: dirOk("SHORT"), sets: ruleSets(rules) });
    const label = (k: "long" | "short") => rules[k]!.conds.map(describeCond).join(rules[k]!.mode === "ANY" ? " or " : " & ");
    if (d.exit && position !== "FLAT") { legs.push(exitLeg(s, 1)); notes.push(`${d.why}: ${exitLabel(s)}`); event = "EXIT"; position = "FLAT"; newState = FLAT_STATE; }
    if (d.enter && position === "FLAT" && canEnter(s)) {
      const e = entryLeg(s, d.enter, spot, legs.length + 1);
      legs.push(e.leg); notes.push(`${d.enter === "LONG" ? "Buy" : "Sell"} rules met on yesterday's daily candle (${label(d.enter === "LONG" ? "long" : "short")}): ${e.label}`);
      event = event === "EXIT" ? "REVERSE" : "ENTRY"; newState = { position: d.enter, ...e.state };
    }
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
      legs.push(exitLeg(s, 1)); notes.push(`Square-off: ${exitLabel(s)}`); event = "SQUARE_OFF"; newState = FLAT_STATE;
    }
  } else if (last.t !== s.last_candle_ts) {
    const fresh = last.day === now.date && nowSec - last.endT <= Math.max(600, s.timeframe_min * 120);
    const candleInWindow = last.endMin >= ss && last.endMin < le && (!s.intraday || last.endMin < sqOff) && now.min < sess.close;
    if (s.last_candle_ts == null) {
      notes.push("Started tracking. Waiting for the next candle to close."); event = "INFO";
    } else if (fresh && candleInWindow) {
      const dirOk = (side: Pos) => s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
      const d = decide(position === "FLAT" ? "FLAT" : position, sig, prev, { join: s.entry_mode === "JOIN", longOk: dirOk("LONG"), shortOk: dirOk("SHORT"), sets: ruleSets(rules) });
      if (d.exit && position !== "FLAT") {
        legs.push(exitLeg(s, legs.length + 1)); notes.push(`${d.why}: ${exitLabel(s)}`);
        event = "EXIT"; position = "FLAT"; newState = FLAT_STATE;
      }
      if (d.enter && position === "FLAT" && canEnter(s)) {
        const e = entryLeg(s, d.enter, last.c, legs.length + 1);
        legs.push(e.leg); notes.push(`${d.enter === "LONG" ? "Buy" : "Sell"} rules met (${label(d.enter === "LONG" ? "long" : "short")}): ${e.label}`);
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
    last_trend: tNow, last_close: spot ?? bars[n - 1].c, last_supertrend: stNow ?? null, last_run_at: new Date().toISOString(), last_error: null,
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
      legs.push(exitLeg(s, 1));
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
      legs.push(e.leg);
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
async function tokenCheck(force: boolean) {
  const { data: set } = await sb.from("portal_settings").select("dhan_client_id, dhan_access_token").single();
  const tok = set?.dhan_access_token ?? "", client = set?.dhan_client_id ?? "";
  const now = Date.now() / 1000, note = (t: string, extra: Record<string, unknown> = {}) =>
    sb.from("portal_settings").update({ token_note: t, token_checked_at: new Date().toISOString(), ...extra }).eq("id", true);
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
    await sb.from("portal_settings").update({
      dhan_access_token: fresh, token_expires_at: fexp ? new Date(fexp * 1000).toISOString() : null, token_renewed_at: new Date().toISOString(),
      token_checked_at: new Date().toISOString(), token_note: "Renewed automatically.",
    }).eq("id", true);
    return { renewed: true };
  } catch (e) {
    await note(`Renewal failed (${e instanceof Error ? e.message : String(e)}). Retrying next hour.`, { token_expires_at: expIso });
    return { renewed: false, reason: "network" };
  }
}
/** Funds in the Dhan account (available balance, margin in use), shown next to the desk's own capital figures. */
async function refreshFunds() {
  const { data: set } = await sb.from("portal_settings").select("dhan_client_id, dhan_access_token").single();
  if (!set?.dhan_access_token) return { ok: false };
  const r = await fetch("https://api.dhan.co/v2/fundlimit", { headers: { "access-token": set.dhan_access_token, "client-id": set.dhan_client_id ?? "", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) { await sb.from("portal_settings").update({ funds_error: `Dhan funds request failed (HTTP ${r.status}).`, funds_at: new Date().toISOString() }).eq("id", true); return { ok: false }; }
  const pickN = (...k: string[]) => { for (const x of k) if (j[x] !== undefined && j[x] !== null) return Number(j[x]); return null; };
  const funds = {
    available: pickN("availabelBalance", "availableBalance"), sod: pickN("sodLimit"), collateral: pickN("collateralAmount"),
    utilized: pickN("utilizedAmount"), withdrawable: pickN("withdrawableBalance"), receivable: pickN("receiveableAmount", "receivableAmount"),
  };
  await sb.from("portal_settings").update({ funds, funds_at: new Date().toISOString(), funds_error: null }).eq("id", true);
  return { ok: true };
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

/** Strategy lab: run one instalment, then hand over to a fresh invocation if there is more to do. */
async function labLoop() {
  const { data: set } = await sb.from("portal_settings").select("dhan_client_id, dhan_access_token").single();
  const creds = { client: set?.dhan_client_id ?? "", token: set?.dhan_access_token ?? "" };
  const chain = async () => {
    const { data: sec } = await sb.from("engine_secret").select("secret").single();
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/engine`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-engine-secret": sec!.secret }, body: JSON.stringify({ action: "lab" }),
    });
  };
  const more = await labStep({ sb, creds, started: Date.now(), chain });
  if (more) await chain();
}

async function runBacktestJob(id: number) {
  const started = Date.now();
  const { data: bt } = await sb.from("algo_backtests").select("*").eq("id", id).single();
  if (!bt || !["queued", "running"].includes(bt.status)) return;
  if (bt.status === "queued" && bt.plans) await sb.from("algo_backtests").update({ status: "running", error: null, progress: "Resuming" }).eq("id", id);
  const setRow = (fields: Record<string, unknown>) => sb.from("algo_backtests").update(fields).eq("id", id);
  try {
    const { data: set } = await sb.from("portal_settings").select("*").single();
    const creds = { client: set?.dhan_client_id ?? "", token: set?.dhan_access_token ?? "" };
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
        "day_pnl_date", "pos_option_side", "pos_entry_px", "pos_entry_prem", "pos_lots", "pos_margin"]) delete snapshot[k];
      if (isCommodity(String(snapshot.data_segment))) {
        const r = await dataSecurity(sb, creds, String(snapshot.data_segment), String(snapshot.data_security_id), ist(Date.now() / 1000).date);
        snapshot.data_sec_resolved = r.sec;
      }
      const res = await planBacktest(snapshot, creds, params, async (m) => { await setRow({ progress: m }); });
      plans = res.plans; acc = newAcc(Number(params.capital)); acc.calls = res.calls; acc.notes = res.notes; cursor = 0; trades = [];
      params = { ...params, strategy: snapshot, margin_rate: await dhanRate(snapshot).catch(() => null) };
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
    if (cursor < plans!.length && acc.rounds < MAX_ROUNDS) {
      await setRow({ acc, cursor, trades, progress: `Priced ${cursor} of ${plans!.length} trades. Continuing…` });
      await chainBacktest(id);
      return;
    }
    const partial = cursor < plans!.length;
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
  }
}

Deno.serve(async (req) => {
  const secret = req.headers.get("x-engine-secret");
  const { data: sec } = await sb.from("engine_secret").select("secret").single();
  if (!secret || !sec || secret !== sec.secret) return new Response("Forbidden", { status: 403 });

  let body: { action?: string; strategy_id?: string; backtest_id?: number } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = body.action ?? "tick";

  if (action === "backtest") {
    if (!body.backtest_id) return Response.json({ error: "backtest_id missing" }, { status: 400 });
    EdgeRuntime.waitUntil(runBacktestJob(Number(body.backtest_id)));
    return Response.json({ accepted: true });
  }

  if (action === "lab_start" || action === "lab_start_manual" || action === "lab") {
    if (action !== "lab") {
      const id = await labStart(sb, action === "lab_start_manual");
      if (!id) return Response.json({ action, started: false, reason: "The lab is switched off." });
    }
    EdgeRuntime.waitUntil(labLoop().catch((e) => console.error("lab", e)));
    return Response.json({ action, accepted: true });
  }

  if (action === "token" || action === "token_renew") return Response.json({ action, ...(await tokenCheck(action === "token_renew")) });
  if (action === "funds") return Response.json({ action, ...(await refreshFunds()) });
  if (action === "margins") {
    const { data: set } = await sb.from("portal_settings").select("dhan_client_id, dhan_access_token").single();
    const { data: ls } = await sb.from("lab_settings").select("assets").eq("id", 1).maybeSingle();
    // The lab's assets plus every asset a strategy trades, checked each morning before the market opens.
    const { data: strats } = await sb.from("algo_strategies").select("underlying").eq("archived", false);
    const keys: string[] = [...new Set([...(ls?.assets ?? []), ...(strats ?? []).map((x) => String(x.underlying))])].filter((k: string) => LAB_ASSETS[k]);
    const n = await refreshMargins(sb, { client: set?.dhan_client_id ?? "", token: set?.dhan_access_token ?? "" }, keys.map((k) => LAB_ASSETS[k]));
    return Response.json({ action, priced: n, of: keys.length });
  }

  if (!["tick", "refresh", "flatten", "sync_instruments"].includes(action)) return Response.json({ error: `Unknown action ${action}` }, { status: 400 });
  const nowIst = ist(Date.now() / 1000);
  if (action === "tick" && (nowIst.wd === 0 || nowIst.wd === 6)) return Response.json({ skipped: "weekend" });

  const { data: set } = await sb.from("portal_settings").select("*").single();
  // Dhan funds, every 10 minutes while the market ticks run.
  if (action === "tick" && (!set?.funds_at || Date.now() - Date.parse(set.funds_at) > 600000)) await refreshFunds().catch(() => {});
  if (action === "sync_instruments") {
    const n = await syncMcx(sb, set?.dhan_client_id ?? "", set?.dhan_access_token ?? "");
    return Response.json({ action, contracts: n });
  }
  let q = sb.from("algo_strategies").select("*");
  q = body.strategy_id ? q.eq("id", body.strategy_id) : q.eq("active", true);
  const { data: strategies, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: Record<string, string> = {};
  for (const row of strategies ?? []) {
    let s = row;
    try {
      // Each market has its own hours (NSE/BSE 09:15–15:30, MCX 09:00–23:30/23:55); ticks outside them are skipped.
      const sess = sessionFor(s.data_segment, nowIst.date);
      if (action === "tick" && (nowIst.min < sess.open || nowIst.min > sess.close + 5)) continue;
      if (isCommodity(String(s.data_segment))) {
        const r = await dataSecurity(sb, { client: set?.dhan_client_id ?? "", token: set?.dhan_access_token ?? "" }, s.data_segment, String(s.data_security_id), nowIst.date);
        s = { ...s, data_security_id: r.sec };
      }
      if (action === "tick") s = await liveRisk(s, set as Settings);
      if (s.strategy_kind === "TIMED") await processTimed(s, set as Settings, action);
      else if (s.strategy_kind === "RULES") await processRules(s, set as Settings, action);
      else await processFlip(s, set as Settings, action);
      results[s.id] = "ok";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results[s.id] = msg;
      await sb.from("algo_strategies").update({ last_error: msg, last_run_at: new Date().toISOString() }).eq("id", s.id);
    }
  }
  return Response.json({ action, results });
});
