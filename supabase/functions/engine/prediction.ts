// Prediction Lab (27 Oct 2026). Kronos-mini runs on Papa's AWS server (predictor/); the engine only feeds it and
// stores what it sends back:
//  pred_feed – every 5 minutes in market hours: the last days of 5-minute candles of every Dhan asset (indices; MCX on
//              the current contract) into pred_bars. Crypto candles the server takes itself from Binance (public).
//  pred_pull – the server's read: settings, the asset list, signed links to the lab's candle files (history), the live
//              bars and the holidays. Public market data only.
//  pred_push – the server's write: its heartbeat, the latest forecast per asset and timeframe, and per-month totals.
// The server authenticates with its own key (x-pred-key; only its sha256 is stored, pred_create_key), which opens these
// two actions and nothing else.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Dhan } from "./dhan.ts";
import { addDays, ist, setHolidays, tradingSession } from "./logic.ts";
import { LAB_ASSETS } from "./lab.ts";
import { CRYPTO } from "./crypto.ts";
import { candleLinks } from "./candles.ts";

const TFS = new Set([5, 15, 30, 60, 240, 1440]);

async function sha256(s: string): Promise<string> {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
/** True when the key matches the stored hash (a missing hash or key never matches). */
export async function predKeyOk(sb: SupabaseClient, key: string | null): Promise<boolean> {
  if (!key || key.length < 20) return false;
  const { data } = await sb.from("pred_settings").select("key_hash").eq("id", 1).maybeSingle();
  return !!data?.key_hash && (await sha256(key)) === data.key_hash;
}

/** The MCX contract the live feed follows: the nearest one that doesn't expire within 5 days (volume moves before). */
async function mcxContract(sb: SupabaseClient, underlying: string, today: string): Promise<string | null> {
  const { data } = await sb.from("mcx_contracts").select("sec_id, expiry").eq("underlying", underlying).gt("expiry", addDays(today, 5)).order("expiry").limit(1);
  return data?.[0]?.sec_id ? String(data[0].sec_id) : null;
}

/** Live 5-minute candles for every Dhan asset whose market is open (or closed in the last 15 minutes). */
export async function predFeed(sb: SupabaseClient, creds: { client: string; token: string }, nowSec = Date.now() / 1000) {
  const { data: set } = await sb.from("pred_settings").select("enabled").eq("id", 1).maybeSingle();
  if (!set?.enabled) return { skipped: "switched off" };
  // Nobody to feed: the server hasn't reported for 30 minutes (or ever), so Dhan isn't asked.
  const { data: w } = await sb.from("pred_worker").select("last_seen").eq("id", 1).maybeSingle();
  if (!w?.last_seen || nowSec * 1000 - Date.parse(w.last_seen) > 30 * 60000) return { skipped: "server not connected" };
  const now = ist(nowSec), today = now.date;
  const { data: hol } = await sb.from("market_holidays").select("day, exch, opens_at").eq("day", today);
  setHolidays(hol ?? []);
  const dhan = new Dhan(creds.client, creds.token);
  const done: string[] = [], errors: Record<string, string> = {};
  for (const a of Object.values(LAB_ASSETS)) {
    if (a.crypto) continue;
    const s = tradingSession(a.seg, today);
    if (!(now.min >= s.open && now.min <= s.close + 15)) continue;
    try {
      const sec = a.commodity ? await mcxContract(sb, a.sec, today) : a.sec;
      if (!sec) { errors[a.key] = "no current contract"; continue; }
      const rows = (await dhan.intraday(sec, a.seg, a.instr, 5, `${addDays(today, -4)} 09:00:00`, `${today} 23:59:00`))
        .filter((r) => r.t + 300 <= nowSec).sort((x, y) => x.t - y.t); // finished candles only
      if (!rows.length) continue;
      const bars = { t: rows.map((r) => r.t), o: rows.map((r) => r.o), h: rows.map((r) => r.h), l: rows.map((r) => r.l), c: rows.map((r) => r.c) };
      const { error } = await sb.from("pred_bars").upsert({ asset: a.key, contract: a.commodity ? sec : null, bars, updated_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
      done.push(a.key);
    } catch (e) {
      errors[a.key] = String((e as Error)?.message ?? e).slice(0, 120);
      if (/token|401|DH-901|DH-902/i.test(String(e))) break; // the token is the problem for all of them
    }
  }
  return { fed: done.length, assets: done, errors };
}

/** The server's read. `files`: signed links to every asset's candle history (asked for once a day). */
export async function predPull(sb: SupabaseClient, body: { files?: boolean }) {
  const { data: set } = await sb.from("pred_settings").select("enabled, model, tfs, horizon, lookback, replay_from, samples").eq("id", 1).maybeSingle();
  const today = ist(Date.now() / 1000).date;
  const assets = Object.values(LAB_ASSETS).map((a) => ({
    key: a.key, name: a.name, seg: a.seg, crypto: !!a.crypto, commodity: a.commodity,
    binance: a.crypto ? CRYPTO[a.sec]?.history_symbol ?? null : null,
  })).filter((a) => !a.crypto || a.binance);
  const { data: bars } = await sb.from("pred_bars").select("asset, contract, bars, updated_at");
  const { data: hol } = await sb.from("market_holidays").select("day, exch, opens_at").gte("day", String(set?.replay_from ?? "2025-09-01")).lte("day", addDays(today, 60));
  const files: Record<string, unknown> = {};
  if (body.files) for (const a of assets) if (!a.crypto) files[a.key] = await candleLinks(sb, a.key).catch(() => []);
  const settings = set ? { enabled: set.enabled, model: set.model, tfs: set.tfs, horizon: set.horizon, lookback: set.lookback, replay_from: set.replay_from, samples: set.samples ?? null } : null;
  return { settings, assets, bars: bars ?? [], holidays: hol ?? [], files: body.files ? files : undefined, server_time: new Date().toISOString() };
}

const num = (x: unknown) => { const v = Number(x); return Number.isFinite(v) ? v : 0; };
/** Confidence bands {lo, mid, hi: [calls, right]}; anything else is dropped. */
const confOf = (c: any) => c && typeof c === "object" ? Object.fromEntries(["lo", "mid", "hi"].map((k) => [k, [Math.trunc(num(c[k]?.[0])), Math.trunc(num(c[k]?.[1]))]])) : null;
/** The server's write: heartbeat, latest forecasts, monthly totals (whole-month figures, so a resend is harmless). */
export async function predPush(sb: SupabaseClient, body: { worker?: any; latest?: any[]; stats?: any[] }) {
  const out: Record<string, number> = {};
  if (body.worker) {
    const w = body.worker;
    const { error } = await sb.from("pred_worker").upsert({ id: 1, last_seen: new Date().toISOString(), version: String(w.version ?? "").slice(0, 40),
      status: String(w.status ?? "").slice(0, 200), detail: w.detail ?? null, error: w.error ? String(w.error).slice(0, 500) : null });
    if (error) throw new Error(error.message);
  }
  const latest = (body.latest ?? []).slice(0, 400).filter((r) => LAB_ASSETS[r.asset] && TFS.has(Number(r.tf)) && Array.isArray(r.path));
  if (latest.length) {
    const { error } = await sb.from("pred_latest").upsert(latest.map((r) => ({ asset: r.asset, tf: Number(r.tf), made_at: new Date(num(r.made_at) * 1000).toISOString(),
      last_close: num(r.last_close), path: r.path.slice(0, 20), actual: Array.isArray(r.actual) ? r.actual.slice(-300) : null, recent: Array.isArray(r.recent) ? r.recent.slice(-60) : null, updated_at: new Date().toISOString() })));
    if (error) throw new Error(error.message);
    out.latest = latest.length;
  }
  const stats = (body.stats ?? []).slice(0, 6000).filter((r) => LAB_ASSETS[r.asset] && TFS.has(Number(r.tf)) && Number(r.h) >= 1 && Number(r.h) <= 20
    && /^\d{4}-\d{2}$/.test(String(r.month)) && (r.mode === "replay" || r.mode === "live"));
  for (let i = 0; i < stats.length; i += 500) {
    const { error } = await sb.from("pred_stats").upsert(stats.slice(i, i + 500).map((r) => ({ asset: r.asset, tf: Number(r.tf), h: Number(r.h), month: r.month, mode: r.mode,
      n: Math.trunc(num(r.n)), dir_n: Math.trunc(num(r.dir_n)), hit: Math.trunc(num(r.hit)), hit_mom: Math.trunc(num(r.hit_mom)),
      ae_k: num(r.ae_k), ae_flat: num(r.ae_flat), d_sum: num(r.d_sum), d_sq: num(r.d_sq), re_k: num(r.re_k), re_atr: num(r.re_atr), r_sum: num(r.r_sum), r_sq: num(r.r_sq),
      conf: confOf(r.conf), cal_n: Math.trunc(num(r.cal_n)), hit_cal: Math.trunc(num(r.hit_cal)),
      updated_at: new Date().toISOString() })));
    if (error) throw new Error(error.message);
  }
  out.stats = stats.length;
  return out;
}
