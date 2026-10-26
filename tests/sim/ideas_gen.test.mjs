// Ideas lab, version 1 of the idea generator: ideas assembled from research building blocks, fixed in advance,
// 4 settings each; the first generated idea is the near-misses combined into one portfolio.
import assert from "node:assert";
import { createClient, db } from "./fakesb.mjs";
import { COMBO_1, combineCombo, generatedIdeas, ideaConfig, ideaRules, ideasStep, LAB_ASSETS } from "./ideas.mjs";

const gen = generatedIdeas();
assert.equal(gen.length, 8 * 5 * 5 * 2 - 4, "8 signals × 5 filters × 5 markets × 2 directions, minus the 4 the research list covers");
assert.equal(new Set(gen.map((g) => g.key)).size, gen.length, "unique keys");
assert.deepEqual(generatedIdeas().map((g) => g.key), gen.map((g) => g.key), "the order is fixed in advance");
assert.ok(!gen.some((g) => g.key === "g-ema-none-all-both" || g.key === "g-rsirev-none-index-both"), "research ideas aren't repeated");
for (const g of gen) {
  assert.equal(g.settings.length, 4);
  for (const s of g.settings) {
    const { rules, entry } = ideaRules(g.key, s.p);
    ideaConfig(g.universe.includes("GOLD") ? "GOLD" : "NIFTY", rules, { entry }); // valid rules
    if (g.key.endsWith("-long")) assert.equal(rules.short.conds.length, 0, "long only: no shorts");
  }
}
console.log("ok   generator:", gen.length, "ideas, e.g.", gen.slice(0, 3).map((g) => g.name));

// --- the combined portfolio: capital shares, years only while every part has history, parts recorded
const leg = (part, k, e, x, n, a, first, q) => ({ asset: k, config: { part }, result: { n: 1, first, last: "2026-10-24", atr_med: a ? { [k]: a } : {}, t: { k: [k], e: [e], x: [x], s: ["L"], n: [n], sl: [10], a: [a || 0], ...(q ? { q: [q] } : {}) } } });
const legs = [
  leg(0, "GOLDM", "2017-01-05 09:00", "2017-02-05 23:00", 1000, 2000, "2016-03-01"),  // trend, from 2016 (before the options start: left out)
  leg(0, "GOLDM", "2023-01-05 09:00", "2023-02-05 23:00", 1000, 2000, "2016-03-01"),
  leg(1, "NIFTY", "2022-01-07 09:30", "2022-01-13 14:30", 500, 0, "2021-11-01", 10),   // option trade, 10 lots on the full capital
];
const c = combineCombo(legs, { parts: [["trend", "don-20-10"], ["optsell", "ic-1.5sd-sl"]], w: "capital" }, { today: "2026-10-24" });
assert.equal(c.from, "2021-11-01", "counted from when every part has history");
assert.equal(c.trades, 2, "the 2017 trend trade is before the combined history");
assert.deepEqual(c.parts.map((x) => x.w), [0.5, 0.5]);
assert.equal(c.parts[1].lots.NIFTY, 5, "option lots scale with the part's capital (10 → 5)");
assert.equal(c.parts[0].lots.GOLDM, Math.round(3500000 * 0.5 * 0.002 / 2000), "trend sized on half the capital");
assert.equal(c.net, 1000 * c.parts[0].lots.GOLDM + 500 * 5);
assert.ok(c.parts[1].options && !c.parts[0].options);
const r = combineCombo([...legs, leg(1, "NIFTY", "2022-03-07 09:30", "2022-03-13 14:30", -800, 0, "2021-11-01", 10)], { parts: [["trend", "x"], ["optsell", "y"]], w: "risk" }, { today: "2026-10-24" });
assert.ok(Math.abs(r.parts[0].w + r.parts[1].w - 1) < 0.01 && r.parts[0].w !== 0.5, "split by risk");
console.log("ok   combined portfolio: capital shares, common history, option lots scaled");

// --- end to end: the first instalment generates (combo first), then each generated idea is tested and decided
let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const at = (d) => Date.parse(`${d}T00:00:00+05:30`) / 1000;
const col = (rows) => ({ t: rows.map((x) => x.t), o: rows.map((x) => x.o), h: rows.map((x) => x.h), l: rows.map((x) => x.l), c: rows.map((x) => x.c) });
const synth = (base) => { const out = []; let cl = base, dr = 0.002; for (let d = Date.parse("2015-06-01"); d <= Date.parse("2026-10-23"); d += 86400000) { const wd = new Date(d).getUTCDay(); if (!wd || wd === 6) continue; if (rnd() < 1 / 100) dr = -dr; const o = cl; cl *= Math.exp(dr + (rnd() - 0.5) * 0.02); out.push({ t: at(new Date(d).toISOString().slice(0, 10)), o, h: Math.max(o, cl) * 1.003, l: Math.min(o, cl) * 0.997, c: cl }); } return out; };
db.lab_candles = [["GOLDM", 30000], ["NIFTY", 8000], ["BTCUSD", 9000]].map(([a, b]) => ({ asset: a, kind: "D", from_day: "2015-06-01", to_day: "2026-10-23", stored: false, bars: col(synth(b)) }));
LAB_ASSETS.BTCUSD = { key: "BTCUSD", name: "Bitcoin", seg: "DELTA", sec: "BTCUSD", instr: "PERP", exchange: "DELTA", lot: 88 * 0.001, commodity: false, crypto: true };
db.lab_settings = [{ id: 1, ideas_enabled: true, ideas_capital: 3500000, ideas_per_day: 3, paused_until: null }];
db.lab_runs = []; db.algo_strategies = []; db.market_holidays = []; db.idea_tries = []; db.idea_legs = []; db.margin_rates = []; db.idea_defs = [];
// The research ideas are already decided (as in production), so the generated ones come next.
const sb = createClient();
const real = Date.now; Date.now = () => Date.parse("2026-10-27T01:00:00+05:30");
await ideasStep(sb, Date.now());
assert.deepEqual(db.idea_defs.map((d) => d.key)[0], COMBO_1.key, "the combined near-misses come first");
assert.equal(db.idea_defs.length, 3, "3 a day (the setting)");
for (const t of db.idea_tries.filter((t) => !db.idea_defs.some((d) => d.key === t.idea))) t.status = "done";
let last, steps = 0;
for (; steps < 3000; steps++) { last = await ideasStep(sb, Date.now()); if (last.idle) break; }
Date.now = real;
const gt = db.idea_tries.filter((t) => db.idea_defs.some((d) => d.key === t.idea));
console.log("generated ideas decided in", steps, "steps:", db.idea_defs.map((d) => d.name));
assert.equal(last.idle, "every idea is done");
assert.equal(gt.length, 6 + 4 + 4, "combo 6 settings, two generated ideas with 4 each");
assert.ok(gt.every((t) => t.status === "done" && t.verdict && t.verdict.luck.tries > 47 + 8), "decided; the luck test counts the new settings too (each idea by its effective tries)");
assert.ok(gt.filter((t) => t.idea === "combo-1").every((t) => t.result.parts && t.result.parts.length >= 2), "combined settings record their parts");
// The day's quota is used up: no more ideas today
Date.now = () => Date.parse("2026-10-27T02:00:00+05:30");
await ideasStep(sb, Date.now());
assert.equal(db.idea_defs.length, 3, "no more than the day's quota");
Date.now = () => Date.parse("2026-10-28T01:00:00+05:30");
await ideasStep(sb, Date.now());
Date.now = real;
assert.equal(db.idea_defs.length, 6, "the next day brings the next 3");
console.log("ok   end to end: daily generation, combined portfolio first, generated ideas tested and decided");
console.log("all passed");
