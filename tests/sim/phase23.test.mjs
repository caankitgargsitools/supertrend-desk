// Stricter lab phase 2 (noise tests, overfitting gauge) and phase 3 (kill rule).
import assert from "node:assert";
import { pbo } from "./stats.mjs";
import { pValue, randomEntries, seeded, shuffledData } from "./noise.mjs";
import { killVerdict } from "./kill.mjs";
import { generate, packTrades, robustVerdict } from "./lab.mjs";

// --- overfitting gauge: pure noise ≈ 50%; one strategy genuinely better in every month ≈ 0%
const rnd = seeded(3), gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
// (one noise table can land far from 50% by chance, as all 924 splits share it: averaged over 20 tables)
const table = () => Array.from({ length: 40 }, () => Array.from({ length: 12 }, () => gauss() * 1000));
const tables = Array.from({ length: 20 }, table);
const avgN = tables.reduce((a, t) => a + pbo(t).pbo, 0) / tables.length;
const avgS = tables.reduce((a, t) => a + pbo(t.map((row, k) => k === 0 ? row.map((x) => x + 2500) : row)).pbo, 0) / tables.length;
console.log("gauge: noise", avgN.toFixed(3), "with a real edge", avgS.toFixed(3), "splits", pbo(tables[0]).splits);
assert.ok(avgN > 0.35 && avgN < 0.65 && avgS < 0.1 && pbo(tables[0]).splits === 924);
assert.equal(pbo([[1, 2, 3, 4]]), null, "too few strategies");
console.log("ok   overfitting gauge");

// --- shuffled candles keep the moves, change their order, repeatable by seed
const day = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
let px = 100; const daily = Array.from({ length: 300 }, (_, i) => { const o = px; px *= 1 + 0.01 * Math.sin(i / 9) + 0.002; return { t: Date.parse(day(i) + "T00:00:00+05:30") / 1000, o, h: Math.max(o, px) * 1.004, l: Math.min(o, px) * 0.996, c: px, v: 0, day: day(i) }; });
const data = { raw: [], byDay: new Map(), daily };
const a = shuffledData(data, true, 7), b = shuffledData(data, true, 7), c = shuffledData(data, true, 8);
const moves = (d) => d.daily.slice(1).map((x, i) => Math.log(x.c / d.daily[i].c).toFixed(9)).sort().join();
assert.equal(a.daily.length, 300); assert.equal(moves(a), moves(data)); assert.deepEqual(a.daily, b.daily); assert.notDeepEqual(a.daily, c.daily);
assert.ok(a.daily.every((x) => x.h >= Math.max(x.o, x.c) - 1e-9 && x.l <= Math.min(x.o, x.c) + 1e-9));
// minute candles: opening gaps stay at session opens; daily candles rebuilt from them
const raw = []; let q = 100;
for (let d = 0; d < 20; d++) for (let m = 0; m < 75; m++) { const o = q; q *= 1 + (m === 0 ? 0.01 : 0.0005) * Math.sin(d + m); const t = Date.parse(`${day(d)}T09:15:00+05:30`) / 1000 + m * 300; raw.push({ t, o, h: Math.max(o, q), l: Math.min(o, q), c: q, day: day(d), min: 555 + m * 5 }); }
const md = shuffledData({ raw, byDay: new Map(), daily: [] }, false, 5);
assert.equal(md.raw.length, raw.length); assert.equal(md.byDay.size, 20); assert.equal(md.daily.length, 20);
assert.ok(Math.abs(md.daily[19].c - md.raw.at(-1).c) < 1e-9);
console.log("ok   shuffled candles: same moves, new order, repeatable");

// --- p-value and random entries
assert.equal(pValue(10, [1, 2, 3]), 0.25); assert.equal(pValue(0, [1, 2, 3]), 1);
const closes = daily.map((d) => ({ t: d.t, c: d.c }));
// "perfect foresight": long only where the next 5 days rise
const fore = []; for (let i = 0; i + 5 < closes.length; i += 6) { const up = closes[i + 5].c > closes[i].c; fore.push({ entry: day(i), exit: day(i + 5), side: up ? "LONG" : "SHORT", entry_px: closes[i].c, exit_px: closes[i + 5].c }); }
const rf = randomEntries(fore, closes, 1000, 1);
const coin = fore.map((t, i) => ({ ...t, side: i % 2 ? "LONG" : "SHORT", entry_px: undefined, exit_px: undefined }));
const rc = randomEntries(coin, closes, 1000, 1);
console.log("random entries: foresight p", rf.p, "coin p", rc.p);
assert.ok(rf.p < 0.01 && rc.p > 0.05);
console.log("ok   random-entry test");

// --- kill rule
const bt = Array.from({ length: 200 }, (_, i) => (i % 3 ? -1000 : 2600)); // backtest: +200 a trade
assert.equal(killVerdict(Array(9).fill(-5000), bt).flag, false, "fewer than 10 trades: not judged");
assert.equal(killVerdict(Array.from({ length: 20 }, (_, i) => bt[i]), bt).flag, false, "trading like its backtest");
const bad = killVerdict(Array(20).fill(-1000), bt);
console.log("kill: 20 losing trades", bad);
assert.ok(bad.flag && bad.real === -20000 && bad.p5 > -20000);
assert.ok(!killVerdict(Array(10).fill(-1000), bt).flag, "10 straight losses happen 1.7% of the time here: not yet");
assert.ok(killVerdict(Array(12).fill(-1000), bt).flag, "12 straight losses (0.8%): below the worst 1%");
console.log("ok   kill rule");

// --- two-stage verdict: a strategy passing everything waits for the noise tests, then they decide
const gold = generate("GOLD", 11), cfg = { ...gold, rules: { ...gold.rules, daily: true } };
const strong = Array.from({ length: 120 }, (_, i) => (i % 10 < 7 ? 900 : -300));
const years = Array.from({ length: 10 }, (_, k) => { const y = 2025 - k, ts = Array.from({ length: 12 }, (_, i) => ({ entry: `${y}-${String(i + 1).padStart(2, "0")}-10 09:30`, exit: `${y}-${String(i + 1).padStart(2, "0")}-12 15:00`, side: "LONG", entry_px: 100, exit_px: 101, net: strong[(k * 12 + i) % 120], exit_why: "x" }));
  return { kind: "year", asset: "GOLD", tf: k + 1, result: { ok: true, net: ts.reduce((s, t) => s + t.net, 0), xcost: 10, from: `${y}-01-01`, to: `${y}-12-31`, tr: packTrades(ts) } }; });
const base = [{ kind: "self", asset: "GOLD", tf: null, result: { net: 50000, max_dd: 10000 } }, { kind: "asset", asset: "SILVER", tf: null, result: { ok: true } },
  { kind: "tf", asset: "GOLD", tf: 60, result: { ok: true } }, ...years, ...Array.from({ length: 8 }, () => ({ kind: "step", asset: "GOLD", tf: null, result: { ok: true, net: 45000, n: 20 } })),
  { kind: "vault", asset: "GOLD", tf: null, result: { net: 9000, n: 3, ok: true } }];
const s1 = robustVerdict(cfg, base, { families: 5219, strict: true });
assert.ok(!s1.passed && s1.needs_stage2 && /waiting for the noise tests/.test(s1.why[0]));
const nz = (realNet, shuffledNet) => [{ kind: "noise", asset: "GOLD", tf: 0, result: { net: realNet } }, ...Array.from({ length: 100 }, (_, k) => ({ kind: "noise", asset: "GOLD", tf: k + 1, result: { net: shuffledNet(k) } }))];
const good = robustVerdict(cfg, [...base, ...nz(80000, (k) => k * 500 - 20000), { kind: "random", asset: "GOLD", tf: null, result: { p: 0.01, real: 500 } }], { families: 5219, strict: true });
console.log("finalist, beats noise →", good.passed, good.noise);
assert.ok(good.passed && good.noise.p < 0.05);
const fake = robustVerdict(cfg, [...base, ...nz(30000, (k) => k * 1000 - 20000), { kind: "random", asset: "GOLD", tf: null, result: { p: 0.3, real: 500 } }], { families: 5219, strict: true });
console.log("finalist, noise does as well →", fake.why);
assert.ok(!fake.passed && /does no better than noise/.test(fake.why.join()) && /random entries did as well: 30%/.test(fake.why.join()));
console.log("ok   two-stage verdict");
console.log("all passed");
