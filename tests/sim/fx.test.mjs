// USD/INR in the rule book (14 Nov 2026, Papa: MCX prices move with the commodity's dollar price and with the rupee —
// "factor in both"): FX = USD/INR's own daily candles; USDPX = the asset's price in dollars (÷ USD/INR, never a later rate);
// the share of a move that came from the rupee; mirrors for shorts; no USD/INR data → false.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { RuleBook, validateRules, ruleTimeframes, rulesUse, describeCond } = await import("./rules.mjs");
const { mirror } = await import("./lab.mjs");
const { mkData, tradingDays, dayT } = await import("./rb_helpers.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

const days = tradingDays("2026-09-01", 40), last = days[39];
// Gold in rupees: flat at 100,000 for 30 days, then +1% a day for 10 days. USD/INR: 84 for 30 days, then +1% a day (so the
// whole rise of the last 10 days is the rupee: the dollar price is flat).
const fxC = (k) => k < 30 ? 84 : 84 * 1.01 ** (k - 29);
const px = (k) => k < 30 ? 100000 : 100000 * 1.01 ** (k - 29);
const data = mkData(days, (d) => { const k = days.indexOf(d), c = px(k); return { o: c, h: c, l: c, c }; }, 10);
const fx = days.map((d, k) => ({ t: dayT(d), o: fxC(k), h: fxC(k), l: fxC(k), c: fxC(k), v: 0, day: d }));
const frames = data.frames([5], "MCX_COMM");
const T = frames.get(5).find((b) => b.day === last && b.startMin === 555 + 25).endT;
const bk = (ind, op, v = 0, p = {}, tf = "D", ext = { fx }) => new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind, tf, p, op, v }] } }), 5, frames, data.daily, data.baseByDay, "MCX_COMM", undefined, ext);

t("FX: USD/INR's own daily candles (up to yesterday)", () => {
  assert.equal(bk("FX", "fx_rising", 0, { n: 5 }).at(T).long, true);
  assert.equal(bk("FX", "fx_falling", 0, { n: 5 }).at(T).long, false);
  assert.equal(bk("FX", "fx_above_sma", 0, { len: 20 }).at(T).long, true);
  assert.equal(bk("FX", "fx_chg_gt", 4, { n: 5 }).at(T).long, true, "+5.1% in 5 days");
  assert.equal(bk("FX", "fx_chg_lt", 4, { n: 5 }).at(T).long, false);
});
t("USDPX: the rupee price ÷ USD/INR — here flat, because the whole rise came from the rupee", () => {
  assert.equal(bk("USDPX", "usd_rising", 0, { n: 5 }).at(T).long, false, "dollar price flat");
  assert.equal(bk("USDPX", "usd_chg_lt", 0.5, { n: 5 }).at(T).long, true);
  assert.equal(bk("USDPX", "fx_share_gt", 90, { n: 5 }).at(T).long, true, "100% of the move was the rupee");
  assert.equal(bk("USDPX", "fx_share_lt", 40, { n: 5 }).at(T).long, false);
  // the plain rupee-price RSI-style check would have seen a strong uptrend; the dollar view doesn't.
});
t("USDPX intraday: each 5-minute candle ÷ the last USD/INR close BEFORE its day", () => {
  assert.equal(bk("USDPX", "usd_rising", 0, { n: 3 }, "base").at(T).long, false, "within the day the price is flat");
  const f2 = fx.map((x) => x.day === last ? { ...x, c: 999, o: 999, h: 999, l: 999 } : x);
  // a wild rate stamped on the candle's own day must not be used intraday (no look-ahead)
  assert.equal(bk("USDPX", "usd_chg_lt", -50, { n: 3 }, "base", { fx: f2 }).at(T).long, false);
});
t("no USD/INR data → false; FX adds no timeframe; descriptions", () => {
  assert.equal(bk("FX", "fx_rising", 0, { n: 5 }, "D", {}).at(T).long, false);
  assert.equal(bk("USDPX", "usd_above_sma", 0, { len: 5 }, "D", {}).at(T).long, false);
  const r = { long: { mode: "ALL", conds: [{ ind: "FX", tf: "15", op: "fx_rising", p: { n: 5 } }, { ind: "RSI", tf: "base", op: "gt", v: 50 }] } };
  assert.deepEqual(ruleTimeframes(r, 5).intraday, [5]); assert.equal(rulesUse(r, "FX"), true);
  assert.equal(describeCond({ ind: "USDPX", tf: "D", p: { n: 10 }, op: "fx_share_lt", v: 40 }), "Price in dollars (÷ USD/INR) daily move of the last 10 candles came less than 40% from USD/INR");
  assert.equal(describeCond({ ind: "FX", tf: "D", p: { len: 50 }, op: "fx_above_sma" }), "USD/INR daily above its 50-candle average");
});
t("mirrors for shorts: rising ↔ falling, above ↔ below, +v% ↔ −v%; the rupee share stays", () => {
  assert.equal(mirror({ ind: "FX", tf: "D", p: { n: 5 }, op: "fx_rising" }).op, "fx_falling");
  assert.equal(mirror({ ind: "USDPX", tf: "D", p: { len: 50 }, op: "usd_above_sma" }).op, "usd_below_sma");
  const m = mirror({ ind: "FX", tf: "D", p: { n: 5 }, op: "fx_chg_gt", v: 1 }); assert.equal(m.op, "fx_chg_lt"); assert.equal(m.v, -1);
  assert.equal(mirror({ ind: "USDPX", tf: "D", p: { n: 5 }, op: "fx_share_lt", v: 40 }).op, "fx_share_lt");
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
