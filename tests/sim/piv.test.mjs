// Pivot points (6 Nov 2026, audit step 2): classic / Camarilla levels from the previous day or week, the central pivot
// range's width, crosses on intraday candles, and the level handed to a limit-at-level fill.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { RuleBook, validateRules, pivotLevels, describeCond } = await import("./rules.mjs");
const { mkData, tradingDays, flat } = await import("./rb_helpers.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

t("classic pivot maths (H 110, L 100, C 106)", () => {
  const L = pivotLevels({ h: 110, l: 100, c: 106 }, false);
  const pp = 316 / 3;
  assert.ok(Math.abs(L.pp - pp) < 1e-9); assert.ok(Math.abs(L.r1 - (2 * pp - 100)) < 1e-9); assert.ok(Math.abs(L.s1 - (2 * pp - 110)) < 1e-9);
  assert.ok(Math.abs(L.r2 - (pp + 10)) < 1e-9); assert.ok(Math.abs(L.s3 - (100 - 2 * (110 - pp))) < 1e-9);
  assert.ok(Math.abs(L.bc - 105) < 1e-9); assert.ok(Math.abs(L.tc - (2 * pp - 105)) < 1e-9); assert.ok(Math.abs(L.w - Math.abs(2 * pp - 105 - 105)) < 1e-9);
});
t("Camarilla H3 / H4 / L3 / L4 stand in for R1 / R2 / S1 / S2", () => {
  const L = pivotLevels({ h: 110, l: 100, c: 106 }, true);
  assert.ok(Math.abs(L.r1 - (106 + 11 / 4)) < 1e-9); assert.ok(Math.abs(L.r2 - (106 + 11 / 2)) < 1e-9); assert.ok(Math.abs(L.s1 - (106 - 11 / 4)) < 1e-9);
});

// 25 days: 24 quiet days with the same range (H 110 L 100 C 107 → the same CPR width), then a day with a tiny range.
const days = tradingDays("2026-09-01", 26);
const data = mkData(days, (day, i) => {
  const k = days.indexOf(day);
  if (k < 24) return i === 0 ? { o: 105, h: 110, l: 100, c: 107 } : flat(107);
  if (k === 24) return i === 0 ? { o: 105, h: 106, l: 104.8, c: 105.6 } : flat(105.6); // a narrow day → tomorrow's CPR is narrow
  // test day (day 24's levels: pp 105.47, r1 106.13, Camarilla H3 105.93): opens under the pivot, rises through R1 on candle 3
  return i === 0 ? flat(105.2) : i === 1 ? flat(105.6) : i === 2 ? flat(106.0) : i === 3 ? { o: 106.0, h: 106.5, l: 106.0, c: 106.3 } : flat(106.4);
});
const seg = "IDX_I", frames = data.frames([5]);
const bk = (op, p = {}) => new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "PIV", tf: "base", p, op }] } }), 5, frames, data.daily, data.baseByDay, seg);
const tAt = (i) => frames.get(5).find((b) => b.day === days[25] && b.startMin === 555 + 5 * i).endT;
const prev = pivotLevels(data.daily[24], false);
t("above / below the pivot and R1 on the test day's candles", () => {
  assert.equal(bk("above_pp").at(tAt(0)).long, false, `open at 105.2 under pp ${prev.pp.toFixed(2)}`);
  assert.equal(bk("above_pp").at(tAt(1)).long, true);
  assert.equal(bk("below_pp").at(tAt(1)).long, false);
  assert.equal(bk("above_r1").at(tAt(2)).long, false, `106.0 under r1 ${prev.r1.toFixed(2)}`);
  assert.equal(bk("above_r1").at(tAt(3)).long, true);
});
t("crosses: only on the candle that crosses", () => {
  assert.equal(bk("cross_up_r1").at(tAt(3)).long, true);
  assert.equal(bk("cross_up_r1").at(tAt(4)).long, false);
  assert.equal(bk("cross_up_pp").at(tAt(1)).long, true);
  assert.equal(bk("cross_up_pp").at(tAt(2)).long, false);
  assert.equal(bk("cross_down_s1").at(tAt(3)).long, false);
});
t("central pivot range: narrow after a narrow day (vs the 20-day median), wide after a wide one", () => {
  assert.equal(bk("cpr_narrow", { k: 0.5 }).at(tAt(1)).long, true, "day 25's CPR comes from the narrow day 24");
  assert.equal(bk("cpr_wide", { k: 0.5 }).at(tAt(1)).long, false);
  const t24 = frames.get(5).find((b) => b.day === days[24] && b.startMin === 560).endT; // on day 24 the CPR comes from an ordinary day
  assert.equal(bk("cpr_narrow", { k: 0.5 }).at(t24).long, false);
  assert.equal(bk("cpr_wide", { k: 0.5 }).at(t24).long, true, "an ordinary width is over 0.5× the median");
});
t("weekly source: the previous week's bar; Camarilla kind", () => {
  const w = bk("above_pp", { src: 1 }); // weekly bars of the quiet weeks: pp = (110+100+107)/3 = 105.67 → 105.6 under, 106.0 above
  assert.equal(w.at(tAt(1)).long, false); assert.equal(w.at(tAt(2)).long, true);
  const cam = bk("above_r1", { kind: 1 }); // Camarilla H3 of day 24 = 105.6 + 1.2×1.1/4 = 105.93
  assert.equal(cam.at(tAt(1)).long, false); assert.equal(cam.at(tAt(2)).long, true);
});
t("levelFor gives the pivot level a limit order would rest at", () => {
  const b1 = bk("cross_up_r1"); assert.ok(Math.abs(b1.levelFor("long", tAt(3)) - prev.r1) < 1e-9);
  const b2 = bk("above_pp"); assert.ok(Math.abs(b2.levelFor("long", tAt(1)) - prev.pp) < 1e-9);
  assert.equal(bk("cpr_narrow").levelFor("long", tAt(1)), null, "a width is not a price level");
});
t("on daily candles the pivot of the day before is compared with the daily close", () => {
  const d = new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "PIV", tf: "D", op: "above_pp" }] }, daily: true }), 375, new Map(), data.daily, new Map(), seg);
  const openT = (day) => Date.parse(`${day}T00:00:00+05:30`) / 1000 + 555 * 60 + 60;
  assert.equal(d.at(openT(days[25])).long, false, "day 24 closed at 105.6, its pivot (from day 23) is 105.67: not above");
  assert.equal(d.at(openT(days[24])).long, true, "day 23 closed at 107, above the pivot from day 22");
});
t("describeCond text follows the digits-stripped family convention", () => {
  assert.equal(describeCond({ ind: "PIV", tf: "base", p: { src: 0, kind: 0 }, op: "cross_up_r1" }), "Pivot points (daily, classic) own timeframe crosses above R1");
  assert.match(describeCond({ ind: "PIV", tf: "base", p: { k: 0.5 }, op: "cpr_narrow" }), /central pivot range narrow \(under 0.5× its 20-day median\)/);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
