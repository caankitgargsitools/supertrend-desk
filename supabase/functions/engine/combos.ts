// Combinations kept up to date in the background (31 Oct 2026, Papa: "keep on checking").
//
// The Combinations page works out pairs and threes of passed lab strategies (same asset, same timeframe, different
// rules) in the browser. This does the same work on a schedule, so new finds don't wait for someone to open the page:
// every call first checks (cheaply) whether any asset and timeframe has a changed list of passed strategies; when one
// has, its pairs and then its threes are re-checked in instalments (each call about a second of CPU, the position kept
// in lab_combo_groups.cursor). Combinations that lessen the drawdown (opposite sides at least 20% of the time they are
// in a trade together, and a better profit ÷ biggest fall than every member alone) are kept in lab_combos with the time
// they were first seen; ones that no longer qualify are marked not current (never deleted). After the first full check
// of a group (the starting point), newly found ones are notified to the admins. The rules mirror the page's comboEval.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const COMBO_MIN_OPP = 20;
export const COMBO_MAX: Record<number, number> = { 2: 150, 3: 50 };
const CHUNK: Record<number, number> = { 2: 5000, 3: 5000 }; // about 0.1 ms each on real data: ~0.5 s of CPU

type Packed = { e?: string[]; x?: string[]; s?: string[]; n?: number[] } | null;
export type Pool = { id: number; label: string; asset: string; twin_of: number | null; fingerprint: string; config: any; cons: number | null; desk?: boolean; fam?: string };
export type Member = { r: Pool; B: Float64Array; D: Int8Array; exT: Float64Array; exN: Float64Array; first: number | null; last: number | null; m0: number; mv: Float64Array; exY: Int16Array };
export type ComboResult = { ids: number[]; from: number; to: number; years: number; opp: number; together: number; net: number; dd: number; ratio: number;
  alone: { net: number; dd: number; ratio: number; n: number }[]; bestAlone: number; better: boolean; gain: number | null; corr: number | null; yOk: number; yN: number };

/** Lab trade times are "YYYY-MM-DD HH:MM" in IST. */
export function comboTime(v: unknown): number | null {
  const s = String(v ?? "");
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return Date.parse(s + "T00:00:00Z") - 19800000;
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(s)) return Date.parse(s.replace(" ", "T") + "Z") - 19800000;
  const t = Date.parse(s); return Number.isFinite(t) ? t : null;
}
const istIso = (t: number) => new Date(t + 19800000).toISOString();
/** Months numbered from year 0 (IST): one profit figure per calendar month, so months compare by position. */
export const monthNo = (t: number) => { const d = new Date(t + 19800000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
/** The timeframe key the page uses: "D" for once a day, else candle minutes. */
export function tfKey(cfg: any): string { return cfg?.rules?.daily ? "D" : String(cfg?.timeframe_min ?? ""); }
/** Same rules = one family (twins, or the same indicators and conditions with other settings). Mirrors the page. */
export function familyOf(r: Pool): string {
  if (r.twin_of) return "T" + r.twin_of;
  const c = r.config || {}, ru = c.rules || {};
  const sig = (set: any) => ((set && set.conds) || []).map((x: any) => `${x.ind}:${x.op}`).sort().join("+") || "-";
  return [r.asset, ru.daily ? "D" : "I", c.direction, sig(ru.long), sig(ru.short)].join("|");
}
export function prep(r: Pool, tl: Packed): Member {
  const e = tl?.e ?? [], x = tl?.x ?? [], sd = tl?.s ?? [], n = tl?.n ?? [];
  const tr = e.map((en, k) => ({ s: comboTime(en)!, e: comboTime(x[k])!, d: sd[k] === "S" ? -1 : 1, n: Number(n[k]) || 0 }))
    .filter((t) => t.s && t.e && t.e >= t.s).sort((a, b) => a.s - b.s);
  const B: number[] = [], D: number[] = [];
  let last = -Infinity;
  for (const t of tr) { const s = Math.max(t.s, last); if (t.e <= s) continue; B.push(s, t.e); D.push(t.d); last = t.e; }
  const ex = tr.map((t) => [t.e, t.n] as [number, number]).sort((a, b) => a[0] - b[0]);
  const m0 = ex.length ? monthNo(ex[0][0]) : 0, mv = new Float64Array(ex.length ? monthNo(ex[ex.length - 1][0]) - m0 + 1 : 0);
  const exY = new Int16Array(ex.length);
  ex.forEach(([t, v], i) => { const mn = monthNo(t); mv[mn - m0] += v; exY[i] = Math.floor(mn / 12); });
  return { r, B: Float64Array.from(B), D: Int8Array.from(D), exT: Float64Array.from(ex.map((q) => q[0])), exN: Float64Array.from(ex.map((q) => q[1])),
    first: ex.length ? tr[0].s : null, last: ex.length ? ex[ex.length - 1][0] : null, m0, mv, exY };
}
/** Correlation of two strategies' monthly profit over calendar months f..t (a month without trades counts as 0). */
export function monthCorr(a: Member, b: Member, f: number, t: number): number | null {
  const n = t - f + 1;
  if (n < 6) return null;
  const va = (m: number) => { const i = m - a.m0; return i >= 0 && i < a.mv.length ? a.mv[i] : 0; }, vb = (m: number) => { const i = m - b.m0; return i >= 0 && i < b.mv.length ? b.mv[i] : 0; };
  let sx = 0, sy = 0; for (let m = f; m <= t; m++) { sx += va(m); sy += vb(m); }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0; for (let m = f; m <= t; m++) { const x = va(m) - mx, y = vb(m) - my; sxy += x * y; sxx += x * x; syy += y * y; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
/** One combination over the period all members were tested (mirrors the page's comboEval). */
export function evalCombo(ms: Member[]): ComboResult | null {
  const from = Math.max(...ms.map((m) => m.first ?? Infinity)), to = Math.min(...ms.map((m) => m.last ?? -Infinity));
  if (!(to - from > 180 * 86400000)) return null;
  const k = ms.length, p = new Int32Array(k);
  for (let j = 0; j < k; j++) { const B = ms[j].B; let a = 0; while (a < B.length && B[a] <= from) a++; p[j] = a; }
  let t = from, two = 0, opp = 0, anyIn = 0;
  for (;;) {
    let nt = Infinity;
    for (let j = 0; j < k; j++) { const B = ms[j].B; if (p[j] < B.length && B[p[j]] < nt) nt = B[p[j]]; }
    if (nt > to) nt = to;
    let lo = 0, sh = 0;
    for (let j = 0; j < k; j++) if (p[j] & 1) { if (ms[j].D[p[j] >> 1] > 0) lo++; else sh++; }
    const dur = nt - t;
    if (dur > 0) { if (lo + sh) anyIn += dur; if (lo + sh >= 2) { two += dur; if (lo && sh) opp += dur; } }
    if (nt >= to) break;
    for (let j = 0; j < k; j++) { const B = ms[j].B; while (p[j] < B.length && B[p[j]] <= nt) p[j]++; }
    t = nt;
  }
  const q = new Int32Array(k), cum = new Float64Array(k), pk = new Float64Array(k), dd = new Float64Array(k), n = new Int32Array(k);
  for (let j = 0; j < k; j++) { const T = ms[j].exT; let a = 0; while (a < T.length && T[a] < from) a++; q[j] = a; }
  let C = 0, P = 0, DD = 0;
  const yrs = new Map<number, number>();
  for (;;) {
    let jb = -1, tb = Infinity;
    for (let j = 0; j < k; j++) { const T = ms[j].exT; if (q[j] < T.length && T[q[j]] < tb) { tb = T[q[j]]; jb = j; } }
    if (jb < 0 || tb > to) break;
    const y = ms[jb].exY[q[jb]], v = ms[jb].exN[q[jb]++];
    cum[jb] += v; n[jb]++; if (cum[jb] > pk[jb]) pk[jb] = cum[jb]; if (pk[jb] - cum[jb] > dd[jb]) dd[jb] = pk[jb] - cum[jb];
    C += v;
    let more = false; for (let j = 0; j < k; j++) { const T = ms[j].exT; if (q[j] < T.length && T[q[j]] === tb) more = true; }
    if (!more) { if (C > P) P = C; if (P - C > DD) DD = P - C; }
    yrs.set(y, (yrs.get(y) || 0) + v);
  }
  const alone = ms.map((_, j) => ({ net: cum[j], dd: dd[j], n: n[j], ratio: dd[j] ? cum[j] / dd[j] : cum[j] > 0 ? Infinity : 0 }));
  if (alone.some((a) => !a.n)) return null;
  const ratio = DD ? C / DD : C > 0 ? Infinity : 0, bestAlone = Math.max(...alone.map((a) => a.ratio));
  const oppPct = two ? (opp / two) * 100 : 0;
  const mFrom = monthNo(from), mTo = monthNo(to), cors: number[] = [];
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) { const c = monthCorr(ms[a], ms[b], mFrom, mTo); if (c != null) cors.push(c); }
  const yv = [...yrs.values()];
  return { ids: ms.map((m) => m.r.id), from, to, years: (to - from) / (365.25 * 86400000), opp: oppPct, together: two && anyIn ? (two / anyIn) * 100 : 0,
    net: C, dd: DD, ratio, alone, bestAlone, better: ratio > bestAlone && oppPct >= COMBO_MIN_OPP,
    gain: bestAlone > 0 && Number.isFinite(bestAlone) ? (ratio / bestAlone - 1) * 100 : null,
    corr: cors.length ? cors.reduce((s, x) => s + x, 0) / cors.length : null, yOk: yv.filter((v) => v > 0).length, yN: yv.length };
}
/** Every pair (or three) of different families, in a fixed order, from position `start`. */
export function* combosOf(fams: string[], size: number, start = 0): Generator<number[]> {
  let i = 0;
  const n = fams.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    if (fams[a] === fams[b]) continue;
    if (size === 2) { if (i++ >= start) yield [a, b]; continue; }
    for (let c = b + 1; c < n; c++) { if (fams[c] === fams[a] || fams[c] === fams[b]) continue; if (i++ >= start) yield [a, b, c]; }
  }
}
export const comboKey = (size: number, ids: number[]) => `${size}:${[...ids].sort((a, b) => a - b).join("+")}`;
function hash(s: string): string { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const fin = (v: number) => (Number.isFinite(v) ? +v.toFixed(4) : null);

/** One instalment of background checking. */
export async function runCombos(sb: SupabaseClient, budgetMs = 900): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  // 1. What each asset and timeframe holds now (small columns only).
  const light: { id: number; asset: string; tf: number | null; daily: boolean | null }[] = [];
  for (let from = 0; from < 30000; from += 1000) {
    const { data, error } = await sb.from("lab_results").select("id, asset, tf:config->timeframe_min, daily:config->rules->daily").eq("passed", true).is("superseded_by", null).eq("robust_status", "done").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    light.push(...(data ?? []) as any); if ((data ?? []).length < 1000) break;
  }
  if (Date.now() - t0 > 3000) return { skipped: "database slow" };
  const groups = new Map<string, number[]>();
  for (const r of light) { const k = `${r.asset}|${r.daily ? "D" : String(r.tf)}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r.id); }
  const { data: rows } = await sb.from("lab_combo_groups").select("*");
  const state = new Map((rows ?? []).map((g: any) => [`${g.asset}|${g.tf}|${g.size}`, g]));
  // 2. Pick one piece of work: an unfinished pass first, then a group whose list changed.
  let pick: { asset: string; tf: string; size: number; sig: string; row: any } | null = null;
  for (const size of [2, 3]) for (const [k, ids] of groups) {
    if (ids.length < size) continue;
    const [asset, tf] = k.split("|"), sig = hash(ids.sort((a, b) => a - b).join(",")), row = state.get(`${k}|${size}`);
    if (row && row.state === "working") { pick = { asset, tf, size, sig, row }; break; }
    if (!pick && (!row || row.sig !== sig)) pick = { asset, tf, size, sig, row };
  }
  if (!pick) return { idle: true, groups: groups.size };
  const { asset, tf, size } = pick;
  const fresh = !pick.row || pick.row.state !== "working" || pick.row.sig !== pick.sig;
  const g = fresh ? { asset, tf, size, sig: pick.sig, cursor: 0, pass_started: new Date().toISOString(), state: "working", baseline_at: pick.row?.baseline_at ?? null, found: 0, checked: 0 } : { ...pick.row };
  // 3. The strategies to combine: the best of each rule family, plus those on an admin's desk (as the page does).
  const pool: Pool[] = [];
  for (let from = 0; from < 5000; from += 500) {
    const { data, error } = await sb.from("lab_results").select("id, label, asset, twin_of, fingerprint, config, cons:robust_list->consistency->score")
      .eq("passed", true).is("superseded_by", null).eq("robust_status", "done").eq("asset", asset).order("id").range(from, from + 499);
    if (error) throw new Error(error.message);
    pool.push(...((data ?? []) as any[]).filter((r) => tfKey(r.config) === tf)); if ((data ?? []).length < 500) break;
  }
  const { data: admins } = await sb.from("profiles").select("user_id").eq("role", "admin");
  const adminIds = (admins ?? []).map((a: any) => a.user_id);
  const { data: desk } = adminIds.length ? await sb.from("algo_strategies").select("lab_id").in("owner_id", adminIds).eq("archived", false).not("lab_id", "is", null) : { data: [] };
  const deskIds = [...new Set((desk ?? []).map((d: any) => Number(d.lab_id)))];
  const deskFp = new Set<string>();
  for (let i = 0; i < deskIds.length; i += 150) {
    const { data } = await sb.from("lab_results").select("fingerprint").in("id", deskIds.slice(i, i + 150));
    for (const r of data ?? []) deskFp.add((r as any).fingerprint);
  }
  const fam = new Map<string, Pool[]>();
  for (const r of pool) { r.cons = r.cons == null ? null : Number(r.cons); r.desk = deskFp.has(r.fingerprint); r.fam = familyOf(r); if (!fam.has(r.fam)) fam.set(r.fam, []); fam.get(r.fam)!.push(r); }
  const best = [...fam.values()].map((xs) => xs.sort((a, b) => (b.cons ?? 0) - (a.cons ?? 0) || a.id - b.id)[0]).sort((a, b) => (b.cons ?? 0) - (a.cons ?? 0) || a.id - b.id);
  const use = best.slice(0, COMBO_MAX[size]);
  for (const r of pool) if (r.desk && !use.includes(r)) use.push(r);
  use.sort((a, b) => a.id - b.id); // a fixed order, so the position carries over from call to call
  const ms: Member[] = [];
  for (let i = 0; i < use.length; i += 25) {
    const { data, error } = await sb.from("lab_results").select("id, trades_long").in("id", use.slice(i, i + 25).map((r) => r.id));
    if (error) throw new Error(error.message);
    const by = new Map((data ?? []).map((d: any) => [d.id, d.trades_long]));
    for (const r of use.slice(i, i + 25)) { const m = prep(r, by.get(r.id)); if (m.exT.length >= 10) ms.push(m); }
  }
  // 4. This instalment.
  const fams = ms.map((m) => m.r.fam!), found: any[] = [];
  let done = 0, finished = true;
  const now = new Date().toISOString(), loop0 = Date.now(); // the time guard counts the work only, not the reads
  for (const set of combosOf(fams, size, Number(g.cursor) || 0)) {
    if (done >= CHUNK[size] || Date.now() - loop0 > budgetMs) { finished = false; break; }
    done++;
    const e = evalCombo(set.map((j) => ms[j]));
    if (!e || !e.better) continue;
    found.push({ key: comboKey(size, e.ids), asset, tf, size, ids: [...e.ids].sort((a, b) => a - b), labels: ms.length ? set.map((j) => ({ id: ms[j].r.id, label: ms[j].r.label, dir: ms[j].r.config?.direction ?? null })) : [],
      opp: fin(e.opp), together: fin(e.together), net: Math.trunc(e.net), dd: Math.trunc(e.dd), ratio: fin(e.ratio), best_alone: fin(e.bestAlone), gain: e.gain == null ? null : fin(e.gain),
      corr: e.corr == null ? null : fin(e.corr), y_ok: e.yOk, y_n: e.yN, years: fin(e.years), from_t: new Date(e.from).toISOString(), to_t: new Date(e.to).toISOString(),
      alone: e.alone.map((a, j) => ({ id: e.ids[j], net: Math.trunc(a.net), dd: Math.trunc(a.dd), ratio: fin(a.ratio), n: a.n })), current: true, checked_at: now });
  }
  for (let i = 0; i < found.length; i += 200) {
    const { error } = await sb.from("lab_combos").upsert(found.slice(i, i + 200), { onConflict: "key" });
    if (error) throw new Error(error.message);
  }
  g.cursor = Number(g.cursor || 0) + done; g.checked = Number(g.checked || 0) + done; g.found = Number(g.found || 0) + found.length;
  g.members = ms.length; g.families = new Set(fams).size;
  let newOnes = 0;
  if (finished) {
    // The pass is complete: anything of this group not seen in it no longer qualifies (kept, marked not current).
    await sb.from("lab_combos").update({ current: false }).eq("asset", asset).eq("tf", tf).eq("size", size).eq("current", true).lt("checked_at", g.pass_started);
    if (g.baseline_at) {
      const { count } = await sb.from("lab_combos").select("key", { count: "exact", head: true }).eq("asset", asset).eq("tf", tf).eq("size", size).eq("current", true).gte("first_seen", g.pass_started);
      newOnes = count ?? 0;
      if (newOnes) for (const u of adminIds) await sb.rpc("notify_tagged", { p_user: u, p_kind: "lab",
        p_title: `${newOnes} new ${size === 2 ? "pair" : "three"}${newOnes === 1 ? "" : "s"} that lessen the drawdown · ${asset} ${tf === "D" ? "daily" : tf + "-minute"}`,
        p_body: `The Combinations tab found ${newOnes} new combination${newOnes === 1 ? "" : "s"} of passed strategies on ${asset} (${tf === "D" ? "daily" : tf + "-minute"}) that are on opposite sides at least ${COMBO_MIN_OPP}% of the time together and have a better profit ÷ biggest fall than each one alone. Backtest figures: worth paper trading, not proven.`,
        p_url: "/?combo=1", p_strategy: null, p_tag: `combos-${asset}-${tf}-${size}-${g.pass_started}` });
    } else g.baseline_at = new Date().toISOString();
    g.state = "done"; g.done_at = new Date().toISOString(); g.cursor = 0;
  }
  const { error: ge } = await sb.from("lab_combo_groups").upsert({ asset, tf, size, sig: g.sig, cursor: g.cursor, pass_started: g.pass_started, state: g.state, done_at: g.done_at ?? null,
    baseline_at: g.baseline_at ?? null, members: g.members, families: g.families, checked: g.checked, found: g.found, updated_at: new Date().toISOString() }, { onConflict: "asset,tf,size" });
  if (ge) throw new Error(ge.message);
  return { asset, tf, size, checked: done, found: found.length, finished, newOnes, ms: Date.now() - t0 };
}
