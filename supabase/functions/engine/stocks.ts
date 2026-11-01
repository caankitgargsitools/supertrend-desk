// Stock futures (1 Nov 2026, Papa): 10 liquid Nifty 50 stocks, traded as NSE stock futures (FUTSTK, monthly).
// Like the indices, signals and backtests use the share price (NSE_EQ cash candles, no futures premium added) and orders
// go to the near-month future. Lot sizes come from Dhan's F&O list (fno_contracts) when it has them.
//
// Share prices jump on a split or bonus (Kotak 5:1, HDFC Bank and Reliance 1:1 bonuses): Dhan's candles are not
// adjusted for that, so a 50% "fall" overnight would look like a real move. Each night the lab's candle download looks
// for overnight jumps that match a split / bonus ratio and stores them (stock_actions); every candle read for a stock
// (lab files and the desk's live candles) divides the prices before the jump by that factor.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ist } from "./logic.ts";

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
/** The underlying of a row in Dhan's F&O list: its column, or for a stock future the trading symbol's first part
 *  ("RELIANCE-Nov2026-FUT") when that column is empty. */
export const fnoUnderlying = (ins: string, und: string | undefined, sym: string | undefined) =>
  und || (ins === "FUTSTK" ? String(sym ?? "").split("-")[0] : "");
export const stockOfSec = (seg: string, sec: string) => seg === "NSE_EQ" ? BY_SEC.get(String(sec)) ?? null : null;

/* ---------- splits and bonuses ---------- */
/** new price ÷ old price for the usual splits (1:2, 1:5, 1:10 …) and bonuses (1:1 = ½, 1:2 = ⅔, 1:3 = ¾). */
export const SPLIT_RATIOS = [1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 2 / 3, 3 / 4, 2 / 5];
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
    const r = splitFactor(o / p);
    if (r && Math.abs(c / p / r - 1) < 0.12) out.push({ day: days[k].day, factor: r });
  }
  return out;
}
/** Per-day open / close from intraday candles (IST days). */
export function daysOf(rows: { t: number; o: number; c: number }[]): { day: string; o: number; c: number }[] {
  const m = new Map<string, { day: string; o: number; c: number }>();
  for (const r of rows) {
    const day = ist(r.t).date, x = m.get(day);
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
/**
 * The multiplier for a candle at time t (seconds): each action of this kind turns into an epoch cut-off once (IST
 * midnight of its day), so 100k candles are compared as numbers instead of each being turned into a date string.
 */
function factorAt(actions: Action[], kind: "d" | "i"): ((t: number) => number) | null {
  const cuts = actions.filter((a) => a[kind]).map((a) => ({ t: Date.parse(`${a.day}T00:00:00+05:30`) / 1000, f: a.factor }));
  if (!cuts.length) return null;
  return (t) => { let f = 1; for (const c of cuts) if (t < c.t) f *= c.f; return f; };
}
const adj = (x: number, f: number) => +(x * f).toFixed(2);
/** Adjusts candle columns in place (t in seconds; o/h/l/c prices; v volume scaled the other way). */
export function adjustCols(bars: any, actions: Action[], kind: "d" | "i") {
  const fAt = bars ? factorAt(actions, kind) : null;
  if (!fAt) return bars;
  for (let j = 0; j < (bars.c ?? []).length; j++) {
    const f = fAt(Number(bars.t[j]));
    if (f === 1) continue;
    for (const k of ["o", "h", "l", "c"]) if (bars[k]) bars[k][j] = adj(bars[k][j], f);
    if (bars.v) bars.v[j] = Math.round(bars.v[j] / f);
  }
  return bars;
}
/** The same for rows ({t, o, h, l, c, v?} with t in seconds; daily rows by their day) — adjusted in place. */
export function adjustRows<T extends Record<string, any>>(rows: T[], actions: Action[], kind: "d" | "i"): T[] {
  const fAt = factorAt(actions, kind);
  if (!fAt) return rows;
  for (const r of rows as Record<string, any>[]) {
    const f = r.day ? factorBefore(actions, String(r.day), kind) : fAt(Number(r.t));
    if (f === 1) continue;
    r.o = adj(r.o, f); r.h = adj(r.h, f); r.l = adj(r.l, f); r.c = adj(r.c, f);
    if (r.v != null) r.v = Math.round(r.v / f);
  }
  return rows;
}

/* ---------- stored actions (stock_actions), loaded once per request ---------- */
let ACTIONS: Map<string, Action[]> | null = null;
export function setStockActions(rows: { asset: string; day: string; factor: number; in_daily: boolean; in_intraday: boolean }[]) {
  ACTIONS = new Map(); actionsAt = 0; // set from outside the database read: the next timed load reads again
  for (const r of rows) {
    const a = ACTIONS.get(r.asset) ?? [];
    a.push({ day: String(r.day).slice(0, 10), factor: Number(r.factor), d: !!r.in_daily, i: !!r.in_intraday });
    ACTIONS.set(r.asset, a);
  }
}
let actionsAt = 0;
/**
 * Loads stock_actions when the copy in memory is older than maxAge ms (true = always, false = only if never loaded).
 * Requests use 60 s; after writing a new action, 0. Writes made by this process also update the copy directly.
 */
export async function loadStockActions(sb: SupabaseClient, maxAge: number | boolean = false) {
  const age = maxAge === true ? 0 : maxAge === false ? Infinity : maxAge;
  if (ACTIONS && Date.now() - actionsAt < age) return;
  const { data, error } = await sb.from("stock_actions").select("asset, day, factor, in_daily, in_intraday");
  if (error) { console.error("stock_actions", error.message); ACTIONS = ACTIONS ?? new Map(); return; }
  setStockActions(data ?? []);
  actionsAt = Date.now();
}
export const actionsFor = (key: string): Action[] => ACTIONS?.get(key) ?? [];

/**
 * Records the splits / bonuses found in a stock's raw candles (daily and intraday separately: Dhan may have adjusted
 * one and not the other). Never deletes; a jump seen again only updates its flags.
 */
export async function saveStockActions(sb: SupabaseClient, key: string, daily: { day: string; factor: number }[], intra: { day: string; factor: number }[],
  cover: { d?: [string, string]; i?: [string, string] } = {}) {
  const m = new Map<string, { asset: string; day: string; factor: number; in_daily: boolean; in_intraday: boolean }>();
  // A known action inside an unbroken stretch of raw candles is re-judged from them: if Dhan has since adjusted its
  // history the jump is gone, and the reads must stop adjusting (else prices before it would be adjusted twice).
  const inside = (c: [string, string] | undefined, d: string) => !!c && d > c[0] && d <= c[1];
  for (const x of actionsFor(key)) m.set(x.day, { asset: key, day: x.day, factor: x.factor,
    in_daily: inside(cover.d, x.day) ? daily.some((y) => y.day === x.day) : x.d, in_intraday: inside(cover.i, x.day) ? intra.some((y) => y.day === x.day) : x.i });
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

/**
 * Current lot sizes from Dhan's F&O list (the nearest stock future), so a lot-size revision is picked up. Kept for 60 s
 * (one read serves the request's lab asset list and the ex-date checks); fresh = read again (after syncFno).
 */
let lotsMemo: { at: number; lots: Record<string, number> } | null = null;
export async function stockLots(sb: SupabaseClient, fresh = false): Promise<Record<string, number>> {
  if (!fresh && lotsMemo && Date.now() - lotsMemo.at < 60000) return lotsMemo.lots;
  const today = ist(Date.now() / 1000).date;
  const { data } = await sb.from("fno_contracts").select("underlying, lot, expiry").eq("instrument", "FUTSTK").in("underlying", STOCK_KEYS).gte("expiry", today).order("expiry");
  const out: Record<string, number> = {};
  for (const r of data ?? []) if (!(r.underlying in out) && Number(r.lot) > 0) out[r.underlying] = Number(r.lot);
  lotsMemo = { at: Date.now(), lots: out };
  return out;
}

/* ---------- a held stock future across a split / bonus ex-date ---------- */
/** The split / bonus factor a price jump matches (new ÷ old within 5%), or null. */
export function splitFactor(ratio: number): number | null {
  if (!(ratio > 0) || ratio > 0.85) return null;
  return SPLIT_RATIOS.find((x) => Math.abs(ratio / x - 1) < 0.05) ?? null;
}
type PosLike = { position: string; qty_mode?: string; pos_qty?: number | null; lot_size?: number | null; pos_entry_px?: number | null; pos_risk?: any; pos_broker?: any;
  pending_trigger?: number | null; trade_type?: string };
const r2 = (x: number) => +x.toFixed(2);
/**
 * The strategy row after an ex-date with factor f (new price ÷ old): the exchange gives 1/f times the shares at f times
 * the price, so the position's value and P&L stay the same. Prices (entry, stop, target, best price, trailing points /
 * ATR, the broker fill, a waiting breakout trigger) × f; units and the lot size ÷ f (lots stay as they are); the broker
 * stop is dropped (it is cancelled and placed again for the new quantity).
 */
export function adjustPosition(s: PosLike, f: number, lotNew: number | null, px: number): Record<string, any> {
  const k = 1 / f, upd: Record<string, any> = {};
  const lot = Number(s.lot_size) || 0;
  // Dhan's list may not show the new lot yet on the morning of the ex-date: its lot is used only when it matches lot ÷ f.
  const want = Math.round(lot * k);
  upd.lot_size = lotNew && lotNew > 0 && want > 0 && Math.abs(lotNew / want - 1) < 0.02 ? lotNew : want;
  if (s.pending_trigger != null) upd.pending_trigger = r2(Number(s.pending_trigger) * f);
  if (s.position === "FLAT") return upd;
  if (s.qty_mode !== "LOTS" && s.pos_qty != null) upd.pos_qty = Math.round(Number(s.pos_qty) * k);
  if (s.pos_entry_px != null) upd.pos_entry_px = r2(Number(s.pos_entry_px) * f);
  const pr = s.pos_risk ? JSON.parse(JSON.stringify(s.pos_risk)) : null;
  if (pr) {
    for (const key of ["entry", "stop", "tgt", "best"]) if (pr[key] != null && Number(pr[key]) > 0) pr[key] = r2(Number(pr[key]) * f);
    if (Number(pr.trailAtr) > 0) pr.trailAtr = +(Number(pr.trailAtr) * f).toFixed(4);
    if (pr.trail && pr.trail.type === "POINTS" && Number(pr.trail.value) > 0) pr.trail = { ...pr.trail, value: r2(Number(pr.trail.value) * f) };
    upd.pos_risk = pr;
  }
  const pb = s.pos_broker ? JSON.parse(JSON.stringify(s.pos_broker)) : null;
  if (pb) {
    pb.legs = (pb.legs ?? []).map((l: any) => ({ ...l, qty: Math.round(Number(l.qty) * k) }));
    if (Number(pb.fill) > 0) pb.fill = r2(Number(pb.fill) * f);
    pb.stopId = null; pb.stopTrig = null; pb.stopRow = null; pb.stopErrAt = null;
    upd.pos_broker = pb;
  }
  upd.pos_ltp = r2(px);
  const units = s.qty_mode === "LOTS" ? Number(s.pos_qty) * upd.lot_size : Number(upd.pos_qty ?? s.pos_qty);
  const entry = Number(upd.pos_entry_px ?? 0), dir = s.position === "LONG" ? 1 : -1;
  upd.pos_upnl = entry > 0 && units > 0 ? Math.trunc((px - entry) * dir * units) : null;
  return upd;
}
