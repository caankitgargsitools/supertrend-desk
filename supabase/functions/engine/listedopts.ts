// Options on stocks and on MCX commodities (6 Nov 2026, Papa: "implement point 3 and 4").
// Index options use Dhan's option chain (expiry list, strikes, premium). For stocks (NSE OPTSTK) and MCX commodities
// (OPTFUT, options on the futures) the desk works from Dhan's own instrument lists instead, synced into fno_contracts
// (NSE_FNO / MCX_COMM, the two nearest expiries): the expiry is the next one listed, the strike the listed one nearest to
// the price moved by the strategy's "strikes away" (positive = out of the money), the premium that option contract's
// last traded price, and the order goes to that exact contract. MCX options expire a few days before their futures and
// not on a fixed weekday, so the weekday settings don't apply to them.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { isCommodity } from "./logic.ts";

export type OptRow = { sec_id: string; seg: string; expiry: string; strike: number; opt_type: "CE" | "PE"; lot: number | null };
/** True for an options strategy whose contracts come from the synced lists (stocks, MCX), not the option chain. */
export const isListedOpt = (s: { data_segment?: unknown }) => {
  const seg = String(s.data_segment ?? "");
  return seg === "NSE_EQ" || isCommodity(seg);
};
const memo = new Map<string, { at: number; rows: OptRow[] }>();
/** The listed options of one underlying (desk key), expiring today or later. Kept 10 minutes per function instance. */
export async function optRows(sb: SupabaseClient, s: { underlying?: unknown; data_segment?: unknown }, today: string): Promise<OptRow[]> {
  const underlying = String(s.underlying ?? ""), mcx = isCommodity(String(s.data_segment ?? "")), key = `${mcx ? "M" : "S"}|${underlying}`;
  const m = memo.get(key);
  if (m && Date.now() - m.at < 600000) return m.rows.filter((r) => r.expiry >= today);
  const { data, error } = await sb.from("fno_contracts").select("sec_id, seg, expiry, strike, opt_type, lot").eq("seg", mcx ? "MCX_COMM" : "NSE_FNO")
    .eq("underlying", underlying).eq("instrument", mcx ? "OPTFUT" : "OPTSTK").gte("expiry", today).order("expiry").order("strike").limit(1000);
  if (error) throw new Error(`Couldn't read ${underlying}'s options: ${error.message}`);
  const rows = (data ?? []).map((r) => ({ ...r, sec_id: String(r.sec_id), strike: Number(r.strike), lot: r.lot == null ? null : Number(r.lot) })) as OptRow[];
  memo.set(key, { at: Date.now(), rows });
  return rows;
}
export const clearOptMemo = () => memo.clear();

/**
 * The contract for a new position: the first listed expiry (after today when `roll` is set, so an expiring series isn't
 * bought on its last day), and of its strikes of that type the one nearest the price, `offset` strikes out of the money
 * (CE higher, PE lower; negative = in the money). Null when nothing is listed.
 */
export function pickListed(rows: OptRow[], price: number, offset: number, type: "CE" | "PE", today: string, roll: boolean): OptRow | null {
  const exps = [...new Set(rows.map((r) => r.expiry))].sort();
  const expiry = exps.find((e) => roll ? e > today : e >= today);
  if (!expiry || !(price > 0)) return null;
  const list = rows.filter((r) => r.expiry === expiry && r.opt_type === type).sort((a, b) => a.strike - b.strike);
  if (!list.length) return null;
  let atm = 0;
  for (let i = 1; i < list.length; i++) if (Math.abs(list[i].strike - price) < Math.abs(list[atm].strike - price)) atm = i;
  const k = Math.round(Number(offset) || 0), i = type === "CE" ? atm + k : atm - k;
  return list[Math.max(0, Math.min(list.length - 1, i))];
}

/** The listed contract for a held position (exact expiry, strike and type), or null. */
export const findListed = (rows: OptRow[], expiry: string, strike: number, type: string) =>
  rows.find((r) => r.expiry === expiry && Math.abs(r.strike - strike) < 0.01 && r.opt_type === type) ?? null;
