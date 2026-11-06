// Lab method (6 Nov 2026, audit step 11b/c): the parameter plateau folded into the consistency score as a soft
// component, and regime-conditional results (VIX tercile, ADX trend / flat, above / below the 200-day average).
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { consistencyScore, robustVerdict, packTrades } = await import("./lab.mjs");
const { regimeStats } = await import("./backtest.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

const ys = (nets) => nets.map((n, k) => ({ y: k + 1, net: n, ok: n > 0 }));
const tr = (nets) => nets.flatMap((yn, k) => Array.from({ length: 12 }, (_, i) => ({ exit: `${2025 - k}-${String(i + 1).padStart(2, "0")}-15`, net: yn / 12 })));
const steady = Array(10).fill(50000);
t("plateau: without nearby-setting results the score is as before; with them a 0–10 part is added and the rest scales to 90", () => {
  const base = consistencyScore(ys(steady), tr(steady));
  assert.ok(!("plateau" in base.parts) && base.score >= 95);
  const good = consistencyScore(ys(steady), tr(steady), null, { ok: 8, n: 8, median: 48000, self: 50000 });
  assert.ok(good.parts.plateau >= 9.5 && good.score >= 95 && good.score <= 100, JSON.stringify(good.parts));
  assert.ok(Math.abs(good.parts.years - base.parts.years * 0.9) < 0.11, "years weight scaled by 0.9");
  const bad = consistencyScore(ys(steady), tr(steady), null, { ok: 2, n: 8, median: -5000, self: 50000 });
  assert.ok(bad.parts.plateau <= 1.3 && bad.score < good.score - 8, `exact-setting result scores lower: ${bad.score} vs ${good.score}`);
  const few = consistencyScore(ys(steady), tr(steady), null, { ok: 1, n: 2, median: 1000, self: 50000 });
  assert.ok(!("plateau" in few.parts), "under 3 nearby settings: no plateau part");
});
t("robustVerdict feeds the step checks into the consistency score", () => {
  const mk = (nets) => { const ts = []; ["2025-11-15","2025-12-15","2026-01-15","2026-02-15","2026-03-15","2026-04-15","2026-05-15","2026-06-15","2026-07-15","2026-08-15","2026-09-15","2026-10-05"].forEach((d, i) => ts.push({ entry: d + " 10:00", exit: d + " 14:00", side: "LONG", entry_px: 100, exit_px: 101, net: nets[i], exit_why: "x" })); return packTrades(ts); };
  const years = Array.from({ length: 5 }, (_, k) => ({ kind: "year", asset: "NIFTY", tf: k + 1, result: { ok: true, net: 12000, xcost: 500, from: "2025-10-11", to: "2026-10-11", tr: mk(Array(12).fill(1000)) } }));
  const steps = Array.from({ length: 6 }, (_, i) => ({ kind: "step", asset: "NIFTY", tf: null, result: { note: `step ${i}`, net: i < 5 ? 11000 : -2000, ok: i < 5, n: 12 } }));
  const base = [{ kind: "self", asset: "NIFTY", tf: null, result: { net: 12000, max_dd: 3000 } }, ...years, { kind: "vault", asset: "NIFTY", tf: null, result: { net: 500, n: 2, ok: true } }];
  const cfg = { underlying: "NIFTY", rules: { daily: true }, direction: "BOTH" };
  const without = robustVerdict(cfg, base, { families: 100 }), withSteps = robustVerdict(cfg, [...base, ...steps], { families: 100 });
  assert.ok(!("plateau" in without.consistency.parts) && "plateau" in withSteps.consistency.parts);
  assert.equal(withSteps.plateau.ok, 5); assert.ok(withSteps.consistency.parts.plateau > 8);
});
// Regimes: 600 daily candles — the first 300 trend up strongly (ADX high, above the 200-day average), the last 300 chop
// around 1800 (ADX near 0; the odd days close under the 200-day average). VIX: 10–14 while trending, 18–24 while flat.
const day = (i) => new Date(Date.UTC(2023, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const daily = Array.from({ length: 600 }, (_, i) => { const c = i < 300 ? 1000 + 3 * i : 1800 + (i % 2 ? -4 : 4); return { t: i, day: day(i), o: c, h: c + 2, l: c - 2, c }; });
const vix = Array.from({ length: 600 }, (_, i) => { const c = i < 300 ? (i % 2 ? 10 : 14) : (i % 2 ? 24 : 18); return { t: i, day: day(i), o: c, h: c, l: c, c }; });
t("regimeStats files each trade under the regime of the day before its entry", () => {
  const trades = [{ entry: `${day(250)} 09:30`, net: 500 }, { entry: `${day(260)} 09:30`, net: 700 }, { entry: `${day(550)} 09:30`, net: -300 }, { entry: `${day(560)} 09:30`, net: -100 }];
  const r = regimeStats(trades, daily, vix, new Map());
  assert.deepEqual(r.adx.trend, { n: 2, net: 1200 }, "the trending-market trades"); assert.deepEqual(r.adx.flat, { n: 2, net: -400 });
  assert.deepEqual(r.trend.up, { n: 2, net: 1200 }); assert.deepEqual(r.trend.down, { n: 2, net: -400 });
  assert.deepEqual(r.vix.low, { n: 2, net: 1200 }, "VIX 10 the day before (its lowest tercile)"); assert.deepEqual(r.vix.high, { n: 2, net: -400 }, "VIX 24 the day before (its highest tercile)");
  assert.equal(regimeStats(trades, daily).vix, null, "no VIX candles: no VIX split");
  assert.equal(regimeStats([], daily), null);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
