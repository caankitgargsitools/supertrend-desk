// Spread watcher (engine spreads.ts, 2 Nov 2026): the charge maths, Dhan's lists, and whole rounds with made-up prices
// (crypto every minute, NSE/BSE every minute in market hours, cash/futures every 15 minutes). Nothing real is called.
import assert from "node:assert/strict";
import { build } from "esbuild";
await build({ entryPoints: ["../../supabase/functions/engine/spreads.ts"], bundle: true, format: "esm", platform: "node", outfile: "spreads.mjs", logLevel: "warning",
  plugins: [{ name: "npm", setup(b) { b.onResolve({ filter: /^npm:/ }, (a) => ({ path: a.path, external: true })); } }] });
const S = await import("./spreads.mjs");
const { db, createClient } = await import("./fakesb.mjs");
const sb = createClient();
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

await t("NSE/BSE charges ≈ 0.041% of a ₹10 lakh trade (STT 0.025% the biggest part)", () => {
  const c = S.nbCostPct(); assert.ok(c > 0.04 && c < 0.042, String(c));
  assert.ok(S.nbCostPct(100000) > c); // ₹20 brokerage weighs more on a small trade
});
await t("cross: buys at the cheaper ask, sells at the other's bid", () => {
  const r = S.bestCross({ bid: 100, ask: 100.1 }, { bid: 100.3, ask: 100.4 }, 0.05, ["NSE", "BSE"]);
  assert.equal(r.buy, 100.1); assert.equal(r.sell, 100.3); assert.equal(r.x.buy_at, "NSE");
  assert.equal(r.gap_pct, +((0.2 / 100.1) * 100).toFixed(4)); assert.equal(r.net_pct, +(r.gap_pct - 0.05).toFixed(4));
  const n = S.bestCross({ bid: 100, ask: 100.05 }, { bid: 100, ask: 100.05 }, 0.05, ["NSE", "BSE"]); assert.ok(n.gap_pct < 0 && n.net_pct < n.gap_pct);
});
await t("cash and carry: 0.8% gap, 0.25% charges, 30 days → ≈ 6.7% a year", () => {
  const r = S.cashCarry({ bid: 999, ask: 1000 }, { bid: 1008, ask: 1009 }, 30);
  assert.equal(r.gap_pct, 0.8); assert.equal(r.net_pct, 0.55); assert.equal(r.yearly, +(0.55 * 365 / 30).toFixed(4));
  assert.ok(S.cashCarry({ bid: 999, ask: 1000 }, { bid: 1008, ask: 1009 }, 0).yearly > 0); // expiry day counts as 1 day
});
await t("crypto charges: 0.05% + GST, four times = 0.236%", () => assert.equal(+S.CX_COST_PCT.toFixed(3), 0.236));
await t("CoinDCX book and Dhan quote read correctly", () => {
  assert.deepEqual(S.dcxBA({ bids: { "77499.9": "1", "77499.8": "2" }, asks: { "77500.1": "1", "77500": "3" } }), { bid: 77499.9, ask: 77500 });
  assert.equal(S.dcxBA({ bids: {}, asks: {} }), null);
  assert.deepEqual(S.dhanBA({ depth: { buy: [{ price: 10 }], sell: [{ price: 10.05 }] } }), { bid: 10, ask: 10.05 });
  assert.equal(S.dhanBA({ depth: { buy: [{ price: 0 }], sell: [{ price: 10 }] } }), null);
});
const FNO = ["SECURITY_ID,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,SM_EXPIRY_DATE,LOT_SIZE",
  "5001,FUTSTK,2885,RELIANCE,RELIANCE-Nov2026-FUT,2026-11-24,500", "5002,FUTSTK,2885,RELIANCE,RELIANCE-Dec2026-FUT,2026-12-29,500",
  "5003,FUTSTK,2885,RELIANCE,RELIANCE-Oct2026-FUT,2026-10-27,500", "6001,FUTSTK,1333,,HDFCBANK-Nov2026-FUT,2026-11-24,650",
  "7001,OPTSTK,2885,RELIANCE,RELIANCE-Nov2026-1400-CE,2026-11-24,500", "8001,FUTIDX,13,NIFTY,NIFTY-Nov2026-FUT,2026-11-25,75"].join("\n");
const BSE = ["SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SYMBOL_NAME", "500325,EQUITY,RELIANCE,RELIANCE INDUSTRIES LTD", "500180,EQUITY,HDFCBANK,HDFC BANK LTD", "999,MF,RELIANCE,X"].join("\n");
await t("Dhan lists: near and next month per stock (expired and options left out), BSE ids for the desk's stocks", () => {
  const ids = S.parseIds(FNO, BSE, "2026-11-02");
  assert.deepEqual(ids.cf.map((c) => [c.key, c.eq, c.lot, c.near.sec, c.next?.sec]), [["HDFCBANK", "1333", 650, "6001", undefined], ["RELIANCE", "2885", 500, "5001", "5002"]]);
  assert.deepEqual(ids.nb, [{ key: "RELIANCE", nse: "2885", bse: "500325" }, { key: "HDFCBANK", nse: "1333", bse: "500180" }]);
});

// Whole rounds. 2 Nov 2026 is a Monday; 10:00 IST = 04:30 UTC.
const at = (hhmm, day = "2026-11-02") => Date.parse(`${day}T${hhmm}:00+05:30`) / 1000;
const fakeFetch = async (url) => {
  const j = (x) => ({ ok: true, status: 200, json: async () => x, text: async () => (typeof x === "string" ? x : JSON.stringify(x)) });
  if (url.includes("delta.exchange/v2/tickers/BTCUSD")) return j({ result: { quotes: { best_bid: "77480", best_ask: "77481" }, funding_rate: "0.01" } });
  if (url.includes("delta.exchange")) return j({ result: { quotes: { best_bid: "0", best_ask: "0" } } }); // no book → skipped
  if (url.includes("orderbook/B-BTC_USDT")) return j({ bids: { "77700": "1" }, asks: { "77701": "1" } });
  if (url.includes("orderbook")) return j({ bids: {}, asks: {} });
  if (url.includes("current_prices")) return j({ prices: { "B-BTC_USDT": { fr: 0.0001 } } });
  if (url.includes("instrument/NSE_FNO")) return j(FNO);
  if (url.includes("instrument/BSE_EQ")) return j(BSE);
  throw new Error("unexpected " + url);
};
const quoteCalls = [];
const fakeDhan = { quoteMany: async (bySeg) => { quoteCalls.push(bySeg); const m = new Map();
  const q = (b, a) => ({ depth: { buy: [{ price: b }], sell: [{ price: a }] } });
  m.set("NSE_EQ|2885", q(1400, 1400.1)); m.set("BSE_EQ|500325", q(1401, 1401.2)); m.set("NSE_EQ|1333", q(900, 900.05)); m.set("BSE_EQ|500180", q(899.9, 900.1));
  m.set("NSE_FNO|5001", q(1411, 1411.5)); m.set("NSE_FNO|5002", q(1420, 1421)); m.set("NSE_FNO|6001", q(905, 905.5));
  return m; } };
db.spread_state = [{ id: 1, started_at: new Date(at("09:00") * 1000).toISOString(), until: new Date(at("09:00", "2026-12-02") * 1000).toISOString(), ids_day: null, ids: null, last_cf: null, runs: 0 }];
db.spread_ticks = []; db.market_holidays = [];
const creds = { client: "C1", token: "TOK" };
await t("before the lists: crypto only; BTC Delta 77,481 → CoinDCX 77,700 is a 0.28% gap, 0.047% after fees", async () => {
  const r = await S.runSpreads(sb, creds, { nowSec: at("08:00"), fetch: fakeFetch, dhan: fakeDhan });
  assert.equal(r.saved, 1); assert.equal(r.market_open, false); assert.equal(quoteCalls.length, 0);
  const x = db.spread_ticks[0]; assert.equal(x.kind, "cx"); assert.equal(x.key, "BTC"); assert.equal(x.x.buy_at, "Delta");
  assert.ok(x.net_pct > 0.04 && x.net_pct < 0.05, String(x.net_pct)); assert.equal(x.x.fund_dcx_pct, 0.01);
});
await t("08:45 on a trading day: the round downloads the lists and quotes nothing yet", async () => {
  const r = await S.runSpreads(sb, creds, { nowSec: at("08:45"), fetch: fakeFetch, dhan: fakeDhan });
  assert.equal(r.synced, true); assert.equal(db.spread_state[0].ids_day, "2026-11-02"); assert.equal(quoteCalls.length, 0);
});
await t("10:00: one quote call with NSE/BSE and cash/futures; RELIANCE BSE dearer; cash/futures near ≈ 0.78%", async () => {
  db.spread_ticks = [];
  const r = await S.runSpreads(sb, creds, { nowSec: at("10:00"), fetch: fakeFetch, dhan: fakeDhan });
  assert.equal(quoteCalls.length, 1); assert.ok(quoteCalls[0].NSE_FNO.includes("5002"));
  const nb = db.spread_ticks.filter((x) => x.kind === "nb"), cf = db.spread_ticks.filter((x) => x.kind === "cf");
  assert.equal(nb.length, 2); assert.equal(cf.length, 3);
  const rel = nb.find((x) => x.key === "RELIANCE"); assert.equal(rel.x.buy_at, "NSE"); assert.equal(rel.buy, 1400.1); assert.equal(rel.sell, 1401);
  const near = cf.find((x) => x.key === "RELIANCE:near"); assert.equal(near.x.days, 22); assert.equal(near.gap_pct, +((1411 - 1400.1) / 1400.1 * 100).toFixed(4));
  assert.ok(r.market_open);
});
await t("10:05: NSE/BSE again, cash/futures waits for its 15 minutes", async () => {
  db.spread_ticks = [];
  await S.runSpreads(sb, creds, { nowSec: at("10:05"), fetch: fakeFetch, dhan: fakeDhan });
  assert.equal(quoteCalls.at(-1).NSE_FNO, undefined); assert.equal(db.spread_ticks.filter((x) => x.kind === "cf").length, 0);
  await S.runSpreads(sb, creds, { nowSec: at("10:15"), fetch: fakeFetch, dhan: fakeDhan });
  assert.equal(db.spread_ticks.filter((x) => x.kind === "cf").length, 3);
});
await t("Saturday and after hours: no Dhan calls, crypto still recorded", async () => {
  const n = quoteCalls.length;
  await S.runSpreads(sb, creds, { nowSec: at("11:00", "2026-11-07"), fetch: fakeFetch, dhan: fakeDhan });
  await S.runSpreads(sb, creds, { nowSec: at("16:00"), fetch: fakeFetch, dhan: fakeDhan });
  assert.equal(quoteCalls.length, n);
});
await t("a holiday: no Dhan calls", async () => {
  db.market_holidays = [{ day: "2026-11-09", exch: "NSE", opens_at: null }];
  const n = quoteCalls.length;
  await S.runSpreads(sb, creds, { nowSec: at("10:00", "2026-11-09"), fetch: fakeFetch, dhan: fakeDhan });
  assert.equal(quoteCalls.length, n);
});
await t("after 30 days the watch stops by itself", async () => {
  const r = await S.runSpreads(sb, creds, { nowSec: at("10:00", "2026-12-03"), fetch: fakeFetch, dhan: fakeDhan });
  assert.equal(r.skipped, "watch period over");
});
if (fails) { console.log(fails, "failed"); process.exit(1); }
