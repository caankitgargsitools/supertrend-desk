// Ideas lab (step 3): ideas fixed in advance, portfolios across assets sized by risk, honest counting of tries.
import assert from "node:assert";
import { createClient, db } from "./fakesb.mjs";
import { IDEAS, combineTry, effectiveTries, ideaConfig, ideaRules, ideaVerdict, ideasStep, ledgerTries, legsFor, pickContracts, relStrengthTrades, seasonTrades } from "./ideas.mjs";

// --- every setting of every rule-based idea is a valid strategy
for (const idea of IDEAS.filter((i) => i.kind === "rules")) {
  for (const s of idea.settings) {
    const { rules, entry, intraday } = ideaRules(idea.key, s.p);
    const cfg = ideaConfig(idea.universe.includes("GOLD") ? "GOLD" : "NIFTY", rules, { entry, intraday });
    assert.equal(cfg.direction, "BOTH"); assert.equal(cfg.intraday, intraday);
  }
}
const nTries = IDEAS.reduce((a, i) => a + i.settings.length, 0);
assert.equal(nTries, 47, "47 settings registered across the 7 ideas");
console.log("ok   7 ideas, 47 settings, every rule setting valid");

// --- legs: daily ideas one per asset; 5-minute ideas one per asset per year
const trend = IDEAS.find((i) => i.key === "trend"), orb = IDEAS.find((i) => i.key === "orb");
assert.equal(legsFor(trend, trend.settings[0], "2026-10-24", new Set(["GOLD", "GOLDM", "NIFTY"])).length, 3);
assert.equal(legsFor(orb, orb.settings[0], "2026-10-24", new Set(["NIFTY"])).length, 5);
console.log("ok   legs per setting");

// --- contract choice: the contract whose lot fits the risk budget (₹7,000 a day at ₹35 lakh)
const pick = pickContracts(["GOLD", "GOLDM", "SILVER", "SILVERM", "SILVERMIC", "NICKEL"], { GOLD: 60000, GOLDM: 6000, SILVER: 54000, SILVERM: 9000, SILVERMIC: 1800, NICKEL: 30000 }, 7000);
assert.equal(pick.get("GOLD"), "GOLDM", "gold: the mini (1 kg is ~9× the budget)");
assert.equal(pick.get("SILVER"), "SILVERMIC", "silver: 4 micro lots fit best");
assert.equal(pick.get("NICKEL"), "NICKEL", "only one contract: kept even if too big");
console.log("ok   contract choice (minis where the big lot is too big)");

// --- combining: lots by ATR at entry, months, years, vault apart
const legs = [{ asset: "GOLDM", result: { n: 3, first: "2016-01-01", last: "2026-10-24", atr_med: { GOLDM: 3500, GOLD: 35000 },
  t: { k: ["GOLDM", "GOLDM", "GOLDM"], e: ["2024-01-05 09:00", "2025-03-02 09:00", "2026-08-01 09:00"], x: ["2024-01-20 23:00", "2025-03-20 23:00", "2026-08-20 23:00"],
    s: ["L", "S", "L"], n: [1000, -500, 800], sl: [100, 100, 100], a: [3500, 7000, 3500] } } }];
const c = combineTry(legs, { today: "2026-10-24" });
assert.equal(c.contracts.GOLD, "GOLDM"); assert.equal(c.lots.GOLDM, 2);
assert.equal(c.trades, 2, "the August 2026 trade is in the vault"); assert.equal(c.net, 2000 - 500, "2 lots, then 1 lot when the ATR doubled");
assert.deepEqual(c.vault, { from: "2026-04-26", to: "2026-10-24", net: 1600, n: 1 });
assert.equal(c.months["2024-01"], 2000); assert.equal(c.months["2025-03"], -500); assert.equal(c.months["2016-01"], 0);
assert.equal(c.years_n, 10); assert.equal(c.years.find((y) => y.y === 1).net, 0); assert.equal(c.years.find((y) => y.y === 2).net, -500); assert.equal(c.years.find((y) => y.y === 3).net, 2000);
console.log("ok   portfolio: sizing by ATR at entry, months, years, vault kept apart");

// --- honest counting: settings that move together count as fewer tries
let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const months = Array.from({ length: 100 }, (_, i) => `20${String(17 + Math.floor(i / 12)).padStart(2, "0")}-${String((i % 12) + 1).padStart(2, "0")}`);
const ser = (f) => Object.fromEntries(months.map((m) => [m, f()]));
const base = ser(() => rnd() - 0.5);
assert.ok(effectiveTries([base, base, base, base]).n < 1.01, "identical settings: one try");
const ind = effectiveTries(Array.from({ length: 6 }, () => ser(() => rnd() - 0.5)));
assert.ok(ind.n > 5, `unrelated settings: about 6 tries (${ind.n})`);
assert.equal(ledgerTries([{ idea: "a", status: "done" }, { idea: "a", status: "done" }, { idea: "b", status: "planned" }], { a: 1.4 }), 2);
console.log("ok   effective tries", ind);

// --- verdicts
const good = (over = {}) => {
  const ms = {}; months.forEach((m, i) => { ms[m] = 60000 + (i % 7 === 0 ? -90000 : 20000) + Math.round((rnd() - 0.5) * 40000); });
  const years = Array.from({ length: 10 }, (_, k) => ({ y: k + 1, from: "", to: "", net: 400000, slip: 50000, n: 60, ok: true, stress_ok: true }));
  return { capital: 3500000, months: ms, net: 4000000, trades: 600, max_dd: 300000, per_year: 400000, calmar: 1.3, sharpe: 1.5, months_n: 100, months_pos: 80,
    years, years_ok: 10, years_n: 10, stress_net: 3500000, stress_years_ok: 10, top_cut: { dropped: 30, net: 2500000 }, vault: { net: 90000, n: 20 }, ...over };
};
const v1 = ideaVerdict(good(), { tries: 20, plateau: { ok: 7, n: 8 } });
console.log("steady portfolio →", v1.why, "luck", v1.luck.dsr, "score", v1.score);
assert.ok(v1.finalist && !v1.passed && /shuffled-price/.test(v1.why[0]));
const y7 = good(); y7.years = y7.years.map((y, i) => i < 3 ? { ...y, ok: false } : y); y7.years_ok = 7;
assert.match(ideaVerdict(y7, { tries: 20, plateau: { ok: 7, n: 8 } }).why.join(" | "), /profitable in 7 of the past 10 years \(needs 8\)/);
const y8 = good({ years_ok: 8 });
assert.ok(ideaVerdict(y8, { tries: 20, plateau: { ok: 7, n: 8 } }).finalist, "8 of 10 is enough");
assert.match(ideaVerdict(good({ vault: { net: -5000, n: 9 } }), { tries: 20, plateau: { ok: 7, n: 8 } }).why.join(" | "), /lost money in the held-back last 6 months/);
assert.match(ideaVerdict(good(), { tries: 20, plateau: { ok: 4, n: 8 } }).why.join(" | "), /only 4 of the idea's 8 settings made money/);
const noise = good({ months: ser(() => Math.round((rnd() - 0.5) * 100000)) });
assert.match(ideaVerdict(noise, { tries: 20, plateau: { ok: 7, n: 8 } }).why.join(" | "), /could be luck/);
assert.ok(ideaVerdict(y8, { tries: 20, plateau: { ok: 7, n: 8 } }).score < v1.score, "fewer profitable years, lower score");
console.log("ok   verdicts: 8 of 10 years, vault, settings, luck; years count in the score");

// --- custom ideas
const day = (i) => new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const series = (drift) => Array.from({ length: 900 }, (_, i) => { const c = 1000 * Math.exp(drift * i); return { t: i, day: day(i), o: c, h: c * 1.01, l: c * 0.99, c }; });
const rs = relStrengthTrades({ GOLDM: series(0.001), SILVERM: series(0), ZINCMINI: series(-0.001) }, { lb: 63, k: 1 }, new Map([["GOLD", "GOLDM"], ["SILVER", "SILVERM"], ["ZINC", "ZINCMINI"]]));
assert.ok(rs.n.length >= 2 && rs.k.every((k, i) => (k === "GOLDM" && rs.s[i] === "L") || (k === "ZINCMINI" && rs.s[i] === "S")), "long the riser, short the faller");
assert.ok(rs.n.every((x) => x > 0), "both legs made money");
const tom = seasonTrades("NIFTY", series(0.0005), { t: "tom", a: 4, b: 3 });
assert.ok(tom.n.length >= 28 && tom.s.every((s) => s === "L"));
const night = seasonTrades("NIFTY", series(0.0005).slice(0, 20), { t: "night", wd: 1 });
assert.ok(night.n.length > 0 && night.n.length < 19 && night.e[0].endsWith("15:30") && night.x[0].endsWith("09:15"));
console.log("ok   relative strength and calendar trades");

// --- end to end on the fake database: one idea at a time, until every buildable idea has its verdicts
const sb = createClient();
const col = (rows) => ({ t: rows.map((r) => r.t), o: rows.map((r) => r.o), h: rows.map((r) => r.h), l: rows.map((r) => r.l), c: rows.map((r) => r.c) });
const at = (d) => Date.parse(`${d}T00:00:00+05:30`) / 1000;
const synth = (start, base, sd) => {
  const out = []; let c = base, drift = 0.001;
  for (let d = Date.parse("2015-06-01"); d <= Date.parse("2026-10-23"); d += 86400000) {
    const wd = new Date(d).getUTCDay(); if (wd === 0 || wd === 6) continue;
    if (rnd() < 1 / 120) drift = -drift;
    const o = c; c = c * Math.exp(drift + (rnd() - 0.5) * sd);
    out.push({ t: at(new Date(d).toISOString().slice(0, 10)), o, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996, c });
  }
  return out;
};
const gold = synth("2015-06-01", 30000, 0.02), nifty = synth("2015-06-01", 8000, 0.02);
db.lab_candles = [
  { asset: "GOLD", kind: "D", from_day: "2015-06-01", to_day: "2026-10-23", stored: false, bars: col(gold) },
  { asset: "GOLDM", kind: "D", from_day: "2015-06-01", to_day: "2026-10-23", stored: false, bars: col(gold) },
  { asset: "NIFTY", kind: "D", from_day: "2015-06-01", to_day: "2026-10-23", stored: false, bars: col(nifty) },
];
db.lab_settings = [{ id: 1, ideas_enabled: true, ideas_capital: 3500000, paused_until: null }];
db.lab_runs = []; db.algo_strategies = []; db.market_holidays = []; db.idea_tries = []; db.idea_legs = []; db.margin_rates = [];
const real = Date.now; Date.now = () => Date.parse("2026-10-24T12:00:00+05:30");
let last, steps = 0;
for (; steps < 400; steps++) { last = await ideasStep(sb, Date.now()); if (last.idle) break; }
Date.now = real;
console.log("ideas lab finished in", steps, "steps:", last);
assert.equal(last.idle, "every idea is done");
assert.equal(db.idea_tries.length, 47, "the ledger holds every setting");
assert.equal(db.idea_tries.filter((t) => t.status === "later").length, 0, "every idea is built");
const done = db.idea_tries.filter((t) => t.status === "done");
assert.equal(done.length, 47, "every setting has its verdict");
const tr = done.filter((t) => t.idea === "trend");
assert.ok(tr.every((t) => t.result.contracts.GOLD === "GOLDM" && t.verdict.why.length && t.verdict.luck.tries >= 7), "gold traded with the mini; luck counted from the ledger");
assert.ok(tr.some((t) => t.result.trades > 0 && t.result.years_n >= 8), "trend settings traded over the years");
assert.ok(db.idea_legs.every((l) => l.result == null), "leg trades cleared once decided (kept in the settings' results)");
console.log("sample:", tr[0].label, "→", tr[0].result.net, tr[0].result.years_ok + "/" + tr[0].result.years_n, tr[0].verdict.why);
console.log("ok   end to end: ledger, one idea at a time, verdicts");
console.log("all passed");
