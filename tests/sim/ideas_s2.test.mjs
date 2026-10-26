// Ideas lab stage 2 (finalists only): 100 runs of the whole portfolio on shuffled candles and 1,000 sets of random
// entries; the real result must beat 95% of each.
import assert from "node:assert";
import { createClient, db } from "./fakesb.mjs";
import { ideasStep, stage2Verdict, weightedRandomEntries } from "./ideas.mjs";

// --- random entries: well-timed trades beat random ones; badly timed don't
const closes = Array.from({ length: 400 }, (_, i) => ({ t: i, c: 100 + 10 * Math.sin(i / 10) }));
const lows = [], highs = [];
for (let i = 1; i < 380; i++) { const d = closes[i].c - closes[i - 1].c, d2 = closes[i + 1].c - closes[i].c; if (d < 0 && d2 >= 0) lows.push(i); if (d > 0 && d2 <= 0) highs.push(i); }
const good = weightedRandomEntries([{ closes, trades: lows.map((i) => ({ e: i, x: i + 15, dir: 1, w: 2 })) }], 1000, 1);
const bad = weightedRandomEntries([{ closes, trades: highs.map((i) => ({ e: i, x: i + 15, dir: 1, w: 2 })) }], 1000, 1);
console.log("timed at lows →", good, "timed at highs →", bad);
assert.ok(good.p <= 0.05 && good.real > good.median && bad.p > 0.9);
console.log("ok   weighted random entries");

const v0 = { passed: false, finalist: true, why: ["passed every test so far: waiting for the shuffled-price and random-entry tests"], score: 80 };
assert.ok(stage2Verdict(v0, { p: 0.01, runs: 100 }, { p: 0.02, runs: 1000 }).passed);
assert.match(stage2Verdict(v0, { p: 0.3, runs: 100 }, { p: 0.02, runs: 1000 }).why.join(" | "), /does no better than noise: 30% of 100 runs/);
assert.match(stage2Verdict(v0, { p: 0.01, runs: 100 }, { p: 0.4, runs: 1000 }).why.join(" | "), /random entries did as well: 40%/);
console.log("ok   final verdict from stage 2");

// --- end to end: strong persistent trends make trend-following finalists; shuffled candles lose the persistence
let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const at = (d) => Date.parse(`${d}T00:00:00+05:30`) / 1000;
const col = (rows) => ({ t: rows.map((r) => r.t), o: rows.map((r) => r.o), h: rows.map((r) => r.h), l: rows.map((r) => r.l), c: rows.map((r) => r.c) });
const synth = (base) => {
  const out = []; let c = base, drift = 0.004 * (rnd() < 0.5 ? 1 : -1), left = 60 + Math.floor(rnd() * 120);
  for (let d = Date.parse("2015-06-01"); d <= Date.parse("2026-10-23"); d += 86400000) {
    const wd = new Date(d).getUTCDay(); if (wd === 0 || wd === 6) continue;
    if (--left <= 0) { drift = -drift; left = 60 + Math.floor(rnd() * 120); }
    const o = c; c = c * Math.exp(drift + (rnd() - 0.5) * 0.008);
    out.push({ t: at(new Date(d).toISOString().slice(0, 10)), o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c });
  }
  return out;
};
db.lab_candles = [["GOLDM", 30000], ["SILVERM", 40000], ["CRUDEOILM", 5000], ["NIFTY", 8000], ["BANKNIFTY", 18000]].map(([a, b]) =>
  ({ asset: a, kind: "D", from_day: "2015-06-01", to_day: "2026-10-23", stored: false, bars: col(synth(b)) }));
db.lab_settings = [{ id: 1, ideas_enabled: true, ideas_capital: 3500000, ideas_per_day: 0, paused_until: null }];
db.lab_runs = []; db.algo_strategies = []; db.market_holidays = []; db.idea_tries = []; db.idea_legs = []; db.margin_rates = [];
const sb = createClient();
const real = Date.now; Date.now = () => Date.parse("2026-10-24T12:00:00+05:30");
let last, steps = 0;
const t0 = performance.now();
for (; steps < 3000; steps++) {
  last = await ideasStep(sb, Date.now());
  if (last.idle || (db.idea_tries.filter((t) => t.idea === "trend").every((t) => t.status === "done"))) break;
}
Date.now = real;
const tr = db.idea_tries.filter((t) => t.idea === "trend");
console.log(`trend decided in ${steps} steps, ${Math.round((performance.now() - t0) / 1000)} s`);
for (const t of tr) console.log(t.setting_key.padEnd(12), t.verdict.passed ? "PASSED" : t.verdict.finalist ? "finalist→failed" : "failed", t.verdict.stage2 ? JSON.stringify({ noise: t.verdict.stage2.noise && t.verdict.stage2.noise.p, random: t.verdict.stage2.random && t.verdict.stage2.random.p }) : "", t.verdict.why[0] || "");
const fin = tr.filter((t) => t.verdict.finalist);
assert.ok(fin.length >= 1, "strong trends give finalists");
assert.ok(fin.every((t) => t.status === "done" && t.verdict.stage2 && t.verdict.stage2.noise && t.verdict.stage2.noise.runs === 100 && t.verdict.stage2.random.runs === 1000), "every finalist went through both stage-2 tests");
assert.ok(fin.some((t) => t.verdict.passed && t.verdict.stage2.noise.p <= 0.05 && t.verdict.stage2.random.p <= 0.05), "a real edge beats shuffled prices and random entries");
assert.ok(db.idea_legs.filter((l) => l.kind === "real").every((l) => l.result == null), "real legs' trades cleared once decided");
console.log("ok   end to end: finalists → 100 shuffled runs + random entries → final verdict");
console.log("all passed");
