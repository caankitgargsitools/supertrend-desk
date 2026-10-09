// Real margin rates from Dhan's margin calculator, per Strategy Lab asset.
// For each asset the near-month future and an at-the-money option are priced with Dhan's calculator (SPAN + exposure),
// and stored as a share of contract value. The lab then works out each trade's margin from the price at that trade's
// entry × lot size × that share, so the capital a strategy needs follows the price it actually traded at.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Dhan } from "./dhan.ts";
import { ist } from "./logic.ts";
import { nearContract } from "./instruments.ts";

export type MarginAsset = { key: string; seg: string; sec: string; exchange: string; lot: number; commodity: boolean };
export type MarginRate = { fut: number | null; futI: number | null; sell: number | null; sellI: number | null };

type Row = { sec: string; inst: string; und: string; exp: string; strike: number; opt: string; lot: number };

/** Index futures and options from Dhan's instrument list for one segment (NSE_FNO or BSE_FNO). */
async function fnoList(creds: { client: string; token: string }, seg: string, wanted: Set<string>): Promise<Row[]> {
  const r = await fetch(`https://api.dhan.co/v2/instrument/${seg}`, {
    headers: { Accept: "text/csv", "access-token": creds.token, "client-id": creds.client }, signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`Couldn't download Dhan's ${seg} instrument list (HTTP ${r.status}).`);
  const text = await r.text();
  const nl = text.indexOf("\n");
  const head = text.slice(0, nl).replace(/\r$/, "").split(",");
  const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iSec = col("SECURITY_ID", "SEM_SMST_SECURITY_ID"), iIns = col("INSTRUMENT", "SEM_INSTRUMENT_NAME"), iUnd = col("UNDERLYING_SYMBOL", "SM_SYMBOL_NAME");
  const iExp = col("SM_EXPIRY_DATE", "SEM_EXPIRY_DATE"), iStk = col("STRIKE_PRICE", "SEM_STRIKE_PRICE"), iOpt = col("OPTION_TYPE", "SEM_OPTION_TYPE"), iLot = col("LOT_SIZE", "SEM_LOT_UNITS");
  if ([iSec, iIns, iUnd, iExp].some((i) => i < 0)) throw new Error(`Dhan's ${seg} instrument list has an unexpected format: ${head.slice(0, 12).join(",")}`);
  const out: Row[] = [];
  let pos = nl + 1;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos); if (end < 0) end = text.length;
    const line = text.slice(pos, end); pos = end + 1;
    if (!line.includes("IDX")) continue; // FUTIDX / OPTIDX only
    const a = line.replace(/\r$/, "").split(",");
    if ((a[iIns] !== "FUTIDX" && a[iIns] !== "OPTIDX") || !wanted.has(a[iUnd])) continue;
    out.push({ sec: a[iSec], inst: a[iIns], und: a[iUnd], exp: (a[iExp] ?? "").slice(0, 10), strike: Number(a[iStk] ?? 0), opt: a[iOpt] ?? "", lot: Number(a[iLot] ?? 0) });
  }
  return out;
}

async function calc(dhan: Dhan, client: string, seg: string, sec: string, qty: number, price: number, product: "MARGIN" | "INTRADAY") {
  const j = await dhan.post("/margincalculator", {
    dhanClientId: client, exchangeSegment: seg, transactionType: "SELL", quantity: qty, productType: product, securityId: String(sec), price: +price.toFixed(2),
  });
  const m = Number(j?.totalMargin ?? j?.total_margin);
  if (!(m > 0)) throw new Error(`No margin returned for ${seg} ${sec}: ${JSON.stringify(j).slice(0, 160)}`);
  return m;
}

/** Refreshes lab_margins for the given assets. Returns how many assets were priced. */
export async function refreshMargins(sb: SupabaseClient, creds: { client: string; token: string }, assets: MarginAsset[]): Promise<number> {
  if (!creds.client || !creds.token) return 0;
  const dhan = new Dhan(creds.client, creds.token);
  const today = ist(Date.now() / 1000).date;
  const { data: daily } = await sb.from("lab_candles").select("asset, bars").eq("kind", "D").in("asset", assets.map((a) => a.key));
  const lastClose = new Map((daily ?? []).map((d) => [d.asset, Number(d.bars?.c?.at(-1))]));
  const lists = new Map<string, Row[]>();
  for (const seg of ["NSE_FNO", "BSE_FNO"]) {
    const keys = new Set(assets.filter((a) => !a.commodity && (seg === "BSE_FNO") === (a.exchange === "BSE")).map((a) => a.key));
    if (keys.size) { try { lists.set(seg, await fnoList(creds, seg, keys)); } catch (e) { console.error("margins", e); lists.set(seg, []); } }
  }
  let done = 0;
  for (const a of assets) {
    const price = lastClose.get(a.key) ?? 0;
    const detail: Record<string, unknown> = { price };
    const row: Record<string, unknown> = { asset: a.key, price, fut_pct: null, fut_pct_i: null, sell_pct: null, sell_pct_i: null, error: null, checked_at: new Date().toISOString() };
    try {
      if (!(price > 0)) throw new Error("No recent price for this asset yet.");
      if (a.commodity) {
        const c = await nearContract(sb, creds, a.key, today);
        // Dhan's MCX quantity is in lots; if the answer looks like a per-unit figure, read it that way instead.
        const value = price * a.lot;
        const m = await calc(dhan, creds.client, "MCX_COMM", c.sec_id, 1, price, "MARGIN");
        let pct = m / value;
        if (pct < 0.01) pct = m / price;
        const mi = await calc(dhan, creds.client, "MCX_COMM", c.sec_id, 1, price, "INTRADAY");
        let pctI = mi / value; if (pctI < 0.01) pctI = mi / price;
        Object.assign(detail, { contract: c.display ?? c.sec_id, expiry: c.expiry, margin: m, margin_intraday: mi, value });
        Object.assign(row, { fut_pct: +pct.toFixed(5), fut_pct_i: +pctI.toFixed(5) });
      } else {
        const seg = a.exchange === "BSE" ? "BSE_FNO" : "NSE_FNO";
        const rows = (lists.get(seg) ?? []).filter((r) => r.und === a.key && r.exp > today);
        const fut = rows.filter((r) => r.inst === "FUTIDX").sort((x, y) => x.exp.localeCompare(y.exp))[0];
        const lot = fut?.lot || a.lot;
        detail.lot_dhan = lot;
        if (fut) {
          const m = await calc(dhan, creds.client, seg, fut.sec, lot, price, "MARGIN");
          const mi = await calc(dhan, creds.client, seg, fut.sec, lot, price, "INTRADAY");
          Object.assign(detail, { future: fut.sec, fut_expiry: fut.exp, fut_margin: m, fut_margin_intraday: mi, value: price * lot });
          Object.assign(row, { fut_pct: +(m / (price * lot)).toFixed(5), fut_pct_i: +(mi / (price * lot)).toFixed(5) });
        }
        const opts = rows.filter((r) => r.inst === "OPTIDX" && r.opt === "CE");
        const exp = opts.map((r) => r.exp).sort()[0];
        const atm = opts.filter((r) => r.exp === exp).sort((x, y) => Math.abs(x.strike - price) - Math.abs(y.strike - price))[0];
        if (atm) {
          let prem = 0;
          try { prem = (await dhan.ltp(seg, atm.sec)) ?? 0; } catch { prem = 0; }
          const m = await calc(dhan, creds.client, seg, atm.sec, lot, prem > 0 ? prem : price * 0.01, "MARGIN");
          const mi = await calc(dhan, creds.client, seg, atm.sec, lot, prem > 0 ? prem : price * 0.01, "INTRADAY");
          Object.assign(detail, { option: atm.sec, opt_strike: atm.strike, opt_expiry: exp, opt_premium: prem, sell_margin: m, sell_margin_intraday: mi });
          Object.assign(row, { sell_pct: +(m / (atm.strike * lot)).toFixed(5), sell_pct_i: +(mi / (atm.strike * lot)).toFixed(5) });
        }
        if (!fut && !atm) throw new Error("No live futures or options found in Dhan's instrument list.");
      }
      done++;
    } catch (e) {
      row.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    }
    row.detail = detail;
    // Keep the last good rates when a check fails.
    if (row.error) await sb.from("lab_margins").upsert({ asset: a.key, error: row.error, detail, checked_at: row.checked_at }, { onConflict: "asset" });
    else await sb.from("lab_margins").upsert(row, { onConflict: "asset" });
  }
  return done;
}

/** Stored rates, by asset. */
export async function loadMarginRates(sb: SupabaseClient): Promise<Record<string, MarginRate>> {
  const { data } = await sb.from("lab_margins").select("asset, fut_pct, fut_pct_i, sell_pct, sell_pct_i");
  const n = (x: unknown) => (Number(x) > 0 ? Number(x) : null);
  return Object.fromEntries((data ?? []).map((r) => [r.asset, { fut: n(r.fut_pct), futI: n(r.fut_pct_i), sell: n(r.sell_pct), sellI: n(r.sell_pct_i) }]));
}
