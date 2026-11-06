// Divergences (6 Nov 2026, audit step 9): price vs RSI / MACD over the last two swings of the Fibonacci swing detector.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { RuleBook, validateRules, describeCond } = await import("./rules.mjs");
const { swings } = await import("./indicators.mjs");
const { rsi } = await import("./indicators.mjs");
const { mkData, tradingDays } = await import("./rb_helpers.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

// One day of 5-minute candles: a sharp fall to a first low (fast, so RSI is very low), a bounce, then a slower drift to a
// LOWER low (RSI less extreme = a bullish divergence), then a bounce that confirms the second low.
const path = [];
for (let i = 0; i < 20; i++) path.push(100);
for (let i = 1; i <= 8; i++) path.push(100 - 2 * i); // fast fall to 84 (low 1)
for (let i = 1; i <= 8; i++) path.push(84 + 1.5 * i); // bounce to 96
for (let i = 1; i <= 16; i++) path.push(96 - 0.8 * i); // slow drift to 83.2 (low 2, lower)
for (let i = 1; i <= 10; i++) path.push(83.2 + 1 * i); // bounce: confirms low 2
const days = tradingDays("2026-10-05", 1);
const data = mkData(days, (_, i) => { const c = path[Math.min(i, path.length - 1)], o = i ? path[Math.min(i - 1, path.length - 1)] : c; return { o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c }; }, path.length);
const frames = data.frames([5]), seg = "IDX_I", bars = frames.get(5);
const bk = (op, p = { mode: 0, k: 2, len: 14, within: 3 }) => new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "DIV", tf: "base", p, op }] }, short: { mode: "ALL", conds: [{ ind: "DIV", tf: "base", p, op: op.replace("bull", "bear") }] } }), 5, frames, data.daily, data.baseByDay, seg);
t("the swing detector sees low 1, the bounce high and the lower low 2", () => {
  const sw = swings(bars, 0, 2, 5, 14);
  const lows = sw.list.filter((s) => s.dir === -1).map((s) => +s.lo.toFixed(1));
  assert.ok(lows.includes(83.7) && lows.includes(82.9), `lows ${lows}`);
  const r = rsi(bars.map((b) => b.c), 14), l1 = sw.list.find((s) => s.dir === -1 && +s.lo.toFixed(1) === 83.7), l2 = sw.list.find((s) => s.dir === -1 && +s.lo.toFixed(1) === 82.9);
  assert.ok(r[l2.iLo] > r[l1.iLo], `RSI at the lower low (${r[l2.iLo].toFixed(1)}) is higher than at the first low (${r[l1.iLo].toFixed(1)})`);
});
t("bullish RSI divergence fires when the second low is confirmed, lives `within` candles, then goes quiet", () => {
  const sw = swings(bars, 0, 2, 5, 14), l2 = sw.list.find((s) => s.dir === -1 && +s.lo.toFixed(1) === 82.9);
  const b = bk("rsi_bull_div");
  assert.equal(b.at(bars[l2.at].endT).long, true, `at candle ${l2.at}`);
  assert.equal(b.at(bars[l2.at + 2].endT).long, true);
  assert.equal(b.at(bars[l2.at + 3].endT).long, false, "after `within` candles");
  assert.equal(b.at(bars[l2.at - 1].endT).long, false, "not before the low is confirmed");
  assert.equal(b.at(bars[l2.at].endT).short, false, "no bearish divergence here");
});
t("MACD divergence uses the MACD line; fractal swings work too", () => {
  const sw = swings(bars, 0, 2, 5, 14), l2 = sw.list.find((s) => s.dir === -1 && +s.lo.toFixed(1) === 82.9);
  assert.equal(bk("macd_bull_div", { mode: 0, k: 2, fast: 12, slow: 26, sig: 9, within: 3 }).at(bars[l2.at].endT).long, true);
  const sw2 = swings(bars, 1, 2, 3, 14), l2f = sw2.list.find((s) => s.dir === -1 && +s.lo.toFixed(1) === 82.9);
  assert.ok(l2f, "fractal detector finds the second low");
  assert.equal(bk("rsi_bull_div", { mode: 1, n: 3, len: 14, within: 3 }).at(bars[l2f.at].endT).long, true);
  assert.equal(describeCond({ ind: "DIV", tf: "base", p: { mode: 0, k: 2, len: 14 }, op: "rsi_bull_div" }), "Divergence (RSI(14), 2×ATR swings) own timeframe bullish divergence (price lower low, RSI higher low)");
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
