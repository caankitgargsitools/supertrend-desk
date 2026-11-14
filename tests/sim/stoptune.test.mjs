// Stop tuning in the Strategy Lab (14 Nov 2026, Papa: "put that as a parameter in the strategy lab", after the stop study):
// for a set number of passed strategies a run, the lab writes their stop variants — a tighter first stop with no trailing
// stop or a wide one — into the run, where each is tested like any strategy. A strategy is tuned once; its variants never.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { db, createClient } = await import("./fakesb.mjs");
const { stopTuneVariants, generatePhase, generate, fingerprint, labelFor } = await import("./lab.mjs");
const { validateRules } = await import("./rules.mjs");
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const sb = createClient();
const pick = (asset, daily) => { for (let s = 1; s < 4000; s++) { const c = generate(asset, s, 500000, 0); if (!!c.rules.daily === daily) return c; } throw new Error("none"); };
const day = pick("GOLD", true), min = pick("NIFTY", false);

await t("daily: 15 versions — stop 0.5–2 × ATR, with no trailing stop or a wide one (3, 4 × ATR); the target stays", () => {
  const p = { ...day, risk: { basis: "UNDERLYING", atr_len: 20, sl: { type: "ATR", value: 4.5 }, trail: { type: "ATR", value: 3 }, tgt: { type: "ATR", value: 7.5 }, max_day_loss: null } };
  const v = stopTuneVariants(p);
  assert.equal(v.length, 15);
  assert.deepEqual([...new Set(v.map((c) => c.risk.sl.value))], [0.5, 0.75, 1, 1.5, 2]);
  assert.deepEqual([...new Set(v.map((c) => c.risk.trail?.value ?? null))], [null, 3, 4]);
  for (const c of v) { assert.equal(c.risk.sl.type, "ATR"); assert.deepEqual(c.risk.tgt, { type: "ATR", value: 7.5 }); assert.equal(c.risk.atr_len, 20); validateRules(c.rules); assert.match(c.lab_note, /^Stop tuning: stop /); }
  assert.equal(new Set(v.map(fingerprint)).size, 15, "every version is a different strategy");
  assert.ok(!v.some((c) => c.risk.trail && c.risk.trail.value < 3), "no tight trailing stop is ever written");
  assert.deepEqual(p.risk.sl, { type: "ATR", value: 4.5 }, "the parent is left as it is");
});
await t("minute candles: wider multiples (their ATR is one candle's swing); a strategy with no stop gets ATR(14)", () => {
  const v = stopTuneVariants({ ...min, risk: null });
  assert.deepEqual([...new Set(v.map((c) => c.risk.sl.value))], [1, 1.5, 2, 3, 4]);
  assert.deepEqual([...new Set(v.map((c) => c.risk.trail?.value ?? null))], [null, 6, 8]);
  assert.ok(v.every((c) => c.risk.atr_len === 14 && c.risk.tgt === null));
});

const parent = (id, cfg, extra = {}) => ({ id, run_id: 1, asset: cfg.underlying, mode: "DAILY", label: labelFor(cfg), fingerprint: fingerprint(cfg), config: cfg, stage: "done", passed: true, robust_status: "done",
  superseded_by: null, stop_tuned_at: null, promoted_id: null, score: 50, created_at: new Date(Date.now() - 40 * 864e5).toISOString(), ...extra });
const g2 = (() => { for (let s = 5000; s < 9000; s++) { const c = generate("GOLD", s, 500000, 0); if (c.rules.daily && fingerprint(c) !== fingerprint(day)) return c; } })();
const reset = () => { db.lab_results = [parent(11, day, { score: 60 }), parent(12, g2, { score: 90 })]; db.lab_refresh = []; db.lab_tried = []; db.lab_runs = []; };
const run = (id, stop_tune, per_night = 50) => ({ id, trigger: "schedule", settings: { per_night, stop_tune, assets: ["GOLD"], capital: 500000, ha_strength_pct: 0 } });
const tuned = (id) => db.lab_results.filter((r) => r.run_id === id && /^Stop tuning/.test(r.config.lab_note ?? ""));

await t("off (0): the run writes only new strategies", async () => {
  reset(); await generatePhase(sb, run(21, 0), ["GOLD"], { from: "2025-01-01" });
  assert.equal(tuned(21).length, 0); assert.ok(db.lab_results.filter((r) => r.run_id === 21).length > 20);
  assert.ok(db.lab_results.slice(0, 2).every((r) => r.stop_tuned_at === null));
});
await t("on: the best passed strategy not tuned yet gets its 15 versions, at most 40% of the run; the rest stays new strategies", async () => {
  reset(); await generatePhase(sb, run(22, 5), ["GOLD"], { from: "2025-01-01" });
  const k = tuned(22);
  assert.equal(k.length, 15, "50 a run → 40% = 20 → one strategy's 15 versions");
  assert.ok(k.every((r) => / \(from lab strategy #12\)$/.test(r.config.lab_note)), "the higher-scored one first");
  assert.ok(k.every((r) => r.stage === "pending" && r.stop_tuned_at && r.fingerprint === fingerprint(r.config)), "written like any strategy to test; never tuned themselves");
  assert.ok(db.lab_results.find((r) => r.id === 12).stop_tuned_at, "the parent is marked");
  assert.equal(db.lab_results.find((r) => r.id === 11).stop_tuned_at, null);
  const fresh = db.lab_results.filter((r) => r.run_id === 22).length - 15;
  assert.ok(fresh >= 25 && fresh <= 36, `about 35 new strategies, got ${fresh}`);
});
await t("the next run takes the next strategy; once all are done nothing more is written", async () => {
  const finish = (id) => { for (const r of db.lab_results) if (r.run_id === id) r.stage = "done"; }; // the run before has been tested
  finish(22); await generatePhase(sb, run(23, 5), ["GOLD"], { from: "2025-01-01" });
  assert.ok(tuned(23).length === 15 && tuned(23).every((r) => / #11\)$/.test(r.config.lab_note)));
  finish(23); await generatePhase(sb, run(24, 5), ["GOLD"], { from: "2025-01-01" });
  assert.equal(tuned(24).length, 0);
});
await t("a strategy saved on a desk goes first; a bigger run tunes more of them; superseded and failed ones never", async () => {
  reset(); db.lab_results[0].promoted_id = "s-1";
  db.lab_results.push(parent(13, pick("GOLD", true), { superseded_by: 99, score: 99, fingerprint: "old" }), parent(14, pick("GOLD", true), { passed: false, score: 99, fingerprint: "bad" }));
  await generatePhase(sb, run(25, 1), ["GOLD"], { from: "2025-01-01" });
  assert.ok(tuned(25).every((r) => / #11\)$/.test(r.config.lab_note)) && tuned(25).length === 15, "the desk one first, though the other scores higher");
  reset(); await generatePhase(sb, run(26, 5, 300), ["GOLD"], { from: "2025-01-01" });
  assert.equal(tuned(26).length, 30, "300 a run: both strategies");
});
await t("a version that already failed (lab_tried) isn't written again", async () => {
  reset(); const v = stopTuneVariants(g2); db.lab_tried = v.slice(0, 4).map((c) => ({ fingerprint: fingerprint(c) }));
  await generatePhase(sb, run(27, 1), ["GOLD"], { from: "2025-01-01" });
  assert.equal(tuned(27).length, 11);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
