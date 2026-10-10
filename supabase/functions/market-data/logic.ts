// Pure strategy maths: no network, no database. Shared by the engine and tests.

export const IST_OFFSET = 19800; // seconds (+05:30)
export const OPEN_MIN = 555; // 09:15
export const CLOSE_MIN = 930; // 15:30

export type Raw = { t: number; o: number; h: number; l: number; c: number; v?: number };
export type Bar = Raw & { day: string; startMin: number; endMin: number; endT: number; lastBaseStart: number };

export function ist(epochSec: number) {
  const d = new Date((epochSec + IST_OFFSET) * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
  return {
    y, m, d: dd, wd: d.getUTCDay(),
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
    date: `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
  };
}

export function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Trading session in IST minutes. NSE/BSE: 09:15–15:30. MCX: 09:00–23:30 while US daylight saving is on, else 23:55. Crypto: 05:30–24:00. */
export type Session = { open: number; close: number };
export function isCommodity(seg: string): boolean { return seg === "MCX_COMM"; }
/** Crypto perpetuals on Delta Exchange: trade every day of the week. */
export function isCrypto(seg: string): boolean { return seg === "DELTA"; }
/** Trading minutes in a day (for warm-up estimates). */
export function dayMinutes(seg: string): number { return isCrypto(seg) ? 1110 : isCommodity(seg) ? 860 : 375; }
function nthSunday(y: number, month: number, n: number): string {
  const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  const day = 1 + ((7 - first) % 7) + (n - 1) * 7;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function sessionFor(seg: string, date: string): Session {
  // Crypto: the desk's crypto day runs 05:30–24:00 IST (Delta's daily candle starts at 00:00 UTC = 05:30 IST), every day.
  if (isCrypto(seg)) return { open: 330, close: 1440 };
  if (!isCommodity(seg)) return { open: OPEN_MIN, close: CLOSE_MIN };
  const y = Number(date.slice(0, 4));
  const usDst = date >= nthSunday(y, 3, 2) && date < nthSunday(y, 11, 1);
  return { open: 540, close: usDst ? 1410 : 1435 };
}

/** Dhan has returned both true-UTC and IST-shifted epochs at different times; detect which. */
export function normaliseTimestamps(ts: number[], seg = "IDX_I"): number {
  if (!ts.length) return 0;
  const lo = isCommodity(seg) ? 540 : OPEN_MIN, hi = isCommodity(seg) ? 1435 : CLOSE_MIN;
  let inside = 0;
  for (const t of ts) { const m = ist(t).min; if (m >= lo && m < hi) inside++; }
  return inside >= ts.length * 0.8 ? 0 : -IST_OFFSET;
}

export function pickBaseInterval(tf: number): number {
  return [60, 25, 15, 5, 1].find((b) => tf % b === 0)!;
}

/** Build tf-minute candles anchored to the session open (09:15 NSE/BSE, 09:00 MCX) each day from smaller base candles. */
export function aggregate(raw: Raw[], tf: number, seg = "IDX_I"): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let key = "", sessDay = "", sess: Session = { open: OPEN_MIN, close: CLOSE_MIN };
  for (const b of raw) {
    const p = ist(b.t);
    if (p.date !== sessDay) { sessDay = p.date; sess = sessionFor(seg, p.date); }
    if (p.min < sess.open || p.min >= sess.close) continue;
    const idx = Math.floor((p.min - sess.open) / tf);
    const k = `${p.date}#${idx}`;
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      const startMin = sess.open + idx * tf;
      const endMin = Math.min(sess.close, startMin + tf);
      const t = b.t - (p.min - startMin) * 60;
      cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0, day: p.date, startMin, endMin, endT: t + (endMin - startMin) * 60, lastBaseStart: b.t };
    } else if (cur) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v = (cur.v ?? 0) + (b.v ?? 0);
      cur.lastBaseStart = b.t;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** A candle counts only once its time is over and its last base candle has arrived. */
export function isComplete(b: Bar, baseInt: number, nowSec: number): boolean {
  return b.endT <= nowSec && b.lastBaseStart + baseInt * 60 >= b.endT;
}

/** Same rules as TradingView's ta.supertrend (Wilder ATR, hl2). trend: 1 = up, -1 = down. */
export function supertrend(bars: { h: number; l: number; c: number }[], period: number, factor: number) {
  const n = bars.length;
  const atr = new Array<number>(n).fill(NaN);
  const up = new Array<number>(n).fill(NaN);
  const lo = new Array<number>(n).fill(NaN);
  const st = new Array<number>(n).fill(NaN);
  const trend = new Array<number>(n).fill(0);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const { h, l } = bars[i];
    const pc = i > 0 ? bars[i - 1].c : bars[i].c;
    const tr = i === 0 ? h - l : Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i < period - 1) { sum += tr; continue; }
    if (i === period - 1) { sum += tr; atr[i] = sum / period; }
    else atr[i] = (atr[i - 1] * (period - 1) + tr) / period;

    const src = (h + l) / 2;
    let u = src + factor * atr[i];
    let d = src - factor * atr[i];
    const pu = i > 0 && !isNaN(up[i - 1]) ? up[i - 1] : 0;
    const pd = i > 0 && !isNaN(lo[i - 1]) ? lo[i - 1] : 0;
    d = d > pd || pc < pd ? d : pd;
    u = u < pu || pc > pu ? u : pu;
    let dir: number; // Pine convention: -1 up, 1 down
    if (i === 0 || isNaN(atr[i - 1])) dir = 1;
    else if (st[i - 1] === up[i - 1]) dir = bars[i].c > u ? -1 : 1;
    else dir = bars[i].c < d ? 1 : -1;
    up[i] = u; lo[i] = d;
    st[i] = dir === -1 ? d : u;
    trend[i] = -dir;
  }
  return { st, trend, atr };
}

/** Next weekly expiry (1=Mon..5=Fri) from an IST date, rolling past today when asked. */
export function nextExpiry(todayIst: { y: number; m: number; d: number; wd: number }, weekday: number, roll: boolean): string {
  let ahead = (weekday - todayIst.wd + 7) % 7;
  if (ahead === 0 && roll) ahead = 7;
  const d = new Date(Date.UTC(todayIst.y, todayIst.m - 1, todayIst.d + ahead));
  return d.toISOString().slice(0, 10);
}

/** Monthly expiry: the last given weekday (1=Mon..5=Fri) of the month, rolling to next month once passed (or on the day, if asked). */
export function nextMonthlyExpiry(todayIst: { y: number; m: number; d: number }, weekday: number, roll: boolean): string {
  const lastOf = (y: number, m: number) => {
    const d = new Date(Date.UTC(y, m, 0)); // last day of month m (1-based)
    while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const today = `${todayIst.y}-${String(todayIst.m).padStart(2, "0")}-${String(todayIst.d).padStart(2, "0")}`;
  const cur = lastOf(todayIst.y, todayIst.m);
  if (cur > today || (cur === today && !roll)) return cur;
  return todayIst.m === 12 ? lastOf(todayIst.y + 1, 1) : lastOf(todayIst.y, todayIst.m + 1);
}

/** Is this date a monthly expiry day (the last such weekday of its month)? */
export function isLastWeekdayOfMonth(date: string, weekday: number): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCDay() !== weekday) return false;
  dt.setUTCDate(dt.getUTCDate() + 7);
  return dt.getUTCMonth() !== m - 1;
}

export function strikeFor(close: number, step: number, offset: number, optType: "CE" | "PE"): number {
  const atm = Math.round(close / step) * step;
  return optType === "CE" ? atm + offset * step : atm - offset * step;
}

export type DayBar = { t: number; o: number; h: number; l: number; c: number; v?: number; day: string };

/** Calendar arithmetic on YYYY-MM-DD strings. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function minToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Combine one day's minute candles into a single (possibly partial) daily candle. */
export function partialDay(bars: Raw[], day: string): DayBar | null {
  if (!bars.length) return null;
  return {
    t: bars[0].t, o: bars[0].o, c: bars[bars.length - 1].c, day,
    h: Math.max(...bars.map((b) => b.h)), l: Math.min(...bars.map((b) => b.l)),
  };
}

/** Fill a leg template's {placeholders}; values are JSON-escaped, result must parse. */
export function fillTemplate(tpl: string, vals: Record<string, string | number>): Record<string, unknown> {
  const s = tpl.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in vals)) return `{${k}}`;
    return JSON.stringify(String(vals[k])).slice(1, -1);
  });
  return JSON.parse(s);
}

/** Heikin Ashi candles and their colour. trend: 1 = green (HA close above HA open), -1 = red; a doji keeps the previous colour. */
export function heikinAshi(bars: { o: number; h: number; l: number; c: number }[]) {
  const n = bars.length;
  const ho = new Array<number>(n), hc = new Array<number>(n), trend = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    hc[i] = (b.o + b.h + b.l + b.c) / 4;
    ho[i] = i === 0 ? (b.o + b.c) / 2 : (ho[i - 1] + hc[i - 1]) / 2;
    trend[i] = hc[i] > ho[i] ? 1 : hc[i] < ho[i] ? -1 : i > 0 ? trend[i - 1] : 0;
  }
  return { ho, hc, trend };
}

/** The signal series a flip-style strategy trades on: Supertrend, or Heikin Ashi colour. */
export function signalSeries(s: { strategy_kind: string; atr_period: number; factor: number | string }, bars: { o: number; h: number; l: number; c: number }[]) {
  if (s.strategy_kind === "HA") {
    const { trend } = heikinAshi(bars);
    return { trend, st: new Array<number>(bars.length).fill(NaN) };
  }
  const { trend, st } = supertrend(bars, s.atr_period, Number(s.factor));
  return { trend, st };
}
