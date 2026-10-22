// Daily self-check of the desk: every strategy's recent paper / live trades are replayed with the backtest engine on the
// stored candles of the same days, and each desk trade is matched with the backtest's trade. A gap (a trade the desk
// missed, an extra trade, a different exit, or a much worse price) points to a fault in the live path (data, timing,
// holidays, stops, orders) rather than to the strategy itself.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { simulateRules, type Plan } from "./backtest.ts";
import { cachedAsset, LAB_ASSETS, refreshAsset } from "./lab.ts";
import { addDays, ist } from "./logic.ts";

export type AuditTrade = {
  side: string; entry_day: string;
  desk: { exit: string; entry_px: number; exit_px: number; pts: number; net: number; why: string } | null;
  bt: { entry: string; exit: string; entry_px: number; exit_px: number | null; pts: number | null; why: string } | null;
  issue: string | null; rupee_gap: number | null;
};
export type AuditResult = {
  strategy_id: string; user_id: string; mode: string; name: string; from_day: string; to_day: string;
  matched: number; missed: number; extra: number; issues: number; desk_pts: number; bt_pts: number; rupee_gap: number;
  verdict: "ok" | "gap" | "skipped"; note: string; trades: AuditTrade[];
};

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const stamp = (day: string, min: number) => `${day} ${hm(min)}`;
/** Minutes between two IST "day + minute of day" points. */
const gapMin = (d1: string, m1: number, d2: string, m2: number) => Math.abs((Date.parse(`${d1}T00:00:00Z`) - Date.parse(`${d2}T00:00:00Z`)) / 60000 + m1 - m2);

type DeskRow = { id: number; side: string; entry_day: string; exit_at: string; entry_px: number; exit_px: number; units: number; net: number; exit_why: string | null };

/** Pure matching of desk trades with backtest plans (exported for tests). */
export function matchTrades(desk: DeskRow[], plans: Plan[], opts: { daily: boolean; tf: number; options: boolean; today: string }) {
  const used = new Set<number>();
  const out: AuditTrade[] = [];
  // Exit tolerance: one decision candle (at least 15 minutes); daily strategies: the same day.
  const tol = Math.max(15, opts.tf);
  for (const p of plans) {
    const open = /Still open at end of test/.test(p.exitWhy);
    const dir = p.side === "LONG" ? 1 : -1;
    const btPts = p.spotOut != null && !open ? (p.spotOut - p.spotIn) * dir : null;
    const bt = { entry: stamp(p.entryDay, p.entryMin), exit: open ? "still open" : stamp(p.exitDay, p.exitMin), entry_px: +p.spotIn.toFixed(2), exit_px: p.spotOut == null ? null : +p.spotOut.toFixed(2), pts: btPts == null ? null : +btPts.toFixed(2), why: open ? "Still open" : p.exitWhy };
    // Same side, entered the same day; of several, the one whose exit is closest.
    const cands = desk.filter((d) => !used.has(d.id) && d.side === p.side && d.entry_day === p.entryDay);
    if (!cands.length) {
      if (open) continue; // the desk may still be holding it; checked against the open position elsewhere
      out.push({ side: p.side, entry_day: p.entryDay, desk: null, bt, issue: "Backtest took this trade; the desk did not", rupee_gap: null });
      continue;
    }
    const ex = (d: DeskRow) => { const e = ist(Date.parse(d.exit_at) / 1000); return { day: e.date, min: e.min }; };
    const best = cands.reduce((a, b) => {
      if (open) return a;
      const ea = ex(a), eb = ex(b);
      return gapMin(eb.day, eb.min, p.exitDay, p.exitMin) < gapMin(ea.day, ea.min, p.exitDay, p.exitMin) ? b : a;
    });
    used.add(best.id);
    const e = ex(best);
    const dPts = (Number(best.exit_px) - Number(best.entry_px)) * dir;
    const deskInfo = { exit: stamp(e.day, e.min), entry_px: Number(best.entry_px), exit_px: Number(best.exit_px), pts: +dPts.toFixed(2), net: Math.trunc(Number(best.net)), why: best.exit_why ?? "" };
    let issue: string | null = null, rupee: number | null = null;
    if (open) issue = "Desk closed it; the backtest is still holding it";
    else {
      const late = opts.daily ? (e.day !== p.exitDay ? Math.round(gapMin(e.day, 0, p.exitDay, 0) / 1440) * 1440 : 0) : gapMin(e.day, e.min, p.exitDay, p.exitMin);
      if (late > (opts.daily ? 0 : tol)) issue = `Exit differs: desk ${deskInfo.exit}, backtest ${bt.exit}`;
      if (!opts.options && btPts != null) {
        rupee = Math.trunc((dPts - btPts) * Number(best.units));
        // Points gap beyond 0.25% of the price: slippage alone doesn't explain it.
        if (!issue && Math.abs(dPts - btPts) > p.spotIn * 0.0025) issue = `Price gap: desk ${dPts.toFixed(1)} pts, backtest ${btPts.toFixed(1)} pts`;
      }
    }
    out.push({ side: p.side, entry_day: p.entryDay, desk: deskInfo, bt, issue, rupee_gap: rupee });
  }
  for (const d of desk) {
    if (used.has(d.id)) continue;
    const e = ist(Date.parse(d.exit_at) / 1000);
    out.push({ side: d.side, entry_day: d.entry_day, desk: { exit: stamp(e.date, e.min), entry_px: Number(d.entry_px), exit_px: Number(d.exit_px), pts: +((Number(d.exit_px) - Number(d.entry_px)) * (d.side === "LONG" ? 1 : -1)).toFixed(2), net: Math.trunc(Number(d.net)), why: d.exit_why ?? "" },
      bt: null, issue: "Desk took this trade; the backtest did not", rupee_gap: null });
  }
  out.sort((a, b) => a.entry_day.localeCompare(b.entry_day));
  return out;
}

/** Self-check of one strategy over its trades of the last `days` days. */
export async function auditStrategy(sb: SupabaseClient, creds: { client: string; token: string }, s: Record<string, any>, mode: "PAPER" | "LIVE", days: number, today: string): Promise<AuditResult | null> {
  const since = addDays(today, -days);
  const { data: rows } = await sb.from("algo_trades").select("id, side, entry_day, exit_at, entry_px, exit_px, units, net, exit_why")
    .eq("strategy_id", s.id).eq("mode", mode).eq("hidden", false).gte("entry_day", since).order("exit_at");
  const desk = (rows ?? []) as DeskRow[];
  if (!desk.length) return null;
  const base: AuditResult = { strategy_id: s.id, user_id: s.owner_id, mode, name: s.name, from_day: desk[0].entry_day, to_day: today, matched: 0, missed: 0, extra: 0, issues: 0,
    desk_pts: 0, bt_pts: 0, rupee_gap: 0, verdict: "skipped", note: "", trades: [] };
  if (!s.rules || s.strategy_kind !== "RULES") return { ...base, note: "Only rule-based (lab) strategies are replayed so far." };
  const key = String(s.underlying);
  if (!LAB_ASSETS[key]) return { ...base, note: `No stored candles for ${key}.` };
  try { await refreshAsset(sb, creds, key, today, 3); } catch (e) { console.error("audit refresh", key, e); }
  const data = await cachedAsset(sb, key);
  const lastDay = data.raw.at(-1)?.day ?? data.daily.at(-1)?.day ?? "";
  // The backtest starts flat on the desk's first trade day, as the desk did.
  const from = base.from_day;
  const plans = simulateRules(s, data, from, today).filter((p) => p.entryDay >= from && p.entryDay <= lastDay);
  const deskIn = desk.filter((d) => d.entry_day <= lastDay);
  const trades = matchTrades(deskIn, plans, { daily: !!s.rules.daily, tf: Number(s.timeframe_min) || 15, options: s.trade_type === "OPTIONS", today });
  // The open position: the desk's against the backtest's.
  const btOpen = plans.find((p) => /Still open at end of test/.test(p.exitWhy));
  const deskOpen = s.position && s.position !== "FLAT" && !!s.live === (mode === "LIVE") ? String(s.position) : "FLAT";
  const btOpenSide = btOpen ? btOpen.side : "FLAT";
  let openNote = "";
  if (deskOpen !== btOpenSide) {
    openNote = `Open position differs: desk ${deskOpen}, backtest ${btOpenSide}${btOpen ? ` (since ${stamp(btOpen.entryDay, btOpen.entryMin)})` : ""}.`;
  }
  const res = { ...base, from_day: from, to_day: lastDay || today, trades };
  for (const t of trades) {
    if (t.desk && t.bt) res.matched++;
    if (!t.desk) res.missed++;
    if (!t.bt) res.extra++;
    if (t.issue) res.issues++;
    if (t.desk) res.desk_pts += t.desk.pts;
    if (t.bt && t.bt.pts != null) res.bt_pts += t.bt.pts;
    if (t.rupee_gap) res.rupee_gap += t.rupee_gap;
  }
  res.desk_pts = +res.desk_pts.toFixed(2); res.bt_pts = +res.bt_pts.toFixed(2);
  if (openNote) res.issues++;
  res.verdict = res.issues ? "gap" : "ok";
  res.note = [openNote, lastDay < today ? `Candles stored up to ${lastDay}.` : ""].filter(Boolean).join(" ");
  return res;
}
