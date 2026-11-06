// Opening gaps (6 Nov 2026, audit step 4): today's open vs the previous close in daily-ATR units; filled; held.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { RuleBook, validateRules, ruleTimeframes } = await import("./rules.mjs");
const { atr } = await import("./indicators.mjs");
const { mkData, tradingDays, flat } = await import("./rb_helpers.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

// 20 days of range 10 (daily ATR ≈ 10), closing at 100; the test day opens at 125 (gap +2.5 ATR), dips to 99 at candle 8.
const days = tradingDays("2026-09-01", 21);
const data = mkData(days, (day, i) => days.indexOf(day) < 20 ? (i === 0 ? { o: 100, h: 105, l: 95, c: 100 } : flat(100)) : i < 8 ? flat(125, 126, 124) : i === 8 ? { o: 124, h: 124, l: 99, c: 101 } : flat(101));
const frames = data.frames([5]), seg = "IDX_I";
const bk = (op, p = {}) => new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "GAP", tf: "base", p, op }] } }), 5, frames, data.daily, data.baseByDay, seg);
const T = (i) => frames.get(5).find((b) => b.day === days[20] && b.startMin === 555 + 5 * i).endT;
const dATR = atr(data.daily, 14)[19];
t("gap size in daily ATRs", () => {
  assert.ok(Math.abs(dATR - 10) < 1e-6, `daily ATR ${dATR}`);
  assert.equal(bk("gap_up_gt", { k: 2 }).at(T(1)).long, true, "25 points = 2.5 ATR");
  assert.equal(bk("gap_up_gt", { k: 3 }).at(T(1)).long, false);
  assert.equal(bk("gap_dn_gt", { k: 1 }).at(T(1)).long, false);
});
t("gap filled once the price trades back through the previous close, and stays so", () => {
  assert.equal(bk("gap_filled").at(T(7)).long, false);
  assert.equal(bk("gap_filled").at(T(8)).long, true);
  assert.equal(bk("gap_filled").at(T(12)).long, true);
});
t("gap held: judged after the first N minutes from the base candles", () => {
  assert.equal(bk("gap_held", { mins: 15 }).at(T(1)).long, false, "too early (09:25)");
  assert.equal(bk("gap_held", { mins: 15 }).at(T(3)).long, true, "the first 15 minutes stayed above 100");
  assert.equal(bk("gap_held", { mins: 45 }).at(T(9)).long, false, "the gap was filled inside the first 45 minutes");
});
t("GAP needs daily candles; on a daily frame it is not evaluated", () => {
  assert.equal(ruleTimeframes({ long: { mode: "ALL", conds: [{ ind: "GAP", tf: "base", op: "gap_up_gt" }] } }, 5).daily, true);
  const d = new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "GAP", tf: "D", op: "gap_up_gt" }] } }), 5, frames, data.daily, data.baseByDay, seg);
  assert.equal(d.at(T(1)).long, false);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
