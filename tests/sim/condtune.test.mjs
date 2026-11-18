// Condition tuning in the Strategy Lab (18 Nov 2026, Papa: "analyze … the market parameters that were prevailing when they
// actually lost the money … not to trade when this condition is there … put it as a parameter in the strategy lab … certain
// time of the day … certain days of the week"): for a set number of passed strategies a run, the lab writes versions that
// only ENTER under one market condition, each tested like any strategy. A strategy is tuned once; its versions never.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { db, createClient } = await import("./fakesb.mjs");
const { condTuneVariants, generatePhase, generate, fingerprint, labelFor, LAB_ASSETS } = await import("./lab.mjs");
const { validateRules, describeCond } = await import("./rules.mjs");
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const sb = createClient();
const pick = (asset, daily) => { for (let s = 1; s < 4000; s++) { const c = generate(asset, s, 500000, 0); if (!!c.rules.daily === daily && (c.rules.long?.conds?.length || c.rules.short?.conds?.length) && (c.rules.long?.mode ?? "ALL") === "ALL") return c; } throw new Error("none"); };
const gold = pick("GOLD", true), nifty = pick("NIFTY", false), goldMin = pick("GOLD", false);
// a coin (the crypto list is read from the database in the engine; here one entry stands in for it)
LAB_ASSETS.BTCUSD = LAB_ASSETS.BTCUSD ?? { key: "BTCUSD", crypto: true, seg: "DELTA" };
const btc = { ...JSON.parse(JSON.stringify(gold)), underlying: "BTCUSD" };
const notes = (v) => v.map((c) => c.lab_note.replace(/^Condition tuning: /, ""));

await t("daily MCX: 6 market conditions + no entries on each weekday Mon–Fri; the condition is added to the entry rules of both sides", () => {
  const v = condTuneVariants(gold);
  assert.equal(v.length, 11, notes(v).join(" | "));
  assert.ok(notes(v).includes("enter only with the 200-day average (long above it, short below)") && notes(v).includes("no entries on Mondays") && !notes(v).some((n) => /Sunday|Saturday|noon|12:00/.test(n)));
  for (const c of v) {
    validateRules(c.rules);
    for (const s of ["long", "short"]) if (gold.rules[s]?.conds?.length) assert.equal(c.rules[s].conds.length, gold.rules[s].conds.length + 1, `${s}: one condition more`);
    assert.deepEqual(c.risk, gold.risk, "stops and exits stay as they were");
    assert.deepEqual(c.rules.exitLong, gold.rules.exitLong);
  }
  const s200 = v.find((c) => /200-day/.test(c.lab_note));
  if (gold.rules.long?.conds?.length) assert.deepEqual(s200.rules.long.conds.at(-1), { ind: "SMA", op: "price_above", tf: "D", p: { len: 200 } });
  if (gold.rules.short?.conds?.length) assert.deepEqual(s200.rules.short.conds.at(-1), { ind: "SMA", op: "price_below", tf: "D", p: { len: 200 } });
  assert.equal(new Set(v.map(fingerprint)).size, v.length, "every version is a different strategy");
  assert.ok(!gold.lab_note || !/Condition/.test(gold.lab_note), "the parent is left as it is");
});
await t("crypto: every day of the week (it trades 7 days); minute strategies also get before / after noon, MCX minute also no evening session", () => {
  assert.equal(condTuneVariants(btc).length, 13);
  const n = condTuneVariants(nifty); assert.equal(n.length, 13, notes(n).join(" | "));
  assert.ok(notes(n).includes("entries before 12:00 IST only") && notes(n).includes("entries from 12:00 IST only"));
  const g = condTuneVariants(goldMin); assert.ok(notes(g).includes("entries before 17:00 IST only (no evening session)"));
  for (const c of [...n, ...g]) validateRules(c.rules);
});
await t("a condition the strategy already has isn't added twice; an ANY-mode entry (where a filter wouldn't filter) gets none", () => {
  const p = JSON.parse(JSON.stringify(gold)); for (const s of ["long", "short"]) if (p.rules[s]?.conds?.length) p.rules[s].conds.push({ ind: "ADX", op: "gt", tf: "D", p: { len: 14 }, v: 20 });
  assert.equal(condTuneVariants(p).length, 10);
  const q = JSON.parse(JSON.stringify(gold)); for (const s of ["long", "short"]) if (q.rules[s]) q.rules[s].mode = "ANY";
  assert.equal(condTuneVariants(q).length, 0);
});
await t("the rule book: TIME 'is not the day' (not_weekday) reads in plain words", () => {
  assert.match(describeCond({ ind: "TIME", op: "not_weekday", tf: "D", p: { d: 3 } }), /is not a Wednesday/);
});

const parent = (id, cfg, extra = {}) => ({ id, run_id: 1, asset: cfg.underlying, mode: "DAILY", label: labelFor(cfg), fingerprint: fingerprint(cfg), config: cfg, stage: "done", passed: true, robust_status: "done",
  superseded_by: null, stop_tuned_at: null, cond_tuned_at: null, promoted_id: null, score: 50, created_at: new Date(Date.now() - 40 * 864e5).toISOString(), ...extra });
const g2 = (() => { for (let s = 5000; s < 9000; s++) { const c = generate("GOLD", s, 500000, 0); if (c.rules.daily && fingerprint(c) !== fingerprint(gold) && (c.rules.long?.mode ?? "ALL") === "ALL") return c; } })();
const reset = () => { db.lab_results = [parent(11, gold, { score: 60 }), parent(12, g2, { score: 90 })]; db.lab_refresh = []; db.lab_tried = []; db.lab_runs = []; };
const run = (id, cond_tune, stop_tune = 0, per_night = 50) => ({ id, trigger: "schedule", settings: { per_night, stop_tune, cond_tune, assets: ["GOLD"], capital: 500000, ha_strength_pct: 0 } });
const tuned = (id) => db.lab_results.filter((r) => r.run_id === id && /^Condition tuning/.test(r.config.lab_note ?? ""));

await t("off (0): nothing written", async () => {
  reset(); await generatePhase(sb, run(31, 0), ["GOLD"], { from: "2025-01-01" });
  assert.equal(tuned(31).length, 0); assert.ok(db.lab_results.slice(0, 2).every((r) => r.cond_tuned_at == null));
});
await t("on: the best passed strategy gets its condition versions (within 40% of the run), marked so they are never tuned again", async () => {
  reset(); await generatePhase(sb, run(32, 5), ["GOLD"], { from: "2025-01-01" });
  const k = tuned(32);
  assert.ok(k.length >= 9 && k.length <= 13, `one strategy's versions, got ${k.length}`);
  assert.ok(k.every((r) => / \(from lab strategy #12\)$/.test(r.config.lab_note)), "the higher-scored one first");
  assert.ok(k.every((r) => r.stage === "pending" && r.cond_tuned_at && r.stop_tuned_at && r.fingerprint === fingerprint(r.config)));
  assert.ok(db.lab_results.find((r) => r.id === 12).cond_tuned_at, "the parent is marked");
  assert.equal(db.lab_results.find((r) => r.id === 11).cond_tuned_at ?? null, null);
});
await t("with stop tuning on as well: both share the 40% (a small run has room only for the stop versions; a bigger one for both)", async () => {
  reset(); await generatePhase(sb, run(33, 5, 5), ["GOLD"], { from: "2025-01-01" });
  assert.equal(tuned(33).length, 0, "50 a run: 20 places, the stop versions took 15");
  reset(); await generatePhase(sb, run(34, 5, 5, 300), ["GOLD"], { from: "2025-01-01" });
  const k = tuned(34), stops = db.lab_results.filter((r) => r.run_id === 34 && /^Stop tuning/.test(r.config.lab_note ?? "")).length;
  assert.equal(stops, 30); assert.ok(k.length >= 18 && k.length + stops <= 120, `both strategies' condition versions: ${k.length}`);
  assert.ok(!k.some((r) => /Stop tuning/.test(r.config.lab_note)), "a stop version is never condition-tuned");
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
