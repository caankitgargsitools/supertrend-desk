// Volatility contraction set (6 Nov 2026, audit step 5): Bollinger bandwidth percentile, candle-range setups (NRn,
// inside bar, range vs ATR) and the Keltner channel with the Bollinger-inside-Keltner squeeze and its release.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { RuleBook, validateRules, describeCond } = await import("./rules.mjs");
const { keltner, pctRank, bollinger } = await import("./indicators.mjs");
const { mkData, tradingDays } = await import("./rb_helpers.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

t("pctRank: the rank of a value among the values before it", () => {
  const x = Array.from({ length: 60 }, (_, i) => i % 20); // 0..19 repeating
  const r = pctRank(x, 20);
  assert.equal(r[19], undefined ?? r[19]); assert.ok(isNaN(r[19]), "NaN until 20 values exist");
  assert.equal(r[40], 0, "a 0 is below everything in the window"); assert.equal(r[59], 95, "19 is above 19 of 20");
});
t("keltner: EMA ± k × ATR", () => {
  const b = Array.from({ length: 40 }, () => ({ o: 100, h: 101, l: 99, c: 100 }));
  const k = keltner(b, 20, 1.5);
  assert.ok(Math.abs(k.mid[39] - 100) < 1e-9 && Math.abs(k.upper[39] - 103) < 1e-9 && Math.abs(k.lower[39] - 97) < 1e-9);
});

// One day: 40 noisy candles (a triangle wave 95 → 105 → 95 with wicks), then 25 dead-flat candles (a squeeze), then a wide one.
const days = tradingDays("2026-10-05", 1);
const tri = (i) => { const k = i % 20; return 100 + (k < 10 ? k : 20 - k) - 5; };
const path = (i) => i < 40 ? tri(i) : i < 65 ? 100 : 104;
const data = mkData(days, (_, i) => {
  const c = path(i), o = i ? path(i - 1) : c;
  if (i === 65) return { o: 100, h: 104.5, l: 100, c: 104 };
  if (i === 50) return { o: 100, h: 100.3, l: 99.9, c: 100 }; // a slightly wider bar inside the squeeze
  if (i === 51) return { o: 100, h: 100.1, l: 99.95, c: 100 }; // an inside bar after it, the narrowest so far
  return { o, h: Math.max(o, c) + (i < 40 ? 0.5 : 0.1), l: Math.min(o, c) - (i < 40 ? 0.5 : 0.1), c };
});
const frames = data.frames([5]), seg = "IDX_I", bars5 = frames.get(5);
const T = (i) => bars5[i].endT;
const bk = (ind, op, p = {}) => new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind, tf: "base", p, op }] } }), 5, frames, data.daily, data.baseByDay, seg);
t("Bollinger bandwidth percentile: at the floor in the squeeze; agrees with the direct ranking in the noisy stretch", () => {
  assert.equal(bk("BB", "bandwidth_pctile_lt", { len: 10, mult: 2, look: 20, pct: 20 }).at(T(64)).long, true);
  assert.equal(bk("BB", "bandwidth_pctile_gt", { len: 10, mult: 2, look: 20, pct: 20 }).at(T(64)).long, false);
  const bb = bollinger(bars5.map((b) => b.c), 10, 2), rk = pctRank(bb.upper.map((u, i) => (u - bb.lower[i]) / bb.basis[i]), 20);
  assert.ok(!isNaN(rk[39]));
  assert.equal(bk("BB", "bandwidth_pctile_lt", { len: 10, mult: 2, look: 20, pct: 50 }).at(T(39)).long, rk[39] < 50);
  assert.equal(bk("BB", "bandwidth_pctile_gt", { len: 10, mult: 2, look: 20, pct: 50 }).at(T(39)).long, rk[39] > 50);
});
t("RANGE: the previous candle was the narrowest of the last n / an inside bar; this candle's range vs ATR", () => {
  assert.equal(bk("RANGE", "nr_n", { n: 7 }).at(T(52)).long, true, "candle 51 (range 0.15) was the narrowest of candles 45–51");
  assert.equal(bk("RANGE", "nr_n", { n: 7 }).at(T(51)).long, false, "candle 50 (range 0.4) was not");
  assert.equal(bk("RANGE", "inside_bar").at(T(52)).long, true, "candle 51 sat inside candle 50");
  assert.equal(bk("RANGE", "inside_bar").at(T(51)).long, false);
  assert.equal(bk("RANGE", "range_gt_atr", { k: 3, len: 14 }).at(T(65)).long, true, "the 4.5-point candle after a dead-flat stretch");
  assert.equal(bk("RANGE", "range_lt_atr", { k: 0.8, len: 14 }).at(T(64)).long, true);
  assert.equal(bk("RANGE", "range_gt_atr", { k: 3, len: 14 }).at(T(64)).long, false);
});
t("Keltner: above the upper channel on the wide candle; squeeze while the bands sit inside the channel; release after", () => {
  assert.equal(bk("KC", "above_upper", { len: 20, k: 1.5 }).at(T(65)).long, true);
  assert.equal(bk("KC", "below_lower", { len: 20, k: 1.5 }).at(T(65)).long, false);
  // bands (20, 2) shrink faster than the ATR-based channel (Wilder smoothing) in the dead-flat stretch
  const sq = bk("KC", "squeeze", { len: 20, k: 1.5, mult: 2 });
  assert.equal(sq.at(T(39)).long, false, "noisy: no squeeze");
  assert.equal(sq.at(T(60)).long, true, "flat: squeeze");
  const bb = bollinger(bars5.map((b) => b.c), 20, 2), kc = keltner(bars5, 20, 1.5);
  assert.ok(bb.upper[60] < kc.upper[60] && bb.lower[60] > kc.lower[60], "bands inside the channel at candle 60");
  const rel = bk("KC", "squeeze_release", { len: 20, k: 1.5, mult: 2 });
  assert.equal(rel.at(T(65)).long, true, "the wide candle releases it");
  assert.equal(rel.at(T(60)).long, false);
});
t("describeCond for the new ops", () => {
  assert.match(describeCond({ ind: "KC", tf: "base", p: { len: 20, k: 1.5 }, op: "squeeze" }), /Keltner\(20,1.5\) own timeframe Bollinger bands inside the channel \(squeeze\)/);
  assert.match(describeCond({ ind: "RANGE", tf: "base", p: { n: 7 }, op: "nr_n" }), /previous candle was the narrowest of the last 7/);
  assert.match(describeCond({ ind: "BB", tf: "base", p: { len: 20, mult: 2, pct: 20, look: 250 }, op: "bandwidth_pctile_lt" }), /bandwidth under its 20th percentile of 250 candles/);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
