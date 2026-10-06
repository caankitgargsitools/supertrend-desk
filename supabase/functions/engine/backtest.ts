// Historical simulation of a strategy, priced with Dhan's expired-options data.
// Runs in instalments so it can cover up to 5 years:
//   1. planBacktest  – downloads index candles once and decides every trade (entry/exit times, strike)
//   2. priceBatch    – prices as many planned trades as fit in one invocation; the engine chains the rest
//   3. summarize     – totals once every trade is priced
import { Dhan, type OptBar } from "./dhan.ts";
import {
  addDays, aggregate, type Bar, type DayBar, ist, minToTime, partialDay, type Raw,
  signalSeries, strikeFor, supertrend, timeToMin, weekdayOf,
} from "./logic.ts";

/** Statutory charge rates in %, as used by brokers' calculators (e.g. Zerodha / Dhan, NSE F&O). */
export type ChargeRates = {
  brk_pct: number; stt_fut: number; stt_opt: number; exch_fut: number; exch_opt: number; sebi: number; gst: number; stamp_fut: number; stamp_opt: number;
};
export type BtParams = { from: string; to: string; capital: number; brokerage: number; other_pct?: number; charges?: ChargeRates; near_code: number };
export type ChargeBreakdown = { brokerage: number; stt: number; exch: number; sebi: number; gst: number; stamp: number; total: number };

/** Charges for one round trip (one buy and one sell order), the way the broker's calculator works them out. */
export function tradeCharges(p: BtParams, isOpt: boolean, buyVal: number, sellVal: number): ChargeBreakdown {
  const c = p.charges;
  if (!c) { // older backtests: flat % of turnover
    const total = 2 * p.brokerage + ((buyVal + sellVal) * (p.other_pct ?? 0)) / 100;
    return { brokerage: 2 * p.brokerage, stt: 0, exch: 0, sebi: 0, gst: 0, stamp: 0, total };
  }
  const perOrder = (v: number) => isOpt ? p.brokerage : Math.min(p.brokerage, (v * c.brk_pct) / 100);
  const turnover = buyVal + sellVal;
  const brokerage = perOrder(buyVal) + perOrder(sellVal);
  const stt = Math.round((sellVal * (isOpt ? c.stt_opt : c.stt_fut)) / 100);
  const exch = (turnover * (isOpt ? c.exch_opt : c.exch_fut)) / 100;
  const sebi = (turnover * c.sebi) / 100;
  const gst = ((brokerage + exch + sebi) * c.gst) / 100;
  const stamp = Math.round((buyVal * (isOpt ? c.stamp_opt : c.stamp_fut)) / 100);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const parts = { brokerage: r2(brokerage), stt, exch: r2(exch), sebi: r2(sebi), gst: r2(gst), stamp };
  return { ...parts, total: r2(parts.brokerage + stt + parts.exch + parts.sebi + parts.gst + stamp) };
}
type MBar = Raw & { day: string; min: number };
type Side = "LONG" | "SHORT";
export type Plan = {
  side: Side; opt: "CE" | "PE" | null; entryDay: string; entryMin: number; exitDay: string; exitMin: number;
  spotIn: number; spotOut: number | null; strike: number | null; why: string; exitWhy: string;
  fillIn?: number; fillOut?: number; // exact index fills for breakout orders
};
export type Acc = {
  equity: number; peak: number; maxDd: number; grossWin: number; grossLoss: number; wins: number;
  gross: number; costs: number; skipped: Record<string, number>; lastDone: string; calls: number; rounds: number;
  chg?: { brokerage: number; stt: number; exch: number; sebi: number; gst: number; stamp: number };
};

export const MAX_DAYS = 1827; // 5 years, the depth of Dhan's expired-options history

function optionsSegment(s: Record<string, any>): string {
  return s.exchange === "BSE" ? "BSE_FNO" : "NSE_FNO";
}

async function intradayRange(dhan: Dhan, s: Record<string, any>, interval: number, from: string, to: string, progress: (m: string) => Promise<void>): Promise<MBar[]> {
  const out = new Map<number, MBar>();
  const chunks = Math.ceil(((Date.parse(to) - Date.parse(from)) / 86400000 + 1) / 86);
  let n = 0;
  for (let a = from; a <= to; a = addDays(a, 86)) {
    const b = addDays(a, 85) < to ? addDays(a, 85) : to;
    if (chunks > 2) await progress(`Downloading index candles (${++n} of ${chunks})`);
    const rows = await dhan.intraday(s.data_security_id, s.data_segment, s.data_instrument, interval, `${a} 09:00:00`, `${b} 15:31:00`);
    for (const r of rows) {
      const p = ist(r.t);
      if (p.min >= 555 && p.min < 930) out.set(r.t, { ...r, day: p.date, min: p.min });
    }
  }
  return [...out.values()].sort((x, y) => x.t - y.t);
}

function groupByDay<T extends { day: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const a = m.get(r.day); if (a) a.push(r); else m.set(r.day, [r]); }
  return m;
}

/** Price at a clock time: open of the first bar starting at/after it (within 15 min), else the last close before it. */
function priceAt<T extends { min: number; o: number; c: number }>(bars: T[] | undefined, m: number): T & { px: number } | null {
  if (!bars || !bars.length) return null;
  const after = bars.find((b) => b.min >= m && b.min <= m + 15);
  if (after) return { ...after, px: after.o };
  let before: T | null = null;
  for (const b of bars) if (b.min < m) before = b;
  return before ? { ...before, px: before.c } : null;
}

export function validateParams(p: BtParams) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || p.from > p.to) throw new Error("Pick a valid date range.");
  const span = (Date.parse(p.to) - Date.parse(p.from)) / 86400000;
  if (span > MAX_DAYS) throw new Error("Backtests can cover up to 5 years per run.");
}

export function newAcc(capital: number): Acc {
  return { equity: capital, peak: capital, maxDd: 0, grossWin: 0, grossLoss: 0, wins: 0, gross: 0, costs: 0, skipped: {}, lastDone: "", calls: 0, rounds: 0 };
}

/** Phase 1: decide every trade from index data. */
export async function planBacktest(
  s: Record<string, any>, creds: { client: string; token: string }, p: BtParams, progress: (msg: string) => Promise<void>,
): Promise<{ plans: Plan[]; calls: number }> {
  if (!creds.client || !creds.token) throw new Error("Add your Dhan client ID and access token under Dhan connection.");
  validateParams(p);
  const dhan = new Dhan(creds.client, creds.token);
  const today = ist(Date.now() / 1000).date;
  const isOpt = s.trade_type === "OPTIONS";
  const step = Number(s.strike_step);
  const kind = s.strategy_kind;
  const biasTf = String(s.bias_timeframe);
  const base = kind !== "TIMED" && s.timeframe_min % 5 !== 0 ? 1 : 5;
  if (base === 1 && (Date.parse(p.to) - Date.parse(p.from)) / 86400000 > 366) {
    throw new Error("Timeframes that aren't a multiple of 5 minutes need 1-minute data; test those up to 1 year per run.");
  }

  // Long warm-up (500+ candles) so Supertrend has settled to the same values the chart shows.
  const warmBars = Math.max(500, s.atr_period * 10);
  let warm = 3;
  if (kind !== "TIMED") warm = Math.ceil(((warmBars * s.timeframe_min) / 375) * 1.5) + 5;
  else if (biasTf !== "D") warm = Math.ceil(((warmBars * Number(biasTf)) / 375) * 1.5) + 5;
  const fetchTo = addDays(p.to, 6) < today ? addDays(p.to, 6) : today;

  const raw = await intradayRange(dhan, s, base, addDays(p.from, -warm), fetchTo, progress);
  if (!raw.length) throw new Error("Dhan returned no index candles for this period.");
  const byDay = groupByDay(raw);
  const allDays = [...byDay.keys()].sort();
  const testDays = allDays.filter((d) => d >= p.from && d <= p.to);
  const nextTradingDay = (d: string) => allDays.find((x) => x > d) ?? null;

  const plans: Plan[] = [];
  const dirOk = (side: Side) => s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
  const mkPlan = (side: Side, day: string, min: number, decide: number, why: string): Plan => {
    const opt = isOpt ? (side === "LONG" ? "CE" : "PE") : null;
    return { side, opt, entryDay: day, entryMin: min, exitDay: "", exitMin: 0, spotIn: decide, spotOut: null, strike: opt ? strikeFor(decide, step, s.strike_offset, opt) : null, why, exitWhy: "" };
  };

  if (kind !== "TIMED") {
    const sigName = kind === "HA" ? "Heikin Ashi" : "Supertrend";
    await progress(`Replaying ${sigName} signals`);
    const nowSec = Date.now() / 1000;
    const bars: Bar[] = aggregate(raw, s.timeframe_min).filter((b) => b.endT <= nowSec);
    const { trend } = signalSeries(s as any, bars);
    const ss = timeToMin(String(s.session_start)), le = timeToMin(String(s.last_entry)), sq = timeToMin(String(s.square_off));
    const breakout = s.entry_trigger === "BREAKOUT";
    const buf = Number(s.buffer_points) || 0;
    // Stop-and-reverse on the signal (Supertrend, or Heikin Ashi colour), decided when a candle closes inside the window:
    //  - Up -> hold long (calls), down -> hold short (puts); the opposite position is closed and reversed.
    //  - Entry at close (CLOSE): trade at that candle's close.
    //    Breakout (BREAKOUT): arm an order at the signal candle's high + buffer (buy) or low - buffer (sell). It fills only if
    //    the next candle trades through it; otherwise it is cancelled and re-armed from that candle, and so on.
    //  - A flip after "no new trades after" is not traded that day. By default (FIRST_CLOSE) it is decided at the close of the
    //    next day's first candle in the window, using the signal as it stands then; with OPEN it is acted on at the session start.
    //  - Intraday mode squares off at the square-off time.
    type Pending = { target: Side | null; up: boolean; trig: number; valid: number; why: string };
    let pos = null as Plan | null;
    let pending = null as Pending | null;
    const close = (day: string, min: number, why: string, px?: number) => {
      if (!pos) return;
      pos.exitDay = day; pos.exitMin = min; pos.exitWhy = why; if (px != null) pos.fillOut = px;
      plans.push(pos); pos = null;
    };
    const want = (t: number): Side | null => t === 1 ? (dirOk("LONG") ? "LONG" : null) : t === -1 ? (dirOk("SHORT") ? "SHORT" : null) : null;
    const okMin = (m: number) => m >= ss && m < le && (!s.intraday || m < sq);
    const armFrom = (target: Side | null, ref: { h: number; l: number }, valid: number, why: string): Pending => {
      const up = target === "LONG" || (target === null && pos?.side === "SHORT");
      const trig = up ? ref.h + buf : ref.l - buf;
      return { target, up, trig, valid, why: `${why}; ${up ? "broke above" : "broke below"} ${+trig.toFixed(2)}` };
    };
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      if (b.day > p.to) break;
      const newDay = b.day !== bars[i - 1].day;
      if (pos && s.intraday && (b.day !== pos.entryDay || b.endMin >= sq)) close(pos.entryDay, sq, "Square-off");
      if (s.intraday && newDay) pending = null;
      if (b.day < p.from || trend[i] === 0 || trend[i - 1] === 0) continue;

      // OPEN mode: a flip from after hours yesterday is acted on at today's session start.
      if (s.after_hours_flip === "OPEN" && newDay) {
        const d0 = want(trend[i - 1]);
        const mism = pos ? pos.side !== d0 : false;
        if (breakout) {
          if (mism || (!pos && d0 && s.entry_mode === "JOIN")) pending = armFrom(d0, bars[i - 1], i, `${sigName} turned after hours`);
        } else if (mism) {
          close(b.day, ss, `${sigName} turned after hours (acted on at the open)`);
          if (d0) pos = mkPlan(d0, b.day, ss, b.o, "Reversed at the open (flip happened after hours)");
        } else if (!pos && d0 && s.entry_mode === "JOIN") pos = mkPlan(d0, b.day, ss, b.o, "Joined trend");
      }

      // Breakout order armed for this candle: fill at the first base candle that trades through the trigger.
      if (breakout && pending && pending.valid === i) {
        const pd = pending;
        const hit = (byDay.get(b.day) ?? []).find((r) => r.min >= b.startMin && r.min < b.endMin && okMin(r.min) && (pd.up ? r.h >= pd.trig : r.l <= pd.trig));
        if (hit) {
          const px = pd.up ? Math.max(hit.o, pd.trig) : Math.min(hit.o, pd.trig);
          const m = hit.min; // the base candle in which the trigger was traded through
          if (pos && pos.side !== pd.target) close(b.day, m, pd.target ? `${sigName} turned (breakout filled)` : "Exit (breakout filled)", px);
          if (pd.target && !pos) { pos = mkPlan(pd.target, b.day, m, px, pd.why); pos.fillIn = px; }
          pending = null;
        }
      }

      const inWindow = b.endMin >= ss && b.endMin < le && (!s.intraday || b.endMin < sq) && b.endMin < 930;
      if (!inWindow) continue;
      const desired = want(trend[i]);
      const flipped = trend[i] !== trend[i - 1];
      if (breakout) {
        const mism = pos ? pos.side !== desired : false;
        if (mism || (!pos && desired && (s.entry_mode === "JOIN" || flipped || pending?.target === desired))) {
          const why = flipped ? (pos ? "Reversed on flip" : "Fresh flip") : pending ? "Re-armed from the next candle" : pos ? "Reversed (flip happened after hours)" : "Joined trend";
          pending = armFrom(desired, b, i + 1, why);
        } else pending = null;
        continue;
      }
      let reversing = false;
      if (pos && pos.side !== desired) { close(b.day, b.endMin, flipped ? `${sigName} turned` : `${sigName} turned after hours (acted on at first candle close)`); reversing = true; }
      if (!pos && desired && (s.entry_mode === "JOIN" || flipped || reversing)) {
        pos = mkPlan(desired, b.day, b.endMin, b.c, flipped ? (reversing ? "Reversed on flip" : "Fresh flip") : reversing ? "Reversed at first candle close (flip happened after hours)" : "Joined trend");
      }
    }
    if (pos) close(testDays[testDays.length - 1] ?? p.to, 925, "Still open at end of test (valued at the last price)");
  } else {
    await progress("Working out the bias for each day");
    const entryMin = timeToMin(String(s.entry_time)), exitMin = timeToMin(String(s.exit_time));
    let biasAt: (day: string) => number;
    if (biasTf === "D") {
      const daily: DayBar[] = await dhan.daily(s.data_security_id, s.data_segment, s.data_instrument,
        addDays(p.from, -Math.ceil(Math.max(500, s.atr_period * 10) * 1.5)), addDays(p.to, 1));
      const full = supertrend(daily, s.atr_period, Number(s.factor)).trend;
      let ptr = -1; // index of the last daily bar before the current day (days are visited in order)
      biasAt = (day) => {
        while (ptr + 1 < daily.length && daily[ptr + 1].day < day) ptr++;
        if (s.bias_source !== "LIVE") return ptr >= 0 ? full[ptr] : 0;
        const part = partialDay((byDay.get(day) ?? []).filter((b) => b.min < entryMin), day);
        const prior = daily.slice(Math.max(0, ptr + 1 - 600), ptr + 1);
        const tr = supertrend(part ? [...prior, part] : prior, s.atr_period, Number(s.factor)).trend;
        return tr.length ? tr[tr.length - 1] : 0;
      };
    } else {
      const tf = Number(biasTf);
      const bb = aggregate(raw, tf);
      const full = supertrend(bb, s.atr_period, Number(s.factor)).trend;
      let ptr = -1;
      biasAt = (day) => {
        const startMin = 555 + Math.floor((entryMin - 555) / tf) * tf;
        if (s.bias_source === "COMPLETED") {
          while (ptr + 1 < bb.length && (bb[ptr + 1].day < day || (bb[ptr + 1].day === day && bb[ptr + 1].endMin <= entryMin))) ptr++;
          return ptr >= 0 ? full[ptr] : 0;
        }
        while (ptr + 1 < bb.length && (bb[ptr + 1].day < day || (bb[ptr + 1].day === day && bb[ptr + 1].startMin < startMin))) ptr++;
        const prior = bb.slice(Math.max(0, ptr + 1 - 600), ptr + 1);
        const part = partialDay((byDay.get(day) ?? []).filter((b) => b.min >= startMin && b.min < entryMin), day);
        const tr = supertrend(part ? [...prior, part] : prior, s.atr_period, Number(s.factor)).trend;
        return tr.length ? tr[tr.length - 1] : 0;
      };
    }
    let pos: Plan | null = null;
    for (const day of testDays) {
      if (pos && s.exit_next_day && day > (pos as Plan).entryDay) { (pos as Plan).exitDay = day; (pos as Plan).exitMin = exitMin; (pos as Plan).exitWhy = "Timed exit"; plans.push(pos); pos = null; }
      const t = biasAt(day);
      if (!pos) {
        const side: Side | null = t === 1 ? "LONG" : t === -1 ? "SHORT" : null;
        const spot = priceAt(byDay.get(day), entryMin);
        if (side && dirOk(side) && spot) {
          pos = mkPlan(side, day, entryMin, spot.px, `${biasTf === "D" ? "Daily" : biasTf + "-min"} Supertrend ${t === 1 ? "up" : "down"}`);
          if (!s.exit_next_day) { (pos as Plan).exitDay = day; (pos as Plan).exitMin = exitMin; (pos as Plan).exitWhy = "Timed exit"; plans.push(pos); pos = null; }
        }
      }
    }
    if (pos) {
      const nd = nextTradingDay((pos as Plan).entryDay);
      if (nd) { (pos as Plan).exitDay = nd; (pos as Plan).exitMin = exitMin; (pos as Plan).exitWhy = "Timed exit"; plans.push(pos); }
    }
  }

  // Record the index price at each entry and exit so pricing never needs the index data again.
  for (const pl of plans) {
    pl.spotIn = pl.fillIn ?? priceAt(byDay.get(pl.entryDay), pl.entryMin)?.px ?? pl.spotIn;
    pl.spotOut = pl.fillOut ?? priceAt(byDay.get(pl.exitDay), pl.exitMin)?.px ?? null;
  }
  return { plans, calls: dhan.calls };
}

/** Phase 2: price planned trades from `start` until the deadline. */
export async function priceBatch(
  s: Record<string, any>, creds: { client: string; token: string }, p: BtParams, plans: Plan[], start: number,
  acc: Acc, deadline: number, progress: (msg: string) => Promise<void>,
): Promise<{ trades: Record<string, unknown>[]; next: number; acc: Acc }> {
  const dhan = new Dhan(creds.client, creds.token);
  const isOpt = s.trade_type === "OPTIONS";
  const units = s.lots * s.lot_size;
  const step = Number(s.strike_step);

  const cache = new Map<string, Map<string, (OptBar & { min: number; day: string })[]>>();
  const winStart = (day: string) => {
    const n = Math.floor((Date.parse(day) - Date.parse(p.from)) / 86400000 / 30);
    return addDays(p.from, n * 30);
  };
  async function series(type: "CALL" | "PUT", k: number, code: number, day: string) {
    const ws = winStart(day);
    const key = `${type}|${k}|${code}|${ws}`;
    let m = cache.get(key);
    if (!m) {
      const rows = await dhan.rolling({ sec: s.data_security_id, segment: optionsSegment(s), interval: 5, code, k, type, from: ws, to: addDays(ws, 30) });
      m = groupByDay(rows.map((r) => { const q = ist(r.t); return { ...r, day: q.date, min: q.min }; }));
      cache.set(key, m);
    }
    return m.get(day);
  }
  async function optPrice(day: string, min: number, spot: number, opt: "CE" | "PE", strike: number, code: number): Promise<number | null> {
    let k = Math.max(-10, Math.min(10, Math.round((strike - Math.round(spot / step) * step) / step)));
    for (let tries = 0; tries < 3; tries++) {
      const bar = priceAt(await series(opt === "CE" ? "CALL" : "PUT", k, code, day), min);
      if (!bar || !(bar.px > 0)) return null;
      if (bar.strike == null || Math.abs(bar.strike - strike) < 0.01) return bar.px;
      const k2 = k + Math.round((strike - bar.strike) / step);
      if (k2 === k || Math.abs(k2) > 10) return null;
      k = k2;
    }
    return null;
  }
  const isExpiry = (d: string) => weekdayOf(d) === Number(s.expiry_weekday);
  const expiriesBetween = (a: string, b: string) => { let n = 0; for (let d = a; d < b; d = addDays(d, 1)) if (isExpiry(d)) n++; return n; };
  const skip = (why: string) => { acc.skipped[why] = (acc.skipped[why] ?? 0) + 1; };

  const trades: Record<string, unknown>[] = [];
  let i = start;
  for (; i < plans.length; i++) {
    if (Date.now() > deadline) break;
    const t = plans[i];
    if ((i - start) % 10 === 0) await progress(`Pricing trade ${i + 1} of ${plans.length}`);
    let inPx: number | null, outPx: number | null, contract: string;
    // Breakout fills are stamped with the base candle in which the trigger traded; price the option at that candle's end.
    const baseMin = s.strategy_kind !== "TIMED" && s.timeframe_min % 5 !== 0 ? 1 : 5;
    const inMin = t.fillIn != null ? t.entryMin + baseMin : t.entryMin, outMin = t.fillOut != null ? t.exitMin + baseMin : t.exitMin;
    if (isOpt && t.opt && t.strike != null) {
      const inCode = p.near_code + (s.roll_on_expiry && isExpiry(t.entryDay) ? 1 : 0);
      const outCode = inCode - expiriesBetween(t.entryDay, t.exitDay);
      if (outCode < p.near_code) { skip("Contract expired before the exit (turn on next-week expiry)"); continue; }
      contract = `${s.dhan_symbol} ${t.strike} ${t.opt}${inCode > p.near_code ? " (next week)" : ""}`;
      inPx = await optPrice(t.entryDay, inMin, t.spotIn, t.opt, t.strike, inCode);
      outPx = inPx == null ? null : await optPrice(t.exitDay, outMin, t.spotOut ?? t.spotIn, t.opt, t.strike, outCode);
    } else {
      contract = `${s.underlying} index (futures proxy)`;
      inPx = t.spotIn;
      outPx = t.spotOut;
    }
    if (inPx == null || outPx == null) { skip("No historical price for that contract and time"); continue; }
    const dir = isOpt ? 1 : t.side === "LONG" ? 1 : -1;
    // Buy and sell legs: a long (or any option buy) buys at entry and sells at exit; a short does the reverse.
    const buyVal = (dir === 1 ? inPx : outPx) * units, sellVal = (dir === 1 ? outPx : inPx) * units;
    const ch = tradeCharges(p, isOpt, buyVal, sellVal);
    // Whole rupees only: paisa are dropped (not rounded up or down).
    const exact = (outPx - inPx) * dir * units;
    const g = Math.trunc(exact), c = Math.trunc(ch.total), net = Math.trunc(exact - ch.total);
    acc.chg = acc.chg ?? { brokerage: 0, stt: 0, exch: 0, sebi: 0, gst: 0, stamp: 0 };
    for (const k of ["brokerage", "stt", "exch", "sebi", "gst", "stamp"] as const) acc.chg[k] += ch[k];
    acc.gross += g; acc.costs += c; acc.equity += net;
    if (net > 0) { acc.wins++; acc.grossWin += net; } else acc.grossLoss += -net;
    acc.peak = Math.max(acc.peak, acc.equity); acc.maxDd = Math.max(acc.maxDd, acc.peak - acc.equity);
    acc.lastDone = t.exitDay;
    trades.push({
      entry: `${t.entryDay} ${minToTime(t.entryMin)}`, exit: `${t.exitDay} ${minToTime(t.exitMin)}`, side: t.side, contract,
      why: t.why, exit_why: t.exitWhy, entry_px: +inPx.toFixed(2), exit_px: +outPx.toFixed(2), units,
      gross: g, costs: c, net, equity: Math.trunc(acc.equity),
      chg: { brokerage: ch.brokerage, stt: ch.stt, exch: ch.exch, sebi: ch.sebi, gst: ch.gst, stamp: ch.stamp, total: ch.total },
    });
  }
  acc.calls += dhan.calls;
  return { trades, next: i, acc };
}

/** Phase 3: totals. */
export function summarize(s: Record<string, any>, p: BtParams, planned: number, tradeCount: number, acc: Acc, partial: boolean) {
  const n = tradeCount;
  const net = acc.equity - Number(p.capital); // sum of each trade's whole-rupee net
  return {
    trades: n, planned, wins: acc.wins, losses: n - acc.wins,
    win_rate: n ? +((acc.wins / n) * 100).toFixed(1) : 0,
    gross: Math.trunc(acc.gross), costs: Math.trunc(acc.costs), net: Math.trunc(net),
    return_pct: +((net / p.capital) * 100).toFixed(2),
    max_dd: Math.trunc(acc.maxDd), max_dd_pct: +((acc.maxDd / p.capital) * 100).toFixed(2),
    profit_factor: acc.grossLoss > 0 ? +(acc.grossWin / acc.grossLoss).toFixed(2) : null,
    avg_net: n ? Math.trunc(net / n) : 0,
    skipped: acc.skipped, priced_with: s.trade_type === "OPTIONS" ? "Dhan expired-options data (5-minute)" : "Index prices as a futures proxy",
    dhan_calls: acc.calls, last_day_done: acc.lastDone, partial,
    charges: acc.chg ? Object.fromEntries(Object.entries(acc.chg).map(([k, v]) => [k, Math.trunc(v)])) : null,
  };
}
