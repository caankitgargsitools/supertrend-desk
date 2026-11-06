// Fibonacci made testable (6 Nov 2026, audit step 3): swing detection without look-ahead (zigzag k×ATR or n-bar
// fractals), retracement levels with a tolerance in ATR units and a confirmation candle, the extension target
// (tgt.type FIB) and the backtester's limit-at-level fill (RuleSet.fill = "LEVEL").
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { swings, atr } = await import("./indicators.mjs");
const { RuleBook, validateRules, swingParamsOf, swingSizes, describeCond } = await import("./rules.mjs");
const { riskInit, normaliseRisk, describeRisk } = await import("./risk.mjs");
const { simulateRules } = await import("./backtest.mjs");
const { mkData, tradingDays, flat } = await import("./rb_helpers.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

// A price path on candles of range 1 (ATR ≈ 1): 30 flat, up 100 → 120 over 20 candles, down to 110 over 10, up to 130.
const path = [];
for (let i = 0; i < 30; i++) path.push(100);
for (let i = 1; i <= 20; i++) path.push(100 + i);
for (let i = 1; i <= 10; i++) path.push(120 - i);
for (let i = 1; i <= 20; i++) path.push(110 + i);
const bars = path.map((c, i) => ({ o: i ? path[i - 1] : c, h: Math.max(c, i ? path[i - 1] : c) + 0.5, l: Math.min(c, i ? path[i - 1] : c) - 0.5, c }));

t("zigzag: the up swing 100 → 120 is known once price has fallen 2 ATR from the high, not before", () => {
  const sw = swings(bars, 0, 2, 5, 14);
  const a = atr(bars, 14);
  const up = sw.list.find((s) => s.dir === 1 && Math.abs(s.hi - 120.5) < 1e-9);
  assert.ok(up, "an up swing to the high 120.5 exists");
  assert.ok(Math.abs(up.lo - 99.5) < 1e-9, "from the low 99.5");
  assert.equal(up.iHi, 49, "the high candle");
  assert.ok(up.at > up.iHi && 120.5 - bars[up.at].l >= 2 * a[up.at], "confirmed only after a 2-ATR fall");
  assert.ok(sw.last[up.at - 1] < sw.list.indexOf(up), "not known a candle earlier");
  const dn = sw.list.find((s) => s.dir === -1 && s.hi === 120.5);
  assert.ok(dn && Math.abs(dn.lo - 109.5) < 1e-9, "then the down swing 120.5 → 109.5");
});
t("fractal mode: highs and lows alternate, confirmed n candles later", () => {
  const sw = swings(bars, 1, 2, 3, 14);
  const up = sw.list.find((s) => s.dir === 1 && s.hi === 120.5);
  assert.ok(up && up.at === up.iHi + 3, "the high is known 3 candles after it");
  for (let i = 1; i < sw.list.length; i++) assert.notEqual(sw.list[i].dir, sw.list[i - 1].dir, "swings alternate");
});
t("swingSizes / swingParamsOf: the size of the last completed swing, with the rule book's own settings", () => {
  const rules = { long: { mode: "ALL", conds: [{ ind: "FIB", tf: "base", p: { mode: 0, k: 2, tol: 0.2 }, op: "pullback_to_50" }] } };
  assert.deepEqual(swingParamsOf(rules), { mode: 0, k: 2, n: 5 });
  assert.deepEqual(swingParamsOf({ long: { mode: "ALL", conds: [] } }), { mode: 0, k: 2, n: 5 });
  const sz = swingSizes(bars, swingParamsOf(rules));
  assert.equal(sz[40], 0, "no swing yet"); assert.ok(Math.abs(sz[60] - 21) < 1e-9, "the 99.5 → 120.5 swing (21 points)");
});

// Intraday candles: one day of the same path (75 candles) as 5-minute bars.
const days = tradingDays("2026-10-05", 2);
// Candle 60 (the first up candle after the fall to 110) is given a low of 110.3: just above the 50% level, inside a 0.2-ATR tolerance.
const q = (d, i) => days.indexOf(d) === 0 ? flat(100, 100.5, 99.5) : i === 60 ? { o: 110, h: 111.5, l: 110.3, c: 111 } : bars[Math.min(i, bars.length - 1)];
const data = mkData(days, q);
const frames = data.frames([5]), seg = "IDX_I";
const bk = (op, p = { mode: 0, k: 2, tol: 0.2 }, side = "long") => new RuleBook(validateRules({ [side]: { mode: "ALL", conds: [{ ind: "FIB", tf: "base", p, op }] } }), 5, frames, data.daily, data.baseByDay, seg);
const T = (i) => frames.get(5).find((b) => b.day === days[1] && b.startMin === 555 + 5 * i).endT;
t("pullback to the 50% level: within the tolerance and closing up → true; no confirmation → false", () => {
  // Up swing 99.5 → 120.5: 50% level 110. Candle 59 closes at 110 (falling, o 111 → c 110): touches the level but closes down.
  assert.equal(bk("pullback_to_50").at(T(59)).long, false, "the candle closes down: no confirmation");
  // Candle 60 opens 110, closes 111: low 110.3 within 0.2×ATR of 110, closes up.
  assert.equal(bk("pullback_to_50").at(T(60)).long, true);
  assert.equal(bk("pullback_to_382").at(T(60)).long, false, "38.2% level is 112.5: 110.3 → 111 is not within the tolerance");
  assert.equal(bk("pullback_to_618").at(T(60)).long, false);
  assert.equal(bk("rally_to_50").at(T(60)).long, false, "a rally op needs a down swing");
  assert.equal(bk("pullback_to_50", { mode: 0, k: 2, tol: 0.05 }).at(T(60)).long, false, "a tighter tolerance misses it (low 110.3 stays 0.3 above the level)");
});
t("in the 38.2–61.8 zone; a swing failure through 78.6%", () => {
  assert.equal(bk("in_zone_bull").at(T(58)).long, true, "close 112 is inside 107.5–112.5");
  assert.equal(bk("in_zone_bull").at(T(55)).long, false, "close 115 is above the zone");
  assert.equal(bk("broke_down_786").at(T(60)).long, false, "111 is above the 78.6% level 104");
});
t("levelFor hands the retracement level to a limit fill", () => {
  assert.ok(Math.abs(bk("pullback_to_50").levelFor("long", T(60)) - 110) < 1e-9);
  assert.equal(bk("in_zone_bull").levelFor("long", T(60)), null);
});
t("Fibonacci target: value % of the swing from the entry; off without a known swing; target only, underlying only", () => {
  const r = normaliseRisk({ basis: "UNDERLYING", sl: { type: "PCT", value: 1 }, tgt: { type: "FIB", value: 161.8 } }, false);
  assert.equal(r.tgt.type, "FIB");
  const rs = riskInit(r, 1, 110, 1, 0, 21);
  assert.ok(Math.abs(rs.tgt - (110 + 1.618 * 21)) < 1e-9); assert.ok(Math.abs(rs.stop - 108.9) < 1e-9);
  assert.equal(riskInit(r, -1, 110, 1, 0, 21).tgt, 110 - 1.618 * 21);
  assert.equal(riskInit(r, 1, 110, 1, 0, 0).tgt, null, "no swing known: the target is off, the stop stays");
  assert.equal(riskInit(normaliseRisk({ basis: "UNDERLYING", tgt: { type: "FIB", value: 100 } }, false), 1, 110, 1, 0, 0), null, "nothing left to watch");
  assert.equal(normaliseRisk({ basis: "UNDERLYING", sl: { type: "FIB", value: 100 } }, false), null, "FIB is a target type only");
  assert.equal(normaliseRisk({ basis: "PREMIUM", tgt: { type: "FIB", value: 100 } }, true), null, "not on the premium");
  assert.match(describeRisk(r), /target 161.8% of the swing \(Fibonacci\)/);
});

// --- the backtester: limit-at-level fills (through a previous-day-high breakout, whose level is known in advance)
const cfg = (fill, extra = {}) => ({
  strategy_kind: "RULES", underlying: "NIFTY", data_security_id: "13", data_segment: seg, data_instrument: "INDEX", exchange: "NSE", dhan_symbol: "NIFTY",
  timeframe_min: 5, direction: "LONG_ONLY", entry_mode: "FLIP", session_start: "09:15", last_entry: "15:00", square_off: "15:15", intraday: true,
  trade_type: "FUTURES", option_side: "BUY", lots: 1, lot_size: 65, qty_mode: "LOTS", strike_step: 50, strike_offset: 0, risk: null,
  rules: { long: { mode: "ALL", conds: [{ ind: "PDHL", tf: "base", op: "cross_above_pdh" }], ...(fill ? { fill } : {}) }, exitLong: { mode: "ANY", conds: [{ ind: "TIME", tf: "base", p: { from: 14, to: 15 }, op: "in_hours" }] } }, ...extra,
});
// Day 1: 100–110 (pdh 110). Day 2: 108 … candle 5 closes 112 (the break); candle 6 dips to 109.5 then closes 111 (the limit fills at 110).
const d2 = tradingDays("2026-10-05", 2);
const mk = (dip) => mkData(d2, (d, i) => d === d2[0] ? (i === 0 ? { o: 100, h: 110, l: 100, c: 105 } : flat(105)) : i < 5 ? flat(108) : i === 5 ? { o: 108, h: 112.5, l: 108, c: 112 } : i === 6 ? (dip ? { o: 112, h: 112, l: 109.5, c: 111 } : { o: 112, h: 113, l: 111.5, c: 112.8 }) : flat(113));
t("LEVEL fill: the limit at the previous-day high fills in the next candle at the level", () => {
  const plans = simulateRules(cfg("LEVEL"), mk(true), d2[0], d2[1]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].spotIn, 110); assert.equal(plans[0].entryMin, 555 + 30, "candle 6 (09:45)"); assert.match(plans[0].why, /limit at 110 filled/);
  const close = simulateRules(cfg(undefined), mk(true), d2[0], d2[1]);
  assert.equal(close[0].spotIn, 112, "a close fill takes the signal candle's close"); assert.equal(close[0].entryMin, 555 + 30, "at the end of candle 5 (09:45)");
});
t("LEVEL fill: not reached in the next candle → filled at that candle's close (priced like every close fill: the next base candle's open)", () => {
  const plans = simulateRules(cfg("LEVEL"), mk(false), d2[0], d2[1]);
  assert.equal(plans.length, 1); assert.equal(plans[0].spotIn, 113); assert.equal(plans[0].entryMin, 555 + 35); assert.match(plans[0].why, /not reached; filled at the close/);
});
t("LEVEL fill with a Fibonacci target: the target is set from the swing at entry", () => {
  const c = cfg("LEVEL", { risk: { basis: "UNDERLYING", sl: { type: "PCT", value: 1 }, tgt: { type: "FIB", value: 100 } } });
  const plans = simulateRules(c, mk(true), d2[0], d2[1]);
  assert.equal(plans.length, 1); assert.equal(plans[0].spotIn, 110);
  // the swing detector (default 2×ATR) sees no completed swing in two flat-then-rising days: target off, the stop stays → the exit is the time rule
  assert.match(plans[0].exitWhy, /Exit-long rules met/);
});
t("validateRules: LEVEL on entries only, not for once-a-day strategies", () => {
  assert.throws(() => validateRules({ long: { mode: "ALL", conds: [{ ind: "PDHL", tf: "D", op: "above_pdh" }], fill: "LEVEL" }, daily: true }), /intraday candles/);
  assert.throws(() => validateRules({ long: { mode: "ALL", conds: [{ ind: "RSI", tf: "base", op: "gt", v: 50 }] }, exitLong: { mode: "ANY", conds: [{ ind: "RSI", tf: "base", op: "lt", v: 40 }], fill: "LEVEL" } }), /entries only/);
  assert.throws(() => validateRules({ long: { mode: "ALL", conds: [{ ind: "RSI", tf: "base", op: "gt", v: 50 }], fill: "MARKET" } }), /close or as a limit/);
  assert.equal(describeCond({ ind: "FIB", tf: "base", p: { mode: 0, k: 2, tol: 0.2 }, op: "pullback_to_618" }), "Fibonacci (2×ATR swings, tolerance 0.2×ATR) own timeframe pulls back to the 61.8% level and closes up");
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
