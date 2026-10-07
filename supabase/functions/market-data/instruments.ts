// Resolves a commodity underlying (e.g. "CRUDEOIL") to Dhan's current near-month futures contract.
// MCX contract security IDs change every expiry, so strategies and charts store the underlying symbol and
// this module looks up the live contract from a table refreshed from Dhan's instrument list once a day.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { isCommodity } from "./logic.ts";

const STALE_MS = 20 * 3600 * 1000;

/** Download Dhan's MCX instrument list and store every commodity futures contract. */
export async function syncMcx(sb: SupabaseClient, clientId: string, token: string): Promise<number> {
  const r = await fetch("https://api.dhan.co/v2/instrument/MCX_COMM", {
    headers: { Accept: "text/csv", "access-token": token, "client-id": clientId },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Couldn't download Dhan's MCX instrument list (HTTP ${r.status}).`);
  const lines = (await r.text()).split(/\r?\n/);
  const head = lines[0].split(",");
  const col = (n: string) => head.indexOf(n);
  const iSec = col("SECURITY_ID"), iIns = col("INSTRUMENT"), iUnd = col("UNDERLYING_SYMBOL"), iDisp = col("DISPLAY_NAME"), iExp = col("SM_EXPIRY_DATE");
  if ([iSec, iIns, iUnd, iExp].some((i) => i < 0)) throw new Error("Dhan's MCX instrument list has an unexpected format.");
  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  for (const line of lines.slice(1)) {
    const a = line.split(",");
    if (a[iIns] !== "FUTCOM" || !/^\d{4}-\d{2}-\d{2}/.test(a[iExp] ?? "")) continue;
    rows.push({ sec_id: a[iSec], underlying: a[iUnd], display: a[iDisp] ?? null, expiry: a[iExp].slice(0, 10), synced_at: now });
  }
  if (!rows.length) throw new Error("Dhan's MCX instrument list had no futures contracts.");
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from("mcx_contracts").upsert(rows.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  await sb.from("mcx_contracts").delete().lt("synced_at", now); // drop expired / delisted contracts
  return rows.length;
}

export type Contract = { sec_id: string; underlying: string; display: string | null; expiry: string };

/**
 * The contract to use for an underlying on a given IST date: the nearest expiry after that date
 * (on expiry day the next contract is used, as liquidity has already moved).
 */
export async function nearContract(sb: SupabaseClient, creds: { client: string; token: string }, underlying: string, onDate: string): Promise<Contract> {
  const pick = async () => (await sb.from("mcx_contracts").select("sec_id, underlying, display, expiry, synced_at")
    .eq("underlying", underlying).gt("expiry", onDate).order("expiry").limit(1)).data?.[0];
  let c = await pick();
  if (!c || Date.now() - Date.parse(c.synced_at) > STALE_MS) {
    await syncMcx(sb, creds.client, creds.token);
    c = await pick();
  }
  if (!c) throw new Error(`No live MCX futures contract found for ${underlying}.`);
  return c;
}

/** Security ID to request data for: commodities resolve to the near contract; everything else is used as-is. */
export async function dataSecurity(sb: SupabaseClient, creds: { client: string; token: string }, seg: string, sec: string, onDate: string) {
  if (isCommodity(seg) && !/^\d+$/.test(sec)) {
    const c = await nearContract(sb, creds, sec, onDate);
    return { sec: c.sec_id, contract: c };
  }
  return { sec, contract: null as Contract | null };
}
