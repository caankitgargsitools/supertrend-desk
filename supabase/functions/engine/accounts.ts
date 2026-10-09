// Multi-user desk: whose broker account a strategy trades on, whether it may open new trades, and the rules of
// strategies bought from the marketplace (kept with the publisher's master copy, never in the buyer's row).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Account = {
  user_id: string; broker: string; dhan_client_id: string | null; dhan_access_token: string | null; webhook_url: string | null; webhook_secret: string | null;
  capital: number | null; capital_since: string | null; deploy_pct: number | null; funds_at: string | null;
};

/** Broker account of a user (Dhan today; the broker column leaves room for others). */
export async function accountFor(sb: SupabaseClient, userId: string, broker = "DHAN", cache?: Map<string, Account | null>): Promise<Account | null> {
  const key = `${userId}|${broker}`;
  if (cache?.has(key)) return cache.get(key)!;
  const { data } = await sb.from("broker_accounts").select("*").eq("user_id", userId).eq("broker", broker).maybeSingle();
  const a = data ? {
    user_id: data.user_id, broker: data.broker, dhan_client_id: data.client_id, dhan_access_token: data.access_token, webhook_url: data.webhook_url,
    webhook_secret: data.webhook_secret, capital: data.capital, capital_since: data.capital_since, deploy_pct: data.deploy_pct, funds_at: data.funds_at,
  } as Account : null;
  cache?.set(key, a);
  return a;
}

/** The admin's account: used for the strategy lab, margin checks and the MCX contract list. */
export async function adminAccount(sb: SupabaseClient): Promise<Account | null> {
  const { data: p } = await sb.from("profiles").select("user_id").eq("role", "admin").eq("status", "active").order("created_at").limit(1).maybeSingle();
  const id = p?.user_id ?? (await sb.from("app_owner").select("user_id").maybeSingle()).data?.user_id;
  return id ? accountFor(sb, id) : null;
}

export const credsOf = (a: Account | null) => ({ client: a?.dhan_client_id ?? "", token: a?.dhan_access_token ?? "" });

/** Fields that define how a strategy trades. A bought strategy takes these from its master at run time. */
export const LOGIC_FIELDS = [
  "strategy_kind", "rules", "risk", "timeframe_min", "atr_period", "factor", "entry_mode", "entry_trigger", "buffer_points", "direction",
  "session_start", "last_entry", "square_off", "intraday", "after_hours_flip", "bias_timeframe", "bias_source", "entry_time", "exit_time",
  "exit_next_day", "trade_type", "option_side", "strike_offset", "strike_step", "expiry_flag", "expiry_weekday", "roll_on_expiry", "expiry_override",
  "underlying", "data_security_id", "data_segment", "data_instrument", "exchange", "dhan_symbol", "futures_symbol", "lot_size", "product_type",
  "leg_template_fut", "leg_template_opt", "asset_class",
];

/** Merges each bought strategy with its master's rules. Strategies whose master is gone are returned with _missing set. */
export async function withMasters(sb: SupabaseClient, rows: Record<string, any>[]): Promise<Record<string, any>[]> {
  const ids = [...new Set(rows.filter((r) => r.source_id).map((r) => r.source_id))];
  if (!ids.length) return rows;
  const { data: masters } = await sb.from("algo_strategies").select("*").in("id", ids);
  const byId = new Map((masters ?? []).map((m) => [m.id, m]));
  return rows.map((r) => {
    if (!r.source_id) return r;
    const m = byId.get(r.source_id);
    if (!m) return { ...r, _missing: true };
    const out: Record<string, any> = { ...r };
    for (const k of LOGIC_FIELDS) out[k] = m[k];
    return out;
  });
}

type Gate = { ok: boolean; why: string | null; role?: string; trial?: boolean; fee?: number };
/**
 * Whether a strategy may open new LIVE trades: the owner's account and wallet (entries_allowed), the deployment fee
 * for this strategy, and, for a bought strategy, a valid purchase. Exits are never blocked.
 */
export async function entryGate(sb: SupabaseClient, s: Record<string, any>, cache: Map<string, any>): Promise<string | null> {
  if (!s.live) return null;
  const u = String(s.owner_id ?? "");
  if (!u) return null;
  if (!cache.has(`e|${u}`)) {
    const [{ data: e }, { data: b }] = await Promise.all([sb.rpc("entries_allowed", { p_user: u }), sb.rpc("billing_for", { p_user: u })]);
    cache.set(`e|${u}`, { ok: e?.ok !== false, why: e?.why ?? null, role: b?.role, trial: b?.trial_active, fee: Number(b?.deploy_fee ?? 0) } as Gate);
  }
  const g = cache.get(`e|${u}`) as Gate;
  if (g.role === "admin") return null;
  if (!g.ok) return g.why ?? "New trades are paused for this account.";
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  if (!g.trial && (g.fee ?? 0) > 0 && (!s.deploy_paid_until || String(s.deploy_paid_until) < today)) return "Deployment fee due. Recharge the wallet; it is taken automatically.";
  if (s.source_id) {
    if (s._missing) return "This strategy is no longer available from its publisher.";
    // Marketplace strategies need a purchase; Strategy Lab picks are free.
    if (s.listing_id) {
      const { data: p } = await sb.from("purchases").select("id").eq("user_id", u).eq("listing_id", s.listing_id).maybeSingle();
      if (!p) return "This strategy hasn't been bought on this account.";
    }
  }
  return null;
}
