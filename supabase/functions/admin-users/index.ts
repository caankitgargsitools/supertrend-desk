// Admin-only user management: create a user (email + temporary password), reset a password, delete a user who
// never traded. Called from the site with the admin's session; everything else about users goes through SQL functions.
import { createClient } from "npm:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(jwt);
  const uid = who?.user?.id;
  if (!uid) return out({ error: "Sign in first." }, 401);
  const { data: me } = await admin.from("profiles").select("role, status").eq("user_id", uid).maybeSingle();
  const { data: owner } = await admin.from("app_owner").select("user_id").eq("user_id", uid).maybeSingle();
  if (!((me?.role === "admin" && me?.status === "active") || owner)) return out({ error: "Only the admin can manage users." }, 403);

  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { /* empty */ }
  try {
    if (b.action === "create") {
      const email = String(b.email ?? "").trim().toLowerCase();
      const password = String(b.password ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return out({ error: "Enter a valid email." }, 400);
      if (password.length < 8) return out({ error: "The temporary password needs at least 8 characters." }, 400);
      const { data: c, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: b.full_name ?? null } });
      if (error || !c.user) return out({ error: error?.message ?? "Couldn't create the user." }, 400);
      const { data: bs } = await admin.from("billing_settings").select("trial_days").maybeSingle();
      const days = b.trial_days != null && b.trial_days !== "" ? Number(b.trial_days) : Number(bs?.trial_days ?? 14);
      const trial = days > 0 ? new Date(Date.now() + 19800000 + days * 86400000).toISOString().slice(0, 10) : null;
      const { error: pe } = await admin.from("profiles").insert({
        user_id: c.user.id, email, full_name: b.full_name || null, phone: b.phone || null, role: "user", status: "active",
        trial_until: trial, can_build: b.can_build !== false, note: b.note || null,
      });
      if (pe) { await admin.auth.admin.deleteUser(c.user.id); return out({ error: pe.message }, 400); }
      await admin.from("broker_accounts").upsert({ user_id: c.user.id, broker: "DHAN" }, { onConflict: "user_id,broker" });
      return out({ ok: true, user_id: c.user.id, trial_until: trial });
    }
    if (b.action === "reset_password") {
      const password = String(b.password ?? "");
      if (password.length < 8) return out({ error: "The password needs at least 8 characters." }, 400);
      const { error } = await admin.auth.admin.updateUserById(String(b.user_id), { password });
      return error ? out({ error: error.message }, 400) : out({ ok: true });
    }
    if (b.action === "delete") {
      const id = String(b.user_id);
      if (id === uid) return out({ error: "You can't delete your own account." }, 400);
      const { count } = await admin.from("algo_trades").select("id", { count: "exact", head: true }).eq("user_id", id);
      const { count: w } = await admin.from("wallet_txns").select("id", { count: "exact", head: true }).eq("user_id", id);
      if ((count ?? 0) > 0 || (w ?? 0) > 0) return out({ error: "This user has trades or wallet entries; block the account instead of deleting it." }, 400);
      await admin.from("algo_strategies").delete().eq("owner_id", id);
      const { error } = await admin.auth.admin.deleteUser(id);
      return error ? out({ error: error.message }, 400) : out({ ok: true });
    }
    return out({ error: "Unknown action." }, 400);
  } catch (e) {
    return out({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
