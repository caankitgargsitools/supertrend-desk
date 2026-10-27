import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/* ---------- candle storage ---------- */
/**
 * The lab's candles live in file storage (bucket "lab-candles", one gzip file per asset and kind), not in the database:
 * every check reloads several MB of them, which on a small database used up its daily disk allowance and slowed logins.
 * The database keeps only a one-line index entry per file (lab_candles: dates and update time, bars empty). Older
 * entries that still hold their candles in the database are moved to storage the first time they are read.
 */
const CANDLE_BUCKET = "lab-candles";
const candlePath = (asset: string, kind: string) => `${asset}/${kind.replace(/[^A-Za-z0-9_-]/g, "_")}.json.gz`;
async function gzipText(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
async function gunzipText(b: Blob): Promise<string> {
  return await new Response(b.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}
export type CandleSet = { asset: string; kind: string; from_day: string; to_day: string; bars: any; updated_at?: string };
export async function saveCandles(sb: SupabaseClient, row: CandleSet) {
  const body = await gzipText(JSON.stringify(row.bars));
  const { error } = await sb.storage.from(CANDLE_BUCKET).upload(candlePath(row.asset, row.kind), body, { upsert: true, contentType: "application/gzip" });
  if (error) throw new Error(`Couldn't save ${row.asset} ${row.kind} candles: ${error.message}`);
  const { error: e2 } = await sb.from("lab_candles").upsert({ asset: row.asset, kind: row.kind, from_day: row.from_day, to_day: row.to_day, bars: null, stored: true,
    updated_at: row.updated_at ?? new Date().toISOString() });
  if (e2) throw new Error(e2.message);
}
/** Candle sets of an asset: given kinds, or "long" = daily, recent 5/15-minute, funding and every yearly chunk. */
export async function readCandles(sb: SupabaseClient, asset: string, kinds: string[] | "long"): Promise<CandleSet[]> {
  let q = sb.from("lab_candles").select("kind, from_day, to_day, stored, updated_at").eq("asset", asset);
  q = kinds === "long" ? q.or("kind.eq.D,kind.eq.I5,kind.eq.F,kind.like.I5Y*") : q.in("kind", kinds);
  const { data: meta, error } = await q;
  if (error) throw new Error(error.message);
  return await Promise.all((meta ?? []).map(async (m) => {
    if (m.stored) {
      const { data, error: e } = await sb.storage.from(CANDLE_BUCKET).download(candlePath(asset, m.kind));
      if (e || !data) throw new Error(`Couldn't read ${asset} ${m.kind} candles: ${e?.message ?? "missing file"}`);
      return { asset, ...m, bars: JSON.parse(await gunzipText(data)) };
    }
    const { data: old, error: e } = await sb.from("lab_candles").select("bars").eq("asset", asset).eq("kind", m.kind).single();
    if (e) throw new Error(e.message);
    if (old?.bars) await saveCandles(sb, { asset, kind: m.kind, from_day: m.from_day, to_day: m.to_day, bars: old.bars, updated_at: m.updated_at });
    return { asset, ...m, bars: old?.bars };
  }));
}

/** Signed download links (gzip JSON, columns t/o/h/l/c[/v]) for an asset's candle files, for the prediction server. */
export async function candleLinks(sb: SupabaseClient, asset: string, seconds = 3600): Promise<{ kind: string; from_day: string; to_day: string; url: string }[]> {
  const { data: meta, error } = await sb.from("lab_candles").select("kind, from_day, to_day, stored").eq("asset", asset).or("kind.eq.D,kind.eq.I5,kind.like.I5Y*");
  if (error) throw new Error(error.message);
  const rows = (meta ?? []).filter((m) => m.stored);
  if (!rows.length) return [];
  const { data: urls, error: e } = await sb.storage.from(CANDLE_BUCKET).createSignedUrls(rows.map((m) => candlePath(asset, m.kind)), seconds);
  if (e) throw new Error(e.message);
  return rows.map((m, i) => ({ kind: m.kind, from_day: m.from_day, to_day: m.to_day, url: urls?.[i]?.signedUrl ?? "" })).filter((x) => x.url);
}
