// Crypto perpetual futures on Delta Exchange India.
//  Candles: Delta India's own candles from the day each coin had settled in there (crypto_assets.cutover); the years
//  before that from Binance's spot market (same coin against USDT, which tracks the US dollar), so the lab can test
//  five and more years. Delta's day starts at 00:00 UTC = 05:30 IST, which is where the desk's crypto session opens.
//  Orders: Delta's REST API, signed with the user's API key and secret (HMAC-SHA256).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { DayBar, Raw } from "./logic.ts";
import { ist } from "./logic.ts";

export const DELTA_SEG = "DELTA";
const DELTA = "https://api.india.delta.exchange";
const BINANCE = "https://data-api.binance.vision";

export type CryptoAsset = {
  key: string; name: string; history_symbol: string | null; cutover: string | null; product_id: number | null;
  contract_value: number | null; tick_size: number | null; slip_pct: number; enabled: boolean; sort: number; lot_coins: number | null;
};
/** Coins the desk offers, by Delta symbol (filled from the crypto_assets table). */
export const CRYPTO: Record<string, CryptoAsset> = {};
/** Rupees per US dollar for P&L, charges and margins (lab settings). */
export const FX = { usdInr: 88 };
let loadedAt = 0;

/** Reads crypto_assets and the dollar rate (at most once a minute per function instance). */
export async function loadCrypto(sb: SupabaseClient, force = false): Promise<CryptoAsset[]> {
  if (!force && Date.now() - loadedAt < 60000) return Object.values(CRYPTO);
  const [{ data: rows }, { data: ls }] = await Promise.all([
    sb.from("crypto_assets").select("*").eq("enabled", true).order("sort"),
    sb.from("lab_settings").select("usd_inr").eq("id", 1).maybeSingle(),
  ]);
  for (const k of Object.keys(CRYPTO)) delete CRYPTO[k];
  for (const r of rows ?? []) {
    CRYPTO[r.key] = { ...r, contract_value: r.contract_value == null ? null : Number(r.contract_value), tick_size: r.tick_size == null ? null : Number(r.tick_size),
      slip_pct: Number(r.slip_pct ?? 0.05), cutover: r.cutover ?? null, lot_coins: r.lot_coins == null ? null : Number(r.lot_coins) } as CryptoAsset;
  }
  if (Number(ls?.usd_inr) > 0) FX.usdInr = Number(ls!.usd_inr);
  loadedAt = Date.now();
  return Object.values(CRYPTO);
}
/**
 * One desk "lot" of a coin is lot_coins coins (about $5,000 worth, e.g. 0.05 BTC = 50 contracts of 0.001 BTC); its
 * lot size is the rupee P&L of that lot for a $1 move (coins × rupees per dollar).
 */
export const lotCoins = (a: CryptoAsset) => a.lot_coins ?? a.contract_value ?? 1;
export const cryptoLot = (a: CryptoAsset) => +(lotCoins(a) * FX.usdInr).toFixed(6);
/** Delta contracts for an order of some lots of a strategy (from its rupee lot size, so it matches the P&L it books). */
export function contractsFor(symbol: string, lotSize: number, lots: number): number {
  const a = CRYPTO[symbol];
  const cv = a?.contract_value ?? 1;
  const perLot = Math.max(1, Math.round(lotSize / (cv * FX.usdInr)));
  return Math.max(1, Math.trunc(lots) * perLot);
}
/** A round coin amount worth about $5,000 (1, 2 or 5 × a power of ten), never below one contract. */
export function niceLot(price: number, cv: number): number {
  const target = 5000 / price;
  let best = cv;
  for (let e = -6; e <= 6; e++) for (const m of [1, 2, 5]) {
    const x = m * 10 ** e;
    if (x >= cv && Math.abs(Math.log(x / target)) < Math.abs(Math.log(best / target))) best = x;
  }
  return +(Math.round(best / cv) * cv).toPrecision(6);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJson(url: string): Promise<any> {
  let last = "";
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "supertrend-desk" }, signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) { last = `HTTP ${r.status}`; await sleep(1500 * (i + 1)); continue; }
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (/HTTP 4\d\d/.test(last) && !/429/.test(last)) throw new Error(`${url.split("?")[0]}: ${last}`);
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`Couldn't reach ${new URL(url).host} (${last}).`);
}

const RES: Record<number, string> = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 120: "2h", 240: "4h", 1440: "1d" };
/** Delta India candles [from, to] (epoch seconds, candle start times), oldest first. Volume converted to coins. */
async function deltaRange(symbol: string, mins: number, from: number, to: number): Promise<Raw[]> {
  const step = mins * 60, cv = CRYPTO[symbol]?.contract_value ?? 1, out = new Map<number, Raw>();
  for (let a = from; a <= to; a += step * 2000) {
    const z = Math.min(to, a + step * 2000 - 1);
    const j = await getJson(`${DELTA}/v2/history/candles?resolution=${RES[mins]}&symbol=${encodeURIComponent(symbol)}&start=${Math.floor(a)}&end=${Math.floor(z)}`);
    for (const c of j?.result ?? []) {
      const t = Number(c.time);
      if (!(t >= from && t <= to)) continue;
      out.set(t, { t, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: Number(c.volume ?? 0) * cv });
    }
  }
  return [...out.values()].sort((x, y) => x.t - y.t);
}
/** Binance spot candles [from, to] (epoch seconds), oldest first. */
async function binanceRange(pair: string, mins: number, from: number, to: number): Promise<Raw[]> {
  const out: Raw[] = [];
  let a = from * 1000;
  const end = to * 1000;
  while (a <= end) {
    const j = await getJson(`${BINANCE}/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=${RES[mins]}&startTime=${a}&endTime=${end}&limit=1000`);
    if (!Array.isArray(j) || !j.length) break;
    for (const k of j) out.push({ t: Math.floor(Number(k[0]) / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    const lastOpen = Number(j[j.length - 1][0]);
    if (j.length < 1000) break;
    a = lastOpen + mins * 60000;
  }
  return out;
}
/** Candles of one coin over [from, to]: Binance history before the cutover day, Delta India from it. */
async function coinRange(symbol: string, mins: number, from: number, to: number): Promise<Raw[]> {
  const a = CRYPTO[symbol];
  const cut = a?.cutover ? Date.parse(`${a.cutover}T00:00:00Z`) / 1000 : 0;
  const out: Raw[] = [];
  if (from < cut && a?.history_symbol) out.push(...await binanceRange(a.history_symbol, mins, from, Math.min(to, cut - 1)));
  if (to >= cut) out.push(...await deltaRange(symbol, mins, Math.max(from, cut), to));
  return out;
}
/** "YYYY-MM-DD HH:mm:ss" IST to epoch seconds. The desk's "from 09:00" day start means the whole day for crypto. */
const istSec = (s: string) => Date.parse(`${s.replace(" ", "T").replace(/T09:00:00$/, "T00:00:00")}+05:30`) / 1000;

/** Minute candles (same contract as Dhan.intraday). 25-minute candles are built from 5-minute ones, anchored at 05:30 IST. */
export async function cryptoIntraday(symbol: string, interval: number, fromDate: string, toDate: string): Promise<Raw[]> {
  const from = istSec(fromDate), to = istSec(toDate);
  if (RES[interval]) return coinRange(symbol, interval, from, to);
  const base = [15, 5, 1].find((b) => interval % b === 0)!;
  const raw = await coinRange(symbol, base, from, to);
  const out: Raw[] = [];
  let cur: Raw | null = null;
  for (const b of raw) {
    const day0 = Math.floor(b.t / 86400) * 86400, k = day0 + Math.floor((b.t - day0) / (interval * 60)) * interval * 60;
    if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v = (cur.v ?? 0) + (b.v ?? 0); }
  }
  if (cur) out.push(cur);
  return out;
}
/** Daily candles (00:00 UTC days, dated by their IST date); toDate is exclusive. */
export async function cryptoDaily(symbol: string, fromDate: string, toDate: string): Promise<DayBar[]> {
  const from = Date.parse(`${fromDate}T00:00:00Z`) / 1000, to = Date.parse(`${toDate}T00:00:00Z`) / 1000 - 1;
  return (await coinRange(symbol, 1440, from, to)).map((r) => ({ ...r, day: ist(r.t).date }));
}
/** Delta India's own daily candles only (no Binance history), for the liquidity check of a newly added coin. */
export async function cryptoDailyDelta(symbol: string, fromDate: string, toDate: string): Promise<DayBar[]> {
  const from = Date.parse(`${fromDate}T00:00:00Z`) / 1000, to = Date.parse(`${toDate}T00:00:00Z`) / 1000 - 1;
  return (await deltaRange(symbol, 1440, from, to)).map((r) => ({ ...r, day: ist(r.t).date }));
}
/** Last traded price on Delta India. */
export async function cryptoLtp(symbol: string): Promise<number | null> {
  const j = await getJson(`${DELTA}/v2/tickers/${encodeURIComponent(symbol)}`);
  const v = Number(j?.result?.close ?? j?.result?.mark_price);
  return v > 0 ? v : null;
}
/** Product details from Delta (contract size, tick, id) for the coin list. */
export async function cryptoProduct(symbol: string) {
  const j = await getJson(`${DELTA}/v2/products/${encodeURIComponent(symbol)}`);
  const p = j?.result;
  if (!p?.id) throw new Error(`Delta has no product ${symbol}.`);
  return { product_id: Number(p.id), contract_value: Number(p.contract_value), tick_size: Number(p.tick_size), name: String(p.description ?? p.short_description ?? symbol),
    state: String(p.state ?? ""), type: String(p.contract_type ?? ""), settles: String(p.settling_asset?.symbol ?? ""), launched: String(p.launch_time ?? "").slice(0, 10),
    underlying: String(p.underlying_asset?.symbol ?? p.spot_index?.config?.underlying_asset ?? "") };
}

/* ---------- signed requests (orders, balances) ---------- */
async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function deltaPrivate(key: string, secret: string, method: "GET" | "POST" | "DELETE", path: string, query = "", body?: unknown): Promise<any> {
  const ts = String(Math.floor(Date.now() / 1000));
  const b = body === undefined ? "" : JSON.stringify(body), q = query ? `?${query}` : "";
  const signature = await hmacHex(secret, method + ts + path + q + b);
  const r = await fetch(DELTA + path + q, {
    method, body: b || undefined, signal: AbortSignal.timeout(15000),
    headers: { "api-key": key, timestamp: ts, signature, "User-Agent": "supertrend-desk", "Content-Type": "application/json", Accept: "application/json" },
  });
  const text = await r.text();
  let j: any = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok || j?.success === false) {
    const code = j?.error?.code ?? "";
    const hint = /invalid_api_key|unauthorized|Signature|expired_signature|ip_not_whitelisted/i.test(text) ? " Check the Delta API key and secret (and that the key allows trading from any IP or this server's IP)." : "";
    throw new Error(`Delta ${path}: HTTP ${r.status}${code ? ` ${code}` : ""}.${hint} ${text.slice(0, 200)}`);
  }
  return j;
}
/** A market order for a number of contracts. */
export async function deltaOrder(key: string, secret: string, o: { symbol: string; size: number; side: "buy" | "sell"; reduceOnly?: boolean }) {
  const a = CRYPTO[o.symbol];
  const body: Record<string, unknown> = { product_symbol: o.symbol, size: Math.trunc(o.size), side: o.side, order_type: "market_order" };
  if (a?.product_id) body.product_id = a.product_id;
  if (o.reduceOnly) body.reduce_only = true;
  return (await deltaPrivate(key, secret, "POST", "/v2/orders", "", body))?.result ?? null;
}
/** Wallet balances (for the connection check). */
export async function deltaBalances(key: string, secret: string) {
  const j = await deltaPrivate(key, secret, "GET", "/v2/wallet/balances");
  const rows: any[] = Array.isArray(j?.result) ? j.result : [];
  return rows.map((x) => ({ asset: String(x.asset_symbol ?? x.asset?.symbol ?? ""), balance: Number(x.balance ?? 0), available: Number(x.available_balance ?? 0),
    inr: x.balance_inr != null ? Number(x.balance_inr) : null })).filter((x) => x.asset);
}
