// Supertrend Algo Portal engine.
// Actions: "tick" (pg_cron, every minute in market hours), "refresh" and "flatten" (portal),
// "backtest" (portal; runs in the background). Every call must carry the x-engine-secret header.
import { createClient } from "npm:@supabase/supabase-js@2";
import { Dhan } from "./dhan.ts";
import { newAcc, planBacktest, priceBatch, summarize, validateParams, type Acc, type Plan } from "./backtest.ts";
import {
  addDays, aggregate, CLOSE_MIN, fillTemplate, isComplete, ist, nextExpiry, OPEN_MIN, partialDay,
  pickBaseInterval, strikeFor, supertrend, timeToMin,
} from "./logic.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Strategy = Record<string, any>;
type Settings = { dhan_client_id: string | null; dhan_access_token: string | null; webhook_url: string | null; webhook_secret: string | null };
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
    const rows = await dhan.intraday(s.data_security_id, s.data_segment, s.data_instrument, interval, `${a} 09:00:00`, z ? `${z} 15:31:00` : fmtIst(nowSec + 120, true));
    for (const r of rows) out.set(r.t, r);
  }
  return [...out.values()].sort((x: any, y: any) => x.t - y.t) as { t: number; o: number; h: number; l: number; c: number }[];
}
function warmDays(tf: number, atr: number) {
  return Math.min(400, Math.max(5, Math.ceil(((Math.max(WARM_BARS, atr * 10) * tf) / 375) * 1.5) + 4));
}
const FLAT_STATE = { position: "FLAT", pos_option_type: null, pos_strike: null, pos_expiry: null, pos_qty: null, pos_entry_date: null };

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

/** Supertrend on the strategy's own candles (flip strategies). */
async function flipSeries(s: Strategy, dhan: Dhan) {
  const tf = s.timeframe_min;
  const baseInt = pickBaseInterval(tf);
  const now = Date.now() / 1000;
  const raw = await intradaySpan(dhan, s, baseInt, warmDays(tf, s.atr_period), now);
  const bars = aggregate(raw, tf).filter((b) => isComplete(b, baseInt, now));
  if (bars.length < s.atr_period + 2) throw new Error(`Only ${bars.length} completed candles came back from Dhan; need at least ${s.atr_period + 2}.`);
  const { st, trend } = supertrend(bars, s.atr_period, Number(s.factor));
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
    const raw = await intradaySpan(dhan, s, baseInt, warmDays(tf, s.atr_period), nowSec);
    const agg = aggregate(raw, tf);
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
    side: opt ? "S" : s.position === "LONG" ? "S" : "B",
    qty: s.pos_qty ?? qtyOf(s), exchange: s.exchange, product: s.product_type, sort,
    symbol: opt ? s.dhan_symbol : s.futures_symbol,
    option_type: s.pos_option_type ?? "", strike: s.pos_strike ?? "", expiry: s.pos_expiry ?? "",
  });
}

function entryLeg(s: Strategy, want: Pos, close: number, sort: number) {
  const opt = s.trade_type === "OPTIONS";
  const qty = qtyOf(s);
  const today = ist(Date.now() / 1000);
  if (!opt) {
    return {
      leg: fillTemplate(s.leg_template_fut, {
        side: want === "LONG" ? "B" : "S", qty, exchange: s.exchange, product: s.product_type, sort, symbol: s.futures_symbol,
      }),
      state: { pos_option_type: null, pos_strike: null, pos_expiry: null, pos_qty: qty, pos_entry_date: today.date },
      label: `${want === "LONG" ? "Buy" : "Sell"} ${s.futures_symbol} x ${qty}`,
    };
  }
  const optType = want === "LONG" ? "CE" : "PE";
  const strike = strikeFor(close, s.strike_step, s.strike_offset, optType);
  const expiry = s.expiry_override && s.expiry_override >= today.date
    ? s.expiry_override
    : nextExpiry(today, s.expiry_weekday, s.roll_on_expiry);
  return {
    leg: fillTemplate(s.leg_template_opt, {
      side: "B", qty, exchange: s.exchange, product: s.product_type, sort, symbol: s.dhan_symbol,
      option_type: optType, strike, expiry,
    }),
    state: { pos_option_type: optType, pos_strike: strike, pos_expiry: expiry, pos_qty: qty, pos_entry_date: today.date },
    label: `Buy ${s.dhan_symbol} ${strike} ${optType} (${expiry}) x ${qty}`,
  };
}

function exitLabel(s: Strategy): string {
  if (s.trade_type === "OPTIONS") return `Sell ${s.dhan_symbol} ${s.pos_strike} ${s.pos_option_type} (${s.pos_expiry}) x ${s.pos_qty}`;
  return `${s.position === "LONG" ? "Sell" : "Buy"} ${s.futures_symbol} x ${s.pos_qty} to close ${String(s.position).toLowerCase()}`;
}

type Candle = { t?: number; trend?: number; c?: number; st?: number };

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
  if (ok) Object.assign(update, FLAT_STATE);
  else Object.assign(update, { last_error: "Exit order failed to send. Check the log and close the position in Dhan.", active: false });
}

async function finish(s: Strategy, set: Settings, update: Record<string, unknown>, legs: Record<string, unknown>[], event: string, notes: string[], newState: Record<string, unknown>, candle: Candle) {
  if (legs.length) {
    const ok = await sendOrders(s, set, event, legs, notes.join(" | "), candle);
    if (ok) Object.assign(update, newState);
    else Object.assign(update, { last_error: "Order failed to send, so the strategy was paused. Check the log and your Dhan positions.", active: false });
  } else if (event === "INFO") {
    await logSignal(s, event, notes.join(" "), candle);
  }
  await sb.from("algo_strategies").update(update).eq("id", s.id);
}

async function processFlip(s: Strategy, set: Settings, action: string) {
  const { bars, st, trend } = await flipSeries(s, dhanFor(set));
  const n = bars.length;
  const last = bars[n - 1];
  const tNow = trend[n - 1], tPrev = trend[n - 2];
  const stNow = isNaN(st[n - 1]) ? undefined : +st[n - 1].toFixed(2);
  const update: Record<string, unknown> = {
    last_trend: tNow, last_close: last.c, last_supertrend: stNow ?? null, last_run_at: new Date().toISOString(), last_error: null,
  };
  const candle = { t: last.t, trend: tNow, c: last.c, st: stNow };
  if (action === "refresh") { await sb.from("algo_strategies").update(update).eq("id", s.id); return; }
  if (action === "flatten") { await flatten(s, set, update, candle); await sb.from("algo_strategies").update(update).eq("id", s.id); return; }

  const nowSec = Date.now() / 1000;
  const now = ist(nowSec);
  const sqOff = timeToMin(String(s.square_off));
  let position: Pos = s.position;
  const legs: Record<string, unknown>[] = [];
  const notes: string[] = [];
  let event = "";
  let newState: Record<string, unknown> = {};

  if (s.intraday && position !== "FLAT" && now.min >= sqOff) {
    legs.push(exitLeg(s, 1));
    notes.push(`Square-off: ${exitLabel(s)}`);
    event = "SQUARE_OFF";
    newState = FLAT_STATE;
  } else {
    // Stop-and-reverse, decided when a candle closes inside the trading window. A flip after "no new trades after"
    // is not traded that day. Next day it is acted on either
    //   FIRST_CLOSE (default): at the close of the first candle in the window, using Supertrend as it stands then
    //                          (no trade if it has already flipped back), or
    //   OPEN: at the session start, from the previous day's last candle.
    const ss = timeToMin(String(s.session_start)), le = timeToMin(String(s.last_entry));
    const openMode = s.after_hours_flip === "OPEN";
    const newCandle = last.t !== s.last_candle_ts;
    const fresh = last.day === now.date && nowSec - last.endT <= Math.max(600, s.timeframe_min * 120);
    const candleInWindow = last.endMin >= ss && last.endMin < le && (!s.intraday || last.endMin < sqOff);
    const nowInWindow = now.min >= ss && now.min < le && (!s.intraday || now.min < sqOff) && now.min < CLOSE_MIN;
    const recent = nowSec - last.endT <= 5 * 86400; // stale-data guard (weekends and holidays allowed)
    const atOpen = openMode && nowInWindow && recent && !(last.day === now.date && last.endMin >= ss);
    if (s.last_candle_ts == null) {
      notes.push(`Started tracking. Trend is ${tNow === 1 ? "up" : "down"}; waiting for the next candle.`);
      event = "INFO";
    } else if ((newCandle && fresh && candleInWindow && now.min < CLOSE_MIN) || atOpen) {
      const desired: Pos = tNow === 1 ? (s.direction === "SHORT_ONLY" ? "FLAT" : "LONG") : (s.direction === "LONG_ONLY" ? "FLAT" : "SHORT");
      const flipped = !atOpen && tNow !== tPrev;
      let reversing = false;
      if (position !== "FLAT" && position !== desired) {
        legs.push(exitLeg(s, legs.length + 1));
        const why = flipped ? "turned" : atOpen ? "turned after hours, so reversing at the open:" : "turned after hours; first candle close confirms, reversing:";
        notes.push(`Supertrend ${why} ${tNow === 1 ? "up" : "down"}: ${exitLabel(s)}`);
        event = "EXIT";
        position = "FLAT";
        newState = FLAT_STATE;
        reversing = true;
      }
      if (desired !== "FLAT" && position === "FLAT" && (s.entry_mode === "JOIN" || flipped || reversing)) {
        const e = entryLeg(s, desired, last.c, legs.length + 1);
        legs.push(e.leg);
        notes.push(`${flipped ? "Supertrend flipped" : reversing ? "Reversing" : "Joining trend"} ${tNow === 1 ? "up" : "down"}: ${e.label}`);
        event = event === "EXIT" ? "REVERSE" : "ENTRY";
        newState = { position: desired, ...e.state };
      }
    }
    update.last_candle_ts = last.t;
  }
  await finish(s, set, update, legs, event, notes, newState, candle);
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
  if (position === "FLAT" && lastEntryDay !== now.date && now.min >= entryMin && now.min < entryMin + 10 && spot) {
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

const MAX_ROUNDS = 40; // safety stop for the self-chaining backtest

/** Ask the engine to continue this backtest in a fresh invocation (each one has its own time budget). */
async function chainBacktest(id: number) {
  const { data: sec } = await sb.from("engine_secret").select("secret").single();
  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/engine`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-engine-secret": sec!.secret },
    body: JSON.stringify({ action: "backtest", backtest_id: id }),
  });
}

async function runBacktestJob(id: number) {
  const started = Date.now();
  const { data: bt } = await sb.from("algo_backtests").select("*").eq("id", id).single();
  if (!bt || !["queued", "running"].includes(bt.status)) return;
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
        "last_close", "last_supertrend", "last_run_at", "last_error", "last_entry_day", "leg_template_fut", "leg_template_opt"]) delete snapshot[k];
      const res = await planBacktest(snapshot, creds, params, async (m) => { await setRow({ progress: m }); });
      plans = res.plans; acc = newAcc(Number(params.capital)); acc.calls = res.calls; cursor = 0; trades = [];
      params = { ...params, strategy: snapshot };
      await setRow({ params, plans, acc, cursor, trades, progress: `Planned ${plans.length} trades. Pricing them now.` });
    }

    const s = params.strategy;
    acc.rounds = (acc.rounds ?? 0) + 1;
    const deadline = started + 110000;
    const res = await priceBatch(s, creds, params, plans!, cursor, acc, deadline, async (m) => { await setRow({ progress: m }); });
    trades = trades.concat(res.trades);
    cursor = res.next; acc = res.acc;

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
    await setRow({ status: "failed", error: e instanceof Error ? e.message : String(e), finished_at: new Date().toISOString() });
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

  if (action === "tick") {
    const now = ist(Date.now() / 1000);
    if (now.wd === 0 || now.wd === 6 || now.min < OPEN_MIN || now.min > CLOSE_MIN + 5) return Response.json({ skipped: "market closed" });
  }

  const { data: set } = await sb.from("portal_settings").select("*").single();
  let q = sb.from("algo_strategies").select("*");
  q = body.strategy_id ? q.eq("id", body.strategy_id) : q.eq("active", true);
  const { data: strategies, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: Record<string, string> = {};
  for (const s of strategies ?? []) {
    try {
      if (s.strategy_kind === "TIMED") await processTimed(s, set as Settings, action);
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
