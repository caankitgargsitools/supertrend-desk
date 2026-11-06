// Cross-sectional momentum on the 33 stock futures (6 Nov 2026, audit step 10): the ledger entry, the ranking with the
// last month skipped, long-only and long / short settings, and the risk per position.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { IDEAS, momentumTrades, relStrengthTrades, legsFor, combineTry } = await import("./ideas.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const idea = IDEAS.find((i) => i.key === "stockmom");
t("registered in the ledger: order 18, custom, daily, 33 stocks, 4 settings, 0.5% risk per position", () => {
  assert.ok(idea); assert.equal(idea.order, 18); assert.equal(idea.kind, "custom"); assert.equal(idea.daily, true);
  assert.equal(idea.universe.length, 33); assert.equal(idea.settings.length, 4); assert.equal(idea.risk, 0.005);
  assert.deepEqual(legsFor(idea, idea.settings[0], "2026-11-06", new Set(idea.universe)), [{ asset: "*", win_from: null, win_to: null, config: { idea: "stockmom", setting: "lb126-k5-ls", p: idea.settings[0].p } }]);
  assert.ok(IDEAS.filter((i) => i.key.startsWith("wk-")).every((i) => i.order < 18), "after the well-known ideas");
});
const day = (i) => new Date(Date.UTC(2018, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const series = (f) => Array.from({ length: 700 }, (_, i) => { const c = f(i); return { t: i, day: day(i), o: c, h: c * 1.01, l: c * 0.99, c }; });
// Six stocks: three steady risers (different speeds), two steady fallers, one that rose until day 400 and then fell hard.
const daily = {
  RELIANCE: series((i) => 1000 * Math.exp(0.0012 * i)), TCS: series((i) => 1000 * Math.exp(0.0008 * i)), INFY: series((i) => 1000 * Math.exp(0.0004 * i)),
  SBIN: series((i) => 1000 * Math.exp(-0.0006 * i)), ITC: series((i) => 1000 * Math.exp(-0.001 * i)),
  WIPRO: series((i) => 1000 * Math.exp(i < 400 ? 0.002 * i : 0.002 * 400 - 0.004 * (i - 400))),
};
const contracts = new Map(Object.keys(daily).map((k) => [k, k]));
t("long the top k, short the bottom shortK, rebalanced every 21 trading days", () => {
  const tr = momentumTrades(daily, { lb: 126, skip: 21, k: 2, shortK: 2 }, contracts);
  assert.ok(tr.n.length > 20);
  for (let i = 0; i < tr.k.length; i++) {
    const k = tr.k[i], side = tr.s[i], e = tr.e[i].slice(0, 10);
    if (e < day(400)) assert.ok((side === "L" && ["WIPRO", "RELIANCE"].includes(k)) || (side === "S" && ["ITC", "SBIN"].includes(k)), `${e} ${k} ${side}`);
  }
  const longs = tr.n.filter((_, i) => tr.s[i] === "L"), shorts = tr.n.filter((_, i) => tr.s[i] === "S");
  assert.ok(longs.length > 0 && shorts.length > 0 && Math.abs(longs.length - shorts.length) <= 4, "as many long as short holding periods");
});
t("skipping the last month: a stock that just collapsed is still ranked by its earlier run, then dropped", () => {
  const noSkip = momentumTrades(daily, { lb: 126, skip: 0, k: 2, shortK: 0 }, contracts), skip = momentumTrades(daily, { lb: 126, skip: 21, k: 2, shortK: 0 }, contracts);
  const firstDrop = (tr) => tr.k.map((k, i) => (k === "WIPRO" && tr.s[i] === "L" ? tr.x[i].slice(0, 10) : null)).filter(Boolean).sort().pop();
  assert.ok(firstDrop(skip) >= firstDrop(noSkip), "with the skip, Wipro is held at least as long after its top");
  assert.ok(skip.s.every((s) => s === "L"), "long only when shortK = 0");
});
t("relStrengthTrades is unchanged (skip 0, as many shorts as longs)", () => {
  const a = relStrengthTrades(daily, { lb: 63, k: 1 }, contracts), b = momentumTrades(daily, { lb: 63, skip: 0, k: 1, shortK: 1 }, contracts);
  assert.deepEqual(a, b);
});
t("the portfolio is sized with the idea's own risk (0.5%): lots from the ATR at entry", () => {
  const legs = [{ asset: "*", result: { n: 2, first: "2019-01-01", last: "2026-10-24", atr_med: { RELIANCE: 15000, TCS: 9000 },
    t: { k: ["RELIANCE", "TCS"], e: ["2024-01-05 15:30", "2024-01-05 15:30"], x: ["2024-02-05 15:30", "2024-02-05 15:30"], s: ["L", "S"], n: [1000, 500], sl: [50, 50], a: [15000, 9000] } } }];
  const c = combineTry(legs, { today: "2026-10-24", risk: idea.risk });
  assert.equal(c.target, 17500, "0.5% of 35 lakh");
  assert.equal(c.lots.RELIANCE, 1); assert.equal(c.lots.TCS, 2); assert.equal(c.net, 1000 * 1 + 500 * 2);
  const c2 = combineTry(legs, { today: "2026-10-24" });
  assert.equal(c2.trades, 1, "at the default 0.2% (₹7,000) Reliance's lot (ATR ₹15,000) is too big and drops out; TCS trades 1 lot");
  assert.equal(c2.net, 500);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
