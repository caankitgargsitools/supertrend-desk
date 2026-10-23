// Candles without Dhan's candle API: the lab's stored history (daily, 5-minute) plus the desk's own 1-minute candles
// built from the per-second prices (table price_bars). Used by strategy ticks only when Dhan refuses a candle request
// (23 Oct 2026: DH-905 on every /charts call while quotes kept working); the lab keeps to Dhan's own candles.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { aggregate, type DayBar, ist, type Raw, sessionFor } from "./logic.ts";
import { readCandles } from "./candles.ts";
import { LAB_ASSETS } from "./lab.ts";

type Col = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
const rowsOf = (c: Col | null | undefined): Raw[] => c ? c.t.map((t, i) => ({ t, o: c.o[i], h: c.h[i], l: c.l[i], c: c.c[i], v: 0 })) : [];
const istSec = (s: string) => Date.parse(`${s.slice(0, 10)}T${s.length > 10 ? s.slice(11, 19) : "00:00:00"}+05:30`) / 1000;

/** The lab asset an instrument belongs to (indices by security ID, MCX contracts by their underlying). */
const assetMemo = new Map<string, string | null>();
async function assetKey(sb: SupabaseClient, seg: string, sec: string): Promise<string | null> {
  const k = `${seg}|${sec}`;
  if (assetMemo.has(k)) return assetMemo.get(k)!;
  let key: string | null = Object.values(LAB_ASSETS).find((a) => a.seg === seg && String(a.sec) === sec)?.key ?? null;
  if (!key && /^\d+$/.test(sec)) {
    const { data } = await sb.from("mcx_contracts").select("underlying").eq("sec_id", sec).maybeSingle();
    key = data?.underlying && LAB_ASSETS[data.underlying] ? data.underlying : null;
  }
  assetMemo.set(k, key);
  return key;
}

/** Stored candles of an asset, kept in memory for 20 minutes (the files change only when the lab refreshes them). */
const storeMemo = new Map<string, { at: number; d: Raw[]; dTo: string; i5: Raw[]; i5To: string }>();
async function stored(sb: SupabaseClient, key: string) {
  const hit = storeMemo.get(key);
  if (hit && Date.now() - hit.at < 20 * 60000) return hit;
  const sets = await readCandles(sb, key, ["D", "I5"]);
  const d = sets.find((x) => x.kind === "D"), i5 = sets.find((x) => x.kind === "I5");
  const v = { at: Date.now(), d: rowsOf(d?.bars), dTo: d?.to_day ?? "", i5: rowsOf(i5?.bars), i5To: i5?.to_day ?? "" };
  storeMemo.set(key, v);
  return v;
}

/** The desk's own 1-minute candles of one instrument between two times (epoch seconds, both inclusive). */
async function ownMinutes(sb: SupabaseClient, seg: string, sec: string, from: number, to: number): Promise<Raw[]> {
  const out: Raw[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await sb.from("price_bars").select("t, o, h, l, c").eq("seg", seg).eq("sec", sec)
      .gte("t", from).lte("t", to).order("t").range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.push({ t: Number(r.t), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: 0 });
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/**
 * Intraday candles of `interval` minutes (anchored to the session open, as Dhan's), from stored 5-minute candles and
 * own minutes. null = an instrument without stored candles (Dhan's error stands); a range with no candles is empty, as
 * Dhan answers for days before its history.
 */
export async function ownIntraday(sb: SupabaseClient, sec: string, seg: string, interval: number, fromDate: string, toDate: string): Promise<Raw[] | null> {
  const from = istSec(fromDate), to = istSec(toDate);
  const key = await assetKey(sb, seg, sec);
  if (!key) return null;
  const hist = interval % 5 === 0 ? (await stored(sb, key)).i5.filter((r) => r.t >= from && r.t <= to) : [];
  const after = hist.length ? hist[hist.length - 1].t + 300 : from;
  const own = await ownMinutes(sb, seg, sec, after, to);
  return aggregate([...hist, ...own], interval, seg).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: 0 }));
}

/** Daily candles (toDate exclusive): stored daily candles, then days built from stored 5-minute candles and own minutes. */
export async function ownDaily(sb: SupabaseClient, sec: string, seg: string, fromDate: string, toDate: string): Promise<DayBar[] | null> {
  const key = await assetKey(sb, seg, sec);
  if (!key) return null;
  const st = await stored(sb, key);
  const out: DayBar[] = st.d.map((r) => ({ ...r, day: ist(r.t).date })).filter((r) => r.day >= fromDate && r.day < toDate);
  const lastDay = out.length ? out[out.length - 1].day : st.dTo;
  const days = new Map<string, DayBar>();
  const add = (r: Raw) => {
    const p = ist(r.t), s = sessionFor(seg, p.date);
    if (p.date <= lastDay || p.date < fromDate || p.date >= toDate || p.min < s.open || p.min >= s.close) return;
    const d = days.get(p.date);
    if (!d) days.set(p.date, { t: istSec(p.date), o: r.o, h: r.h, l: r.l, c: r.c, v: 0, day: p.date });
    else { d.h = Math.max(d.h, r.h); d.l = Math.min(d.l, r.l); d.c = r.c; }
  };
  for (const r of st.i5) add(r);
  const i5End = st.i5.length ? st.i5[st.i5.length - 1].t + 300 : istSec(lastDay || fromDate);
  for (const r of await ownMinutes(sb, seg, sec, i5End, istSec(toDate))) add(r);
  return [...out, ...[...days.values()].sort((a, b) => a.t - b.t)];
}
