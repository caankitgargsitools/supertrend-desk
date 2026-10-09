// End-of-day check against the broker: reads the user's Dhan positions, matches them with the desk's closed LIVE trades
// of the day, replaces the desk's estimate with Dhan's realised P&L where the quantities agree, records the day in
// daily_pnl, and (on the billing run) takes the profit share from the wallet.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { accountFor } from "./accounts.ts";

const istDay = (ms = Date.now()) => new Date(ms + 19800000).toISOString().slice(0, 10);

type Pos = Record<string, any>;
const num = (x: unknown) => Number(x) || 0;

/** Does a Dhan position belong to a desk trade's contract key (OPT|sym|strike|CE|expiry or FUT|sym)? */
export function matches(ref: string, p: Pos): boolean {
  const [kind, sym, strike, typ, exp] = ref.split("|");
  const ts = String(p.tradingSymbol ?? "").toUpperCase();
  if (kind === "OPT") {
    const ot = String(p.drvOptionType ?? "").toUpperCase();
    const pt = ot.startsWith("C") ? "CE" : ot.startsWith("P") ? "PE" : "";
    return pt === typ && Math.abs(num(p.drvStrikePrice) - num(strike)) < 0.01 && String(p.drvExpiryDate ?? "").slice(0, 10) === exp
      && ts.startsWith(String(sym).toUpperCase());
  }
  const fs = String(sym).toUpperCase().replace(/\d*!$/, "");
  const ot = String(p.drvOptionType ?? "").toUpperCase();
  return (ts === fs || (ts.startsWith(fs.split(/[-\s]/)[0]) && /FUT/.test(ts))) && !/^(CALL|PUT|CE|PE)/.test(ot);
}

export async function syncUser(sb: SupabaseClient, userId: string, charge: boolean) {
  const acct = await accountFor(sb, userId);
  const day = istDay();
  const from = new Date(Date.parse(`${day}T00:00:00+05:30`)).toISOString();
  const { data: trades } = await sb.from("algo_trades").select("id, broker_ref, units, gross, costs, net, verified, fee")
    .eq("user_id", userId).eq("mode", "LIVE").gte("exit_at", from).order("exit_at");
  const list = trades ?? [];
  let positions: Pos[] = [], note = "", matched = 0;
  if (!acct?.dhan_access_token) note = "No Dhan account connected; desk estimates used.";
  else {
    try {
      const r = await fetch("https://api.dhan.co/v2/positions", {
        headers: { "access-token": acct.dhan_access_token, "client-id": acct.dhan_client_id ?? "", Accept: "application/json" }, signal: AbortSignal.timeout(20000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(j)) note = `Dhan positions request failed (HTTP ${r.status}); desk estimates used.`;
      else positions = j;
    } catch (e) { note = `Dhan positions request failed (${e instanceof Error ? e.message : String(e)}); desk estimates used.`; }
  }
  // Group today's unbilled trades by contract and compare with Dhan's closed position for it.
  const groups = new Map<string, typeof list>();
  for (const t of list) if (t.broker_ref && t.fee == null && !t.verified) groups.set(t.broker_ref, [...(groups.get(t.broker_ref) ?? []), t]);
  const unmatched: string[] = [];
  for (const [ref, ts] of groups) {
    const ps = positions.filter((p) => matches(ref, p));
    if (ps.length !== 1) { if (positions.length || !note) unmatched.push(ref); continue; }
    const p = ps[0];
    const units = ts.reduce((a, t) => a + num(t.units), 0);
    const traded = Math.max(num(p.buyQty) + num(p.carryForwardBuyQty), num(p.sellQty) + num(p.carryForwardSellQty));
    // Only when the position is closed and its quantity is exactly the desk's (no manual trades mixed in).
    if (num(p.netQty) !== 0 || traded !== units) { unmatched.push(ref); continue; }
    const realised = num(p.realizedProfit);
    const deskGross = ts.reduce((a, t) => a + num(t.gross), 0);
    const share = (realised - deskGross) / ts.length;
    for (const t of ts) {
      const gross = Math.trunc(num(t.gross) + share);
      await sb.from("algo_trades").update({ gross, net: Math.trunc(gross - num(t.costs)), verified: true }).eq("id", t.id);
      matched++;
    }
  }
  if (unmatched.length && !note) note = `${unmatched.length} contract(s) couldn't be matched exactly with Dhan (manual trades or partial fills); desk estimates used for those.`;
  const { data: after } = await sb.from("algo_trades").select("net").eq("user_id", userId).eq("mode", "LIVE").gte("exit_at", from);
  const deskNet = (after ?? []).reduce((a, t) => a + num(t.net), 0);
  const dhanReal = positions.length ? Math.trunc(positions.reduce((a, p) => a + num(p.realizedProfit), 0)) : null;
  await sb.from("daily_pnl").upsert({
    user_id: userId, day, desk_net: Math.trunc(deskNet), dhan_realised: dhanReal, matched, note: note || null, checked_at: new Date().toISOString(),
    positions: positions.map((p) => ({ s: p.tradingSymbol, q: p.netQty, r: p.realizedProfit, u: p.unrealizedProfit })).slice(0, 100),
  });
  if (acct) await sb.from("broker_accounts").update({ synced_at: new Date().toISOString(), sync_note: note || `Checked with Dhan: ${matched} trade(s) matched.` })
    .eq("user_id", userId).eq("broker", "DHAN");
  let fee = 0;
  if (charge) {
    const { data, error } = await sb.rpc("charge_profit_share", { p_user: userId });
    if (error) throw new Error(error.message);
    fee = num(data);
  }
  return { day, trades: list.length, matched, desk_net: Math.trunc(deskNet), dhan_realised: dhanReal, fee, note: note || null };
}

/** Billing run: every user with LIVE trades not yet billed. */
export async function billingDay(sb: SupabaseClient) {
  const { data } = await sb.from("algo_trades").select("user_id").eq("mode", "LIVE").is("fee", null).not("user_id", "is", null);
  const users = [...new Set((data ?? []).map((r) => r.user_id as string))];
  const out: Record<string, unknown> = {};
  for (const u of users) { try { out[u] = await syncUser(sb, u, true); } catch (e) { out[u] = { error: e instanceof Error ? e.message : String(e) }; } }
  return { users: users.length, results: out };
}
