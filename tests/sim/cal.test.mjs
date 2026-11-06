// Calendar conditions (6 Nov 2026, audit step 7): expiry days under the strategy's own expiry rule, days to expiry, the
// turn of the month from the trading-day calendar, market-event days from market_events (engine-wide set, 1-day memo).
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { RuleBook, validateRules, describeCond } = await import("./rules.mjs");
const { mkData, tradingDays, flat } = await import("./rb_helpers.mjs");
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

// Trading days Oct–Nov 2026 (Mon–Fri; 2026-11-26 is a Thursday: the last Thursday of November; 2026-11-24 the last Tuesday).
const days = tradingDays("2026-10-01", 45);
const data = mkData(days, () => flat(100), 3);
const seg = "IDX_I", frames = data.frames([5]);
const atOpen = (day) => frames.get(5).find((b) => b.day === day).endT;
const bk = (op, p = {}, v, ext) => new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "CAL", tf: "base", p, op, ...(v != null ? { v } : {}) }] } }), 5, frames, data.daily, data.baseByDay, seg, undefined, ext);
await t("expiry day: weekly on the strategy's weekday (Nifty: Tuesday since Sept 2025), monthly on the last such weekday", () => {
  assert.equal(bk("is_expiry_day", { wd: 2, monthly: 0 }, undefined, { expiry: { weekday: 2, monthly: false, underlying: "NIFTY" } }).at(atOpen("2026-11-03")).long, true, "a Tuesday");
  assert.equal(bk("is_expiry_day", { wd: 2, monthly: 0 }).at(atOpen("2026-11-04")).long, false, "a Wednesday");
  assert.equal(bk("is_expiry_day", { wd: 4, monthly: 1 }).at(atOpen("2026-11-26")).long, true, "the last Thursday of November");
  assert.equal(bk("is_expiry_day", { wd: 4, monthly: 1 }).at(atOpen("2026-11-19")).long, false, "a Thursday that isn't the last");
  assert.equal(bk("not_expiry_day", { wd: 4, monthly: 1 }).at(atOpen("2026-11-19")).long, true);
  // without wd / monthly on the condition the rule book's ext.expiry decides; with neither, unknown → false
  assert.equal(bk("is_expiry_day", {}, undefined, { expiry: { weekday: 4, monthly: true, underlying: "RELIANCE" } }).at(atOpen("2026-11-26")).long, true);
  assert.equal(bk("is_expiry_day", {}).at(atOpen("2026-11-26")).long, false);
  assert.equal(bk("not_expiry_day", {}).at(atOpen("2026-11-19")).long, false, "unknown expiry rule: never true either way");
});
await t("days to expiry", () => {
  assert.equal(bk("days_to_expiry_lt", { wd: 4, monthly: 1 }, 3).at(atOpen("2026-11-24")).long, true, "2 days before the last Thursday");
  assert.equal(bk("days_to_expiry_lt", { wd: 4, monthly: 1 }, 3).at(atOpen("2026-11-20")).long, false);
  assert.equal(bk("days_to_expiry_lt", { wd: 2, monthly: 0 }, 2).at(atOpen("2026-11-02")).long, true, "Monday: the weekly Tuesday is tomorrow");
});
await t("turn of the month: the last a and first b trading days (October 2026 ends Friday the 30th)", () => {
  const tom = bk("turn_of_month", { a: 2, b: 3 });
  assert.equal(tom.at(atOpen("2026-10-29")).long, true, "2nd-last trading day of October");
  assert.equal(tom.at(atOpen("2026-10-30")).long, true, "last trading day");
  assert.equal(tom.at(atOpen("2026-10-28")).long, false, "3rd-last: outside a = 2");
  assert.equal(tom.at(atOpen("2026-11-02")).long, true, "1st trading day of November");
  assert.equal(tom.at(atOpen("2026-11-04")).long, true, "3rd trading day");
  assert.equal(tom.at(atOpen("2026-11-05")).long, false, "4th trading day");
  // the live edge: the last stored day is the decision day itself, the rest of the month comes from the weekday calendar
  const short = mkData(days.filter((d) => d <= "2026-11-27"), () => flat(100), 3);
  const live = new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "CAL", tf: "base", p: { a: 2, b: 3 }, op: "turn_of_month" }] } }), 5, short.frames([5]), short.daily, short.baseByDay, seg);
  assert.equal(live.at(short.frames([5]).get(5).find((b) => b.day === "2026-11-27").endT).long, true, "Friday 27th: only Monday 30th follows → one of the last 2");
  assert.equal(live.at(short.frames([5]).get(5).find((b) => b.day === "2026-11-26").endT).long, false, "26th: two trading days follow");
});
await t("market-event days: ± n days around a stored event; no events → false", () => {
  const ev = new Set(["2026-11-04"]);
  assert.equal(bk("event_day", { n: 0 }, undefined, { events: ev }).at(atOpen("2026-11-04")).long, true);
  assert.equal(bk("event_day", { n: 0 }, undefined, { events: ev }).at(atOpen("2026-11-05")).long, false);
  assert.equal(bk("event_day", { n: 1 }, undefined, { events: ev }).at(atOpen("2026-11-05")).long, true);
  assert.equal(bk("event_day", { n: 1 }, undefined, { events: ev }).at(atOpen("2026-11-03")).long, true);
  assert.equal(bk("event_day", { n: 1 }).at(atOpen("2026-11-04")).long, false, "the engine-wide set is empty");
  assert.equal(describeCond({ ind: "CAL", tf: "base", p: { n: 1 }, op: "event_day" }), "Calendar: is within 1 days of a market event");
  assert.equal(describeCond({ ind: "CAL", tf: "base", p: { wd: 2, monthly: 0 }, op: "is_expiry_day" }), "Calendar: is an expiry day");
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
