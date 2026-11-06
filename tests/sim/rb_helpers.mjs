// Small synthetic candle builders for the rule tests (6 Nov 2026): NSE session days of 5-minute candles.
import { aggregate } from "./logic.mjs";
const OPEN = 555; // 09:15 IST
export const dayT = (day) => Date.parse(`${day}T00:00:00+05:30`) / 1000;
/** Trading days (Mon–Fri) from a start date. */
export function tradingDays(from, n) {
  const out = []; let d = Date.parse(from + "T00:00:00Z");
  while (out.length < n) { const wd = new Date(d).getUTCDay(); if (wd !== 0 && wd !== 6) out.push(new Date(d).toISOString().slice(0, 10)); d += 86400000; }
  return out;
}
/**
 * 5-minute candles for several days. bars(day, i) returns {o,h,l,c[,v,oi]} for candle i (0 = 09:15) of that day, or null to
 * stop the day early. 75 candles a day by default.
 */
export function mkData(days, bars, perDay = 75) {
  const raw = [], byDay = new Map(), daily = [];
  for (const day of days) {
    const t0 = dayT(day) + OPEN * 60, rows = [];
    for (let i = 0; i < perDay; i++) {
      const b = bars(day, i); if (!b) break;
      const r = { t: t0 + i * 300, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0, ...(b.oi != null ? { oi: b.oi } : {}), day, min: OPEN + i * 5 };
      raw.push(r); rows.push(r);
    }
    if (!rows.length) continue;
    byDay.set(day, rows);
    daily.push({ t: dayT(day), o: rows[0].o, h: Math.max(...rows.map((r) => r.h)), l: Math.min(...rows.map((r) => r.l)), c: rows[rows.length - 1].c, v: rows.reduce((a, r) => a + (r.v ?? 0), 0), day });
  }
  const frames = (tfs, seg = "IDX_I") => new Map(tfs.map((tf) => [tf, aggregate(raw, tf, seg)]));
  const baseByDay = new Map([...byDay].map(([d, rows]) => [d, rows.map((r) => ({ min: r.min, h: r.h, l: r.l }))]));
  return { raw, byDay, daily, frames, baseByDay };
}
/** A flat candle at price p (optionally with its own high / low). */
export const flat = (p, h = p, l = p) => ({ o: p, h, l, c: p });
