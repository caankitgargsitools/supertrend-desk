// One-time owner account creation for the Supertrend Desk website.
// Creates a confirmed login for the invited email only, and only while no owner exists.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  let email = "", password = "";
  try { ({ email, password } = await req.json()); } catch { return reply(400, { error: "Send email and password." }); }
  email = String(email ?? "").trim().toLowerCase();
  password = String(password ?? "");

  const { count } = await sb.from("app_owner").select("*", { count: "exact", head: true });
  if ((count ?? 0) > 0) return reply(409, { error: "The owner account already exists. Sign in instead." });

  const { data: invite } = await sb.from("owner_invite").select("email").single();
  if (!invite || email !== String(invite.email).toLowerCase()) {
    await new Promise((r) => setTimeout(r, 800));
    return reply(403, { error: "This email isn't the invited owner email for this desk." });
  }
  if (password.length < 10) return reply(400, { error: "Use a password of at least 10 characters." });

  // Remove a stray unconfirmed sign-up with the same email, if any.
  const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list?.users.find((u) => (u.email ?? "").toLowerCase() === email);
  if (existing) await sb.auth.admin.deleteUser(existing.id);

  const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) return reply(500, { error: error?.message ?? "Couldn't create the account." });

  const { error: ownErr } = await sb.from("app_owner").insert({ id: true, user_id: data.user.id });
  if (ownErr) return reply(500, { error: ownErr.message });
  return reply(200, { ok: true });
});
