// India VIX as a rule input (6 Nov 2026, audit step 8): its own daily / intraday candles through RuleExt, level,
// direction and percentile ops, no VIX data → false, timeframes left out of the asset's own needs.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { RuleBook, validateRules, ruleTimeframes, rulesUse, describeCond } = await import("./rules.mjs");
const { mkData, tradingDays, flat } = await import("./rb_helpers.mjs");
const { simulateRules } = await import("./backtest.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

const days = tradingDays("2026-09-01", 40);
const data = mkData(days, () => flat(100), 10);
// VIX: 39 days at 12 … 14 (rising slowly), the last day's daily close 20; intraday on the last day: 15 → 20 over 10 candles.
const vixD = mkData(days, (d, i) => { const k = days.indexOf(d); return k < 39 ? flat(12 + k * 0.05) : flat(15 + i * 0.5); }, 10);
const vix = vixD.daily, vixRaw = vixD.raw.map(({ day: _d, min: _m, ...r }) => r);
const frames = data.frames([5]), seg = "IDX_I", last = days[39];
const T = (i) => frames.get(5).find((b) => b.day === last && b.startMin === 555 + 5 * i).endT;
const bk = (op, v, tf = "D", p = {}, ext = { vix, vixRaw }) => new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "VIX", tf, p, op, v }] } }), 5, frames, data.daily, data.baseByDay, seg, undefined, ext);
t("daily VIX: yesterday's close against a level (today's candle is not complete)", () => {
  assert.equal(bk("vix_lt", 15).at(T(5)).long, true, "yesterday closed at 13.9");
  assert.equal(bk("vix_gt", 15).at(T(5)).long, false);
  assert.equal(bk("vix_rising", 0, "D", { n: 5 }).at(T(5)).long, true);
});
t("intraday VIX: the 5-minute candles aggregated to the condition's timeframe", () => {
  assert.equal(bk("vix_gt", 16, "base").at(T(1)).long, false, "VIX 15.5 at 09:25");
  assert.equal(bk("vix_gt", 16, "base").at(T(4)).long, true, "VIX 17 at 09:40");
  assert.equal(bk("vix_gt", 16, "15").at(T(5)).long, true, "15-minute candle 09:30–09:45 closes at 17");
});
t("percentile of the last `look` candles", () => {
  assert.equal(bk("vix_pctile_gt", 80, "D", { look: 20 }).at(T(5)).long, true, "yesterday was the highest of the last 20 days");
  assert.equal(bk("vix_pctile_lt", 50, "D", { look: 20 }).at(T(5)).long, false);
});
t("no VIX data → false; VIX adds no timeframe to the asset's own needs", () => {
  assert.equal(bk("vix_lt", 50, "D", {}, {}).at(T(5)).long, false);
  assert.equal(bk("vix_lt", 50, "base", {}, { vix }).at(T(5)).long, true, "no intraday VIX: the daily series stands in");
  const r = { long: { mode: "ALL", conds: [{ ind: "VIX", tf: "15", op: "vix_lt", v: 20 }, { ind: "RSI", tf: "base", op: "gt", v: 50 }] } };
  assert.deepEqual(ruleTimeframes(r, 5).intraday, [5]); assert.equal(rulesUse(r, "VIX"), true); assert.equal(rulesUse(r, "GAP"), false);
  assert.equal(describeCond({ ind: "VIX", tf: "D", p: { look: 250 }, op: "vix_pctile_gt", v: 80 }), "India VIX daily above its 80th percentile of 250 candles");
});
t("simulateRules passes the VIX series through SimData", () => {
  const s = { strategy_kind: "RULES", underlying: "NIFTY", data_security_id: "13", data_segment: seg, data_instrument: "INDEX", exchange: "NSE", dhan_symbol: "NIFTY",
    timeframe_min: 5, direction: "LONG_ONLY", entry_mode: "JOIN", session_start: "09:15", last_entry: "15:00", square_off: "15:15", intraday: true, trade_type: "FUTURES", option_side: "BUY",
    lots: 1, lot_size: 65, qty_mode: "LOTS", strike_step: 50, strike_offset: 0, risk: null, expiry_weekday: 2, expiry_flag: "WEEK",
    rules: { long: { mode: "ALL", conds: [{ ind: "VIX", tf: "base", op: "vix_gt", v: 16 }] }, exitLong: { mode: "ANY", conds: [{ ind: "VIX", tf: "base", op: "vix_lt", v: 16 }] } } };
  const plans = simulateRules(s, { ...data, vix, vixRaw }, last, last);
  assert.equal(plans.length, 1); assert.equal(plans[0].entryMin, 555 + 20, "entered at the close of the candle where VIX crossed 16 (09:35)");
  assert.equal(simulateRules(s, data, last, last).length, 0, "without VIX data the condition never fires");
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
