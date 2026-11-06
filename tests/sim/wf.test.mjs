// Walk-forward (6 Nov 2026, audit step 11a): quarterly re-ranking by consistency on the trades before each quarter, the
// next quarter recorded; the stitched curve vs the pool's average; instalments through lab_walkforward.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { createClient, db } = await import("./fakesb.mjs");
const { walkForward, wfSummary, yearsBefore, labWalkForward, packTrades } = await import("./lab.mjs");
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

// Monthly trades 2019–2026: steady winners (+2000 a month), a lumpy one (big years, bad years), steady losers (−1500).
let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const monthly = (f) => { const out = []; for (let y = 2019; y <= 2026; y++) for (let m = 1; m <= 12; m++) { if (y === 2026 && m > 10) break; const d = `${y}-${String(m).padStart(2, "0")}-15`; out.push({ entry: `${d} 10:00`, exit: `${d} 14:00`, side: "LONG", entry_px: 100, exit_px: 101, net: Math.trunc(f(y, m)), exit_why: "x" }); } return out; };
const steady = (k) => monthly(() => 2000 + (rnd() - 0.5) * 800 + k * 50);
const lumpy = monthly((y) => (y % 3 === 0 ? 9000 : -2500) + (rnd() - 0.5) * 1000);
const loser = (k) => monthly(() => -1500 + (rnd() - 0.5) * 800 + k * 20);
const pool = [{ id: 1, trades: steady(0) }, { id: 2, trades: steady(1) }, { id: 3, trades: lumpy }, { id: 4, trades: loser(0) }, { id: 5, trades: loser(1) }, { id: 6, trades: steady(2) }];
await t("yearsBefore: 12-month windows ending at the quarter start, as far back as the trades go", () => {
  const ys = yearsBefore(pool[0].trades, "2023-01-01");
  assert.equal(ys.length, 4, "2019–2022"); assert.ok(ys.every((y) => y.ok)); assert.equal(ys[0].y, 1);
  assert.equal(yearsBefore(pool[3].trades, "2021-01-01").filter((y) => y.ok).length, 0);
});
await t("walkForward: quarters start two years in, the steady winners are picked, the loser never, picks beat the pool average", () => {
  const r = walkForward(pool, 3);
  assert.ok(r.finished); assert.ok(r.quarters.length >= 16, `${r.quarters.length} quarters`);
  assert.equal(r.quarters[0].q, "2021Q2", "first pick after 8 quarters of history (the 2019Q1 start + 730 days → 2021Q1 ranked on, 2021Q2 recorded)");
  assert.ok(r.quarters.every((q) => !q.picked.includes(4) && !q.picked.includes(5)), "losers never picked");
  assert.ok(r.quarters.every((q) => q.picked.length === 3 && q.n_pool === 6));
  const s = wfSummary(r.quarters);
  assert.ok(s.stitched_net > s.pool_net && s.beat_pool > s.quarters * 0.8, JSON.stringify(s));
  assert.equal(s.curve.length, s.quarters); assert.equal(s.from, "2021-04-01");
});
await t("walkForward resumes from a cursor: the deadline stops it, the next call carries on, the result is the same", () => {
  const full = walkForward(pool, 3);
  let calls = 0; const part = walkForward(pool, 3, 0, () => ++calls > 5);
  assert.ok(!part.finished && part.quarters.length < full.quarters.length && part.cursor > 0);
  const rest = walkForward(pool, 3, part.cursor);
  assert.deepEqual([...part.quarters, ...rest.quarters], full.quarters);
});
await t("labWalkForward on the fake database: one group per call, the row saved with its summary; idle when all are fresh", async () => {
  const sb = createClient();
  db.lab_results = pool.map((p, i) => ({ id: p.id, asset: i < 4 ? "GOLD" : "NIFTY", mode: "DAILY", robust_status: "done", superseded_by: null, trades_long: packTrades(p.trades), robust: { consistency: { score: 50 + i } } }));
  // the Nifty group has only 2 strategies (k + 1 needed) → skipped; GOLD (4) computed
  db.lab_walkforward = [];
  const r1 = await labWalkForward(sb, { budgetMs: 1e9 });
  assert.equal(r1.asset, "GOLD"); assert.ok(r1.finished && r1.quarters > 0);
  const row = db.lab_walkforward.find((x) => x.asset === "GOLD" && x.mode === "DAILY");
  assert.ok(row && row.state === "done" && row.summary.quarters === r1.quarters && row.computed_at);
  const r2 = await labWalkForward(sb, { budgetMs: 1e9 });
  assert.equal(r2.idle, true, "nothing stale left");
  // a tiny budget: the work is cut into instalments, the cursor carried in the row
  db.lab_walkforward = []; db.lab_results.forEach((r) => { r.asset = "GOLD"; });
  const a = await labWalkForward(sb, { budgetMs: 0 });
  assert.equal(a.finished, false); assert.ok(db.lab_walkforward[0].state === "working");
  let last = a; for (let i = 0; i < 200 && !last.finished; i++) last = await labWalkForward(sb, { budgetMs: 0 });
  assert.ok(last.finished, "finished in instalments");
  assert.deepEqual(db.lab_walkforward[0].quarters.map((q) => q.q), walkForward(pool, 3).quarters.map((q) => q.q));
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
