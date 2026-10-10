// Position sizing from capital. Pure maths shared by the live engine and backtests.
//
// A strategy's `sizing` (null or mode FIXED = always its own "lots"):
//   mode       AUTO – lots worked out before every entry from the capital available
//   alloc_pct  share of current equity given to this strategy (e.g. 20 = 20%)
//   dd_pct     the most of that allocation you accept losing in a drawdown (e.g. 25)
//   dd_per_lot the worst drawdown for 1 lot (₹), normally taken from a backtest
//   dd_mult    safety multiple on that drawdown (future drawdowns are often deeper; default 1.5)
//   margin_pct margin per lot as % of contract value, for futures and option writing (exchange SPAN + exposure)
//   max_lots   upper cap
// Current equity = starting capital + realised P&L, so size grows after profits and shrinks after losses.
export type Sizing = { mode: "FIXED" | "AUTO"; alloc_pct: number; dd_pct: number; dd_per_lot: number | null; dd_mult: number; margin_pct: number; max_lots: number };

export function defaultMarginPct(seg: string): number { return seg === "MCX_COMM" || seg === "DELTA" ? 10 : 12; }

export function normaliseSizing(x: unknown, seg: string): Sizing | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Partial<Sizing>;
  if (r.mode !== "AUTO") return null;
  const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  return {
    mode: "AUTO",
    alloc_pct: num(r.alloc_pct, 0.1, 100, 20),
    dd_pct: num(r.dd_pct, 1, 100, 25),
    dd_per_lot: Number(r.dd_per_lot) > 0 ? Number(r.dd_per_lot) : null,
    dd_mult: num(r.dd_mult, 1, 5, 1.5),
    margin_pct: num(r.margin_pct, 1, 100, defaultMarginPct(seg)),
    max_lots: Math.trunc(num(r.max_lots, 1, 1000, 10)),
  };
}

/**
 * Money tied up by one lot: option buying = premium × lot size; futures and option writing = contract value × margin %.
 * price: underlying price; premium: option premium when known.
 */
export function marginPerLot(s: { trade_type: string; option_side?: string; lot_size: number; data_segment: string }, sz: Sizing | null, price: number, premium: number | null): number {
  const lot = Number(s.lot_size);
  const mPct = sz?.margin_pct ?? defaultMarginPct(s.data_segment);
  if (s.trade_type === "OPTIONS" && s.option_side !== "SELL") return premium && premium > 0 ? premium * lot : price * lot * 0.01;
  return price * lot * mPct / 100;
}

export type SizeResult = { lots: number; why: string; margin: number };
const r0 = (x: number) => Math.trunc(x).toLocaleString("en-IN");

/**
 * Lots for the next entry.
 *  equity: starting capital + realised P&L; usedByOthers: margin held by the other open positions;
 *  deployPct: the most of equity that may be tied up at once across all strategies.
 */
export function lotsFor(sz: Sizing, equity: number, marginLot: number, usedByOthers: number, deployPct: number): SizeResult {
  const eq = Math.max(0, equity);
  const alloc = eq * sz.alloc_pct / 100;
  const parts: string[] = [`equity ₹${r0(eq)} × ${sz.alloc_pct}% = ₹${r0(alloc)}`];
  let lots = sz.max_lots;
  const byMargin = marginLot > 0 ? Math.floor(alloc / marginLot) : sz.max_lots;
  parts.push(`₹${r0(marginLot)} a lot → ${byMargin}`);
  lots = Math.min(lots, byMargin);
  if (sz.dd_per_lot) {
    const byDd = Math.floor((alloc * sz.dd_pct / 100) / (sz.dd_per_lot * sz.dd_mult));
    parts.push(`drawdown budget ${sz.dd_pct}% ÷ (₹${r0(sz.dd_per_lot)} × ${sz.dd_mult}) → ${byDd}`);
    lots = Math.min(lots, byDd);
  }
  const room = eq * deployPct / 100 - usedByOthers;
  const byDeploy = marginLot > 0 ? Math.floor(Math.max(0, room) / marginLot) : sz.max_lots;
  if (byDeploy < lots) { parts.push(`only ₹${r0(Math.max(0, room))} left under the ${deployPct}% deployment cap → ${byDeploy}`); lots = byDeploy; }
  lots = Math.max(0, Math.min(lots, sz.max_lots));
  return { lots, margin: lots * marginLot, why: `${parts.join("; ")} ⇒ ${lots} lot${lots === 1 ? "" : "s"}` };
}
