// Chart data for the Supertrend Desk website: OHLC candles for any Dhan instrument,
// timeframe and date range, plus the live price. Only the signed-in desk owner may call it.
import { createClient } from "npm:@supabase/supabase-js@2";
import { Dhan } from "./dhan.ts";
import { addDays, aggregate, type DayBar, isCommodity, isCrypto, ist, partialDay, pickBaseInterval, sessionFor } from "./logic.ts";
import { loadCrypto } from "./crypto.ts";
import { dataSecurity } from "./instruments.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const service = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Longest span per timeframe, in calendar days (keeps responses fast and inside Dhan's limits).
function maxDays(tf: string): number {
  if (tf === "D") return 3660;
  if (tf === "W") return 7320;
  const n = Number(tf);
  return n <= 1 ? 31 : n <= 3 ? 92 : n <= 10 ? 184 : n <= 30 ? 366 : n <= 125 ? 731 : 1095;
}

const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const fmtIst = (sec: number) => { const d = new Date((sec + 19800) * 1000).toISOString(); return `${d.slice(0, 10)} ${d.slice(11, 19)}`; };

function mondayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((wd + 6) % 7));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const user = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: owner, error: ownErr } = await user.rpc("is_owner");
    if (ownErr || owner !== true) return reply(403, { error: "Sign in with the desk owner account." });

    const b = await req.json().catch(() => ({}));
    const sec = String(b.sec ?? "").trim(), seg = String(b.seg ?? ""), instr = String(b.instr ?? "");
    const tf = String(b.tf ?? "");
    if (!/^(\d{1,10}|[A-Z][A-Z0-9]{1,19})$/.test(sec) || !/^[A-Z_]{3,12}$/.test(seg) || !/^[A-Z]{3,10}$/.test(instr)) return reply(400, { error: "Pick a valid instrument." });
    if (!(tf === "D" || tf === "W" || (/^\d{1,3}$/.test(tf) && Number(tf) >= 1 && Number(tf) <= 375))) return reply(400, { error: "Unsupported timeframe." });
    const nowSec = Date.now() / 1000, today = ist(nowSec).date;
    let to = isDate(b.to) ? b.to : today; if (to > today) to = today;
    let from = isDate(b.from) ? b.from : addDays(to, -30);
    if (from > to) return reply(400, { error: "The start date is after the end date." });
    const span = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (span > maxDays(tf)) from = addDays(to, -maxDays(tf));

    // Crypto (Delta Exchange) prices are public; everything else is read with the Dhan connection.
    const cr = isCrypto(seg);
    if (cr) await loadCrypto(service);
    const { data: set } = cr ? { data: { dhan_client_id: "-", dhan_access_token: "-" } } : await service.from("portal_settings").select("dhan_client_id, dhan_access_token").single();
    if (!set?.dhan_client_id || !set?.dhan_access_token) return reply(400, { error: "Add your Dhan client ID and access token under Dhan connection." });
    const dhan = new Dhan(set.dhan_client_id, set.dhan_access_token);

    const now = ist(nowSec);
    const sess = sessionFor(seg, today);
    const marketOpen = cr ? now.min >= sess.open : now.wd >= 1 && now.wd <= 5 && now.min >= sess.open && now.min <= sess.close + 5;
    // Commodities: candles come from the current near-month contract (daily history is Dhan's continuous series).
    const resolved = await dataSecurity(service, { client: set.dhan_client_id, token: set.dhan_access_token }, seg, sec, today);
    const secId = resolved.sec;
    const wantLive = to === today && marketOpen;
    let bars: { t: number; o: number; h: number; l: number; c: number }[] = [];

    if (tf === "D" || tf === "W") {
      const daily: DayBar[] = await dhan.daily(secId, seg, instr, tf === "W" ? mondayOf(from) : from, addDays(to, 1));
      // Crypto: Delta's own daily candle for today is already live (its day starts 05:30 IST).
      let days = cr ? daily : daily.filter((d) => d.day < today || !wantLive);
      if (wantLive && !cr) {
        const intr = await dhan.intraday(secId, seg, instr, 1, `${today} 09:00:00`, fmtIst(nowSec + 60));
        const part = partialDay(intr.filter((r) => ist(r.t).date === today), today);
        const existing = daily.find((d) => d.day === today);
        if (part) days.push({ ...part, t: existing?.t ?? Date.parse(`${today}T00:00:00+05:30`) / 1000 });
        else if (existing) days.push(existing);
      }
      days = days.filter((d) => d.day >= (tf === "W" ? mondayOf(from) : from));
      if (tf === "D") bars = days.map(({ t, o, h, l, c }) => ({ t, o, h, l, c }));
      else {
        const weeks = new Map<string, { t: number; o: number; h: number; l: number; c: number }>();
        for (const d of days) {
          const k = mondayOf(d.day);
          const w = weeks.get(k);
          if (!w) weeks.set(k, { t: d.t, o: d.o, h: d.h, l: d.l, c: d.c });
          else { w.h = Math.max(w.h, d.h); w.l = Math.min(w.l, d.l); w.c = d.c; }
        }
        bars = [...weeks.values()];
      }
    } else {
      const n = Number(tf);
      const base = pickBaseInterval(n);
      const raw = [];
      for (let a = from; a <= to; a = addDays(a, 86)) {
        const z = addDays(a, 85) < to ? addDays(a, 85) : to;
        raw.push(...await dhan.intraday(secId, seg, instr, base, `${a} 09:00:00`, z === today ? fmtIst(nowSec + 60) : `${z} 23:59:00`));
      }
      const seen = new Set<number>();
      const uniq = raw.filter((r) => (seen.has(r.t) ? false : (seen.add(r.t), true))).sort((x, y) => x.t - y.t);
      bars = aggregate(uniq, n, seg).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
    }

    let ltp: number | null = null;
    if (wantLive && bars.length) {
      try { ltp = await dhan.ltp(seg, secId); } catch { ltp = null; }
      if (ltp && ltp > 0) {
        let last = bars[bars.length - 1];
        if (tf !== "D" && tf !== "W" && now.min >= sess.open && now.min < sess.close) {
          const n = Number(tf);
          const bucket = Date.parse(`${today}T00:00:00+05:30`) / 1000 + (sess.open + Math.floor((now.min - sess.open) / n) * n) * 60;
          if (last.t < bucket) { last = { t: bucket, o: ltp, h: ltp, l: ltp, c: ltp }; bars.push(last); }
        }
        last.c = ltp; last.h = Math.max(last.h, ltp); last.l = Math.min(last.l, ltp);
      }
    }
    return reply(200, { bars, from, to, live: wantLive, ltp, fetched_at: new Date().toISOString(),
      contract: resolved.contract ? { name: resolved.contract.display, expiry: resolved.contract.expiry } : null,
      session: sess, commodity: isCommodity(seg), crypto: cr });
  } catch (e) {
    return reply(502, { error: e instanceof Error ? e.message : String(e) });
  }
});
