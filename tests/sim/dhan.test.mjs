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
// 16 Nov 2026: the desk-wide quote turn — a quote request waits for the moment the gate hands out; candles don't ask it.
{ const asked = []; let next = Date.now() + 1500;
  Dhan.quoteGate = async (k) => { asked.push(k); const t = next; next += 1100; return t; };
  const c2 = new Dhan("c2", "tok2"); calls.length = 0; const tq = Date.now();
  await c2.ltpMany({ IDX_I: ["13"] }, true);
  assert.ok(calls[0].at - tq >= 1400, "waits for its turn"); assert.deepEqual(asked, ["c2"], "keyed by the client id");
  await c2.daily("13", "IDX_I", "INDEX", "2026-01-01", "2026-10-22"); assert.equal(asked.length, 1, "candles don't take a quote turn");
  Dhan.quoteGate = async () => { throw new Error("db down"); };
  calls.length = 0; await new Dhan("c3", "tok3").ltpMany({ IDX_I: ["13"] }, true); assert.equal(calls.length, 1, "gate unreachable: asks anyway");
  Dhan.quoteGate = null; }
console.log("ok", Date.now() - t0, "ms");
