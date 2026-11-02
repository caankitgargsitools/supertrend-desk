/**
 * Spread watcher (2 Nov 2026, Papa): measures for 30 days whether price gaps the desk's speed can use would have paid
 * after every charge. Watch only — no orders. Best bid / ask everywhere (a gap between last prices can't be traded).
 *   nb  NSE vs BSE, the desk's 10 stocks, every minute in market hours (buy at the cheaper exchange's ask, sell at the
 *       other's bid; intraday charges on both legs).
 *   cf  cash vs futures, every F&O stock, near and next month, every 15 minutes (buy the share at its ask, sell the
 *       future at its bid, hold to expiry; delivery charges).
 *   cx  Delta India vs CoinDCX futures, BTC / ETH / SOL, every minute 24x7 (taker fees to open and close both sides),
 *       plus each exchange's funding rate.
 * Rows go to spread_ticks (never deleted); spread_state.until ends the watch.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Dhan } from "./dhan.ts";
import { ist, setHolidays, tradingSession } from "./logic.ts";
import { fnoUnderlying, STOCKS } from "./stocks.ts";

type BA = { bid: number; ask: number };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Trade size assumed for the NSE / BSE charges (each leg); brokerage is ₹20 or 0.03% an order, whichever is less. */
export const NB_SIZE = 1_000_000;
/**
 * NSE vs BSE, intraday, both legs, % of the trade: brokerage 2 × min(₹20, 0.03%), STT 0.025% on the sell, exchange
 * ≈ 0.003% NSE + 0.00375% BSE, SEBI 0.0001% × 2, stamp 0.003% on the buy, GST 18% on brokerage + exchange + SEBI.
 * Assumes the broker nets the NSE buy against the BSE sell as one intraday trade; selling shares you don't hold on
 * one exchange can otherwise end in a short delivery (auction penalty), or must come from shares held (delivery STT
 * 0.1% each side), which the page notes.
 */
export function nbCostPct(size = NB_SIZE): number {
  const brk = 2 * Math.min(20, size * 0.0003), exch = size * (0.00003 + 0.0000375), sebi = size * 0.000002;
  const stt = size * 0.00025, stamp = size * 0.00003, gst = 0.18 * (brk + exch + sebi);
  return (brk + exch + sebi + stt + stamp + gst) / size * 100;
}
/**
 * Cash and carry held to expiry, % of the share value: STT 0.1% on the share bought + 0.1% when the future settles
 * by delivery, futures STT 0.02%, stamp 0.015% (delivery) + 0.002% (futures), exchange and GST ≈ 0.01%, brokerage
 * ≈ 0.003% at this size. Rounded to 0.25%.
 */
export const CF_COST_PCT = 0.25;
/** Delta India and CoinDCX taker fee 0.05% + 18% GST, paid four times (open and close, both exchanges). */
export const CX_COST_PCT = 4 * 0.05 * 1.18;

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const ok = (x: BA | null | undefined): x is BA => !!x && x.bid > 0 && x.ask > 0 && x.ask >= x.bid;

/** The better direction between two venues: buy at one's ask, sell at the other's bid. */
export function bestCross(a: BA, b: BA, cost: number, names: [string, string]) {
  const ab = (b.bid - a.ask) / a.ask * 100, ba = (a.bid - b.ask) / b.ask * 100;
  const first = ab >= ba;
  const buy = first ? a.ask : b.ask, sell = first ? b.bid : a.bid, gap = first ? ab : ba;
  return { buy, sell, gap_pct: r4(gap), net_pct: r4(gap - cost), x: { buy_at: first ? names[0] : names[1], sell_at: first ? names[1] : names[0] } };
}
/** Cash and carry: buy the share at its ask, sell the future at its bid, held for `days` (≥ 1) until expiry. */
export function cashCarry(spot: BA, fut: BA, days: number) {
  const gap = (fut.bid - spot.ask) / spot.ask * 100, net = gap - CF_COST_PCT, d = Math.max(1, days);
  return { buy: spot.ask, sell: fut.bid, gap_pct: r4(gap), net_pct: r4(net), yearly: r4(net * 365 / d) };
}

/** Best bid / ask from a Dhan full quote (depth level 1). */
export function dhanBA(q: any): BA | null {
  const bid = Number(q?.depth?.buy?.[0]?.price), ask = Number(q?.depth?.sell?.[0]?.price);
  return bid > 0 && ask > 0 ? { bid, ask } : null;
}
/** CoinDCX order book ({bids: {price: qty}, asks: {price: qty}}). */
export function dcxBA(j: any): BA | null {
  const bids = Object.keys(j?.bids ?? {}).map(Number).filter((x) => x > 0), asks = Object.keys(j?.asks ?? {}).map(Number).filter((x) => x > 0);
  return bids.length && asks.length ? { bid: Math.max(...bids), ask: Math.min(...asks) } : null;
}
export const CX_COINS = [{ key: "BTC", delta: "BTCUSD", dcx: "B-BTC_USDT" }, { key: "ETH", delta: "ETHUSD", dcx: "B-ETH_USDT" }, { key: "SOL", delta: "SOLUSD", dcx: "B-SOL_USDT" }];

async function json(f: Fetch, url: string) {
  const r = await f(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}
/** Delta India vs CoinDCX for each coin, with both funding rates (% per funding interval as each exchange gives it). */
export async function cryptoRound(f: Fetch = fetch) {
  const [deltas, books, dcxAll] = await Promise.all([
    Promise.all(CX_COINS.map((c) => json(f, `https://api.india.delta.exchange/v2/tickers/${c.delta}`).catch(() => null))),
    Promise.all(CX_COINS.map((c) => json(f, `https://public.coindcx.com/market_data/v3/orderbook/${c.dcx}-futures/10`).catch(() => null))),
    json(f, "https://public.coindcx.com/market_data/v3/current_prices/futures/rt").catch(() => null),
  ]);
  const rows: Record<string, unknown>[] = [];
  CX_COINS.forEach((c, i) => {
    const q = deltas[i]?.result?.quotes, d: BA | null = q ? { bid: Number(q.best_bid), ask: Number(q.best_ask) } : null, x = dcxBA(books[i]);
    if (!ok(d) || !ok(x)) return;
    const b = bestCross(d, x, CX_COST_PCT, ["Delta", "CoinDCX"]);
    const fd = Number(deltas[i]?.result?.funding_rate), fc = Number(dcxAll?.prices?.[c.dcx]?.fr);
    rows.push({ kind: "cx", key: c.key, buy: b.buy, sell: b.sell, gap_pct: b.gap_pct, net_pct: b.net_pct,
      x: { ...b.x, fund_delta_pct: Number.isFinite(fd) ? fd : null, fund_dcx_pct: Number.isFinite(fc) ? r4(fc * 100) : null } });
  });
  return rows;
}

/* ---------- Dhan security ids, once a day ---------- */
type CfId = { key: string; eq: string; lot: number; near?: { sec: string; exp: string }; next?: { sec: string; exp: string } };
export type SpreadIds = { nb: { key: string; nse: string; bse: string }[]; cf: CfId[] };
function csv(text: string) {
  const lines = text.split(/\r?\n/), head = lines[0].split(",");
  return { lines: lines.slice(1), col: (k: string) => head.indexOf(k) };
}
/**
 * Stock futures from Dhan's NSE F&O list (near and next month, their shares' NSE ids from UNDERLYING_SECURITY_ID) and
 * the desk's 10 stocks on BSE from the BSE share list.
 */
export function parseIds(fnoCsv: string, bseCsv: string, today: string): SpreadIds {
  const f = csv(fnoCsv);
  const iSec = f.col("SECURITY_ID"), iIns = f.col("INSTRUMENT"), iUnd = f.col("UNDERLYING_SYMBOL"), iSym = f.col("SYMBOL_NAME"),
    iExp = f.col("SM_EXPIRY_DATE"), iLot = f.col("LOT_SIZE"), iUsec = f.col("UNDERLYING_SECURITY_ID");
  const by = new Map<string, { eq: string; lot: number; futs: { sec: string; exp: string }[] }>();
  for (const line of f.lines) {
    const a = line.split(",");
    if (a[iIns] !== "FUTSTK") continue;
    const exp = (a[iExp] ?? "").slice(0, 10);
    if (!(exp >= today)) continue;
    const und = fnoUnderlying("FUTSTK", a[iUnd], iSym >= 0 ? a[iSym] : undefined);
    if (!und) continue;
    const e = by.get(und) ?? { eq: iUsec >= 0 ? String(a[iUsec] ?? "").trim() : "", lot: Number(a[iLot]) || 0, futs: [] };
    e.futs.push({ sec: a[iSec], exp });
    by.set(und, e);
  }
  const cf: CfId[] = [];
  for (const [key, e] of by) {
    if (!(Number(e.eq) > 0)) continue;
    const futs = e.futs.sort((x, y) => x.exp.localeCompare(y.exp));
    cf.push({ key, eq: e.eq, lot: e.lot, near: futs[0], next: futs[1] });
  }
  const b = csv(bseCsv);
  const bSec = b.col("SECURITY_ID"), bIns = b.col("INSTRUMENT"), bUnd = b.col("UNDERLYING_SYMBOL"), bSym = b.col("SYMBOL_NAME");
  const bse = new Map<string, string>();
  for (const line of b.lines) {
    const a = line.split(",");
    if (bIns >= 0 && a[bIns] !== "EQUITY") continue;
    for (const k of [a[bUnd], bSym >= 0 ? a[bSym] : ""]) { const s = String(k ?? "").trim().toUpperCase(); if (s && !bse.has(s)) bse.set(s, a[bSec]); }
  }
  const nb = STOCKS.filter((s) => bse.has(s.key)).map((s) => ({ key: s.key, nse: s.sec, bse: bse.get(s.key)! }));
  return { nb, cf: cf.sort((x, y) => x.key.localeCompare(y.key)) };
}
async function downloadIds(f: Fetch, creds: { client: string; token: string }, today: string): Promise<SpreadIds> {
  const get = async (seg: string) => {
    const r = await f(`https://api.dhan.co/v2/instrument/${seg}`, { headers: { Accept: "text/csv", "access-token": creds.token, "client-id": creds.client }, signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error(`Couldn't download Dhan's ${seg} list (HTTP ${r.status}).`);
    return r.text();
  };
  const [fno, bse] = await Promise.all([get("NSE_FNO"), get("BSE_EQ")]);
  return parseIds(fno, bse, today);
}

/* ---------- one round (engine action "spreads", every minute) ---------- */
export async function runSpreads(sb: SupabaseClient, creds: { client: string; token: string }, opts: { nowSec?: number; fetch?: Fetch; dhan?: Dhan } = {}) {
  const f = opts.fetch ?? fetch, nowSec = opts.nowSec ?? Date.now() / 1000;
  const { data: st } = await sb.from("spread_state").select("*").eq("id", 1).maybeSingle();
  if (!st) return { skipped: "no spread_state row" };
  if (nowSec * 1000 > Date.parse(st.until)) return { skipped: "watch period over" };
  const now = ist(nowSec), today = now.date, rows: Record<string, unknown>[] = [], errors: Record<string, string> = {};
  const upd: Record<string, unknown> = { last_run: new Date(nowSec * 1000).toISOString(), runs: (st.runs ?? 0) + 1 };
  try { rows.push(...await cryptoRound(f)); } catch (e) { errors.cx = String((e as Error)?.message ?? e).slice(0, 160); }

  const { data: hol } = await sb.from("market_holidays").select("day, exch, opens_at").eq("day", today);
  setHolidays(hol ?? []);
  const s = tradingSession("NSE_EQ", today), weekday = now.wd >= 1 && now.wd <= 5 && s.open < 1440;
  const open = weekday && now.min >= s.open && now.min < s.close;
  let ids = st.ids as SpreadIds | null, synced = false;
  if (weekday && st.ids_day !== today && now.min >= 510 && now.min < s.close && creds.token) {
    // The day's lists (big downloads): this round does only that, the quotes start next minute.
    try { ids = await downloadIds(f, creds, today); Object.assign(upd, { ids, ids_day: today }); synced = true; }
    catch (e) { errors.ids = String((e as Error)?.message ?? e).slice(0, 160); }
  } else if (open && ids && creds.token) {
    const doCf = !st.last_cf || nowSec * 1000 - Date.parse(st.last_cf) >= 14.5 * 60000;
    const bySeg: Record<string, string[]> = { NSE_EQ: ids.nb.map((x) => x.nse), BSE_EQ: ids.nb.map((x) => x.bse) };
    if (doCf) for (const c of ids.cf) {
      bySeg.NSE_EQ.push(c.eq);
      (bySeg.NSE_FNO ??= []).push(...[c.near?.sec, c.next?.sec].filter(Boolean) as string[]);
    }
    try {
      const q = await (opts.dhan ?? new Dhan(creds.client, creds.token)).quoteMany(bySeg);
      const get = (seg: string, sec: string) => dhanBA(q.get(`${seg}|${sec}`));
      for (const x of ids.nb) {
        const a = get("NSE_EQ", x.nse), b = get("BSE_EQ", x.bse);
        if (ok(a) && ok(b)) rows.push({ kind: "nb", key: x.key, ...bestCross(a, b, nbCostPct(), ["NSE", "BSE"]) });
      }
      if (doCf) {
        for (const c of ids.cf) {
          const spot = get("NSE_EQ", c.eq);
          if (!ok(spot)) continue;
          for (const [tag, fut] of [["near", c.near], ["next", c.next]] as const) {
            if (!fut) continue;
            const fq = get("NSE_FNO", fut.sec);
            if (!ok(fq)) continue;
            const days = Math.round((Date.parse(fut.exp) - Date.parse(today)) / 86400000);
            const cc = cashCarry(spot, fq, days);
            rows.push({ kind: "cf", key: `${c.key}:${tag}`, buy: cc.buy, sell: cc.sell, gap_pct: cc.gap_pct, net_pct: cc.net_pct,
              x: { days, yearly: cc.yearly, exp: fut.exp, lot: c.lot } });
          }
        }
        upd.last_cf = new Date(nowSec * 1000).toISOString();
      }
    } catch (e) { errors.dhan = String((e as Error)?.message ?? e).slice(0, 160); }
  }
  const at = new Date(nowSec * 1000).toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("spread_ticks").insert(rows.slice(i, i + 500).map((r) => ({ at, ...r })));
    if (error) errors.save = error.message;
  }
  upd.last_error = Object.keys(errors).length ? JSON.stringify(errors).slice(0, 400) : null;
  await sb.from("spread_state").update(upd).eq("id", 1);
  return { saved: rows.length, synced, market_open: open, errors };
}
