// Ideas lab, crypto funding signal: short when the previous day's funding was high, long when deeply negative;
// each day held booked with the funding received or paid; Binance's history read in pages.
import assert from "node:assert";
import { binanceFunding, fundingTrades, LAB_ASSETS } from "./ideas.mjs";

LAB_ASSETS.BTCUSD = { key: "BTCUSD", name: "Bitcoin", seg: "DELTA", sec: "BTCUSD", instr: "PERP", exchange: "DELTA", lot: 88 * 0.001, commodity: false, crypto: true };
const day = (i) => new Date(Date.UTC(2021, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const daily = Array.from({ length: 60 }, (_, i) => ({ t: i, day: day(i), o: 60000, h: 60300, l: 59700, c: 60000 }));

// Funding 0.05% per 8 hours on days 0..29 (decisions on days 1..30), 0 afterwards: short for 30 days, then out.
const sig = new Map(daily.map((d, i) => [d.day, i < 30 ? 0.05 : 0]));
const t = fundingTrades("BTCUSD", daily, sig, new Map(), 0.01);
assert.equal(t.n.length, 31, "30 days held + the closing booking");
assert.ok(t.s.every((s) => s === "S"), "high funding: short");
assert.equal(t.e[0].slice(0, 10), day(1), "the signal is the previous day's funding (no look-ahead)");
const perDay = 0.0005 * 3 * 60000 * 0.088;
assert.ok(Math.abs(t.n[5] - Math.trunc(perDay)) <= 1, `a quiet day held earns the funding (${t.n[5]} ≈ ${perDay.toFixed(1)})`);
const total = t.n.reduce((a, x) => a + x, 0);
assert.ok(total > 0 && total < 30 * perDay, "funding received minus fees and slippage");
// Delta's actual rate is used for the money when known
const paid = new Map([[day(5), 0.01]]);
const t2 = fundingTrades("BTCUSD", daily, sig, paid, 0.01);
assert.ok(Math.abs(t2.n[4] - Math.trunc(0.0001 * 3 * 60000 * 0.088)) <= 1, "day 5 paid at Delta's 0.01%");
// Deeply negative funding: long, and the long pays nothing when the rate is negative (it receives)
const neg = new Map(daily.map((d, i) => [d.day, i < 10 ? -0.04 : 0]));
const t3 = fundingTrades("BTCUSD", daily, neg, new Map(), 0.02);
assert.ok(t3.s.every((s) => s === "L") && t3.n[3] > 0, "negative funding: long, receiving it");
// Inside the band: no trades
assert.equal(fundingTrades("BTCUSD", daily, new Map(daily.map((d) => [d.day, 0.015])), new Map(), 0.02).n.length, 0);
console.log("ok   funding signal: side, timing, funding received or paid, Delta's rate when known");

// Binance history: pages of 1,000, averaged per UTC day, fractions → % per 8 hours
const real = globalThis.fetch; let calls = 0;
const rows = Array.from({ length: 1500 }, (_, i) => ({ symbol: "BTCUSDT", fundingTime: Date.UTC(2020, 0, 1) + i * 8 * 3600000, fundingRate: i % 3 === 0 ? "0.0003" : "0.0000" }));
globalThis.fetch = async (url) => { calls++; const from = Number(new URL(url).searchParams.get("startTime")); const page = rows.filter((r) => r.fundingTime >= from).slice(0, 1000); return { ok: true, json: async () => page }; };
const m = await binanceFunding("BTCUSDT", Date.UTC(2020, 0, 1), Date.UTC(2021, 6, 1));
globalThis.fetch = real;
assert.equal(calls, 2, "two pages"); assert.equal(m.size, 500); assert.equal(m.get("2020-01-01"), 0.01, "(0.03% + 0 + 0) / 3 = 0.01%");
console.log("ok   Binance funding history: pages, daily average, units");
console.log("all passed");
