// Historical simulation of a strategy, priced with Dhan's expired-options data.
// Runs in instalments so it can cover up to 5 years:
//   1. planBacktest  – downloads index candles once and decides every trade (entry/exit times, strike)
//   2. priceBatch    – prices as many planned trades as fit in one invocation; the engine chains the rest
//   3. summarize     – totals once every trade is priced
import { legsFor, legSign, legText, structMargin, structName, structOf } from "./structures.ts";
import { Dhan, DhanBusyError, type OptBar } from "./dhan.ts";
import {
  addDays, aggregate, type Bar, type DayBar, isCommodity, isLastWeekdayOfMonth, ist, minToTime, partialDay, type Raw,
  sessionFor, signalSeries, strikeFor, supertrend, timeToMin, weekdayOf,
} from "./logic.ts";
import { decide, describeCond, ruleSets, RuleBook, ruleTimeframes, type Signals, validateRules, warmBarsFor } from "./rules.ts";
import { atr as atrSeries } from "./indicators.ts";
import { hasLevels, normaliseRisk, type RiskHit, riskInit, riskScan, type RiskState } from "./risk.ts";
import { lotsFor, marginPerLot, normaliseSizing } from "./sizing.ts";

const epochAt = (day: string, min: number) => Date.parse(`${day}T00:00:00+05:30`) / 1000 + min * 60;

/** Statutory charge rates in %, as used by brokers' calculators (e.g. Zerodha / Dhan, NSE F&O). */
export type ChargeRates = {
  brk_pct: number; stt_fut: number; stt_opt: number; exch_fut: number; exch_opt: number; sebi: number; gst: number; stamp_fut: number; stamp_opt: number;
};
/** sizing: work out lots per trade from equity with the strategy's sizing settings; deploy_pct: portfolio deployment cap (%). */
/** margin_rate: Dhan's margin rate (share of contract value) for this asset when the run started; used for lots from capital. */
export type BtParams = { from: string; to: string; capital: number; brokerage: number; other_pct?: number; charges?: ChargeRates; near_code: number; sizing?: boolean; deploy_pct?: number; margin_rate?: number | null; sell_rate?: number | null };
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
export type MBar = Raw & { day: string; min: number };
type Side = "LONG" | "SHORT";
export type Plan = {
  side: Side; opt: "CE" | "PE" | null; entryDay: string; entryMin: number; exitDay: string; exitMin: number;
  spotIn: number; spotOut: number | null; strike: number | null; why: string; exitWhy: string;
  fillIn?: number; fillOut?: number; // exact index fills for breakout orders and stop / target exits
  rk?: RiskState | null; // stop / target levels while the position is open (underlying basis)
};
export type Acc = {
  equity: number; peak: number; maxDd: number; grossWin: number; grossLoss: number; wins: number;
  gross: number; costs: number; skipped: Record<string, number>; lastDone: string; calls: number; rounds: number;
  chg?: { brokerage: number; stt: number; exch: number; sebi: number; gst: number; stamp: number };
  busy?: number; // rounds cut short because Dhan was unavailable
  notes?: string[]; // caveats found while planning (e.g. limited commodity history)
  dayNet?: Record<string, number>; // net ₹ of closed trades per exit day (daily loss limit)
  lots?: { min: number; max: number; sum: number; n: number }; // lots per trade when sized from capital
};

/** Saved option series shared between runs (the strategy lab keeps them in the database). */
export type OptStore = { get(key: string): Promise<OptBar[] | null>; put(key: string, rows: OptBar[]): Promise<void> };
const WIN_ANCHOR = "2020-01-01";

export const MAX_DAYS = 1827; // 5 years, the depth of Dhan's expired-options history

function optionsSegment(s: Record<string, any>): string {
  return s.exchange === "BSE" ? "BSE_FNO" : "NSE_FNO";
}

/** The security to fetch candles for: commodities use the near-month contract resolved before planning. */
const dataSec = (s: Record<string, any>) => String(s.data_sec_resolved ?? s.data_security_id);

async function intradayRange(dhan: Dhan, s: Record<string, any>, interval: number, from: string, to: string, progress: (m: string) => Promise<void>): Promise<MBar[]> {
  const out = new Map<number, MBar>();
  const chunks = Math.ceil(((Date.parse(to) - Date.parse(from)) / 86400000 + 1) / 86);
  let n = 0;
  for (let a = from; a <= to; a = addDays(a, 86)) {
    const b = addDays(a, 85) < to ? addDays(a, 85) : to;
    if (chunks > 2) await progress(`Downloading candles (${++n} of ${chunks})`);
    const rows = await dhan.intraday(dataSec(s), s.data_segment, s.data_instrument, interval, `${a} 09:00:00`, `${b} 23:59:00`);
    for (const r of rows) {
      const p = ist(r.t), sess = sessionFor(s.data_segment, p.date);
      if (p.min >= sess.open && p.min < sess.close) out.set(r.t, { ...r, day: p.date, min: p.min });
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
  // Long tests of once-a-day futures strategies may go back 10 years (daily candles); everything else 5 years.
  if (span > ((p as any).long ? 3660 : MAX_DAYS)) throw new Error(`Backtests can cover up to ${(p as any).long ? 10 : 5} years per run.`);
}

export function newAcc(capital: number): Acc {
  return { equity: capital, peak: capital, maxDd: 0, grossWin: 0, grossLoss: 0, wins: 0, gross: 0, costs: 0, skipped: {}, lastDone: "", calls: 0, rounds: 0 };
}

/** Phase 1: decide every trade from index data. */
export async function planBacktest(
  s: Record<string, any>, creds: { client: string; token: string }, p: BtParams, progress: (msg: string) => Promise<void>,
): Promise<{ plans: Plan[]; calls: number; notes: string[] }> {
  if (!creds.client || !creds.token) throw new Error("Add your Dhan client ID and access token under Dhan connection.");
  validateParams(p);
  const dhan = new Dhan(creds.client, creds.token);
  const today = ist(Date.now() / 1000).date;
  const isOpt = s.trade_type === "OPTIONS";
  const step = Number(s.strike_step);
  const kind = s.strategy_kind;
  const biasTf = String(s.bias_timeframe);
  const seg = String(s.data_segment);
  const notes: string[] = [];
  const rules = kind === "RULES" ? validateRules(s.rules) : null;
  // Multi-leg structures take their stops on the index / futures price (premium stops are single-option only).
  const risk = normaliseRisk(s.risk, isOpt && !structOf(s));
  const levels = hasLevels(risk) && risk!.basis === "UNDERLYING";
  const ruleTfs = rules ? ruleTimeframes(rules, s.timeframe_min) : null;
  const needsMinute = kind !== "TIMED" && (s.timeframe_min % 5 !== 0 || (ruleTfs?.intraday ?? []).some((tf) => tf % 5 !== 0));
  const base = needsMinute ? 1 : 5;
  if (base === 1 && (Date.parse(p.to) - Date.parse(p.from)) / 86400000 > 366) {
    throw new Error("Timeframes that aren't a multiple of 5 minutes need 1-minute data; test those up to 1 year per run.");
  }

  // Long warm-up (500+ candles) so Supertrend has settled to the same values the chart shows.
  const warmBars = rules ? warmBarsFor(rules) : Math.max(500, s.atr_period * 10);
  const dayMins = isCommodity(seg) ? 860 : 375; // trading minutes per day
  const maxTf = rules ? Math.max(s.timeframe_min, ...ruleTfs!.intraday) : s.timeframe_min;
  let warm = 3;
  if (kind !== "TIMED") warm = Math.ceil(((warmBars * maxTf) / dayMins) * 1.5) + 5;
  else if (biasTf !== "D") warm = Math.ceil(((warmBars * Number(biasTf)) / dayMins) * 1.5) + 5;
  const fetchTo = addDays(p.to, 6) < today ? addDays(p.to, 6) : today;

  const dailyMode = !!rules?.daily;
  const raw = dailyMode ? [] : await intradayRange(dhan, s, base, addDays(p.from, -warm), fetchTo, progress);
  if (!raw.length && !dailyMode) throw new Error(isCommodity(seg)
    ? "Dhan returned no candles for this period. For commodities Dhan only has intraday history for the current contract; try a recent period."
    : "Dhan returned no index candles for this period.");
  if (isCommodity(seg) && raw.length && raw[0].day > p.from) {
    notes.push(`Dhan has intraday history for the current ${s.underlying} contract only from ${raw[0].day}, so trades start there.`);
  }
  const byDay = groupByDay(raw);
  const allDays = [...byDay.keys()].sort();
  const testDays = allDays.filter((d) => d >= p.from && d <= p.to);
  const nextTradingDay = (d: string) => allDays.find((x) => x > d) ?? null;

  const plans: Plan[] = [];
  const dirOk = (side: Side) => s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
  const selling = isOpt && s.option_side === "SELL";
  const mkPlan = (side: Side, day: string, min: number, decide: number, why: string): Plan => {
    // Buying: bullish → CE, bearish → PE. Writing: bullish → sell PE, bearish → sell CE.
    const opt = isOpt ? ((side === "LONG") !== selling ? "CE" : "PE") : null;
    return { side, opt, entryDay: day, entryMin: min, exitDay: "", exitMin: 0, spotIn: decide, spotOut: null, strike: opt ? strikeFor(decide, step, s.strike_offset, opt) : null, why, exitWhy: "" };
  };

  if (kind === "RULES") {
    await progress("Checking your conditions on every candle");
    const daily: DayBar[] = ruleTfs!.daily
      ? await dhan.daily(dataSec(s), seg, s.data_instrument, addDays(p.from, -Math.ceil(warmBars * 1.5)), addDays(p.to, 1))
      : [];
    plans.push(...simulateRules(s, { raw, byDay, daily }, p.from, p.to));
  } else if (kind !== "TIMED") {
    const sigName = kind === "HA" ? "Heikin Ashi" : "Supertrend";
    await progress(`Replaying ${sigName} signals`);
    const nowSec = Date.now() / 1000;
    const bars: Bar[] = aggregate(raw, s.timeframe_min, seg).filter((b) => b.endT <= nowSec);
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
      pos.rk = undefined; plans.push(pos); pos = null;
    };
    // Stop loss / target / trailing stop on the index (or commodity) price, checked on the base candles.
    const fATR = levels ? atrSeries(bars, risk!.atr_len ?? 14) : [];
    const arm = (k: number, px: number, scanFrom: number) => { if (pos && levels) pos.rk = riskInit(risk, pos.side === "LONG" ? 1 : -1, px, fATR[k], scanFrom); };
    const scanBar = (b: Bar) => {
      if (!pos?.rk) return;
      const rows = (byDay.get(b.day) ?? []).filter((r) => r.min >= b.startMin && r.min < b.endMin && (!s.intraday || r.min < sq));
      const hit = riskScan(pos.rk, rows);
      if (hit) close(b.day, ist(hit.t).min, hit.why, hit.px);
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
      if (pos && s.intraday && b.day !== pos.entryDay) close(pos.entryDay, sq, "Square-off");
      scanBar(b);
      if (pos && s.intraday && b.endMin >= sq) close(pos.entryDay, sq, "Square-off");
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
          if (d0) { pos = mkPlan(d0, b.day, ss, b.o, "Reversed at the open (flip happened after hours)"); arm(i - 1, b.o, b.t); scanBar(b); }
        } else if (!pos && d0 && s.entry_mode === "JOIN") { pos = mkPlan(d0, b.day, ss, b.o, "Joined trend"); arm(i - 1, b.o, b.t); scanBar(b); }
      }

      // Breakout order armed for this candle: fill at the first base candle that trades through the trigger.
      if (breakout && pending && pending.valid === i) {
        const pd = pending;
        const hit = (byDay.get(b.day) ?? []).find((r) => r.min >= b.startMin && r.min < b.endMin && okMin(r.min) && (pd.up ? r.h >= pd.trig : r.l <= pd.trig));
        if (hit) {
          const px = pd.up ? Math.max(hit.o, pd.trig) : Math.min(hit.o, pd.trig);
          const m = hit.min; // the base candle in which the trigger was traded through
          if (pos && pos.side !== pd.target) close(b.day, m, pd.target ? `${sigName} turned (breakout filled)` : "Exit (breakout filled)", px);
          if (pd.target && !pos) { pos = mkPlan(pd.target, b.day, m, px, pd.why); pos.fillIn = px; arm(i - 1, px, hit.t + base * 60); scanBar(b); }
          pending = null;
        }
      }

      const inWindow = b.endMin >= ss && b.endMin < le && (!s.intraday || b.endMin < sq) && b.endMin < sessionFor(seg, b.day).close;
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
        arm(i, b.c, b.endT);
      }
    }
    if (pos) close(testDays[testDays.length - 1] ?? p.to, sessionFor(seg, testDays[testDays.length - 1] ?? p.to).close - 5, "Still open at end of test (valued at the last price)");
  } else {
    await progress("Working out the bias for each day");
    const entryMin = timeToMin(String(s.entry_time)), exitMin = timeToMin(String(s.exit_time));
    let biasAt: (day: string) => number;
    if (biasTf === "D") {
      const daily: DayBar[] = await dhan.daily(dataSec(s), s.data_segment, s.data_instrument,
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
      const bb = aggregate(raw, tf, seg);
      const full = supertrend(bb, s.atr_period, Number(s.factor)).trend;
      let ptr = -1;
      biasAt = (day) => {
        const open = sessionFor(seg, day).open;
        const startMin = open + Math.floor((entryMin - open) / tf) * tf;
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
    delete pl.rk;
  }
  // Timed strategies: stop / target / trailing stop between the entry and exit times (points or %; no ATR).
  if (kind === "TIMED" && levels) {
    for (const pl of plans) {
      const t0 = epochAt(pl.entryDay, pl.entryMin), t1 = epochAt(pl.exitDay, pl.exitMin);
      const rk = riskInit(risk, pl.side === "LONG" ? 1 : -1, pl.spotIn, 0, t0);
      if (!rk) continue;
      const rows = allDays.filter((d) => d >= pl.entryDay && d <= pl.exitDay).flatMap((d) => byDay.get(d) ?? []).filter((r) => r.t < t1);
      const hit = riskScan(rk, rows);
      if (hit) { const q = ist(hit.t); pl.exitDay = q.date; pl.exitMin = q.min; pl.fillOut = hit.px; pl.spotOut = hit.px; pl.exitWhy = hit.why; }
    }
  }
  return { plans, calls: dhan.calls, notes };
}

/** Candle data a condition strategy is simulated on. */
export type SimData = { raw: MBar[]; byDay: Map<string, MBar[]>; daily: DayBar[] };

/**
 * Every trade a condition strategy would have made between `from` and `to` (pure: no network).
 *  - Intraday rules: decided at each close of a candle of the strategy's timeframe; orders fill at that close.
 *  - Once-a-day rules (rules.daily): decided at each session open from completed daily candles; orders fill at the open.
 * memo lets many strategies on the same candles share candle frames and indicator series (the strategy lab).
 */
export function simulateRules(s: Record<string, any>, data: SimData, from: string, to: string, memo?: Map<string, unknown>): Plan[] {
  const rules = validateRules(s.rules);
  const seg = String(s.data_segment);
  const isOpt = s.trade_type === "OPTIONS";
  const step = Number(s.strike_step);
  const selling = isOpt && s.option_side === "SELL";
  const dirOk = (side: Side) => s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
  const mkPlan = (side: Side, day: string, min: number, px: number, why: string): Plan => {
    // Buying: bullish → CE, bearish → PE. Writing: bullish → sell PE, bearish → sell CE.
    const opt = isOpt ? ((side === "LONG") !== selling ? "CE" : "PE") : null;
    return { side, opt, entryDay: day, entryMin: min, exitDay: "", exitMin: 0, spotIn: px, spotOut: null, strike: opt ? strikeFor(px, step, s.strike_offset, opt) : null, why, exitWhy: "" };
  };
  const sets = ruleSets(rules);
  const label = (k: "long" | "short") => rules[k]!.conds.map(describeCond).join(rules[k]!.mode === "ANY" ? " or " : " & ");
  const cfg = { join: s.entry_mode === "JOIN", longOk: dirOk("LONG"), shortOk: dirOk("SHORT"), sets };
  const plans: Plan[] = [];
  let pos = null as Plan | null;
  let prev = null as Signals | null;
  const cache = memo ?? new Map<string, unknown>();
  const M = <T>(key: string, fn: () => T): T => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key) as T; };
  const risk = normaliseRisk(s.risk, isOpt && !structOf(s));
  const levels = hasLevels(risk) && risk!.basis === "UNDERLYING";
  const atrLen = risk?.atr_len ?? 14;

  if (rules.daily) {
    const days = data.daily;
    const book = new RuleBook(rules, s.timeframe_min, new Map(), days, data.byDay as any, seg, cache);
    const openT = (day: string) => Date.parse(`${day}T00:00:00+05:30`) / 1000 + sessionFor(seg, day).open * 60 + 60;
    const close = (d: DayBar, why: string, px: number, atClose = false) => {
      if (!pos) return;
      pos.exitDay = d.day; pos.exitMin = atClose ? sessionFor(seg, d.day).close - 5 : sessionFor(seg, d.day).open; pos.exitWhy = why; pos.fillOut = px; pos.spotOut = px;
      pos.rk = undefined; plans.push(pos); pos = null;
    };
    const dATR = levels ? M(`D|ATR${atrLen}`, () => atrSeries(days, atrLen)) : [];
    // A stop or target inside a completed day: the daily candle's range after the entry (time of day unknown).
    const scanDay = (d: DayBar) => {
      if (!pos?.rk) return;
      const hit = riskScan(pos.rk, [{ t: d.t, o: d.o, h: d.h, l: d.l }]);
      if (hit) close(d, hit.why, hit.px, true);
    };
    let last: DayBar | null = null;
    for (let i = 1; i < days.length; i++) {
      const d = days[i];
      if (d.day > to) break;
      if (d.day < from) continue;
      if (last) scanDay(last);
      if (prev === null) prev = book.at(openT(days[i - 1].day));
      const now = book.at(openT(d.day));
      const dc = decide(pos ? pos.side : "FLAT", now, prev, cfg);
      if (dc.exit) close(d, dc.why, d.o);
      if (dc.enter && !pos) {
        pos = mkPlan(dc.enter, d.day, sessionFor(seg, d.day).open, d.o, `${dc.why}: ${label(dc.enter === "LONG" ? "long" : "short")}`); pos.fillIn = d.o;
        if (levels) pos.rk = riskInit(risk, dc.enter === "LONG" ? 1 : -1, d.o, dATR[i - 1], d.t);
      }
      prev = now; last = d;
    }
    if (last) scanDay(last);
    if (pos && last) close(last, "Still open at end of test (valued at the last close)", last.c, true);
    return plans;
  }

  const tfs = ruleTimeframes(rules, s.timeframe_min);
  const nowSec = Date.now() / 1000;
  const frames = new Map<number, Bar[]>();
  for (const tf of tfs.intraday) frames.set(tf, M(`frame|${tf}`, () => aggregate(data.raw, tf, seg).filter((b) => b.endT <= nowSec)));
  const book = new RuleBook(rules, s.timeframe_min, frames, data.daily, data.byDay as any, seg, cache);
  const bars = frames.get(s.timeframe_min)!;
  const ss = timeToMin(String(s.session_start)), le = timeToMin(String(s.last_entry)), sq = timeToMin(String(s.square_off));
  const close = (day: string, min: number, why: string, px?: number) => {
    if (!pos) return;
    pos.exitDay = day; pos.exitMin = min; pos.exitWhy = why; if (px != null) pos.fillOut = px;
    pos.rk = undefined; plans.push(pos); pos = null;
  };
  const tfATR = levels ? M(`${s.timeframe_min}|ATR${atrLen}`, () => atrSeries(bars, atrLen)) : [];
  let lastDay = "";
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (b.day > to) break;
    if (pos && s.intraday && b.day !== pos.entryDay) close(pos.entryDay, sq, "Square-off");
    if (pos?.rk) { // stop / target inside this candle, on the base candles
      const rows = (data.byDay.get(b.day) ?? []).filter((r) => r.min >= b.startMin && r.min < b.endMin && (!s.intraday || r.min < sq));
      const hit = riskScan(pos.rk, rows);
      if (hit) close(b.day, ist(hit.t).min, hit.why, hit.px);
    }
    if (pos && s.intraday && b.endMin >= sq) close(pos.entryDay, sq, "Square-off");
    if (b.day < from) continue;
    lastDay = b.day;
    if (prev === null) prev = book.at(bars[i - 1].endT);
    const now = book.at(b.endT);
    const inWindow = b.endMin >= ss && b.endMin < le && (!s.intraday || b.endMin < sq) && b.endMin < sessionFor(seg, b.day).close;
    if (inWindow) {
      const dc = decide(pos ? pos.side : "FLAT", now, prev, cfg);
      if (dc.exit) close(b.day, b.endMin, dc.why);
      if (dc.enter && !pos) {
        pos = mkPlan(dc.enter, b.day, b.endMin, b.c, `${dc.why}: ${label(dc.enter === "LONG" ? "long" : "short")}`);
        if (levels) pos.rk = riskInit(risk, dc.enter === "LONG" ? 1 : -1, b.c, tfATR[i], b.endT);
      }
    }
    prev = now;
  }
  if (pos) {
    const d = lastDay || to;
    if (s.intraday) close(pos.entryDay, sq, "Square-off");
    else close(d, sessionFor(seg, d).close - 5, "Still open at end of test (valued at the last price)");
  }
  for (const pl of plans) {
    pl.spotIn = pl.fillIn ?? priceAt(data.byDay.get(pl.entryDay), pl.entryMin)?.px ?? pl.spotIn;
    pl.spotOut = pl.fillOut ?? priceAt(data.byDay.get(pl.exitDay), pl.exitMin)?.px ?? null;
  }
  return plans;
}

/** Phase 2: price planned trades from `start` until the deadline. */
export async function priceBatch(
  s: Record<string, any>, creds: { client: string; token: string }, p: BtParams, plans: Plan[], start: number,
  acc: Acc, deadline: number, progress: (msg: string) => Promise<void>, store?: OptStore,
): Promise<{ trades: Record<string, unknown>[]; next: number; acc: Acc }> {
  const dhan = new Dhan(creds.client, creds.token);
  dhan.deadline = deadline + 25000;
  const isOpt = s.trade_type === "OPTIONS";
  const fixedUnits = s.lots * s.lot_size;
  const step = Number(s.strike_step);
  const sz0 = p.sizing ? normaliseSizing(s.sizing, String(s.data_segment)) : null;
  const sz = sz0 && Number(p.margin_rate) > 0 ? { ...sz0, margin_pct: Number(p.margin_rate) * 100 } : sz0;

  const cache = new Map<string, Map<string, (OptBar & { min: number; day: string })[]>>();
  let busyStreak = 0;
  // 30-day request windows on a fixed calendar grid, so the same window can be reused by other runs.
  const winStart = (day: string) => {
    const n = Math.floor((Date.parse(day) - Date.parse(WIN_ANCHOR)) / 86400000 / 30);
    return addDays(WIN_ANCHOR, n * 30);
  };
  const today = ist(Date.now() / 1000).date;
  async function series(type: "CALL" | "PUT", k: number, code: number, day: string) {
    const ws = winStart(day);
    const key = `${type}|${k}|${code}|${ws}`;
    let m = cache.get(key);
    const storeKey = `${s.data_security_id}|${optionsSegment(s)}|${s.expiry_flag === "MONTH" ? "M" : "W"}|${key}`;
    const final = addDays(ws, 31) < today; // a window wholly in the past never changes
    if (!m && store && final) {
      const rows = await store.get(storeKey);
      if (rows) { m = groupByDay(rows.map((r) => { const q = ist(r.t); return { ...r, day: q.date, min: q.min }; })); cache.set(key, m); }
    }
    if (!m) {
      const get = (from: string, to: string) => dhan.rolling({ sec: s.data_security_id, segment: optionsSegment(s), interval: 5, code, k, type, from, to, flag: s.expiry_flag === "MONTH" ? "MONTH" : "WEEK" });
      let rows: OptBar[];
      try { rows = await get(ws, addDays(ws, 30)); }
      catch (e) {
        if (!(e instanceof DhanBusyError)) throw e;
        // Dhan timed out on 30 days at once: ask for 10 days at a time instead.
        busyStreak++;
        if (busyStreak > 6) throw e; // Dhan is down; stop this round and resume later
        rows = [];
        for (let a = 0; a < 30; a += 10) rows.push(...await get(addDays(ws, a), addDays(ws, a + 10)));
      }
      busyStreak = 0;
      if (store && final) await store.put(storeKey, rows);
      m = groupByDay(rows.map((r) => { const q = ist(r.t); return { ...r, day: q.date, min: q.min }; }));
      cache.set(key, m);
    }
    return m.get(day);
  }
  let lastK = 0, lastT = 0;
  async function optPrice(day: string, min: number, spot: number, opt: "CE" | "PE", strike: number, code: number): Promise<number | null> {
    let k = Math.max(-10, Math.min(10, Math.round((strike - Math.round(spot / step) * step) / step)));
    for (let tries = 0; tries < 3; tries++) {
      const bar = priceAt(await series(opt === "CE" ? "CALL" : "PUT", k, code, day), min);
      if (!bar || !(bar.px > 0)) return null;
      if (bar.strike == null || Math.abs(bar.strike - strike) < 0.01) { lastK = k; lastT = bar.t; return bar.px; }
      const k2 = k + Math.round((strike - bar.strike) / step);
      if (k2 === k || Math.abs(k2) > 10) return null;
      k = k2;
    }
    return null;
  }
  // Premium-based stop / target: follow this exact strike's 5-minute candles from entry to the planned exit.
  // Dhan's data is by distance from ATM, so as the index moves the strike is picked up from the neighbouring series.
  async function premiumHit(t: Plan, inCode: number, entryT: number, exitT: number, rs: RiskState): Promise<RiskHit | null> {
    const type = t.opt === "CE" ? "CALL" : "PUT";
    let k = lastK;
    for (let d = t.entryDay; d <= t.exitDay; d = addDays(d, 1)) {
      const code = inCode - expiriesBetween(t.entryDay, d);
      const base = (await series(type, k, code, d)) ?? [];
      const rows: { t: number; o: number; h: number; l: number }[] = [];
      for (const b of base) {
        if (b.t < entryT || b.t >= exitT) continue;
        let bar: OptBar | undefined = b;
        if (b.strike != null && Math.abs(b.strike - t.strike!) >= 0.01) {
          const k2 = k + Math.round((t.strike! - b.strike) / step);
          bar = Math.abs(k2) <= 10 ? ((await series(type, k2, code, d)) ?? []).find((x) => x.t === b.t) : undefined;
          if (bar && bar.strike != null && Math.abs(bar.strike - t.strike!) >= 0.01) bar = undefined;
        }
        if (bar && bar.o > 0) rows.push({ t: bar.t, o: bar.o, h: bar.h ?? Math.max(bar.o, bar.c), l: bar.l ?? Math.min(bar.o, bar.c) });
      }
      const hit = riskScan(rs, rows);
      if (hit) return hit;
    }
    return null;
  }
  const monthly = s.expiry_flag === "MONTH";
  const isExpiry = (d: string) => monthly ? isLastWeekdayOfMonth(d, Number(s.expiry_weekday)) : weekdayOf(d) === Number(s.expiry_weekday);
  const expiriesBetween = (a: string, b: string) => { let n = 0; for (let d = a; d < b; d = addDays(d, 1)) if (isExpiry(d)) n++; return n; };
  const skip = (why: string) => { acc.skipped[why] = (acc.skipped[why] ?? 0) + 1; };
  const risk = normaliseRisk(s.risk, isOpt && !structOf(s));
  const premiumLevels = isOpt && !structOf(s) && hasLevels(risk) && risk!.basis === "PREMIUM";
  const maxDayLoss = risk?.max_day_loss ?? null;
  acc.dayNet = acc.dayNet ?? {};

  const trades: Record<string, unknown>[] = [];
  const struct = structOf(s);
  let i = start;
  for (; i < plans.length; i++) {
    if (Date.now() > deadline) break;
    const t = { ...plans[i] };
    if ((i - start) % 10 === 0) await progress(`Pricing trade ${i + 1} of ${plans.length}`);
    // Daily loss limit: once the day's closed trades have lost the limit, no new trades that day.
    if (maxDayLoss && (acc.dayNet[t.entryDay] ?? 0) <= -maxDayLoss) { skip("Daily loss limit reached"); continue; }
    if (struct) {
      // Multi-leg: every leg priced at the same entry and exit times; P&L and charges are the sum of the legs.
      const baseMin = s.strategy_kind !== "TIMED" && s.timeframe_min % 5 !== 0 ? 1 : 5;
      const inMin = t.fillIn != null ? t.entryMin + baseMin : t.entryMin, outMin = t.fillOut != null ? t.exitMin + baseMin : t.exitMin;
      const inCode = p.near_code + (s.roll_on_expiry && isExpiry(t.entryDay) ? 1 : 0);
      const gone = expiriesBetween(t.entryDay, t.exitDay);
      const legs = legsFor(struct, t.side, t.spotIn, step);
      if (legs.some((l) => l.opt !== "FUT" && inCode + (l.x ?? 0) - gone < p.near_code)) { skip("Contract expired before the exit (turn on next-week expiry)"); continue; }
      const priced: (typeof legs[number] & { px: number; out: number })[] = [];
      let bad = false;
      try {
        for (const l of legs) {
          if (l.opt === "FUT") { priced.push({ ...l, px: t.spotIn, out: t.spotOut ?? t.spotIn }); continue; }
          const a = await optPrice(t.entryDay, inMin, t.spotIn, l.opt, l.strike!, inCode + (l.x ?? 0));
          const b = a == null ? null : await optPrice(t.exitDay, outMin, t.spotOut ?? t.spotIn, l.opt, l.strike!, inCode + (l.x ?? 0) - gone);
          if (a == null || b == null) { bad = true; break; }
          priced.push({ ...l, px: a, out: b });
        }
      } catch (e) {
        if (e instanceof DhanBusyError) { acc.busy = (acc.busy ?? 0) + 1; break; }
        throw e;
      }
      if (bad) { skip("No historical price for a leg at that time"); continue; }
      const lot = Number(s.lot_size);
      const mLot = structMargin(priced, t.spotIn, lot, Number(p.margin_rate) > 0 ? Number(p.margin_rate) : 0.12, Number(p.sell_rate) > 0 ? Number(p.sell_rate) : 0.12);
      let lots = Number(s.lots);
      if (sz) {
        const sr = lotsFor(sz, acc.equity, mLot, 0, Number(p.deploy_pct ?? 100));
        if (sr.lots < 1) { skip("Not enough capital for 1 lot"); continue; }
        lots = sr.lots;
        acc.lots = acc.lots ?? { min: lots, max: lots, sum: 0, n: 0 };
        acc.lots.min = Math.min(acc.lots.min, lots); acc.lots.max = Math.max(acc.lots.max, lots); acc.lots.sum += lots; acc.lots.n++;
      }
      const units = lots * lot;
      let exact = 0;
      const ch = { brokerage: 0, stt: 0, exch: 0, sebi: 0, gst: 0, stamp: 0, total: 0 };
      for (const l of priced) {
        const u = units * (l.q ?? 1), sg = legSign(l);
        exact += (l.out - l.px) * sg * u;
        const c1 = tradeCharges(p, l.opt !== "FUT", (sg === 1 ? l.px : l.out) * u, (sg === 1 ? l.out : l.px) * u);
        for (const k of ["brokerage", "stt", "exch", "sebi", "gst", "stamp", "total"] as const) ch[k] += c1[k];
      }
      // Net premium of the position per unit (paid when positive, received when negative), at entry and exit.
      const netIn = priced.reduce((a2, l) => a2 + legSign(l) * l.px * (l.q ?? 1), 0), netOut = priced.reduce((a2, l) => a2 + legSign(l) * l.out * (l.q ?? 1), 0);
      const g = Math.trunc(exact), c = Math.trunc(ch.total), net = Math.trunc(exact - ch.total);
      acc.chg = acc.chg ?? { brokerage: 0, stt: 0, exch: 0, sebi: 0, gst: 0, stamp: 0 };
      for (const k of ["brokerage", "stt", "exch", "sebi", "gst", "stamp"] as const) acc.chg[k] += ch[k];
      acc.gross += g; acc.costs += c; acc.equity += net;
      if (net > 0) { acc.wins++; acc.grossWin += net; } else acc.grossLoss += -net;
      acc.peak = Math.max(acc.peak, acc.equity); acc.maxDd = Math.max(acc.maxDd, acc.peak - acc.equity);
      acc.lastDone = t.exitDay;
      acc.dayNet[t.exitDay] = (acc.dayNet[t.exitDay] ?? 0) + net;
      trades.push({
        entry: `${t.entryDay} ${minToTime(t.entryMin)}`, exit: `${t.exitDay} ${minToTime(t.exitMin)}`, side: t.side,
        contract: `${structName(struct)}: ${priced.map((l) => legText(l, s.dhan_symbol)).join(" · ")}`,
        legs: priced.map((l) => ({ opt: l.opt, act: l.act, strike: l.strike, x: l.x ?? 0, q: l.q ?? 1, in: +l.px.toFixed(2), out: +l.out.toFixed(2) })),
        why: t.why, exit_why: t.exitWhy, entry_px: +netIn.toFixed(2), exit_px: +netOut.toFixed(2), units, lots, margin: Math.trunc(mLot),
        spot_in: t.spotIn, gross: g, costs: c, net, equity: Math.trunc(acc.equity),
        chg: { brokerage: ch.brokerage, stt: ch.stt, exch: ch.exch, sebi: ch.sebi, gst: ch.gst, stamp: ch.stamp, total: ch.total },
      });
      continue;
    }
    let inPx: number | null = null, outPx: number | null = null, contract = "";
    // Breakout fills are stamped with the base candle in which the trigger traded; price the option at that candle's end.
    const baseMin = s.strategy_kind !== "TIMED" && s.timeframe_min % 5 !== 0 ? 1 : 5;
    const inMin = t.fillIn != null ? t.entryMin + baseMin : t.entryMin, outMin = t.fillOut != null ? t.exitMin + baseMin : t.exitMin;
    if (isOpt && t.opt && t.strike != null) {
      const inCode = p.near_code + (s.roll_on_expiry && isExpiry(t.entryDay) ? 1 : 0);
      const outCode = inCode - expiriesBetween(t.entryDay, t.exitDay);
      if (outCode < p.near_code) { skip("Contract expired before the exit (turn on next-week expiry)"); continue; }
      contract = `${s.option_side === "SELL" ? "Sell " : ""}${s.dhan_symbol} ${t.strike} ${t.opt}${inCode > p.near_code ? " (next week)" : ""}`;
      try {
        inPx = await optPrice(t.entryDay, inMin, t.spotIn, t.opt, t.strike, inCode);
        if (inPx != null && premiumLevels) {
          // Buyers lose when the premium falls, writers when it rises.
          const rs = riskInit(risk, s.option_side === "SELL" ? -1 : 1, inPx, 0, lastT);
          const hit = rs ? await premiumHit(t, inCode, lastT, epochAt(t.exitDay, outMin), rs) : null;
          if (hit) {
            const q = ist(hit.t);
            t.exitDay = q.date; t.exitMin = q.min; t.exitWhy = `${hit.why} (premium)`;
            outPx = hit.px;
          }
        }
        if (outPx == null && inPx != null) outPx = await optPrice(t.exitDay, outMin, t.spotOut ?? t.spotIn, t.opt, t.strike, outCode);
      } catch (e) {
        // Dhan unavailable: keep everything priced so far; the engine retries from this trade in a little while.
        if (e instanceof DhanBusyError) { acc.busy = (acc.busy ?? 0) + 1; break; }
        throw e;
      }
    } else {
      contract = isCommodity(String(s.data_segment)) ? `${s.underlying} futures (near month)` : `${s.underlying} index (futures proxy)`;
      inPx = t.spotIn;
      outPx = t.spotOut;
    }
    if (inPx == null || outPx == null) { skip("No historical price for that contract and time"); continue; }
    // Lots from the equity at the time of the trade (grows after profits, shrinks after losses).
    let units = fixedUnits, lots = Number(s.lots);
    if (sz) {
      const sr = lotsFor(sz, acc.equity, marginPerLot(s as any, sz, t.spotIn, isOpt ? inPx : null), 0, Number(p.deploy_pct ?? 100));
      if (sr.lots < 1) { skip("Not enough capital for 1 lot"); continue; }
      lots = sr.lots; units = lots * Number(s.lot_size);
      acc.lots = acc.lots ?? { min: lots, max: lots, sum: 0, n: 0 };
      acc.lots.min = Math.min(acc.lots.min, lots); acc.lots.max = Math.max(acc.lots.max, lots); acc.lots.sum += lots; acc.lots.n++;
    }
    // Direction of the money: option buyers and longs gain when price rises; option writers and shorts when it falls.
    const dir = isOpt ? (s.option_side === "SELL" ? -1 : 1) : t.side === "LONG" ? 1 : -1;
    // Buy and sell legs: a long (or an option buy) buys at entry and sells at exit; a short (or an option write) the reverse.
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
    acc.dayNet[t.exitDay] = (acc.dayNet[t.exitDay] ?? 0) + net;
    trades.push({
      entry: `${t.entryDay} ${minToTime(t.entryMin)}`, exit: `${t.exitDay} ${minToTime(t.exitMin)}`, side: t.side, contract,
      why: t.why, exit_why: t.exitWhy, entry_px: +inPx.toFixed(2), exit_px: +outPx.toFixed(2), units, lots,
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
    skipped: acc.skipped, notes: acc.notes ?? [],
    priced_with: structOf(s) ? `Dhan expired-options data (5-minute), every leg of the ${structName(structOf(s)!)}` : s.trade_type === "OPTIONS" ? "Dhan expired-options data (5-minute)" : isCommodity(String(s.data_segment)) ? "Near-month futures prices" : "Index prices as a futures proxy",
    dhan_calls: acc.calls, last_day_done: acc.lastDone, partial,
    lots: acc.lots && acc.lots.n ? { min: acc.lots.min, max: acc.lots.max, avg: +(acc.lots.sum / acc.lots.n).toFixed(1) } : null,
    charges: acc.chg ? Object.fromEntries(Object.entries(acc.chg).map(([k, v]) => [k, Math.trunc(v)])) : null,
  };
}
