// Multi-leg option structures (spreads, straddles, strangles, iron condors, calendars, futures + option hedges).
// A structure is written for a bullish (Buy) signal; on a bearish (Sell) signal it is mirrored: calls become puts,
// strikes above the money go below it, and a futures leg changes side. Neutral structures mirror to themselves.

export type SLeg = { opt: "CE" | "PE" | "FUT"; act: "B" | "S"; k: number; x?: 0 | 1; q?: number };
export type Structure = { preset: string; w?: number; d?: number; legs?: SLeg[] };
export type PricedLeg = SLeg & { strike: number | null };

type Preset = { name: string; group: string; neutral?: boolean; legs: (w: number, d: number) => SLeg[]; note: string };
export const STRUCT_PRESETS: Record<string, Preset> = {
  BULL_CALL: { name: "Bull call / bear put spread (debit)", group: "Vertical spreads", legs: (w) => [{ opt: "CE", act: "B", k: 0 }, { opt: "CE", act: "S", k: w }],
    note: "Buy the at-the-money option and sell one further out. Capped loss and capped profit; cheaper than buying the option alone." },
  BULL_PUT: { name: "Bull put / bear call spread (credit)", group: "Vertical spreads", legs: (w) => [{ opt: "PE", act: "S", k: 0 }, { opt: "PE", act: "B", k: -w }],
    note: "Sell the at-the-money option and buy one further out as protection. Collects premium; loss capped at the width minus the premium." },
  LONG_STRADDLE: { name: "Long straddle", group: "Straddles & strangles", neutral: true, legs: () => [{ opt: "CE", act: "B", k: 0 }, { opt: "PE", act: "B", k: 0 }],
    note: "Buy the at-the-money call and put. Gains from a big move either way." },
  SHORT_STRADDLE: { name: "Short straddle", group: "Straddles & strangles", neutral: true, legs: () => [{ opt: "CE", act: "S", k: 0 }, { opt: "PE", act: "S", k: 0 }],
    note: "Sell the at-the-money call and put. Gains when the market stays still; unlimited risk both ways." },
  LONG_STRANGLE: { name: "Long strangle", group: "Straddles & strangles", neutral: true, legs: (_w, d) => [{ opt: "CE", act: "B", k: d }, { opt: "PE", act: "B", k: -d }],
    note: "Buy an out-of-the-money call and put. Cheaper than a straddle; needs a bigger move." },
  SHORT_STRANGLE: { name: "Short strangle", group: "Straddles & strangles", neutral: true, legs: (_w, d) => [{ opt: "CE", act: "S", k: d }, { opt: "PE", act: "S", k: -d }],
    note: "Sell an out-of-the-money call and put. Gains in a range; unlimited risk outside it." },
  IRON_CONDOR: { name: "Iron condor", group: "Iron condor & fly", neutral: true,
    legs: (w, d) => [{ opt: "CE", act: "S", k: d }, { opt: "CE", act: "B", k: d + w }, { opt: "PE", act: "S", k: -d }, { opt: "PE", act: "B", k: -d - w }],
    note: "Short strangle with protection bought further out on both sides. Gains in a range; loss capped." },
  IRON_FLY: { name: "Iron butterfly", group: "Iron condor & fly", neutral: true,
    legs: (w) => [{ opt: "CE", act: "S", k: 0 }, { opt: "PE", act: "S", k: 0 }, { opt: "CE", act: "B", k: w }, { opt: "PE", act: "B", k: -w }],
    note: "Short straddle with protection on both sides. Gains if the market stays near the strike; loss capped." },
  CALENDAR: { name: "Calendar spread", group: "Calendar", legs: (_w, d) => [{ opt: "CE", act: "S", k: d, x: 0 }, { opt: "CE", act: "B", k: d, x: 1 }],
    note: "Sell this expiry and buy the next expiry at the same strike. Gains from the faster time decay of the near option." },
  FUT_HEDGED: { name: "Futures + protective option", group: "Futures + options", legs: (_w, d) => [{ opt: "FUT", act: "B", k: 0 }, { opt: "PE", act: "B", k: -d }],
    note: "Futures in the signal's direction with an option bought against it (a put under a long, a call over a short). Loss capped near the strike." },
  FUT_COVERED: { name: "Futures + covered option", group: "Futures + options", legs: (_w, d) => [{ opt: "FUT", act: "B", k: 0 }, { opt: "CE", act: "S", k: d }],
    note: "Futures in the signal's direction with an option sold beyond it for extra income. Profit capped at the strike." },
};

/** The structure of a strategy, or null when it trades a single leg. */
export function structOf(s: Record<string, any>): Structure | null {
  const st = s?.structure;
  if (!st || s.trade_type !== "OPTIONS") return null;
  if (st.preset && STRUCT_PRESETS[st.preset]) return st;
  if (st.preset === "CUSTOM" && Array.isArray(st.legs) && st.legs.length) return st;
  return null;
}
/** Legs for a bullish signal (as defined). */
export function baseLegs(st: Structure): SLeg[] {
  const w = Math.max(1, Math.trunc(Number(st.w ?? 2))), d = Math.max(0, Math.trunc(Number(st.d ?? 2)));
  const legs = st.preset === "CUSTOM" ? (st.legs ?? []) : STRUCT_PRESETS[st.preset].legs(w, d);
  return legs.slice(0, 6).map((l) => ({ opt: l.opt, act: l.act, k: Math.trunc(Number(l.k) || 0), x: l.x === 1 ? 1 : 0, q: Math.max(1, Math.trunc(Number(l.q) || 1)) }));
}
/** Mirrors a leg for a bearish signal. */
const mirror = (l: SLeg): SLeg => l.opt === "FUT" ? { ...l, act: l.act === "B" ? "S" : "B" } : { ...l, opt: l.opt === "CE" ? "PE" : "CE", k: -l.k };
/** The legs for a signal, with strikes from the price at entry. */
export function legsFor(st: Structure, side: "LONG" | "SHORT", spot: number, step: number): PricedLeg[] {
  const atm = Math.round(spot / step) * step;
  return baseLegs(st).map((l) => (side === "SHORT" ? mirror(l) : l)).map((l) => ({ ...l, strike: l.opt === "FUT" ? null : atm + l.k * step }));
}
export const legSign = (l: { act: string }) => l.act === "B" ? 1 : -1;
export function legText(l: PricedLeg, symbol: string): string {
  return `${l.act === "B" ? "Buy" : "Sell"}${(l.q ?? 1) > 1 ? ` ${l.q}×` : ""} ${l.opt === "FUT" ? `${symbol} futures` : `${symbol} ${l.strike} ${l.opt}`}${l.x === 1 ? " (next expiry)" : ""}`;
}
export function structName(st: Structure): string {
  return st.preset === "CUSTOM" ? "Custom multi-leg" : STRUCT_PRESETS[st.preset]?.name ?? st.preset;
}
/**
 * Margin for one lot of the structure (an estimate): premium paid on bought options; for each sold option, the width
 * to its protecting bought option of the same type and expiry, or, if unprotected, the writing margin on the strike;
 * futures at the futures margin rate. Only one side of an iron condor can lose, so the larger side's width counts.
 */
export function structMargin(legs: (PricedLeg & { px: number })[], spot: number, lot: number, futRate: number, sellRate: number): number {
  let m = 0;
  const widths: Record<string, number> = { CE: 0, PE: 0 };
  const longs = legs.filter((l) => l.opt !== "FUT" && l.act === "B").map((l) => ({ ...l, used: 0 }));
  for (const l of legs) {
    const q = l.q ?? 1;
    if (l.opt === "FUT") { m += spot * lot * futRate * q; continue; }
    if (l.act === "B") { m += l.px * lot * q; continue; }
    const cover = longs.find((b) => b.opt === l.opt && (b.x ?? 0) >= (l.x ?? 0) && b.used < (b.q ?? 1));
    if (cover) { cover.used++; widths[l.opt] += Math.abs(Number(cover.strike) - Number(l.strike)) * lot * q; }
    else m += Number(l.strike) * lot * sellRate * q;
  }
  return Math.trunc(m + Math.max(widths.CE, widths.PE));
}
