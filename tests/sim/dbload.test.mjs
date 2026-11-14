// Database load (14 Nov 2026, Papa: go ahead with the savings). A chart is saved when its last candle is new; a fresh
// worker (no memory of earlier writes) used to rewrite every chart every minute. Now the strategy's own last candle
// tells it the chart is already saved; that chart is rewritten only in every fifth minute, or when the portal asks.
import assert from "node:assert/strict";
process.env.SUPABASE_URL = "http://sim"; process.env.SUPABASE_SERVICE_ROLE_KEY = "k"; process.env.ENGINE_SECRET = "s";
globalThis.Deno = { env: { get: (k) => process.env[k] ?? "" }, serve: () => {} };
const { db } = await import("./fakesb.mjs");
const { saveChart, chartLast } = await import("./engine.mjs");
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const bars = (lastT) => [1, 2, 3].map((k) => ({ t: lastT - (3 - k) * 300, o: 100, h: 101, l: 99, c: 100 + k }));
const nan = [NaN, NaN, NaN], zero = [0, 0, 0];
const realMin = Date.prototype.getUTCMinutes;
const atMinute = async (m, f) => { Date.prototype.getUTCMinutes = () => m; try { await f(); } finally { Date.prototype.getUTCMinutes = realMin; } };
const writes = () => (db.algo_chart ?? []).length ? JSON.stringify(db.algo_chart[0].bars.at(-1)) : null;

await t("a new candle's chart is saved; the same candle isn't saved twice by the same worker", async () => {
  chartLast.clear(); db.algo_chart = [];
  const s = { id: "c1", last_candle_ts: 1000, locked: false };
  await atMinute(3, () => saveChart(s, bars(1300), nan, zero));
  assert.equal(db.algo_chart.length, 1, "new candle 1300 saved");
  db.algo_chart = [];
  await atMinute(3, () => saveChart(s, bars(1300), nan, zero));
  assert.equal(db.algo_chart.length, 0, "remembered: not written again");
});
await t("a fresh worker doesn't rewrite a chart whose candle the strategy already handled", async () => {
  chartLast.clear(); db.algo_chart = [];
  const s = { id: "c2", last_candle_ts: 1300, locked: false };
  await atMinute(3, () => saveChart(s, bars(1300), nan, zero));
  assert.equal(db.algo_chart.length, 0, "minute 3: skipped");
  await atMinute(7, () => saveChart(s, bars(1300), nan, zero));
  assert.equal(db.algo_chart.length, 0, "minute 7: skipped");
});
await t("…except in every fifth minute (the bar in progress, or a write that failed)", async () => {
  chartLast.clear(); db.algo_chart = [];
  const s = { id: "c3", last_candle_ts: 1300, locked: false };
  await atMinute(10, () => saveChart(s, bars(1300), nan, zero));
  assert.equal(db.algo_chart.length, 1, "minute 10: written");
});
await t("a fresh worker saves a candle the strategy hasn't handled yet", async () => {
  chartLast.clear(); db.algo_chart = [];
  const s = { id: "c4", last_candle_ts: 1000, locked: false };
  await atMinute(3, () => saveChart(s, bars(1300), nan, zero));
  assert.equal(db.algo_chart.length, 1); assert.ok(writes().includes("1300"));
  // a strategy that has never run (no last candle) is always saved
  chartLast.clear(); db.algo_chart = [];
  await atMinute(3, () => saveChart({ id: "c5", last_candle_ts: null, locked: false }, bars(1300), nan, zero));
  assert.equal(db.algo_chart.length, 1);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
