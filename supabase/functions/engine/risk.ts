// Stop loss, target, trailing stop and daily loss limit. Pure maths shared by the live engine, backtests and the lab.
//
// A strategy's `risk` (null = none):
//   basis  UNDERLYING – levels on the index / commodity price (futures and options alike; option positions follow
//                       the signal's direction, so a bullish PE write is stopped when the index falls)
//          PREMIUM    – levels on the option's own premium (options only). A buyer is hurt when the premium falls,
//                       a writer when it rises.
//   sl / tgt / trail  { type: POINTS | PCT | ATR, value }  (ATR = multiple of ATR(atr_len) on the strategy's candles at
//                     entry; underlying basis only). Trailing: the stop follows the best price reached by that distance.
//   tgt only          { type: FIB, value }  (6 Nov 2026): a Fibonacci extension target — value % of the last completed
//                     swing's size (100 / 127.2 / 161.8), measured from the entry in the trade's direction; underlying
//                     basis only. Without a known swing at entry (no swing yet, or the live engine not passing one) the
//                     target is simply off for that trade.
//   max_day_loss      ₹. Once the day's closed trades have lost this much, no new trades that day.
export type RiskRule = { type: "POINTS" | "PCT" | "ATR" | "FIB"; value: number };
export type Risk = { basis: "UNDERLYING" | "PREMIUM"; sl?: RiskRule | null; tgt?: RiskRule | null; trail?: RiskRule | null; atr_len?: number; max_day_loss?: number | null };

/** Levels for an open position. dir 1: gains when price rises (long, option buyer on premium); -1: gains when it falls. */
export type RiskState = { dir: 1 | -1; stop: number | null; tgt: number | null; trail: RiskRule | null; trailAtr: number; best: number; scanFrom: number };
export type RiskHit = { px: number; t: number; why: string };

const on = (r?: RiskRule | null): r is RiskRule => !!r && Number(r.value) > 0 && ["POINTS", "PCT", "ATR", "FIB"].includes(r.type);

/** Cleans a risk object from the form / database; returns null when nothing is switched on. */
export function normaliseRisk(x: unknown, isOptions: boolean): Risk | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Risk;
  const basis = r.basis === "PREMIUM" && isOptions ? "PREMIUM" : "UNDERLYING";
  const fix = (q?: RiskRule | null, tgt = false) => on(q) && !(basis === "PREMIUM" && (q.type === "ATR" || q.type === "FIB")) && (tgt || q.type !== "FIB") ? { type: q.type, value: Number(q.value) } : null;
  const out: Risk = { basis, sl: fix(r.sl), tgt: fix(r.tgt, true), trail: fix(r.trail), atr_len: Math.max(2, Math.min(100, Number(r.atr_len) || 14)),
    max_day_loss: Number(r.max_day_loss) > 0 ? Number(r.max_day_loss) : null };
  return out.sl || out.tgt || out.trail || out.max_day_loss ? out : null;
}
export const needsAtr = (r: Risk | null) => !!r && [r.sl, r.tgt, r.trail].some((q) => q?.type === "ATR");
/** The target is a Fibonacci extension: the entry needs the size of the last completed swing. */
export const needsSwing = (r: Risk | null) => !!r && r.tgt?.type === "FIB";
export const hasLevels = (r: Risk | null) => !!r && !!(r.sl || r.tgt || r.trail);

function dist(q: RiskRule, ref: number, atr: number, swing = 0): number {
  return q.type === "POINTS" ? q.value : q.type === "PCT" ? (ref * q.value) / 100 : q.type === "FIB" ? (swing * q.value) / 100 : q.value * atr;
}

/**
 * Levels at entry. price: entry price in the basis's units; atr: ATR at entry (underlying basis); swing: size of the last
 * completed swing at entry (price points; only a FIB target reads it — 0 / missing leaves that target off).
 */
export function riskInit(risk: Risk | null, dir: 1 | -1, price: number, atr: number, scanFrom: number, swing = 0): RiskState | null {
  if (!hasLevels(risk) || !(price > 0)) return null;
  const r = risk!;
  if (needsAtr(r) && !(atr > 0)) return null;
  const stop = r.sl ? price - dir * dist(r.sl, price, atr) : null;
  const tgt = r.tgt && !(r.tgt.type === "FIB" && !(swing > 0)) ? price + dir * dist(r.tgt, price, atr, swing) : null;
  if (stop === null && tgt === null && !r.trail) return null;
  return { dir, stop: stop !== null && stop <= 0 ? null : stop, tgt: tgt !== null && tgt <= 0 ? 0.05 : tgt, trail: r.trail ?? null, trailAtr: atr, best: price, scanFrom };
}

/** Current effective stop (fixed stop or trailing stop, whichever is tighter) and which one it is. */
export function effectiveStop(rs: RiskState): { px: number | null; trailing: boolean } {
  const tr = rs.trail ? rs.best - rs.dir * dist(rs.trail, rs.best, rs.trailAtr) : null;
  if (tr === null) return { px: rs.stop, trailing: false };
  if (rs.stop === null) return { px: tr, trailing: true };
  return rs.dir === 1 ? (tr > rs.stop ? { px: tr, trailing: true } : { px: rs.stop, trailing: false })
    : (tr < rs.stop ? { px: tr, trailing: true } : { px: rs.stop, trailing: false });
}

/**
 * Walks candles in time order (only those starting at or after rs.scanFrom) and returns the first stop / target hit.
 * Within one candle the stop is assumed to come first (the cautious reading). A gap through a level fills at the open.
 * Updates rs.best (for the trailing stop) as it goes.
 */
export function riskScan(rs: RiskState, rows: { t: number; o: number; h: number; l: number }[]): RiskHit | null {
  for (const r of rows) {
    if (r.t < rs.scanFrom) continue;
    const st = effectiveStop(rs);
    const whyStop = st.trailing ? "Trailing stop" : "Stop loss";
    if (st.px !== null) {
      if (rs.dir === 1 ? r.o <= st.px : r.o >= st.px) return { px: r.o, t: r.t, why: `${whyStop} (gap through ${round(st.px)})` };
      if (rs.dir === 1 ? r.l <= st.px : r.h >= st.px) return { px: st.px, t: r.t, why: `${whyStop} at ${round(st.px)}` };
    }
    if (rs.tgt !== null) {
      if (rs.dir === 1 ? r.o >= rs.tgt : r.o <= rs.tgt) return { px: r.o, t: r.t, why: `Target (gap through ${round(rs.tgt)})` };
      if (rs.dir === 1 ? r.h >= rs.tgt : r.l <= rs.tgt) return { px: rs.tgt, t: r.t, why: `Target at ${round(rs.tgt)}` };
    }
    rs.best = rs.dir === 1 ? Math.max(rs.best, r.h) : Math.min(rs.best, r.l);
  }
  return null;
}
const round = (x: number) => +x.toFixed(2);

/** "SL 1.5×ATR(14) · target 1% · trail 30 pts · max loss ₹5,000/day (on underlying)". */
export function describeRisk(r: Risk | null): string {
  if (!r) return "No stop loss";
  const q = (x: RiskRule) => x.type === "POINTS" ? `${x.value} pts` : x.type === "PCT" ? `${x.value}%` : x.type === "FIB" ? `${x.value}% of the swing (Fibonacci)` : `${x.value}×ATR(${r.atr_len ?? 14})`;
  const parts: string[] = [];
  if (r.sl) parts.push(`SL ${q(r.sl)}`);
  if (r.tgt) parts.push(`target ${q(r.tgt)}`);
  if (r.trail) parts.push(`trail ${q(r.trail)}`);
  if (parts.length) parts[parts.length - 1] += r.basis === "PREMIUM" ? " (on premium)" : " (on underlying)";
  if (r.max_day_loss) parts.push(`max loss ₹${Math.trunc(r.max_day_loss).toLocaleString("en-IN")}/day`);
  return parts.join(" · ");
}
