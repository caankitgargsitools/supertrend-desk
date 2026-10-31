// Background combinations (engine combos.ts): the maths matches the page, passes run in instalments, the first full
// pass is the starting point, later new finds are notified, and nothing is deleted.
import assert from "node:assert/strict";
import { build } from "esbuild";
await build({ entryPoints: ["../../supabase/functions/engine/combos.ts"], bundle: true, format: "esm", platform: "node", outfile: "combos.mjs", logLevel: "warning",
  plugins: [{ name: "npm", setup(b) { b.onResolve({ filter: /^npm:/ }, (a) => ({ path: a.path, external: true })); } }] });
const C = await import("./combos.mjs");
const { db, createClient } = await import("./fakesb.mjs");
const sb = createClient();
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const pack = (trs) => ({ e: trs.map((x) => x[0] + " 09:00"), x: trs.map((x) => x[1] + " 23:25"), s: trs.map((x) => x[2]), n: trs.map((x) => x[3]) });
const months = Array.from({ length: 24 }, (_, i) => [new Date(Date.UTC(2020, i, 1)).toISOString().slice(0, 10), new Date(Date.UTC(2020, i, 25)).toISOString().slice(0, 10)]);
await t("maths: the same answers as the page's hand-made case", async () => {
  const A = C.prep({ id: 1 }, pack(months.map(([a, b], i) => [a, b, "L", i % 2 ? -100 : 200])));
  const B = C.prep({ id: 2 }, pack(months.map(([a, b], i) => [a, b, "S", i % 2 ? 200 : -100])));
  const D = C.prep({ id: 3 }, pack(months.map(([a, b], i) => [a, b, "L", i % 2 ? -100 : 200])));
  const ab = C.evalCombo([A, B]), ad = C.evalCombo([A, D]), abd = C.evalCombo([A, B, D]);
  assert.equal(Math.round(ab.opp), 100); assert.equal(Math.round(ad.opp), 0); assert.equal(Math.round(abd.opp), 100);
  assert.equal(ab.dd, 0); assert.equal(ab.alone[0].dd, 100); assert.equal(ab.net, 2400); assert.equal(ab.better, true); assert.equal(ad.better, false);
  assert.equal(+ab.corr.toFixed(2), -1);
});
await t("enumeration skips same-family members and resumes from a position", async () => {
  const fams = ["a", "b", "a", "c"];
  const all = [...C.combosOf(fams, 2)].map((x) => x.join(""));
  assert.deepEqual(all, ["01", "03", "12", "13", "23"]);
  assert.deepEqual([...C.combosOf(fams, 2, 3)].map((x) => x.join("")), ["13", "23"]);
  assert.deepEqual([...C.combosOf(fams, 3)].map((x) => x.join("")), ["013", "123"]);
});
// Five Gold Mini daily strategies on different rules; 101 and 102 sit on opposite sides.
const gen = (id) => { let seed = id * 13; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const tr = []; let t0 = Date.UTC(2019, 0, 2);
  while (t0 < Date.UTC(2026, 6, 1)) { const len = (3 + Math.floor(rnd() * 8)) * 86400000, a = new Date(t0).toISOString().slice(0, 10), b = new Date(t0 + len).toISOString().slice(0, 10);
    const up = Math.floor(t0 / (40 * 86400000)) % 2 === 0; const side = id === 102 ? (up ? "S" : "L") : id === 101 ? (up ? "L" : "S") : rnd() > .5 ? "L" : "S";
    tr.push([a, b, side, Math.round((rnd() - 0.4) * 60000)]); t0 += len + (1 + Math.floor(rnd() * 4)) * 86400000; }
  return pack(tr); };
const IND = ["RSI", "EMA", "MACD", "ADX", "BB", "VWAP"];
const row = (id, k) => ({ id, label: `Rule ${IND[k]} ${id}`, asset: "GOLDM", twin_of: null, fingerprint: "fp" + id, passed: true, superseded_by: null, robust_status: "done",
  config: { timeframe_min: 375, direction: "BOTH", rules: { daily: true, long: { conds: [{ ind: IND[k], op: ">" }] }, short: { conds: [{ ind: IND[k], op: "<" }] } } },
  tf: 375, daily: true, cons: 90 - k, trades_long: gen(id) });
db.lab_results = [101, 102, 103, 104, 105].map(row);
db.lab_combo_groups = []; db.lab_combos = []; db.notifications = [];
db.profiles = [{ user_id: "admin1", role: "admin" }, { user_id: "u2", role: "user" }];
db.algo_strategies = [];
const runAll = async () => { const out = []; for (let i = 0; i < 20; i++) { const r = await C.runCombos(sb); out.push(r); if (r.idle) break; } return out; };
await t("first pass: pairs then threes checked, combinations that lessen stored, no notification (starting point)", async () => {
  const out = await runAll();
  assert.ok(out.some((r) => r.size === 2 && r.finished) && out.some((r) => r.size === 3 && r.finished), JSON.stringify(out));
  assert.ok(out[out.length - 1].idle);
  const g2 = db.lab_combo_groups.find((g) => g.size === 2);
  assert.equal(g2.state, "done"); assert.ok(g2.baseline_at); assert.equal(g2.checked, 10);
  const pair = db.lab_combos.find((c) => c.key === "2:101+102");
  assert.ok(pair && pair.current && pair.opp >= 90, JSON.stringify(pair));
  assert.ok(db.lab_combos.every((c) => c.opp >= 20));
  assert.equal(db.notifications.length, 0);
});
await t("nothing changed → idle (cheap check only)", async () => {
  const r = await C.runCombos(sb); assert.equal(r.idle, true);
});
await t("a new strategy passes → its group is re-checked, new finds notified to admins only, old ones keep their first-seen time", async () => {
  const before = db.lab_combos.find((c) => c.key === "2:101+102").first_seen;
  await new Promise((r) => setTimeout(r, 5));
  const nw = row(106, 5); nw.trades_long = (() => { const p = gen(101); p.s = p.s.map((x) => (x === "L" ? "S" : "L")); return p; })(); // the mirror of 101
  db.lab_results.push(nw);
  const out = await runAll();
  assert.ok(out.some((r) => r.finished && r.newOnes > 0), JSON.stringify(out));
  assert.equal(db.lab_combos.find((c) => c.key === "2:101+102").first_seen, before);
  assert.ok(db.lab_combos.some((c) => c.ids.includes(106) && c.current));
  assert.ok(db.notifications.length >= 1 && db.notifications.every((n) => n.user_id === "admin1" && n.kind === "lab"));
  assert.match(db.notifications[0].title, /new (pair|three)s? that lessen the drawdown · GOLDM daily/);
});
await t("a member no longer passes → its combinations marked not current, never deleted", async () => {
  const n0 = db.lab_combos.length;
  db.lab_results.find((r) => r.id === 106).passed = false;
  await runAll();
  assert.equal(db.lab_combos.length, n0);
  assert.ok(db.lab_combos.filter((c) => c.ids.includes(106)).every((c) => !c.current));
  assert.ok(db.lab_combos.find((c) => c.key === "2:101+102").current);
});
await t("big groups are worked in instalments (position carried between calls)", async () => {
  db.lab_combo_groups = []; db.lab_combos = [];
  db.lab_results = Array.from({ length: 40 }, (_, i) => ({ ...row(200 + i, i % 6), fingerprint: "g" + i,
    config: { timeframe_min: 375, direction: "BOTH", rules: { daily: true, long: { conds: [{ ind: "X" + i, op: ">" }] }, short: { conds: [] } } } }));
  const r1 = await C.runCombos(sb, 1e9); // no time limit: only the chunk size limits a call
  assert.equal(r1.size, 2); assert.equal(r1.finished, true); // 780 pairs fit in one chunk
  const r2 = await C.runCombos(sb, 1e9);
  assert.equal(r2.size, 3); assert.equal(r2.finished, false); // 9,880 threes don't
  const g3 = db.lab_combo_groups.find((g) => g.size === 3); assert.equal(g3.state, "working"); assert.equal(g3.cursor, r2.checked);
  let r = r2; for (let i = 0; i < 10 && !r.finished; i++) r = await C.runCombos(sb, 1e9);
  assert.equal(r.finished, true); assert.equal(db.lab_combo_groups.find((g) => g.size === 3).checked, 9880);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
