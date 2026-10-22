// End-to-end scenarios against a simulated Dhan and an in-memory database.
import assert from "node:assert/strict";
// A weekday, 11:00 IST (market open).
const T0 = Date.parse("2026-10-15T05:30:00Z"); let clock = T0;
Date.now = () => clock;
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
globalThis.Deno = { env: { get: (k) => k === "SUPABASE_URL" ? "http://x" : "k" }, serve: () => {} };
globalThis.EdgeRuntime = { waitUntil() {} };
const dhan = { orders: new Map(), ltp: {}, positions: [], log: [], next: 1, reject: null };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), m = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null;
  const J = (x, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
  dhan.log.push(`${m} ${u.pathname}`);
  if (u.pathname === "/v2/marketfeed/ltp") { const seg = Object.keys(body).find((k) => k !== "dhanClientId"); const sec = String(body[seg][0]); return J({ data: { [seg]: { [sec]: { last_price: dhan.ltp[sec] } } }, status: "success" }); }
  if (u.pathname === "/v2/orders" && m === "POST") {
    if (dhan.reject) { const r = dhan.reject; dhan.reject = null; return J({ errorMessage: r }, 400); }
    const id = String(dhan.next++); dhan.orders.set(id, { ...body, orderId: id, orderStatus: body.orderType.startsWith("STOP") ? "PENDING" : "PENDING", filledQty: 0 });
    return J({ orderId: id, orderStatus: "TRANSIT" });
  }
  let mm = u.pathname.match(/^\/v2\/orders\/(\w+)$/);
  if (mm) {
    const o = dhan.orders.get(mm[1]);
    if (m === "GET") return J(o ?? {}, o ? 200 : 404);
    if (m === "PUT") { Object.assign(o, { orderType: body.orderType, price: body.price, triggerPrice: body.triggerPrice, quantity: body.quantity }); return J({ orderId: o.orderId, orderStatus: o.orderStatus }); }
    if (m === "DELETE") { if (o.orderStatus === "TRADED") return J({ errorMessage: "already traded" }, 400); o.orderStatus = "CANCELLED"; return J({ orderId: o.orderId, orderStatus: "CANCELLED" }); }
  }
  if (u.pathname === "/v2/positions") return J(dhan.positions);
  return J({ errorMessage: "not simulated: " + u.pathname }, 404);
};
const fill = (id, px, status = "TRADED") => Object.assign(dhan.orders.get(String(id)), { orderStatus: status, filledQty: status === "TRADED" ? dhan.orders.get(String(id)).quantity : 0, averageTradedPrice: px });
const { db, rpcs } = await import("./fakesb.mjs");
let viaDb = 0;
rpcs.dhan_send = async (a) => { viaDb++; const r = await fetch("https://api.dhan.co" + a.p_path, { method: a.p_method, body: a.p_body || undefined }); return { data: { status: r.status, body: await r.text() }, error: null }; };
const E0 = await import("./engine.mjs");
const E = { ...E0, runOrders: async (n) => { clock += 16000; const r = await E0.runOrders(n); if (r.skipped) throw new Error(r.skipped); return r; } };
const iso = () => new Date().toISOString();
db.broker_accounts = [{ user_id: "u1", broker: "DHAN", client_id: "C1", access_token: "TOK", webhook_url: null }];
db.live_lock = [{ id: 1, until: "2000-01-01T00:00:00Z" }];
db.fno_contracts = [{ seg: "NSE_FNO", sec_id: "35001", underlying: "NIFTY", instrument: "FUTIDX", expiry: "2026-10-27", lot: 75, tick: 0.05, display: "NIFTY OCT FUT", synced_at: iso() },
  { seg: "NSE_FNO", sec_id: "45001", underlying: "NIFTY", instrument: "OPTIDX", expiry: "2026-10-20", strike: 25000, opt_type: "CE", lot: 75, tick: 0.05, display: "NIFTY 25000 CE", synced_at: iso() }];
db.algo_signals = []; db.algo_trades = []; db.notifications = []; db.live_orders = [];
const tpl = '{"transactionType":"{side}","orderType":"MKT","quantity":"{qty}","exchange":"{exchange}","symbol":"{symbol}","instrument":"FUT","productType":"{product}","sort_order":"{sort}","price":"0"}';
const base = { id: "s1", owner_id: "u1", name: "Nifty test", live: true, active: true, exchange: "NSE", futures_symbol: "NIFTY1!", dhan_symbol: "NIFTY", underlying: "NIFTY", data_segment: "IDX_I",
  data_security_id: "13", trade_type: "FUTURES", qty_mode: "LOTS", lots: 1, lot_size: 75, product_type: "M", leg_template_fut: tpl, risk: { basis: "UNDERLYING", sl: { type: "POINTS", value: 100 } }, position: "FLAT", strategy_kind: "FLIP" };
db.algo_strategies = [{ ...base }];
const S = () => db.algo_strategies.find((x) => x.id === "s1");
const lo = () => db.live_orders;
const set = { user_id: "u1", broker: "DHAN", dhan_client_id: "C1", dhan_access_token: "TOK" };
const leg = (side) => ({ transactionType: side, orderType: "MKT", quantity: "1", exchange: "NSE", symbol: "NIFTY1!", instrument: "FUT", productType: "M" });
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

const { db: _d } = await import("./fakesb.mjs"); await t("entry: limit at the futures LTP, strategy marked working", async () => {
  dhan.ltp["35001"] = 25120.02;
  assert.equal(await E.queueDhan(S(), set, "ENTRY", [leg("B")], "Buy NIFTY1! x 1", { c: 25000 }), true);
  const o = dhan.orders.get("1");
  assert.equal(o.orderType, "LIMIT"); assert.equal(o.price, 25120.05); assert.equal(o.quantity, 75); assert.equal(o.exchangeSegment, "NSE_FNO"); assert.equal(o.productType, "MARGIN");
  assert.equal(S().exec_state, "working"); assert.equal(lo()[0].state, "working");
  Object.assign(S(), { position: "LONG", pos_qty: 1, pos_entry_px: 25000, pos_risk: { basis: "UNDERLYING", dir: 1, stop: 24900, tgt: null, trail: null, best: 25000, scanFrom: 0 } });
});
await t("quiet market (LTP at the limit) → left alone", async () => {
  dhan.ltp["35001"] = 25120.05;
  await E.runOrders(1);
  assert.equal(dhan.orders.get("1").price, 25120.05); assert.equal(lo()[0].steps, 0);
});
await t("price moves up → limit raised one step (5 pts)", async () => {
  dhan.ltp["35001"] = 25124;
  await E.runOrders(1);
  assert.equal(dhan.orders.get("1").price, 25125.05); assert.equal(lo()[0].steps, 1);
});
await t("fill → recorded, offset vs index kept, strategy free", async () => {
  fill(1, 25125.05);
  await E.runOrders(1);
  assert.equal(lo()[0].state, "filled"); assert.equal(S().exec_state, null);
  assert.equal(S().pos_broker.legs[0].qty, 75); assert.equal(S().pos_broker.offset, 125.05);
});
await t("broker stop placed beyond the desk stop (index stop + futures gap)", async () => {
  const s2 = await E.syncStop(S(), set);
  const stop = dhan.orders.get("2");
  assert.equal(stop.orderType, "STOP_LOSS"); assert.equal(stop.transactionType, "SELL");
  assert.equal(stop.triggerPrice, 25015.05); // 24900 + 125.05 − 2 steps of 5
  assert.ok(stop.price < stop.triggerPrice);
  assert.equal(S().pos_broker.stopId, "2"); assert.ok(lo().some((r) => r.purpose === "stop" && r.state === "resting"));
});
await t("trailing stop tightens → broker stop moved up, never down", async () => {
  S().pos_risk = { ...S().pos_risk, stop: 24950 };
  await E.syncStop(S(), set);
  assert.equal(dhan.orders.get("2").triggerPrice, 25065.05);
  S().pos_risk = { ...S().pos_risk, stop: 24920 };
  await E.syncStop(S(), set);
  assert.equal(dhan.orders.get("2").triggerPrice, 25065.05);
});
await t("exit: stop cancelled first, position checked, exit sent", async () => {
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 75 }];
  dhan.ltp["35001"] = 25200;
  assert.equal(await E.queueDhan(S(), set, "EXIT", [leg("S")], "Sell NIFTY1! x 1 to close long", { c: 25080 }), true);
  assert.equal(dhan.orders.get("2").orderStatus, "CANCELLED");
  const ex = dhan.orders.get("3"); assert.equal(ex.transactionType, "SELL"); assert.equal(ex.price, 25200);
  // the desk books the trade at its own price (bookPnl), then goes flat
  db.algo_trades.push({ id: 900, strategy_id: "s1", mode: "LIVE", exit_at: iso(), units: 75, entry_px: 25000, exit_px: 25080, gross: 6000, costs: 100, net: 5900, exit_why: "Exit" });
  Object.assign(S(), { position: "FLAT", pos_broker: null, pos_risk: null });
});
await t("exit rejected → retried at market → fill corrects the ledger to Dhan's prices", async () => {
  fill(3, null, "REJECTED"); dhan.orders.get("3").omsErrorDescription = "price band";
  await E.runOrders(1);
  const r = lo().find((x) => x.purpose === "exit");
  assert.equal(r.market_retry, true); const mk = dhan.orders.get("4"); assert.equal(mk.orderType, "MARKET");
  fill(4, 25195);
  await E.runOrders(1);
  const tr = db.algo_trades[0];
  assert.equal(tr.entry_px, 25125.05); assert.equal(tr.exit_px, 25195); assert.equal(tr.gross, Math.trunc((25195 - 25125.05) * 75));
  assert.equal(S().exec_state, null);
});
await t("exit for a position Dhan doesn't hold → not sent (no wrong-way trade), alert", async () => {
  Object.assign(S(), { position: "LONG", pos_qty: 1, pos_broker: { broker: "DHAN", legs: [{ sec: "35001", seg: "NSE_FNO", qty: 75 }], tick: 0.05, step: 5, option: false, offset: 0, fill: 25000 } });
  dhan.positions = [];
  const n0 = dhan.next;
  assert.equal(await E.queueDhan(S(), set, "EXIT", [leg("S")], "x", { c: 25000 }), true);
  assert.equal(dhan.next, n0);
  assert.ok(db.notifications.some((n) => /Exit not sent/.test(n.title)));
  Object.assign(S(), { position: "FLAT", pos_broker: null, exec_state: null });
});
await t("entry chased 4 steps then given up → desk flat again, alert", async () => {
  dhan.ltp["35001"] = 25300;
  await E.queueDhan(S(), set, "ENTRY", [leg("B")], "Buy", { c: 25180 });
  Object.assign(S(), { position: "LONG", pos_qty: 1 });
  for (let i = 0; i < 5; i++) { dhan.ltp["35001"] += 20; await E.runOrders(1); }
  const r = lo()[lo().length - 1];
  assert.equal(r.state, "gave_up"); assert.equal(r.steps, 4);
  assert.equal(S().position, "FLAT"); assert.equal(S().exec_state, null); assert.equal(S().active, true);
  assert.ok(db.notifications.some((n) => /Entry not filled/.test(n.title)));
});
await t("entry rejected → desk flat, strategy paused with Dhan's reason", async () => {
  dhan.reject = "Insufficient margin";
  const ok = await E.queueDhan(S(), set, "ENTRY", [leg("B")], "Buy", { c: 25180 });
  assert.equal(ok, false); assert.equal(S().exec_state, null);
  assert.match(S().last_error, /Insufficient margin/); assert.equal(S().active, false);
  Object.assign(S(), { active: true, last_error: null, position: "FLAT" });
});
await t("reversal: entry waits until the exit fills", async () => {
  Object.assign(S(), { position: "LONG", pos_qty: 1, pos_broker: { broker: "DHAN", legs: [{ sec: "35001", seg: "NSE_FNO", qty: 75 }], tick: 0.05, step: 5, option: false, offset: 100, fill: 25100 } });
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 75 }];
  dhan.ltp["35001"] = 25100;
  const n0 = dhan.next;
  await E.queueDhan(S(), set, "REVERSE", [leg("S"), leg("S")], "Reverse", { c: 25000 });
  assert.equal(dhan.next, n0 + 1); // only the exit so far
  const ex = String(n0); fill(ex, 25100); await E.runOrders(1);
  const en = dhan.orders.get(String(n0 + 1)); assert.ok(en, "entry placed after the exit filled"); assert.equal(en.transactionType, "SELL");
  fill(n0 + 1, 25099); await E.runOrders(1);
  assert.equal(S().pos_broker.legs[0].qty, -75); assert.equal(S().exec_state, null);
});
await t("broker stop fills → desk books the exit and goes flat", async () => {
  Object.assign(S(), { position: "SHORT", pos_qty: 1, pos_entry_px: 25000, pos_risk: { basis: "UNDERLYING", dir: -1, stop: 25100, tgt: null, trail: null, best: 25000, scanFrom: 0 } });
  await E.syncStop(S(), set);
  const sid = S().pos_broker.stopId; assert.equal(dhan.orders.get(sid).transactionType, "BUY");
  fill(sid, 25205);
  const before = db.algo_trades.length;
  await E.runOrders(1);
  assert.equal(S().position, "FLAT"); assert.equal(db.algo_trades.length, before + 1);
  assert.ok(db.algo_signals.some((g) => g.event === "STOP_LOSS" && /Stop-loss order filled/.test(g.description)));
});
await t("reconcile: broker holds a contract the desk doesn't → alert once", async () => {
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: -75 }];
  const r1 = await E.reconcile(); const n1 = db.notifications.filter((n) => /don't match/.test(n.title)).length;
  await E.reconcile(); const n2 = db.notifications.filter((n) => /don't match/.test(n.title)).length;
  assert.match(JSON.stringify(r1), /desk 0 broker -75/); assert.equal(n1, 1); assert.equal(n2, 1);
});
await t("reconcile: matching positions → match", async () => {
  Object.assign(S(), { position: "SHORT", pos_broker: { broker: "DHAN", legs: [{ sec: "35001", seg: "NSE_FNO", qty: -75 }], tick: 0.05, step: 5, option: false, offset: 0, fill: 1 } });
  assert.match(JSON.stringify(await E.reconcile()), /match/);
});

// ---------- Delta Exchange ----------
const delta = { orders: new Map(), next: 500, positions: [], partial: false, calls: [] };
rpcs.delta_send = (a) => {
  const body = a.p_body ? JSON.parse(a.p_body) : null; delta.calls.push(`${a.p_method} ${a.p_path}`);
  const R = (x, st = 200) => ({ data: { status: st, body: JSON.stringify({ success: st < 300, result: x }) }, error: null });
  if (a.p_path === "/v2/orders" && a.p_method === "POST") {
    const id = delta.next++;
    const stop = !!body.stop_order_type;
    const o = { id, ...body, state: stop ? "open" : "closed", unfilled_size: stop ? body.size : delta.partial ? 3 : 0, average_fill_price: stop ? null : "64000.5" };
    delta.orders.set(String(id), o); return R(o);
  }
  if (a.p_path === "/v2/orders" && a.p_method === "PUT") { Object.assign(delta.orders.get(String(body.id)), { stop_price: body.stop_price }); return R(delta.orders.get(String(body.id))); }
  if (a.p_path === "/v2/orders" && a.p_method === "DELETE") { Object.assign(delta.orders.get(String(body.id)), { state: "cancelled" }); return R({}); }
  const m = a.p_path.match(/^\/v2\/orders\/(\d+)$/); if (m) return R(delta.orders.get(m[1]));
  if (a.p_path === "/v2/positions/margined") return R(delta.positions);
  return R({ error: "not simulated" }, 404);
};
db.broker_accounts.push({ user_id: "u1", broker: "DELTA", client_id: "KEY", access_token: "SECRET" });
const dset = { user_id: "u1", broker: "DELTA", dhan_client_id: "KEY", dhan_access_token: "SECRET" };
db.algo_strategies.push({ ...base, id: "c1", name: "BTC test", exchange: "DELTA", futures_symbol: "BTCUSD", dhan_symbol: "BTCUSD", underlying: "BTCUSD", data_segment: "DELTA", lot_size: 0.001,
  risk: { basis: "UNDERLYING", sl: { type: "PCT", value: 1 } } });
const C = () => db.algo_strategies.find((x) => x.id === "c1");
await t("delta entry: market order checked filled, position recorded", async () => {
  assert.equal(await E.sendDelta(C(), dset, "ENTRY", [{ broker: "DELTA", symbol: "BTCUSD", side: "B", qty: 1, reduce_only: false }], "Buy", { c: 64000 }), true);
  assert.ok(C().pos_broker.legs[0].qty > 0); assert.equal(C().pos_broker.fill, 64000.5);
  Object.assign(C(), { position: "LONG", pos_qty: 1, pos_risk: { basis: "UNDERLYING", dir: 1, stop: 63360, tgt: null, trail: null, best: 64000, scanFrom: 0 } });
});
await t("delta stop placed (reduce-only stop-loss order) below the desk stop", async () => {
  await E.syncStop(C(), dset);
  const o = delta.orders.get(String(C().pos_broker.stopId));
  assert.equal(o.stop_order_type, "stop_loss_order"); assert.equal(o.reduce_only, true); assert.equal(o.side, "sell"); assert.ok(Number(o.stop_price) < 63360);
});
await t("delta exit: stop cancelled, reduce-only exit, position cleared", async () => {
  const sid = String(C().pos_broker.stopId);
  assert.equal(await E.sendDelta(C(), dset, "EXIT", [{ broker: "DELTA", symbol: "BTCUSD", side: "S", qty: 1, reduce_only: true }], "Sell", { c: 64100 }), true);
  assert.equal(delta.orders.get(sid).state, "cancelled"); assert.equal(C().pos_broker, null);
});
await t("delta partial fill → reported as failed (strategy gets paused by the caller)", async () => {
  delta.partial = true;
  assert.equal(await E.sendDelta(C(), dset, "ENTRY", [{ broker: "DELTA", symbol: "BTCUSD", side: "B", qty: 1, reduce_only: false }], "Buy", { c: 64000 }), false);
  delta.partial = false;
});

await t("supervised live test: 1 lot NATGASMINI, worked, filled, stop placed in the same run, closed", async () => {
  db.mcx_contracts = [{ sec_id: "460001", underlying: "NATGASMINI", display: "NATGASMINI NOV FUT", expiry: "2026-10-27", lot: 1, tick: 0.1, synced_at: iso() }];
  const tplm = tpl;
  db.algo_strategies.push({ ...base, id: "m1", name: "NG test", exchange: "MCX", futures_symbol: "NATGASMINI1!", dhan_symbol: "NATGASMINI", underlying: "NATGASMINI", data_segment: "MCX_COMM",
    data_security_id: "NATGASMINI", lot_size: 250, active: false, leg_template_fut: tplm, risk: { basis: "UNDERLYING", sl: { type: "PCT", value: 3 } } });
  const M = () => db.algo_strategies.find((x) => x.id === "m1");
  dhan.ltp["460001"] = 300.25;
  const r = await E.liveTest("m1");
  assert.equal(r.ok, true, JSON.stringify(r));
  const id = String(dhan.next - 1), o = dhan.orders.get(id);
  assert.equal(o.exchangeSegment, "MCX_COMM"); assert.equal(o.quantity, 1); assert.equal(o.price, 300.3);
  assert.equal(M().position, "LONG"); assert.equal(M().exec_state, "working");
  fill(id, 300.3);
  await E.runOrders(1);
  const sid = M().pos_broker?.stopId; assert.ok(sid, "stop placed");
  const so = dhan.orders.get(sid); assert.equal(so.transactionType, "SELL"); assert.ok(so.triggerPrice < 296 && so.triggerPrice > 295, String(so.triggerPrice));
  assert.equal(M().pos_entry_px, 300.3);
  dhan.positions = [{ exchangeSegment: "MCX_COMM", securityId: "460001", netQty: 1 }];
  assert.equal(await E.queueDhan(M(), set, "FLATTEN", [leg("S")].map((l) => ({ ...l, exchange: "MCX", symbol: "NATGASMINI1!" })), "Manual exit", { c: 301 }), true);
  assert.equal(dhan.orders.get(sid).orderStatus, "CANCELLED");
});
await t("per-second stop: paper position below its stop exits once, even when two checks see it together", async () => {
  const P = { ...base, id: "p1", name: "Paper stop", live: false, position: "LONG", pos_qty: 1, pos_entry_px: 25000, pos_entry_date: "2026-10-15", exec_state: null,
    pos_risk: { basis: "UNDERLYING", dir: 1, stop: 24900, tgt: null, trail: null, best: 25000, scanFrom: 0 } };
  db.algo_strategies.push(P);
  const before = db.algo_trades.length;
  const p1 = () => db.algo_strategies.find((x) => x.id === "p1");
  await Promise.all([E.secondRisk({ ...p1() }, 24880, iso()), E.secondRisk({ ...p1() }, 24880, iso())]);
  assert.equal(p1().position, "FLAT");
  assert.equal(db.algo_trades.length - before, 1, "one trade booked");
  const tr = db.algo_trades.at(-1); assert.equal(Number(tr.exit_px), 24880); assert.equal(p1().exec_state, null);
});
await t("per-second trailing: a new best price moves the trailing stop, then a pull-back exits", async () => {
  const P = { ...base, id: "p2", name: "Paper trail", live: false, position: "SHORT", pos_qty: 1, pos_entry_px: 25000, pos_entry_date: "2026-10-15", exec_state: null, risk: { basis: "UNDERLYING", trail: { type: "POINTS", value: 50 } },
    pos_risk: { basis: "UNDERLYING", dir: -1, stop: null, tgt: null, trail: { type: "POINTS", value: 50 }, best: 25000, scanFrom: 0 } };
  db.algo_strategies.push(P);
  const p2 = () => db.algo_strategies.find((x) => x.id === "p2");
  await E.secondRisk({ ...p2() }, 24900, iso());           // new low: trail now 24950
  assert.equal(p2().pos_risk.best, 24900); assert.equal(p2().position, "SHORT");
  clock += 1000; await E.secondRisk({ ...p2() }, 24940, iso()); // still under 24950
  assert.equal(p2().position, "SHORT");
  clock += 1000; await E.secondRisk({ ...p2() }, 24960, iso()); // above 24950: exit
  assert.equal(p2().position, "FLAT");
  assert.equal(Number(db.algo_trades.at(-1).exit_px), 24960);
});
await t("Dhan order calls went through the database (fixed IP)", async () => assert.ok(viaDb > 20));
console.log(fails ? `${fails} failed` : "all passed");

