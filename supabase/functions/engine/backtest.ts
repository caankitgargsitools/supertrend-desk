// Historical simulation of a strategy, priced with Dhan's expired-options data.
import { Dhan, type OptBar } from "./dhan.ts";
import {
  addDays, aggregate, type Bar, type DayBar, ist, minToTime, partialDay, pickBaseInterval, type Raw,
  strikeFor, supertrend, timeToMin, weekdayOf,
} from "./logic.ts";

export type BtParams = { from: string; to: string; capital: number; brokerage: number; other_pct: number; near_code: number };
type MBar = Raw & { day: string; min: number };
type Side = "LONG" | "SHORT";
type Plan = {
  side: Side; opt: "CE" | "PE" | null; entryDay: string; entryMin: number; exitDay: string; exitMin: number;
  spotIn: number; strike: number | null; why: string; exitWhy: string;
};

const MAX_DAYS = 184;

function optionsSegment(s: Record<string, any>): string {
  return s.exchange === "BSE" ? "BSE_FNO" : "NSE_FNO";
}

async function intradayRange(dhan: Dhan, s: Record<string, any>, interval: number, from: string, to: string): Promise<MBar[]> {
  const out = new Map<number, MBar>();
  for (let a = from; a <= to; a = addDays(a, 86)) {
    const b = addDays(a, 85) < to ? addDays(a, 85) : to;
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

export async function runBacktest(
  s: Record<string, any>, creds: { client: string; token: string }, p: BtParams,
  progress: (msg: string) => Promise<void>, deadline: number,
) {
  if (!creds.client || !creds.token) throw new Error("Add your Dhan client ID and access token under Dhan connection.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || p.from > p.to) throw new Error("Pick a valid date range.");
  const span = (Date.parse(p.to) - Date.parse(p.from)) / 86400000;
  if (span > MAX_DAYS) throw new Error(`Backtest up to ${MAX_DAYS} days per run. Split longer periods into several runs.`);

  const dhan = new Dhan(creds.client, creds.token);
  const today = ist(Date.now() / 1000).date;
  const isOpt = s.trade_type === "OPTIONS";
  const units = s.lots * s.lot_size;
  const step = Number(s.strike_step);
  const kind = s.strategy_kind;
  const biasTf = String(s.bias_timeframe);
  const base = kind === "FLIP" && s.timeframe_min % 5 !== 0 ? 1 : 5;

  let warm = 3;
  if (kind === "FLIP") warm = Math.ceil(((s.atr_period * 10 * s.timeframe_min) / 375) * 1.6) + 5;
  else if (biasTf !== "D") warm = Math.ceil(((s.atr_period * 10 * Number(biasTf)) / 375) * 1.6) + 5;
  const fetchTo = addDays(p.to, 6) < today ? addDays(p.to, 6) : today;

  await progress("Downloading index candles");
  const raw = await intradayRange(dhan, s, base, addDays(p.from, -warm), fetchTo);
  if (!raw.length) throw new Error("Dhan returned no index candles for this period.");
  const byDay = groupByDay(raw);
  const allDays = [...byDay.keys()].sort();
  const testDays = allDays.filter((d) => d >= p.from && d <= p.to);
  const nextTradingDay = (d: string) => allDays.find((x) => x > d) ?? null;

  // ---------- 1. decide the trades from index data ----------
  const plans: Plan[] = [];
  const dirOk = (side: Side) => s.direction === "BOTH" || (side === "LONG" ? s.direction === "LONG_ONLY" : s.direction === "SHORT_ONLY");
  const mkPlan = (side: Side, day: string, min: number, spot: number, why: string): Plan => {
    const opt = isOpt ? (side === "LONG" ? "CE" : "PE") : null;
    return { side, opt, entryDay: day, entryMin: min, exitDay: "", exitMin: 0, spotIn: spot, strike: opt ? strikeFor(spot, step, s.strike_offset, opt) : null, why, exitWhy: "" };
  };

  if (kind === "FLIP") {
    await progress("Replaying Supertrend signals");
    const nowSec = Date.now() / 1000;
    const bars: Bar[] = aggregate(raw, s.timeframe_min).filter((b) => b.endT <= nowSec);
    const { trend } = supertrend(bars, s.atr_period, Number(s.factor));
    const ss = timeToMin(String(s.session_start)), le = timeToMin(String(s.last_entry)), sq = timeToMin(String(s.square_off));
    let pos: Plan | null = null;
    const close = (day: string, min: number, why: string) => { if (pos) { pos.exitDay = day; pos.exitMin = min; pos.exitWhy = why; plans.push(pos); pos = null; } };
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      if (b.day > p.to) break;
      if (pos && s.intraday && (b.day !== pos.entryDay || b.endMin >= sq)) close(pos.entryDay, sq, "Square-off");
      if (b.day < p.from || trend[i] === 0 || trend[i - 1] === 0) continue;
      const desired: Side | null = trend[i] === 1 ? (dirOk("LONG") ? "LONG" : null) : (dirOk("SHORT") ? "SHORT" : null);
      const flipped = trend[i] !== trend[i - 1];
      if (pos && pos.side !== desired) close(b.day, b.endMin, "Supertrend turned");
      const inWindow = b.endMin >= ss && b.endMin < le && (!s.intraday || b.endMin < sq) && b.endMin < 930;
      if (!pos && desired && inWindow && (s.entry_mode === "JOIN" || flipped)) {
        pos = mkPlan(desired, b.day, b.endMin, b.c, flipped ? "Fresh flip" : "Joined trend");
      }
    }
    if (pos) close(testDays[testDays.length - 1] ?? p.to, 925, "End of test");
  } else {
    await progress("Working out the daily bias");
    const entryMin = timeToMin(String(s.entry_time)), exitMin = timeToMin(String(s.exit_time));
    let biasAt: (day: string) => number;
    if (biasTf === "D") {
      const daily = (await dhan.daily(s.data_security_id, s.data_segment, s.data_instrument,
        addDays(p.from, -Math.ceil((s.atr_period * 8 + 60) * 1.5)), addDays(p.to, 1)));
      biasAt = (day) => {
        const prior: DayBar[] = daily.filter((d) => d.day < day);
        let series: { h: number; l: number; c: number }[] = prior;
        if (s.bias_source === "LIVE") {
          const part = partialDay((byDay.get(day) ?? []).filter((b) => b.min < entryMin), day);
          if (part) series = [...prior, part];
        }
        const tr = supertrend(series, s.atr_period, Number(s.factor)).trend;
        return tr.length ? tr[tr.length - 1] : 0;
      };
    } else {
      const tf = Number(biasTf);
      const bb = aggregate(raw, tf);
      const full = supertrend(bb, s.atr_period, Number(s.factor)).trend;
      biasAt = (day) => {
        if (s.bias_source === "COMPLETED") {
          let idx = -1;
          for (let i = 0; i < bb.length; i++) {
            if (bb[i].day < day || (bb[i].day === day && bb[i].endMin <= entryMin)) idx = i; else break;
          }
          return idx >= 0 ? full[idx] : 0;
        }
        const startMin = 555 + Math.floor((entryMin - 555) / tf) * tf;
        const prior = bb.filter((b) => b.day < day || (b.day === day && b.startMin < startMin)).slice(-400);
        const part = partialDay((byDay.get(day) ?? []).filter((b) => b.min >= startMin && b.min < entryMin), day);
        const series = part ? [...prior, part] : prior;
        const tr = supertrend(series, s.atr_period, Number(s.factor)).trend;
        return tr.length ? tr[tr.length - 1] : 0;
      };
    }
    let pos: Plan | null = null;
    for (const day of testDays) {
      if (pos && s.exit_next_day && day > pos.entryDay) { pos.exitDay = day; pos.exitMin = exitMin; pos.exitWhy = "Timed exit"; plans.push(pos); pos = null; }
      if (!pos) {
        const t = biasAt(day);
        const side: Side | null = t === 1 ? "LONG" : t === -1 ? "SHORT" : null;
        const spot = priceAt(byDay.get(day), entryMin);
        if (side && dirOk(side) && spot) {
          pos = mkPlan(side, day, entryMin, spot.px, `${biasTf === "D" ? "Daily" : biasTf + "-min"} Supertrend ${t === 1 ? "up" : "down"}`);
          if (!s.exit_next_day) { pos.exitDay = day; pos.exitMin = exitMin; pos.exitWhy = "Timed exit"; plans.push(pos); pos = null; }
        }
      }
    }
    if (pos) {
      const nd = nextTradingDay((pos as Plan).entryDay);
      if (nd) { (pos as Plan).exitDay = nd; (pos as Plan).exitMin = exitMin; (pos as Plan).exitWhy = "Timed exit"; plans.push(pos); }
    }
  }

  // ---------- 2. price each trade ----------
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
  async function optPrice(day: string, min: number, opt: "CE" | "PE", strike: number, code: number): Promise<number | null> {
    const spot = priceAt(byDay.get(day), min);
    if (!spot) return null;
    let k = Math.max(-10, Math.min(10, Math.round((strike - Math.round(spot.px / step) * step) / step)));
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

  const trades: Record<string, unknown>[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  let equity = p.capital, peak = p.capital, maxDd = 0, grossWin = 0, grossLoss = 0, wins = 0, gross = 0, costs = 0;
  let partial = false, lastDone = "";

  for (let i = 0; i < plans.length; i++) {
    const t = plans[i];
    if (Date.now() > deadline) { partial = true; break; }
    if (i % 8 === 0) await progress(`Pricing trade ${i + 1} of ${plans.length}`);
    let inPx: number | null, outPx: number | null, contract: string;
    if (isOpt && t.opt && t.strike != null) {
      const inCode = p.near_code + (s.roll_on_expiry && isExpiry(t.entryDay) ? 1 : 0);
      const outCode = inCode - expiriesBetween(t.entryDay, t.exitDay);
      if (outCode < p.near_code) { skip("Contract expired before the exit (turn on next-week expiry)"); continue; }
      contract = `${s.dhan_symbol} ${t.strike} ${t.opt}${inCode > p.near_code ? " (next week)" : ""}`;
      inPx = await optPrice(t.entryDay, t.entryMin, t.opt, t.strike, inCode);
      outPx = inPx == null ? null : await optPrice(t.exitDay, t.exitMin, t.opt, t.strike, outCode);
    } else {
      contract = `${s.underlying} index (futures proxy)`;
      inPx = priceAt(byDay.get(t.entryDay), t.entryMin)?.px ?? null;
      outPx = priceAt(byDay.get(t.exitDay), t.exitMin)?.px ?? null;
    }
    if (inPx == null || outPx == null) { skip("No historical price for that contract and time"); continue; }
    const dir = isOpt ? 1 : t.side === "LONG" ? 1 : -1;
    const g = (outPx - inPx) * dir * units;
    const c = 2 * p.brokerage + ((inPx + outPx) * units * p.other_pct) / 100;
    const net = g - c;
    gross += g; costs += c; equity += net;
    if (net > 0) { wins++; grossWin += net; } else grossLoss += -net;
    peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity);
    lastDone = t.exitDay;
    trades.push({
      entry: `${t.entryDay} ${minToTime(t.entryMin)}`, exit: `${t.exitDay} ${minToTime(t.exitMin)}`, side: t.side, contract,
      why: t.why, exit_why: t.exitWhy, entry_px: +inPx.toFixed(2), exit_px: +outPx.toFixed(2), units,
      gross: +g.toFixed(2), costs: +c.toFixed(2), net: +net.toFixed(2), equity: +equity.toFixed(2),
    });
  }

  const n = trades.length;
  const summary = {
    trades: n, planned: plans.length, wins, losses: n - wins,
    win_rate: n ? +((wins / n) * 100).toFixed(1) : 0,
    gross: +gross.toFixed(2), costs: +costs.toFixed(2), net: +(gross - costs).toFixed(2),
    return_pct: +(((gross - costs) / p.capital) * 100).toFixed(2),
    max_dd: +maxDd.toFixed(2), max_dd_pct: +((maxDd / p.capital) * 100).toFixed(2),
    profit_factor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    avg_net: n ? +((gross - costs) / n).toFixed(2) : 0,
    skipped, priced_with: isOpt ? "Dhan expired-options data (5-minute)" : "Index prices as a futures proxy",
    dhan_calls: dhan.calls, last_day_done: lastDone, partial,
  };
  return { summary, trades, partial };
}
