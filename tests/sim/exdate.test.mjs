// Stock futures across a split / bonus ex-date (index.ts stockExDate): the held position, its stops and the broker stop
// are adjusted once, before any stop is looked at; flat strategies take the new lot; candles are read adjusted.
import assert from "node:assert/strict";
const T0 = Date.parse("2026-11-16T04:00:00Z"); let clock = T0; // Monday 09:30 IST
Date.now = () => clock;
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
globalThis.Deno = { env: { get: (k) => k === "SUPABASE_URL" ? "http://x" : "k" }, serve: () => {} };
globalThis.EdgeRuntime = { waitUntil() {} };
const dhan = { orders: new Map(), ltp: {}, log: [], rawClose: 2000, adjusted: false };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), m = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null;
  const J = (x, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
  dhan.log.push(`${m} ${u.pathname}`);
  if (u.pathname === "/v2/marketfeed/ltp") { const seg = Object.keys(body).find((k) => k !== "dhanClientId"); const sec = String(body[seg][0]); return J({ data: { [seg]: { [sec]: { last_price: dhan.ltp[sec] } } }, status: "success" }); }
  if (u.pathname === "/v2/charts/historical" || u.pathname === "/v2/charts/intraday") {
    const c = dhan.adjusted ? dhan.rawClose / 5 : dhan.rawClose, t = Date.parse("2026-11-13T09:15:00+05:30") / 1000;
    return J({ timestamp: [t], open: [c], high: [c], low: [c], close: [c], volume: [1] });
  }
  const mm = u.pathname.match(/^\/v2\/orders\/(\w+)$/);
  if (mm && m === "DELETE") { const o = dhan.orders.get(mm[1]); if (o) o.orderStatus = "CANCELLED"; return J({ orderId: mm[1], orderStatus: "CANCELLED" }); }
  return J({ errorMessage: "not simulated: " + u.pathname }, 404);
};
const { db, rpcs } = await import("./fakesb.mjs");
rpcs.dhan_send = async (a) => { const r = await fetch("https://api.dhan.co" + a.p_path, { method: a.p_method, body: a.p_body || undefined }); return { data: { status: r.status, body: await r.text() }, error: null }; };
const E = await import("./engine.mjs");
db.broker_accounts = [{ user_id: "u1", broker: "DHAN", client_id: "C1", access_token: "TOK", webhook_url: null }];
db.notifications = []; db.live_orders = []; db.stock_actions = [];
db.fno_contracts = [{ seg: "NSE_FNO", sec_id: "66001", underlying: "KOTAKBANK", instrument: "FUTSTK", expiry: "2026-11-23", lot: 10000, tick: 0.05, display: "KOTAKBANK NOV FUT", synced_at: new Date().toISOString() }];
const friday = "2026-11-13T09:59:00.000Z";
const base = { owner_id: "u1", active: true, exchange: "NSE", futures_symbol: "KOTAKBANK1!", dhan_symbol: "KOTAKBANK", underlying: "KOTAKBANK", data_segment: "NSE_EQ", data_security_id: "1922",
  data_instrument: "EQUITY", trade_type: "FUTURES", qty_mode: "UNITS", lots: 1, lot_size: 2000, product_type: "M", strategy_kind: "RULES" };
const longRow = () => ({ ...base, id: "k1", name: "Kotak long", live: true, position: "LONG", pos_qty: 2000, pos_lots: 1, pos_entry_px: 2000, pos_entry_date: "2026-11-10", pos_ltp: 2010, pos_ltp_at: friday,
  pos_risk: { basis: "UNDERLYING", dir: 1, entry: 2000, stop: 1900, tgt: 2200, best: 2050, trail: { type: "POINTS", value: 60 }, trailAtr: 0, scanFrom: 0 },
  risk: { basis: "UNDERLYING", sl: { type: "POINTS", value: 100 } },
  pos_broker: { broker: "DHAN", legs: [{ sec: "66001", seg: "NSE_FNO", qty: 2000, product: "MARGIN" }], tick: 0.05, step: 1, option: false, offset: 0, fill: 2001, stopId: "S1", stopTrig: 1990, stopRow: 5 } });
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

await t("without the adjustment the 5:1 split would look like a stop being hit (the case this guards)", async () => {
  assert.ok(400 < longRow().pos_risk.stop);
});
await t("Kotak 5:1 ex-date: a held long is adjusted once — 10,000 shares at 400, stop 380, target 440, trail 12 points, broker stop replaced", async () => {
  db.algo_strategies = [longRow()];
  dhan.orders.set("S1", { orderId: "S1", orderStatus: "PENDING" });
  db.live_orders = [{ id: 5, strategy_id: "k1", broker_order_id: "S1", state: "resting", purpose: "stop" }];
  const s = await E.stockExDate({ ...db.algo_strategies[0] }, 402);
  const r = db.algo_strategies[0];
  assert.equal(r.pos_qty, 10000); assert.equal(r.lot_size, 10000); assert.equal(r.pos_entry_px, 400); assert.equal(r.ca_day, "2026-11-16");
  assert.equal(r.pos_risk.stop, 380); assert.equal(r.pos_risk.tgt, 440); assert.equal(r.pos_risk.best, 410); assert.equal(r.pos_risk.entry, 400); assert.equal(r.pos_risk.trail.value, 12);
  assert.equal(r.pos_broker.legs[0].qty, 10000); assert.equal(r.pos_broker.fill, 400.2); assert.equal(r.pos_broker.stopId, null);
  assert.equal(r.pos_upnl, Math.trunc((402 - 400) * 10000));
  assert.equal(dhan.orders.get("S1").orderStatus, "CANCELLED"); assert.equal(db.live_orders[0].state, "cancelled");
  assert.deepEqual(db.stock_actions.map((a) => [a.asset, a.day, a.factor, a.in_daily, a.in_intraday]), [["KOTAKBANK", "2026-11-16", 0.2, true, true]]);
  assert.ok(db.notifications.some((n) => /position adjusted/.test(n.title)), "owner told");
  assert.equal(s.pos_qty, 10000);
  // the same price a second later (per-second loop, then the minute tick): nothing changes again
  const again = await E.stockExDate({ ...r }, 401);
  assert.equal(db.algo_strategies[0].pos_qty, 10000); assert.equal(again.pos_entry_px, 400);
  const stale = await E.stockExDate({ ...longRow() }, 401); // an older copy of the row (other loop): the claim stops it
  assert.equal(db.algo_strategies[0].pos_qty, 10000); assert.equal(stale.pos_qty, 10000);
});
await t("the adjusted position's stop isn't hit by the new price", async () => {
  await E.secondRisk({ ...db.algo_strategies[0] }, 401, new Date().toISOString());
  assert.equal(db.algo_strategies[0].position, "LONG"); assert.ok(!db.algo_signals?.length);
});
await t("the price loop's older copy of the row (read before the adjustment) gets the adjusted stop, not the old one", async () => {
  const old = { ...longRow(), ca_day: null }; // what the per-second loop may still hold for up to 5 seconds
  const got = await E.stockExDate(old, 401);
  assert.equal(got.pos_risk.stop, 380); assert.equal(got.pos_qty, 10000);
  await E.secondRisk(got, 401, new Date().toISOString());
  assert.equal(db.algo_strategies[0].position, "LONG", "no false stop");
});
await t("a short in LOTS mode: lots stay, the lot size follows the exchange; P&L unchanged", async () => {
  const before = (2010 - 2050) * -1 * 1 * 2000; // short 1 lot of 2,000 from 2,050, price 2,010
  db.algo_strategies = [{ ...longRow(), id: "k2", live: false, position: "SHORT", qty_mode: "LOTS", pos_qty: 1, pos_entry_px: 2050, pos_broker: null,
    pos_risk: { basis: "UNDERLYING", dir: -1, entry: 2050, stop: 2150, tgt: null, best: 2000, trail: null, trailAtr: 0, scanFrom: 0 } }];
  await E.stockExDate({ ...db.algo_strategies[0] }, 402);
  const r = db.algo_strategies[0];
  assert.equal(r.pos_qty, 1); assert.equal(r.lot_size, 10000); assert.equal(r.pos_entry_px, 410); assert.equal(r.pos_risk.stop, 430);
  assert.equal((402 - 410) * -1 * 1 * 10000, (2010 - 2050) * -1 * 2000 , "P&L at the equivalent price is the same"); void before;
});
await t("a flat strategy on the stock: its waiting breakout trigger and lot size move; one opened today is left alone", async () => {
  db.algo_strategies = [{ ...base, id: "k3", position: "FLAT", pending_trigger: 2100, last_close: 2010, last_run_at: friday },
    { ...longRow(), id: "k4", live: false, pos_entry_date: "2026-11-16", pos_entry_px: 401, pos_qty: 10000, lot_size: 10000, pos_ltp_at: new Date().toISOString() }];
  await E.stockExDate({ ...db.algo_strategies[0] }, 402);
  assert.equal(db.algo_strategies[0].pending_trigger, 420); assert.equal(db.algo_strategies[0].lot_size, 10000);
  await E.stockExDate({ ...db.algo_strategies[1] }, 402);
  assert.equal(db.algo_strategies[1].pos_entry_px, 401); assert.equal(db.algo_strategies[1].pos_qty, 10000);
});
await t("a normal day (dividend-size move): nothing is changed or recorded", async () => {
  clock += 3 * 86400000; // Thursday
  db.stock_actions = []; db.algo_strategies = [{ ...longRow(), id: "k5", ca_day: null, pos_ltp_at: new Date(clock - 86400000).toISOString(), pos_ltp: 400, pos_entry_px: 400, lot_size: 10000, pos_qty: 10000 }];
  await E.stockExDate({ ...db.algo_strategies[0] }, 392);
  assert.equal(db.algo_strategies[0].pos_qty, 10000); assert.equal(db.stock_actions.length, 0);
});
await t("Dhan already adjusted its history: the action is recorded with no candle adjustment, the position still adjusted", async () => {
  clock += 86400000; // Friday
  dhan.adjusted = true;
  db.stock_actions = []; db.algo_strategies = [{ ...longRow(), id: "k6", underlying: "KOTAKBANK", pos_ltp_at: new Date(clock - 86400000).toISOString() }];
  await E.stockExDate({ ...db.algo_strategies[0] }, 402);
  assert.deepEqual(db.stock_actions.map((a) => [a.in_daily, a.in_intraday]), [[false, false]]);
  assert.equal(db.algo_strategies[0].pos_qty, 10000);
});
await t("a 25% gap that matches a 1:3 bonus but Dhan's lot hasn't changed: treated as a real move, owner told", async () => {
  clock += 3 * 86400000; // Monday
  dhan.adjusted = false; dhan.rawClose = 400;
  db.notifications = []; db.stock_actions = [];
  db.fno_contracts = [{ seg: "NSE_FNO", sec_id: "66001", underlying: "KOTAKBANK", instrument: "FUTSTK", expiry: "2026-11-30", lot: 10000, tick: 0.05, display: "KOTAKBANK NOV FUT", synced_at: new Date().toISOString() }];
  db.algo_strategies = [{ ...longRow(), id: "k8", lot_size: 10000, pos_qty: 10000, pos_entry_px: 400, pos_ltp: 400, pos_ltp_at: new Date(clock - 3 * 86400000).toISOString(),
    pos_risk: { basis: "UNDERLYING", dir: 1, entry: 400, stop: 380, tgt: null, best: 400, trail: null, trailAtr: 0, scanFrom: 0 }, pos_broker: null }];
  await E.stockExDate({ ...db.algo_strategies[0] }, 300);
  assert.equal(db.algo_strategies[0].pos_qty, 10000); assert.equal(db.stock_actions.length, 0);
  assert.ok(db.notifications.some((n) => /gapped 25%/.test(n.title)));
});
await t("…and the same gap with Dhan's lot gone from 10,000 to 13,333: adjusted as a bonus", async () => {
  clock += 86400000;
  db.stock_actions = []; db.fno_contracts[0].lot = 13333;
  db.algo_strategies = [{ ...db.algo_strategies[0], id: "k9", pos_ltp_at: new Date(clock - 86400000).toISOString() }];
  await E.stockExDate({ ...db.algo_strategies[0] }, 300);
  assert.equal(db.algo_strategies[0].pos_qty, 13333); assert.equal(db.algo_strategies[0].lot_size, 13333); assert.equal(db.algo_strategies[0].pos_risk.stop, 285);
});
await t("a strategy already priced today isn't checked against Dhan's candles again (no extra Dhan calls)", async () => {
  clock += 86400000; db.stock_actions = []; // a later day, no split / bonus
  const n0 = dhan.log.filter((l) => /charts/.test(l)).length;
  db.algo_strategies = [{ ...longRow(), id: "k10", pos_ltp: 400, pos_ltp_at: new Date().toISOString(), pos_entry_px: 400, lot_size: 10000, pos_qty: 10000 }];
  await E.stockExDate({ ...db.algo_strategies[0] }, 401);
  assert.equal(dhan.log.filter((l) => /charts/.test(l)).length, n0); assert.equal(db.algo_strategies[0].pos_qty, 10000);
});
await t("flat stock strategies take Dhan's current lot size", async () => {
  clock += 86400000; // a day without an ex-date (on one, the adjustment sets the lot and this sync waits)
  db.algo_strategies = [{ ...base, id: "k7", position: "FLAT", lot_size: 2000 }];
  await E.stockLotSync({ ...db.algo_strategies[0] });
  assert.equal(db.algo_strategies[0].lot_size, db.fno_contracts[0].lot);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
