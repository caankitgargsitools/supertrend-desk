// Own candles: stored lab history + 1-minute candles from the per-second prices, used when Dhan refuses candle requests.
import assert from "node:assert";
import { createClient, db } from "./fakesb.mjs";
import { ownDaily, ownIntraday } from "./own.mjs";
import { Dhan } from "./dhan.mjs";
const sb = createClient();
const at = (d, hm) => Date.parse(`${d}T${hm}:00+05:30`) / 1000;
const col = (rows) => ({ t: rows.map((r) => r.t), o: rows.map((r) => r.o), h: rows.map((r) => r.h), l: rows.map((r) => r.l), c: rows.map((r) => r.c) });

// Stored: daily candles to 21 Oct, 5-minute candles of 22 Oct (09:15-15:25). Own minutes: 23 Oct 10:30-11:59.
const D = ["2026-10-19", "2026-10-20", "2026-10-21"].map((d, i) => ({ t: at(d, "00:00"), o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i }));
const I5 = []; for (let m = 0; m < 75; m++) { const t = at("2026-10-22", "09:15") + m * 300; I5.push({ t, o: 200 + m, h: 201 + m, l: 199 + m, c: 200.5 + m }); }
db.lab_candles = [
  { asset: "NIFTY", kind: "D", from_day: "2026-10-19", to_day: "2026-10-21", stored: false, bars: col(D) },
  { asset: "NIFTY", kind: "I5", from_day: "2026-10-22", to_day: "2026-10-22", stored: false, bars: col(I5) },
  { asset: "GOLD", kind: "D", from_day: "2026-10-19", to_day: "2026-10-21", stored: false, bars: col(D) },
  { asset: "GOLD", kind: "I5", from_day: "2026-10-22", to_day: "2026-10-22", stored: false, bars: col(I5) },
];
db.mcx_contracts = [{ sec_id: "495213", underlying: "GOLD", expiry: "2026-12-04" }];
db.price_bars = [];
for (let m = 0; m < 90; m++) {
  const t = at("2026-10-23", "10:30") + m * 60, b = 300 + m;
  db.price_bars.push({ seg: "IDX_I", sec: "13", t, o: b, h: b + 2, l: b - 1, c: b + 1 });
  db.price_bars.push({ seg: "MCX_COMM", sec: "495213", t, o: b, h: b + 2, l: b - 1, c: b + 1 });
}

// 15-minute candles: 25 for 22 Oct from the stored 5-minute candles, then 6 for 23 Oct (10:30 ... 11:45) from own minutes.
const r15 = await ownIntraday(sb, "13", "IDX_I", 15, "2026-10-21 09:00:00", "2026-10-23 12:01:00");
const d22 = r15.filter((r) => r.t < at("2026-10-23", "00:00")), d23 = r15.filter((r) => r.t >= at("2026-10-23", "00:00"));
assert.equal(d22.length, 25, "22 Oct: 25 fifteen-minute candles");
assert.deepEqual(d22[0], { t: at("2026-10-22", "09:15"), o: 200, h: 203, l: 199, c: 202.5, v: 0 }, "first 15m candle from three 5m candles");
assert.equal(d23.length, 6, "23 Oct: six candles from own minutes");
assert.deepEqual(d23[0], { t: at("2026-10-23", "10:30"), o: 300, h: 316, l: 299, c: 315, v: 0 }, "own 15m candle: open of the first minute, high/low of all, close of the last");
console.log("ok   15-minute candles: stored 5-minute history, then own minutes");

// 1-minute candles: own minutes only (no stored 1-minute history).
const r1 = await ownIntraday(sb, "13", "IDX_I", 1, "2026-10-23 09:00:00", "2026-10-23 10:35:00");
assert.equal(r1.length, 6); assert.equal(r1[0].t, at("2026-10-23", "10:30"));
console.log("ok   1-minute candles: own minutes");

// MCX contract: its underlying's stored candles (via mcx_contracts) plus the contract's own minutes.
const g25 = await ownIntraday(sb, "495213", "MCX_COMM", 25, "2026-10-22 09:00:00", "2026-10-23 23:59:00");
assert.ok(g25.length > 0 && g25.at(-1).t >= at("2026-10-23", "10:30"), "MCX: own candles after the stored ones");
assert.equal(g25[0].t, at("2026-10-22", "09:00"), "MCX 25m candles anchored to its 09:00 open");
console.log("ok   MCX contract mapped to its underlying's stored candles");

// Daily: stored days, then 22 Oct built from 5-minute candles and 23 Oct from own minutes; toDate exclusive.
const dd = await ownDaily(sb, "13", "IDX_I", "2026-10-01", "2026-10-24");
assert.deepEqual(dd.map((d) => d.day), ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
assert.deepEqual(dd[3], { t: at("2026-10-22", "00:00"), o: 200, h: 275, l: 199, c: 274.5, v: 0, day: "2026-10-22" }, "22 Oct from 5m");
assert.deepEqual(dd[4], { t: at("2026-10-23", "00:00"), o: 300, h: 391, l: 299, c: 390, v: 0, day: "2026-10-23" }, "23 Oct from own minutes");
assert.deepEqual((await ownDaily(sb, "13", "IDX_I", "2026-10-01", "2026-10-23")).map((d) => d.day).at(-1), "2026-10-22", "toDate exclusive");
console.log("ok   daily candles: stored, then built from 5-minute and own candles");

// The Dhan client: a refused candle request (HTTP 400 / DH-905) falls back only when allowed (strategy ticks).
let status = 400;
globalThis.fetch = async () => new Response(JSON.stringify({ errorType: "Input_Exception", errorCode: status === 400 ? "DH-905" : "DH-901" }), { status });
Dhan.own = { intraday: (sec, seg, i, a, z) => ownIntraday(sb, sec, seg, i, a, z), daily: (sec, seg, a, z) => ownDaily(sb, sec, seg, a, z) };
const lab = new Dhan("c", "t");
await assert.rejects(lab.intraday("13", "IDX_I", "INDEX", 15, "2026-10-21 09:00:00", "2026-10-23 12:01:00"), /DH-905/, "lab: no fallback");
const tick = new Dhan("c", "t"); tick.useOwn = true;
assert.deepEqual(await tick.intraday("13", "IDX_I", "INDEX", 15, "2026-10-21 09:00:00", "2026-10-23 12:01:00"), r15, "tick: own candles");
assert.equal((await tick.daily("13", "IDX_I", "INDEX", "2026-10-01", "2026-10-24")).length, 5);
assert.ok(Dhan.ownUsed.has("IDX_I|13"), "noted as own candles");
assert.deepEqual(await tick.intraday("13", "IDX_I", "INDEX", 15, "2025-01-01 09:00:00", "2025-03-01 23:59:00"), [], "a range before the stored candles: empty, as Dhan answers");
status = 401;
await assert.rejects(tick.intraday("13", "IDX_I", "INDEX", 15, "2026-10-21 09:00:00", "2026-10-23 12:01:00"), /HTTP 401/, "bad token: no fallback");
status = 400;
await assert.rejects(tick.intraday("999", "IDX_I", "INDEX", 15, "2026-10-21 09:00:00", "2026-10-23 12:01:00"), /DH-905/, "no own candles: Dhan's error stands");
console.log("ok   Dhan client falls back on DH-905 for strategy ticks only; other errors unchanged");
console.log("all passed");
