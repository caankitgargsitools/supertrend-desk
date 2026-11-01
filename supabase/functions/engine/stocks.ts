// Stock futures (1 Nov 2026, Papa): 10 liquid Nifty 50 stocks, traded as NSE stock futures (FUTSTK, monthly).
// Like the indices, signals and backtests use the share price (NSE_EQ cash candles, no futures premium added) and orders
// go to the near-month future. Lot sizes come from Dhan's F&O list (fno_contracts) when it has them.
//
// Share prices jump on a split or bonus (Kotak 5:1, HDFC Bank and Reliance 1:1 bonuses): Dhan's candles are not
// adjusted for that, so a 50% "fall" overnight would look like a real move. Each night the lab's candle download looks
// for overnight jumps that match a split / bonus ratio and stores them (stock_actions); every candle read for a stock
// (lab files and the desk's live candles) divides the prices before the jump by that factor.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Stock = { key: string; name: string; sec: string; lot: number; slip: number };
/** Dhan NSE_EQ security ids and lot sizes checked against Dhan's instrument list on 1 Nov 2026. */
export const STOCKS: Stock[] = [
  { key: "RELIANCE", name: "Reliance Industries", sec: "2885", lot: 500, slip: 0.0003 },
  { key: "HDFCBANK", name: "HDFC Bank", sec: "1333", lot: 650, slip: 0.0003 },
  { key: "ICICIBANK", name: "ICICI Bank", sec: "4963", lot: 700, slip: 0.0003 },
  { key: "INFY", name: "Infosys", sec: "1594", lot: 400, slip: 0.0003 },
  { key: "TCS", name: "Tata Consultancy Services", sec: "11536", lot: 225, slip: 0.0003 },
  { key: "SBIN", name: "State Bank of India", sec: "3045", lot: 750, slip: 0.0003 },
  { key: "BHARTIARTL", name: "Bharti Airtel", sec: "10604", lot: 475, slip: 0.0004 },
  { key: "AXISBANK", name: "Axis Bank", sec: "5900", lot: 625, slip: 0.0004 },
  { key: "LT", name: "Larsen & Toubro", sec: "11483", lot: 175, slip: 0.0004 },
  { key: "KOTAKBANK", name: "Kotak Mahindra Bank", sec: "1922", lot: 2000, slip: 0.0004 },
];
export const STOCK_KEYS = STOCKS.map((s) => s.key);
export const isStock = (key: string) => STOCK_KEYS.includes(String(key));
const BY_SEC = new Map(STOCKS.map((s) => [s.sec, s.key]));
/** The stock for an NSE_EQ security id (the desk's data_security_id). */
export const stockOfSec = (seg: string, sec: string) => seg === "NSE_EQ" ? BY_SEC.get(String(sec)) ?? null : null;

/* ---------- splits and bonuses ---------- */
/** new price ÷ old price for the usual splits (1:2, 1:5, 1:10 …) and bonuses (1:1 = ½, 1:2 = ⅔, 1:3 = ¾). */
export const SPLIT_RATIOS = [1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 2 / 3, 3 / 4, 2 / 5];
const TOL = 0.025;
export type Action = { day: string; factor: number; d: boolean; i: boolean };

/**
 * Overnight jumps that match a split / bonus ratio: the day's open against the previous close, and the day's close
 * against the previous close (both must match, so a gap that a real crash fills during the day isn't taken).
 * bars: daily (or per-day) candles in time order with day, o, c.
 */
export function findSplits(days: { day: string; o: number; c: number }[]): { day: string; factor: number }[] {
  const out: { day: string; factor: number }[] = [];
  for (let k = 1; k < days.length; k++) {
    const p = days[k - 1].c, o = days[k].o, c = days[k].c;
    if (!(p > 0 && o > 0 && c > 0)) continue;
    const ro = o / p, rc = c / p;
    if (ro > 0.8) continue;
    const r = SPLIT_RATIOS.find((x) => Math.abs(ro / x - 1) < TOL * 2 && Math.abs(rc / x - 1) < 0.12);
    if (r) out.push({ day: days[k].day, factor: r });
  }
  return out;
}
/** Per-day open / close from intraday candles (IST days). */
export function daysOf(rows: { t: number; o: number; c: number }[]): { day: string; o: number; c: number }[] {
  const m = new Map<string, { day: string; o: number; c: number }>();
  for (const r of rows) {
    const day = new Date((r.t + 19800) * 1000).toISOString().slice(0, 10), x = m.get(day);
    if (!x) m.set(day, { day, o: r.o, c: r.c }); else x.c = r.c;
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
}
/** Multiplier for a candle of this IST day: the product of the factors of every action after it. */
export function factorBefore(actions: Action[], day: string, kind: "d" | "i"): number {
  let f = 1;
  for (const a of actions) if (a[kind] && day < a.day) f *= a.factor;
  return f;
}
/** Adjusts candle columns in place (t in seconds or day strings in d; o/h/l/c prices; v volume scaled the other way). */
export function adjustCols(bars: any, actions: Action[], kind: "d" | "i") {
  if (!bars || !actions.some((a) => a[kind])) return bars;
  const n = (bars.c ?? []).length;
  for (let j = 0; j < n; j++) {
    const day = bars.d ? String(bars.d[j]) : new Date((Number(bars.t[j]) + 19800) * 1000).toISOString().slice(0, 10);
    const f = factorBefore(actions, day, kind);
    if (f === 1) continue;
    for (const k of ["o", "h", "l", "c"]) if (bars[k]) bars[k][j] = +(bars[k][j] * f).toFixed(2);
    if (bars.v) bars.v[j] = Math.round(bars.v[j] / f);
  }
  return bars;
}
/** The same for rows ({t, o, h, l, c, v?} with t in seconds, or {day, …} for daily bars). */
export function adjustRows<T extends Record<string, any>>(rows: T[], actions: Action[], kind: "d" | "i"): T[] {
  if (!actions.some((a) => a[kind])) return rows;
  return rows.map((r) => {
    const day = r.day ? String(r.day) : new Date((Number(r.t) + 19800) * 1000).toISOString().slice(0, 10);
    const f = factorBefore(actions, day, kind);
    return f === 1 ? r : { ...r, o: +(r.o * f).toFixed(2), h: +(r.h * f).toFixed(2), l: +(r.l * f).toFixed(2), c: +(r.c * f).toFixed(2), ...(r.v != null ? { v: Math.round(r.v / f) } : {}) };
  });
}

/* ---------- stored actions (stock_actions), loaded once per request ---------- */
let ACTIONS: Map<string, Action[]> | null = null;
export function setStockActions(rows: { asset: string; day: string; factor: number; in_daily: boolean; in_intraday: boolean }[]) {
  ACTIONS = new Map();
  for (const r of rows) {
    const a = ACTIONS.get(r.asset) ?? [];
    a.push({ day: String(r.day).slice(0, 10), factor: Number(r.factor), d: !!r.in_daily, i: !!r.in_intraday });
    ACTIONS.set(r.asset, a);
  }
}
export async function loadStockActions(sb: SupabaseClient, force = false) {
  if (ACTIONS && !force) return;
  const { data, error } = await sb.from("stock_actions").select("asset, day, factor, in_daily, in_intraday");
  if (error) { console.error("stock_actions", error.message); ACTIONS = ACTIONS ?? new Map(); return; }
  setStockActions(data ?? []);
}
export const actionsFor = (key: string): Action[] => ACTIONS?.get(key) ?? [];

/**
 * Records the splits / bonuses found in a stock's raw candles (daily and intraday separately: Dhan may have adjusted
 * one and not the other). Never deletes; a jump seen again only updates its flags.
 */
export async function saveStockActions(sb: SupabaseClient, key: string, daily: { day: string; factor: number }[], intra: { day: string; factor: number }[]) {
  const m = new Map<string, { asset: string; day: string; factor: number; in_daily: boolean; in_intraday: boolean }>();
  for (const x of actionsFor(key)) m.set(x.day, { asset: key, day: x.day, factor: x.factor, in_daily: x.d, in_intraday: x.i });
  for (const x of daily) m.set(x.day, { ...(m.get(x.day) ?? { asset: key, day: x.day, factor: x.factor, in_intraday: false }), in_daily: true });
  for (const x of intra) m.set(x.day, { ...(m.get(x.day) ?? { asset: key, day: x.day, factor: x.factor, in_daily: false }), in_intraday: true });
  const rows = [...m.values()];
  if (!rows.length) return 0;
  const { error } = await sb.from("stock_actions").upsert(rows.map((r) => ({ ...r, seen_at: new Date().toISOString() })), { onConflict: "asset,day" });
  if (error) throw new Error(`stock_actions: ${error.message}`);
  const cur = ACTIONS ?? new Map<string, Action[]>();
  cur.set(key, rows.map((r) => ({ day: r.day, factor: r.factor, d: r.in_daily, i: r.in_intraday })));
  ACTIONS = cur;
  return rows.length;
}

/** Current lot sizes from Dhan's F&O list (the nearest stock future), so a lot-size revision is picked up. */
export async function stockLots(sb: SupabaseClient): Promise<Record<string, number>> {
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const { data } = await sb.from("fno_contracts").select("underlying, lot, expiry").eq("instrument", "FUTSTK").in("underlying", STOCK_KEYS).gte("expiry", today).order("expiry");
  const out: Record<string, number> = {};
  for (const r of data ?? []) if (!(r.underlying in out) && Number(r.lot) > 0) out[r.underlying] = Number(r.lot);
  return out;
}
