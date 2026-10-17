// Live order execution: limit orders that chase the price in small steps, confirmation of every fill, a real
// stop-loss order at the broker after each entry, and a regular check of the broker's positions against the desk.
//
// The desk keeps deciding as before (its position is the position the strategy wants). For live strategies the
// orders that carry out a decision are worked here:
//   • every leg goes as a LIMIT order at the last traded price, tagged with a unique correlation id;
//   • every 15 seconds each working order is checked: filled → recorded; rejected → the desk is put right and you are
//     alerted; price moved past the limit → the limit moves one step towards it (≈0.02% of the price, 1% of an option's
//     premium, rounded to the tick); price not past the limit (a quiet market) → left as it is;
//   • an entry gives up after 4 steps (the desk goes back to flat, you are alerted); an exit goes as a MARKET order
//     after 3 steps, because getting out comes first;
//   • after an entry fills, a STOP_LOSS_MARKET order is placed at the broker a little beyond the desk's stop, so the
//     position is protected even if the desk is down; it follows the trailing stop and is cancelled before any exit;
//   • every few minutes the broker's net positions are compared with the desk, contract by contract.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Creds = { client: string; token: string };
export type Side = "BUY" | "SELL";
export type Purpose = "entry" | "exit";
export type BrokerStatus = { status: string; filled: number; qty: number; avg: number | null; reason: string | null; price: number | null; orderType: string | null };

/* ---------------------------------------------------------------- pure rules (tested) */

export const ENTRY_MAX_STEPS = 4;
export const EXIT_MAX_STEPS = 3;

/** Round a price to the contract's tick: buys round up, sells round down (so the limit is never worse than asked). */
export function toTick(px: number, tick: number, side?: Side): number {
  const t = tick > 0 ? tick : 0.05;
  const n = px / t;
  const k = side === "BUY" ? Math.ceil(n - 1e-9) : side === "SELL" ? Math.floor(n + 1e-9) : Math.round(n);
  return +(k * t).toFixed(6);
}
/** One chasing step: ≈0.02% of the price (an option: 1% of its premium), at least one tick, a whole number of ticks. */
export function stepFor(px: number, tick: number, option: boolean): number {
  const t = tick > 0 ? tick : 0.05;
  const raw = Math.abs(px) * (option ? 0.01 : 0.0002);
  return +(Math.max(1, Math.round(raw / t)) * t).toFixed(6);
}
/** Dhan's order states that are final, and the ones that still work. */
const DONE_BAD = new Set(["REJECTED", "CANCELLED", "EXPIRED"]);
export type Chase =
  | { kind: "filled" }
  | { kind: "failed"; reason: string }
  | { kind: "wait" }
  | { kind: "modify"; price: number }
  | { kind: "market" }
  | { kind: "give_up" };
/**
 * What to do with a working order, given its state at the broker and the last traded price.
 * o: { purpose, side, limit (null once it went to market), steps (modifications so far), step, tick }.
 */
export function chaseDecision(o: { purpose: Purpose; side: Side; limit: number | null; steps: number; step: number; tick: number }, st: BrokerStatus, ltp: number | null): Chase {
  const s = String(st.status || "").toUpperCase();
  if (s === "TRADED" || (st.qty > 0 && st.filled >= st.qty)) return { kind: "filled" };
  if (DONE_BAD.has(s)) return { kind: "failed", reason: st.reason || s.toLowerCase() };
  if (o.limit == null || !(Number(ltp) > 0)) return { kind: "wait" }; // a market order, or no price to compare with
  const away = o.side === "BUY" ? Number(ltp) > o.limit : Number(ltp) < o.limit;
  if (!away) return { kind: "wait" }; // quiet market: the price hasn't passed our limit, leave the order as it is
  if (o.purpose === "exit" && o.steps >= EXIT_MAX_STEPS) return { kind: "market" };
  if (o.purpose === "entry" && o.steps >= ENTRY_MAX_STEPS) return st.filled > 0 ? { kind: "market" } : { kind: "give_up" };
  const next = o.side === "BUY" ? o.limit + o.step : o.limit - o.step;
  return { kind: "modify", price: toTick(next, o.tick, o.side) };
}
/** Where the broker's stop order goes: a little beyond the desk's stop (the desk normally exits first; this is the backstop). */
/** The limit price of a stop order: far enough beyond the trigger to fill like a market order (≈0.5%, an option 10%). */
export function stopLimit(trigger: number, positionLong: boolean, tick: number, option: boolean): number {
  const room = Math.max(5 * (tick > 0 ? tick : 0.05), trigger * (option ? 0.1 : 0.005));
  return toTick(positionLong ? Math.max(tick || 0.05, trigger - room) : trigger + room, tick, positionLong ? "SELL" : "BUY");
}
export function brokerStopTrigger(deskStop: number, offset: number, positionLong: boolean, step: number, tick: number): number {
  const beyond = 2 * step;
  return toTick(positionLong ? deskStop + offset - beyond : deskStop + offset + beyond, tick, positionLong ? "SELL" : "BUY");
}
/** Desk vs broker, contract by contract: the differences worth an alert. */
export function positionDiff(desk: Map<string, number>, broker: Map<string, number>): { key: string; desk: number; broker: number }[] {
  const keys = new Set([...desk.keys(), ...broker.keys()]);
  const out: { key: string; desk: number; broker: number }[] = [];
  for (const k of keys) {
    const d = desk.get(k) ?? 0, b = broker.get(k) ?? 0;
    if (d !== b) out.push({ key: k, desk: d, broker: b });
  }
  return out;
}

/* ---------------------------------------------------------------- Dhan order API */

export type HttpFn = (url: string, init: RequestInit) => Promise<Response>;
let http: HttpFn = (u, i) => fetch(u, i);
/** Tests swap in a simulated Dhan. */
export function setHttp(f: HttpFn) { http = f; }

async function dhanReq(c: Creds, method: string, path: string, body?: Record<string, unknown>) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", "access-token": c.token, "client-id": c.client },
    signal: AbortSignal.timeout(12000),
  };
  if (body) init.body = JSON.stringify({ dhanClientId: c.client, ...body });
  const r = await http("https://api.dhan.co/v2" + path, init);
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, j, text };
}
const errText = (x: { status: number; j: any; text: string }) =>
  String(x.j?.errorMessage ?? x.j?.omsErrorDescription ?? x.j?.message ?? x.j?.remarks ?? x.text ?? "").slice(0, 200) || `HTTP ${x.status}`;

export type OrderSpec = { sec: string; seg: string; product: string; side: Side; qty: number; type: OrdType; price?: number; trigger?: number; tag?: string };
/** STOP_LOSS = a stop with a limit price well beyond the trigger (NSE doesn't take stop-market orders on options). */
export type OrdType = "LIMIT" | "MARKET" | "STOP_LOSS" | "STOP_LOSS_MARKET";
const hasPrice = (t: OrdType) => t === "LIMIT" || t === "STOP_LOSS";
const hasTrigger = (t: OrdType) => t === "STOP_LOSS" || t === "STOP_LOSS_MARKET";
/** Places an order. Returns Dhan's order id, or throws with Dhan's reason. */
export async function dhanPlace(c: Creds, o: OrderSpec): Promise<{ id: string; status: string }> {
  const x = await dhanReq(c, "POST", "/orders", {
    transactionType: o.side, exchangeSegment: o.seg, productType: o.product, orderType: o.type, validity: "DAY", securityId: String(o.sec),
    quantity: Math.trunc(o.qty), disclosedQuantity: 0, price: hasPrice(o.type) ? Number(o.price) : 0, triggerPrice: hasTrigger(o.type) ? Number(o.trigger) : 0,
    afterMarketOrder: false, ...(o.tag ? { correlationId: o.tag } : {}),
  });
  const id = x.j?.orderId;
  if (!x.ok || !id) throw new Error(`Dhan didn't accept the order: ${errText(x)}`);
  return { id: String(id), status: String(x.j?.orderStatus ?? "TRANSIT") };
}
const one = (j: any) => Array.isArray(j) ? j[0] : Array.isArray(j?.data) ? j.data[0] : j?.data && !Array.isArray(j.data) ? j.data : j;
function statusOf(o: any): BrokerStatus {
  return {
    status: String(o?.orderStatus ?? ""), filled: Number(o?.filledQty ?? o?.tradedQuantity ?? 0), qty: Number(o?.quantity ?? 0),
    avg: Number(o?.averageTradedPrice ?? o?.tradedPrice ?? 0) > 0 ? Number(o.averageTradedPrice ?? o.tradedPrice) : null,
    reason: o?.omsErrorDescription ? String(o.omsErrorDescription) : null, price: o?.price != null ? Number(o.price) : null, orderType: o?.orderType ?? null,
  };
}
export async function dhanStatus(c: Creds, id: string): Promise<BrokerStatus> {
  const x = await dhanReq(c, "GET", `/orders/${encodeURIComponent(id)}`);
  if (!x.ok) throw new Error(`Couldn't read order ${id}: ${errText(x)}`);
  return statusOf(one(x.j));
}
/** An order placed with this tag (used when the reply to a placement was lost). */
export async function dhanByTag(c: Creds, tag: string): Promise<{ id: string; st: BrokerStatus } | null> {
  const x = await dhanReq(c, "GET", `/orders/external/${encodeURIComponent(tag)}`);
  const o = x.ok ? one(x.j) : null;
  return o?.orderId ? { id: String(o.orderId), st: statusOf(o) } : null;
}
export async function dhanModify(c: Creds, id: string, m: { type: OrdType; qty: number; price?: number; trigger?: number }) {
  const x = await dhanReq(c, "PUT", `/orders/${encodeURIComponent(id)}`, {
    orderId: id, orderType: m.type, legName: "", quantity: Math.trunc(m.qty), price: hasPrice(m.type) ? Number(m.price) : 0,
    disclosedQuantity: 0, triggerPrice: hasTrigger(m.type) ? Number(m.trigger) : 0, validity: "DAY",
  });
  if (!x.ok) throw new Error(`Couldn't modify order ${id}: ${errText(x)}`);
}
export async function dhanCancel(c: Creds, id: string) {
  const x = await dhanReq(c, "DELETE", `/orders/${encodeURIComponent(id)}`);
  if (!x.ok) throw new Error(`Couldn't cancel order ${id}: ${errText(x)}`);
}
/** Net open quantity per contract ("SEGMENT|securityId" → signed quantity, + long / − short). */
export async function dhanPositions(c: Creds): Promise<Map<string, number>> {
  const x = await dhanReq(c, "GET", "/positions");
  if (!x.ok) throw new Error(`Couldn't read Dhan positions: ${errText(x)}`);
  const rows: any[] = Array.isArray(x.j) ? x.j : Array.isArray(x.j?.data) ? x.j.data : [];
  const out = new Map<string, number>();
  for (const p of rows) {
    const q = Number(p.netQty ?? 0);
    if (!q) continue;
    const k = `${p.exchangeSegment}|${p.securityId}`;
    out.set(k, (out.get(k) ?? 0) + q);
  }
  return out;
}
export async function dhanLtp(c: Creds, seg: string, sec: string): Promise<number | null> {
  const x = await dhanReq(c, "POST", "/marketfeed/ltp", { [seg]: [Number(sec)] }).catch(() => null);
  if (!x?.ok) return null;
  const v = x.j?.data?.[seg]?.[String(sec)]?.last_price;
  return Number(v) > 0 ? Number(v) : null;
}

/* ---------------------------------------------------------------- contracts (security ids, lot sizes, ticks) */

const FNO_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX", "BANKEX"];
/** Downloads Dhan's F&O instrument lists (NSE and BSE) and keeps the index futures and options of the next 4 months. */
export async function syncFno(sb: SupabaseClient, c: Creds): Promise<number> {
  const until = new Date(Date.now() + 125 * 86400000).toISOString().slice(0, 10);
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  let n = 0;
  const now = new Date().toISOString();
  for (const seg of ["NSE_FNO", "BSE_FNO"]) {
    const r = await http(`https://api.dhan.co/v2/instrument/${seg}`, { headers: { Accept: "text/csv", "access-token": c.token, "client-id": c.client }, signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error(`Couldn't download Dhan's ${seg} instrument list (HTTP ${r.status}).`);
    const lines = (await r.text()).split(/\r?\n/);
    const head = lines[0].split(",");
    const col = (k: string) => head.indexOf(k);
    const iSec = col("SECURITY_ID"), iIns = col("INSTRUMENT"), iUnd = col("UNDERLYING_SYMBOL"), iExp = col("SM_EXPIRY_DATE"),
      iStr = col("STRIKE_PRICE"), iOpt = col("OPTION_TYPE"), iLot = col("LOT_SIZE"), iTick = col("TICK_SIZE"), iDisp = col("DISPLAY_NAME");
    if ([iSec, iIns, iUnd, iExp].some((i) => i < 0)) throw new Error(`Dhan's ${seg} instrument list has an unexpected format.`);
    const rows: Record<string, unknown>[] = [];
    for (const line of lines.slice(1)) {
      const a = line.split(",");
      const ins = a[iIns], und = a[iUnd], exp = (a[iExp] ?? "").slice(0, 10);
      if ((ins !== "FUTIDX" && ins !== "OPTIDX") || !FNO_UNDERLYINGS.includes(und) || !(exp >= today && exp <= until)) continue;
      rows.push({ sec_id: a[iSec], seg, underlying: und, instrument: ins, expiry: exp, strike: ins === "OPTIDX" && iStr >= 0 ? Number(a[iStr]) : null,
        opt_type: ins === "OPTIDX" && iOpt >= 0 ? a[iOpt] : null, lot: iLot >= 0 ? Number(a[iLot]) || null : null, tick: iTick >= 0 ? Number(a[iTick]) / 100 || null : null, // Dhan lists the tick in paise
        display: iDisp >= 0 ? a[iDisp] : null, synced_at: now });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from("fno_contracts").upsert(rows.slice(i, i + 500));
      if (error) throw new Error(error.message);
    }
    n += rows.length;
  }
  return n; // expired contracts are never picked (every lookup asks for an expiry on or after today)
}
export type Resolved = { sec: string; seg: string; lot: number; tick: number; label: string; option: boolean };
/**
 * The broker contract for one order leg (as the desk writes it for the webhook): index futures → the near-month
 * contract, index options → the exact strike / expiry, MCX → the near-month contract the desk trades.
 */
export async function resolveLeg(sb: SupabaseClient, c: Creds, s: Record<string, any>, leg: Record<string, any>, onDate: string): Promise<Resolved> {
  const exch = String(leg.exchange ?? s.exchange ?? "NSE").toUpperCase();
  const instr = String(leg.instrument ?? "").toUpperCase();
  const symbol = String(leg.symbol ?? "").replace(/\d*!$/, "").toUpperCase();
  if (exch === "MCX") {
    const pick = async () => (await sb.from("mcx_contracts").select("sec_id, display, expiry, lot, tick").eq("underlying", symbol || String(s.underlying))
      .gt("expiry", onDate).order("expiry").limit(1)).data?.[0];
    const k = await pick();
    if (!k) throw new Error(`No MCX contract found for ${symbol || s.underlying}.`);
    return { sec: String(k.sec_id), seg: "MCX_COMM", lot: Number(k.lot) || 1, tick: Number(k.tick) || 1, label: String(k.display ?? symbol), option: false };
  }
  const seg = exch === "BSE" ? "BSE_FNO" : "NSE_FNO";
  const fresh = async () => {
    const { data } = await sb.from("fno_contracts").select("synced_at").eq("seg", seg).order("synced_at", { ascending: false }).limit(1);
    if (!data?.length || Date.now() - Date.parse(data[0].synced_at) > 20 * 3600000) await syncFno(sb, c);
  };
  await fresh();
  if (instr === "OPT" || leg.option_type) {
    const strike = Number(leg.strike_price ?? leg.strike), type = String(leg.option_type ?? "").toUpperCase(), exp = String(leg.expiry_date ?? leg.expiry ?? "").slice(0, 10);
    const { data } = await sb.from("fno_contracts").select("sec_id, lot, tick, display").eq("seg", seg).eq("underlying", symbol).eq("instrument", "OPTIDX")
      .eq("expiry", exp).eq("strike", strike).eq("opt_type", type).limit(1);
    const k = data?.[0];
    if (!k) throw new Error(`No ${symbol} ${strike} ${type} option expiring ${exp} in Dhan's list.`);
    return { sec: String(k.sec_id), seg, lot: Number(k.lot) || Number(s.lot_size) || 1, tick: Number(k.tick) || 0.05, label: String(k.display ?? `${symbol} ${strike} ${type}`), option: true };
  }
  const { data } = await sb.from("fno_contracts").select("sec_id, lot, tick, display, expiry").eq("seg", seg).eq("underlying", symbol).eq("instrument", "FUTIDX")
    .gte("expiry", onDate).order("expiry").limit(1);
  const k = data?.[0];
  if (!k) throw new Error(`No ${symbol} futures contract in Dhan's list.`);
  return { sec: String(k.sec_id), seg, lot: Number(k.lot) || Number(s.lot_size) || 1, tick: Number(k.tick) || 0.05, label: String(k.display ?? `${symbol} FUT`), option: false };
}
/** Order quantity at Dhan: MCX in lots, NSE / BSE F&O in units (lots × lot size). */
export function brokerQty(seg: string, lots: number, lot: number): number {
  return seg === "MCX_COMM" ? Math.trunc(lots) : Math.trunc(lots * lot);
}
export const productOf = (p: unknown) => /^(I|INTRA|INTRADAY|MIS)$/i.test(String(p ?? "")) ? "INTRADAY" : "MARGIN";
export const sideOf = (t: unknown): Side => /^(B|BUY)$/i.test(String(t ?? "")) ? "BUY" : "SELL";
