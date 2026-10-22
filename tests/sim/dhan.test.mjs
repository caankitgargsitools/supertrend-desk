import { Dhan } from "./dhan.mjs";
import assert from "node:assert";
const calls = [];
globalThis.fetch = async (url, o) => { const b = JSON.parse(o.body); calls.push({ url, b, at: Date.now() }); await new Promise((r) => setTimeout(r, 50));
  if (url.endsWith("/marketfeed/ltp")) { const data = {}; for (const [seg, secs] of Object.entries(b)) { data[seg] = {}; for (const s of secs) data[seg][s] = { last_price: s * 10 }; } return new Response(JSON.stringify({ data })); }
  return new Response(JSON.stringify({ timestamp: [1760000000], open: [1], high: [2], low: [0.5], close: [1.5] })); };
Dhan.memo = new Map(); Dhan.ltpSeed = new Map();
const a = new Dhan("c", "tok"), b = new Dhan("c", "tok");
const t0 = Date.now();
const [x, y] = await Promise.all([a.intraday("13", "IDX_I", "INDEX", 5, "2026-10-01 09:00:00", "2026-10-22 12:31:05"), b.intraday("13", "IDX_I", "INDEX", 5, "2026-10-01 09:00:00", "2026-10-22 12:31:40")]);
assert.equal(calls.length, 1, "same candles fetched once"); assert.deepEqual(x, y);
const p = await Promise.all([a.ltp("IDX_I", "13"), b.ltp("MCX_COMM", "444"), a.ltp("IDX_I", "51")]);
assert.deepEqual(p, [130, 4440, 510]); assert.equal(calls.length, 2, "three prices in one request");
assert.equal(await b.ltp("IDX_I", "13"), 130); assert.equal(calls.length, 2, "seeded price reused");
// pacing shared across objects: two different requests 210ms apart
calls.length = 0;
await Promise.all([a.daily("13", "IDX_I", "INDEX", "2026-01-01", "2026-10-22"), b.daily("25", "IDX_I", "INDEX", "2026-01-01", "2026-10-22")]);
assert.ok(calls[1].at - calls[0].at >= 200, "shared pacing");
Dhan.memo = null; Dhan.ltpSeed = null;
calls.length = 0; await a.ltp("IDX_I", "13"); assert.equal(calls.length, 1, "outside a tick: direct");
console.log("ok", Date.now() - t0, "ms");
