// Find Love · edge function skeleton (Deno). Actions: health, match.
// Like the desk's engine: the deployed function is a one-line wrapper importing this file at a pinned commit.
// Auth (to decide with Papa): a user JWT for `match` (the caller must see both cases under RLS); a service secret for jobs.
import { createClient } from "npm:@supabase/supabase-js@2";
import { findCandidates, type CaseLite } from "./match.ts";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: { action?: string; case_id?: number } = {};
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body.action ?? "health";

  if (action === "health") return json({ ok: true, service: "findlove", at: new Date().toISOString() });

  if (action === "match") {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "sign in" }, 401);
    if (!body.case_id) return json({ error: "case_id needed" }, 400);
    // RLS decides what this user may see; the function only ranks what comes back.
    const sb = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const me = await sb.schema("findlove").from("cases").select("id,kind,sex,age_years,age_tol,lat,lon,at").eq("id", body.case_id).maybeSingle();
    if (me.error || !me.data) return json({ error: "case not found" }, 404);
    const others = await sb.schema("findlove").from("cases").select("id,kind,sex,age_years,age_tol,lat,lon,at")
      .neq("kind", me.data.kind).eq("hidden", false).in("status", ["open", "matched"]).limit(1000);
    if (others.error) return json({ error: others.error.message }, 500);
    return json({ candidates: findCandidates(me.data as CaseLite, (others.data ?? []) as CaseLite[]) });
  }

  return json({ error: "unknown action" }, 400);
});
