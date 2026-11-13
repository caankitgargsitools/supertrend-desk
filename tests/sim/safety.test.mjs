// Phase 1 "stop silent losses" (4 Nov 2026): paused positions still managed, exits to the contract held, one decision
// per candle, rejected exits put back and retried, stop cancels confirmed, stuck order states, partly filled entries,
// overnight broker stops, option expiry day, and provisional live P&L confirmed by Dhan's fills.
// Simulated Dhan and an in-memory database (node build.mjs first).
import assert from "node:assert/strict";
const T0 = Date.parse("2026-10-15T05:30:00Z"); let clock = T0; // Thursday, 11:00 IST
Date.now = () => clock;
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
let handler = null;
globalThis.Deno = { env: { get: (k) => k === "SUPABASE_URL" ? "http://x" : "k" }, serve: (h) => { handler = h; } };
globalThis.EdgeRuntime = { waitUntil() {} };
const dhan = { orders: new Map(), ltp: {}, positions: [], next: 1, reject: null, noCancel: new Set(), onCancel: null, chain: {}, expiries: [], calls: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), m = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null;
  const J = (x, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
  dhan.calls.push(`${m} ${u.pathname}`);
  if (u.pathname === "/v2/marketfeed/ltp") {
    const data = {};
    for (const seg of Object.keys(body).filter((k) => k !== "dhanClientId")) { data[seg] = {}; for (const sec of body[seg]) if (dhan.ltp[String(sec)] != null) data[seg][String(sec)] = { last_price: dhan.ltp[String(sec)] }; }
    return J({ data, status: "success" });
  }
  if (u.pathname === "/v2/optionchain/expirylist") return J({ data: dhan.expiries, status: "success" });
  if (u.pathname === "/v2/optionchain") return J({ data: { oc: dhan.chain[body.Expiry] ?? {} }, status: "success" });
  if (u.pathname === "/v2/orders" && m === "POST") {
    if (dhan.rejectAll) return J({ errorMessage: dhan.rejectAll }, 400);
    if (dhan.autoFill && body.orderType === "MARKET") { const id = String(dhan.next++); dhan.orders.set(id, { ...body, orderId: id, orderStatus: "TRADED", filledQty: dhan.autoFillQty ?? body.quantity, averageTradedPrice: dhan.autoFill }); return J({ orderId: id, orderStatus: "TRANSIT" }); }
    if (dhan.reject) { const r = dhan.reject; dhan.reject = null; return J({ errorMessage: r }, 400); }
    const id = String(dhan.next++); dhan.orders.set(id, { ...body, orderId: id, orderStatus: "PENDING", filledQty: 0 });
    return J({ orderId: id, orderStatus: "TRANSIT" });
  }
  const mm = u.pathname.match(/^\/v2\/orders\/(\w+)$/);
  if (mm) {
    const o = dhan.orders.get(mm[1]);
    if (m === "GET") return J(o ?? {}, o ? 200 : 404);
    if (m === "PUT") { Object.assign(o, { orderType: body.orderType, price: body.price, triggerPrice: body.triggerPrice, quantity: body.quantity }); return J({ orderId: o.orderId, orderStatus: o.orderStatus }); }
    if (m === "DELETE") {
      if (dhan.noCancel.has(mm[1])) return J({ errorMessage: "order is being modified" }, 400);
      if (o.orderStatus === "TRADED") return J({ errorMessage: "already traded" }, 400);
      if (dhan.onCancel) dhan.onCancel(o);
      o.orderStatus = "CANCELLED"; return J({ orderId: o.orderId, orderStatus: "CANCELLED" });
    }
  }
  if (u.pathname === "/v2/positions") return J(dhan.positions);
  return J({ errorMessage: "not simulated: " + u.pathname }, 404);
};
const fill = (id, px, status = "TRADED", qty) => Object.assign(dhan.orders.get(String(id)), { orderStatus: status, filledQty: status === "TRADED" ? dhan.orders.get(String(id)).quantity : (qty ?? 0), averageTradedPrice: px });
const { db, rpcs } = await import("./fakesb.mjs");
rpcs.dhan_send = async (a) => { const r = await fetch("https://api.dhan.co" + a.p_path, { method: a.p_method, body: a.p_body || undefined }); return { data: { status: r.status, body: await r.text() }, error: null }; };
const E0 = await import("./engine.mjs");
const E = { ...E0, runOrders: async (n) => { clock += 16000; const r = await E0.runOrders(n); if (r.skipped) throw new Error(r.skipped); return r; } };
const iso = () => new Date().toISOString();
db.broker_accounts = [{ user_id: "u1", broker: "DHAN", client_id: "C1", access_token: "TOK", webhook_url: null }];
db.live_lock = [{ id: 1, until: "2000-01-01T00:00:00Z" }];
db.engine_secret = [{ secret: "SECRET" }];
db.engine_lock = [{ name: "tick", until: "2000-01-01T00:00:00Z" }, { name: "tick_crypto", until: "2000-01-01T00:00:00Z" }];
db.fno_contracts = [
  { seg: "NSE_FNO", sec_id: "35001", underlying: "NIFTY", instrument: "FUTIDX", expiry: "2026-10-27", lot: 75, tick: 0.05, display: "NIFTY OCT FUT", synced_at: iso() },
  { seg: "NSE_FNO", sec_id: "35002", underlying: "NIFTY", instrument: "FUTIDX", expiry: "2026-11-24", lot: 75, tick: 0.05, display: "NIFTY NOV FUT", synced_at: iso() },
];
db.algo_signals = []; db.algo_trades = []; db.notifications = []; db.live_orders = []; db.market_holidays = []; db.lab_margins = [];
const tpl = '{"transactionType":"{side}","orderType":"MKT","quantity":"{qty}","exchange":"{exchange}","symbol":"{symbol}","instrument":"FUT","productType":"{product}","sort_order":"{sort}","price":"0"}';
const tplOpt = '{"transactionType":"{side}","orderType":"MKT","quantity":"{qty}","exchange":"{exchange}","symbol":"{symbol}","instrument":"OPT","productType":"{product}","sort_order":"{sort}","price":"0","option_type":"{option_type}","strike_price":"{strike}","expiry_date":"{expiry}"}';
const base = { owner_id: "u1", name: "Nifty test", live: true, active: true, archived: false, is_master: false, exchange: "NSE", futures_symbol: "NIFTY1!", dhan_symbol: "NIFTY", underlying: "NIFTY",
  data_segment: "IDX_I", data_security_id: "13", trade_type: "FUTURES", qty_mode: "LOTS", lots: 1, lot_size: 75, product_type: "M", leg_template_fut: tpl, leg_template_opt: tplOpt,
  risk: { basis: "UNDERLYING", sl: { type: "POINTS", value: 100 } }, position: "FLAT", strategy_kind: "FLIP" };
const pbOf = (sec = "35001", qty = 75, extra = {}) => ({ broker: "DHAN", legs: [{ sec, seg: "NSE_FNO", qty, product: "MARGIN" }], tick: 0.05, step: 5, option: false, offset: 0, fill: 25000, ...extra });
const longPos = (extra = {}) => ({ position: "LONG", pos_qty: 1, pos_lots: 1, pos_entry_px: 25000, pos_entry_date: "2026-10-14", pos_margin: 300000,
  pos_risk: { basis: "UNDERLYING", dir: 1, stop: 24900, tgt: null, trail: null, best: 25000, scanFrom: 0 }, pos_broker: pbOf(), exec_state: null, last_error: null, ...extra });
const add = (id, extra) => { db.algo_strategies = (db.algo_strategies ?? []).filter((x) => x.id !== id); db.algo_strategies.push({ ...base, id, ...extra }); return () => db.algo_strategies.find((x) => x.id === id); };
const set = { user_id: "u1", broker: "DHAN", dhan_client_id: "C1", dhan_access_token: "TOK" };
const leg = (side) => ({ transactionType: side, orderType: "MKT", quantity: "1", exchange: "NSE", symbol: "NIFTY1!", instrument: "FUT", productType: "M" });
const write = async (id, upd) => Object.assign(db.algo_strategies.find((x) => x.id === id), JSON.parse(JSON.stringify(upd)));
const note = (re) => db.notifications.some((n) => re.test(n.title));
const ordersOf = (id) => db.live_orders.filter((r) => r.strategy_id === id);
const tick = async (action = "tick") => {
  const r = await handler(new Request("http://x", { method: "POST", headers: { "x-engine-secret": "SECRET", "content-type": "application/json" }, body: JSON.stringify({ action }) }));
  return (await r.json()).results ?? {};
};
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.stack.split("\n").slice(0, 3).join(" | ")); } };

// ---------------- 1. paused strategies with a position are still managed ----------------
await t("1 paused paper position: the per-second stop still exits it", async () => {
  const S = add("p1", { live: false, active: false, ...longPos({ pos_broker: null }) });
  await E.secondRisk(S(), 24850, iso());
  assert.equal(S().position, "FLAT");
  assert.equal(db.algo_trades.filter((x) => x.strategy_id === "p1").length, 1);
});
await t("1 the tick loads a paused strategy holding a position, not a paused flat one", async () => {
  const P = add("p2", { active: false, ...longPos({ exec_state: "exit_retry", exec_at: new Date(clock - 120000).toISOString() }) });
  add("p3", { active: false, position: "FLAT" });
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 75 }];
  dhan.ltp["13"] = 25010; dhan.ltp["35001"] = 25060;
  const res = await tick();
  assert.equal(res.p2, "exit retried"); assert.equal(res.p3, undefined);
  assert.equal(P().position, "FLAT"); assert.equal(P().exec_state, "working");
  const ex = ordersOf("p2").find((r) => r.purpose === "exit"); assert.ok(ex); assert.equal(ex.sec, "35001");
  db.algo_strategies = db.algo_strategies.filter((x) => !["p1", "p2", "p3"].includes(x.id));
  for (const r of db.live_orders) if (["working", "queued"].includes(r.state)) r.state = "cancelled";
});
await t("1 reconcile compares paused live strategies too", async () => {
  add("p4", { active: false, ...longPos() });
  dhan.positions = [];
  const r = await E.reconcile();
  assert.match(JSON.stringify(r), /desk 75 broker 0/);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "p4");
});

// ---------------- 2. exits go to the contract actually held ----------------
await t("2 exit of a position held in an older contract goes to that contract, with the quantity held", async () => {
  const S = add("c1", longPos({ pos_broker: pbOf("34001", 50) })); // held: the September contract (no longer listed), 50 units
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "34001", netQty: 50 }];
  dhan.ltp["34001"] = 25020;
  assert.equal(await E.queueDhan(S(), set, "EXIT", [leg("S")], "Sell NIFTY1! x 1 to close long", { c: 25000 }), true);
  const r = ordersOf("c1").find((x) => x.purpose === "exit");
  assert.equal(r.sec, "34001"); assert.equal(r.qty, 50);
  const o = dhan.orders.get(String(r.broker_order_id)); assert.equal(o.securityId, "34001"); assert.equal(o.quantity, 50);
  r.state = "cancelled"; db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "c1");
});

// ---------------- 3. one decision per candle ----------------
await t("3 the same candle's entry seen twice (slow update): one signal, one entry, nothing changed the second time", async () => {
  const S = add("d1", { live: false, risk: null });
  const candle = { t: Math.floor(clock / 1000 / 60) * 60 - 60, c: 25000 };
  const go = async () => {
    const s = { ...S(), position: "FLAT" }, update = { last_candle_ts: candle.t };
    await E.finishNow(s, set, update, [leg("B")], "ENTRY", ["Buy NIFTY1! x 1"], { position: "LONG", pos_qty: 1, pos_entry_date: "2026-10-15", _px: 25000 }, candle);
  };
  await go();
  assert.equal(S().position, "LONG");
  S().pos_entry_px = 25000; S().pos_qty = 1;
  const before = JSON.stringify(S());
  await go();
  assert.equal(db.algo_signals.filter((g) => g.strategy_id === "d1" && g.event === "ENTRY").length, 1);
  assert.equal(JSON.stringify(S()), before);
});
await t("3 live: a repeated candle sends no second order to Dhan", async () => {
  const S = add("d2", { risk: null });
  dhan.ltp["35001"] = 25000;
  const candle = { t: Math.floor(clock / 1000 / 60) * 60 - 120, c: 25000 };
  const go = () => E.finishNow({ ...S(), position: "FLAT", exec_state: null }, set, {}, [leg("B")], "ENTRY", ["Buy NIFTY1! x 1"], { position: "LONG", pos_qty: 1, pos_entry_date: "2026-10-15", _px: 25000 }, candle);
  await go(); const n = dhan.next; await go();
  assert.equal(dhan.next, n);
  assert.equal(ordersOf("d2").length, 1);
  for (const r of ordersOf("d2")) r.state = "cancelled";
  db.algo_strategies = db.algo_strategies.filter((x) => !["d1", "d2"].includes(x.id));
});

// ---------------- 4 + 10. rejected exit: put back, trade hidden, retried; fills confirm the provisional trade ----------------
await t("4/10 exit booked as provisional, Dhan rejects it (also at market) → position back, trade hidden, retry set", async () => {
  const S = add("r1", longPos());
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 75 }];
  dhan.ltp["35001"] = 25080;
  const upd = {};
  await E.flattenNow(S(), set, upd, { c: 25050 }); await write("r1", upd);
  assert.equal(S().position, "FLAT"); assert.equal(S().exec_state, "working");
  const tr = db.algo_trades.find((x) => x.strategy_id === "r1");
  assert.equal(tr.provisional, true); assert.ok(tr.order_batch);
  const ex = ordersOf("r1").find((r) => r.purpose === "exit");
  fill(ex.broker_order_id, null, "REJECTED"); dhan.orders.get(String(ex.broker_order_id)).omsErrorDescription = "price band";
  dhan.reject = "RMS: blocked"; // the market retry is refused too
  await E.runOrders(1);
  assert.equal(S().position, "LONG"); assert.equal(S().pos_qty, 1); assert.equal(S().pos_risk.stop, 24900);
  assert.equal(S().exec_state, "exit_retry"); assert.equal(S().active, true);
  assert.equal(S().pos_broker.legs[0].sec, "35001"); assert.equal(S().pos_broker.exitTries, 1);
  assert.equal(tr.hidden, true); assert.equal(tr.provisional, false);
  assert.ok(note(/Exit not done yet/));
});
await t("4 an exit Dhan refuses outright (limit and market, e.g. Invalid IP) keeps the position: not flat, no trade booked, retry set", async () => {
  // 13 Nov 2026 audit: the refusal came back inside the send, failRow put the position back, and the caller then
  // booked the trade and wrote FLAT over it — the desk flat while Dhan still held the position.
  const S = add("rx", longPos({ pos_broker: pbOf("35001", 75), pos_risk: null })); // no stop resting at the broker
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 150 }]; // r1 (the test before) holds 75 too
  dhan.ltp["35001"] = 25080; dhan.rejectAll = "Invalid IP";
  const n0 = db.algo_trades.filter((x) => x.strategy_id === "rx" && !x.hidden).length;
  const upd = {};
  await E.flattenNow(S(), set, upd, { c: 25050 }); await write("rx", upd);
  assert.equal(S().position, "LONG", "the desk still holds what Dhan holds");
  assert.equal(S().pos_qty, 1); assert.equal(S().exec_state, "exit_retry"); assert.equal(S().pos_broker.legs[0].sec, "35001");
  assert.equal(db.algo_trades.filter((x) => x.strategy_id === "rx" && !x.hidden).length, n0, "no trade booked");
  assert.ok(note(/Exit not done yet/));
  // the same through a strategy's own exit signal (finishNow)
  const S2 = add("ry", longPos({ pos_broker: pbOf("35001", 75), pos_risk: null }));
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 225 }];
  const u2 = {};
  await E.finishNow(S2(), set, u2, [{ ...leg("S") }], "EXIT", ["Exit signal: Sell NIFTY1! x 1"], { position: "FLAT", pos_qty: null, pos_lots: null, pos_entry_px: null, pos_broker: null, pos_risk: null, pos_margin: null }, { t: Math.floor(clock / 60000) * 60 - 60, c: 25050 });
  assert.equal(S2().position, "LONG"); assert.equal(S2().exec_state, "exit_retry");
  assert.equal(db.algo_trades.filter((x) => x.strategy_id === "ry" && !x.hidden).length, 0);
  dhan.rejectAll = null; dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 75 }];
  db.algo_strategies = db.algo_strategies.filter((x) => !["rx", "ry"].includes(x.id));
  db.live_orders = db.live_orders.filter((x) => !["rx", "ry"].includes(x.strategy_id));
});
await t("4 a stop goes back in at the broker while the exit is retried", async () => {
  const S = () => db.algo_strategies.find((x) => x.id === "r1");
  await E.runOrders(1);
  assert.ok(S().pos_broker.stopId, "stop placed again");
  assert.equal(dhan.orders.get(String(S().pos_broker.stopId)).orderType, "STOP_LOSS");
});
await t("4/10 the retry a minute later goes out; its fill confirms the trade at Dhan's prices", async () => {
  const S = () => db.algo_strategies.find((x) => x.id === "r1");
  db.live_orders.push({ id: 7001, strategy_id: "r1", purpose: "entry", sec: "35001", state: "filled", avg_px: 25010, qty: 75, created_at: "2026-10-14T05:00:00.000Z" });
  assert.equal(await E.retryExit(S(), set), true, "waits for its minute"); assert.equal(S().position, "LONG");
  clock += 60000;
  assert.equal(await E.retryExit(S(), set), true);
  assert.equal(S().position, "FLAT"); assert.equal(S().exec_state, "working");
  const stop = dhan.orders.get(String(db.live_orders.find((r) => r.strategy_id === "r1" && r.purpose === "stop" && r.state !== "failed").broker_order_id));
  assert.equal(stop.orderStatus, "CANCELLED", "stop cancelled before the exit");
  const tr = db.algo_trades.filter((x) => x.strategy_id === "r1" && !x.hidden);
  assert.equal(tr.length, 1); assert.equal(tr[0].provisional, true); assert.match(tr[0].exit_why, /Exit retried \(attempt 2 of 5\)/);
  const ex = ordersOf("r1").filter((r) => r.purpose === "exit" && r.state === "working")[0];
  fill(ex.broker_order_id, 25070);
  await E.runOrders(1);
  assert.equal(tr[0].provisional, false); assert.equal(tr[0].entry_px, 25010); assert.equal(tr[0].exit_px, 25070);
  assert.equal(S().exec_state, null);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "r1");
});
await t("4 five failed exits in a row → the desk stops trying, stops new trades and asks to close by hand", async () => {
  const S = add("r2", longPos({ pos_broker: pbOf("35001", 75, { exitTries: 4, exitWhy: "Stop loss" }) }));
  const upd = {};
  dhan.noCancel.clear();
  // the position can't be read and the order is refused at once
  dhan.reject = "RMS: blocked";
  const ok = await E.queueDhan(S(), set, "EXIT", [leg("S")], "x", { c: 25000 });
  assert.equal(ok, true); // queued; Dhan refused it at once → failRow → market retry
  // the market retry needed a second rejection; here the first rejection was the limit order, the retry went out:
  const live = ordersOf("r2").find((r) => r.purpose === "exit");
  if (live.state === "working") { fill(live.broker_order_id, null, "REJECTED"); dhan.reject = "RMS: blocked"; await E.runOrders(1); }
  assert.equal(S().position, "LONG"); assert.equal(S().active, false); assert.equal(S().exec_state, null);
  assert.match(S().last_error, /failed 5 times/); assert.ok(note(/close it by hand/));
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "r2");
});

// ---------------- 5. a stop that can't be cancelled ----------------
await t("5 stop can't be cancelled → nothing sent, still recorded as resting, retried later, alert", async () => {
  const S = add("k1", longPos());
  await E.syncStop(S(), set);
  const sid = S().pos_broker.stopId; assert.ok(sid);
  dhan.noCancel.add(String(sid));
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 75 }];
  const n = dhan.next, upd = {};
  await E.flattenNow(S(), set, upd, { c: 25000 }); await write("k1", upd);
  assert.equal(dhan.next, n, "no exit order sent");
  assert.equal(S().position, "LONG"); assert.equal(S().exec_state, "exit_retry");
  assert.equal(db.live_orders.find((r) => r.broker_order_id === sid).state, "resting");
  assert.equal(dhan.orders.get(String(sid)).orderStatus, "PENDING");
  assert.ok(note(/Stop order couldn't be cancelled/));
  dhan.noCancel.clear();
  clock += 61000;
  await E.retryExit(S(), set);
  assert.equal(dhan.orders.get(String(sid)).orderStatus, "CANCELLED"); assert.equal(S().position, "FLAT");
  for (const r of ordersOf("k1")) if (["working", "queued"].includes(r.state)) r.state = "cancelled";
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "k1");
});

// ---------------- 6. stuck "working" ----------------
await t("6 'working' with nothing left at the broker for 10 minutes → cleared, alert", async () => {
  const S = add("w1", longPos({ exec_state: "working", exec_at: new Date(clock - 11 * 60000).toISOString() }));
  await E.runOrders(1);
  assert.equal(S().exec_state, null); assert.ok(note(/Order state cleared/));
});
await t("6 an order filled at Dhan the order manager never saw → booked", async () => {
  const S = add("w2", { ...longPos({ pos_broker: null }), exec_state: "working", exec_at: new Date(clock - 11 * 60000).toISOString() });
  dhan.ltp["35001"] = 25000;
  const id = String(dhan.next++); dhan.orders.set(id, { orderId: id, orderStatus: "TRADED", quantity: 75, filledQty: 75, averageTradedPrice: 25001, transactionType: "BUY" });
  db.live_orders.push({ id: 7101, user_id: "u1", strategy_id: "w2", broker: "DHAN", batch: "b-w2", seq: 0, purpose: "entry", side: "BUY", sec: "35001", seg: "NSE_FNO", product: "MARGIN", qty: 75, lot: 75, tick: 0.05,
    state: "working", broker_order_id: id, steps: 0, step: 5, limit_px: 25000, ref_px: 25000, updated_at: new Date(clock - 11 * 60000).toISOString(), created_at: new Date(clock - 11 * 60000).toISOString() });
  const acct = db.broker_accounts; db.broker_accounts = []; // the main pass can't reach the account…
  await E0.runOrders(1);
  db.broker_accounts = acct; clock += 16000;
  await E0.runOrders(1); // …the stuck check reads it again once it can
  assert.equal(db.live_orders.find((r) => r.id === 7101).state, "filled");
  assert.equal(S().exec_state, null); assert.equal(S().pos_broker.legs[0].qty, 75);
  db.algo_strategies = db.algo_strategies.filter((x) => !["w1", "w2"].includes(x.id));
});

// ---------------- 7. partly filled entries ----------------
await t("7 entry given up while 25 of 75 traded → the desk holds 25 (1/3 lot) with its stop", async () => {
  const S = add("e1", { risk: { basis: "UNDERLYING", sl: { type: "POINTS", value: 100 } } });
  dhan.ltp["35001"] = 25300;
  await E.queueDhan(S(), set, "ENTRY", [leg("B")], "Buy", { c: 25180 });
  Object.assign(S(), { position: "LONG", pos_qty: 1, pos_lots: 1, pos_margin: 300000, pos_entry_px: 25180, pos_risk: { basis: "UNDERLYING", dir: 1, stop: 25080, tgt: null, trail: null, best: 25180, scanFrom: 0 } });
  dhan.onCancel = (o) => { o.filledQty = 25; o.averageTradedPrice = 25305; };
  for (let i = 0; i < 6 && S().exec_state === "working"; i++) { dhan.ltp["35001"] += 20; await E.runOrders(1); }
  dhan.onCancel = null;
  assert.equal(S().position, "LONG"); assert.equal(S().exec_state, null);
  assert.equal(S().pos_broker.legs[0].qty, 25); assert.ok(Math.abs(S().pos_qty - 1 / 3) < 0.001); assert.equal(S().pos_margin, 100000);
  assert.ok(note(/Entry filled in part/));
  dhan.ltp["35001"] = 25300;
  await E.runOrders(1);
  const stop = dhan.orders.get(String(S().pos_broker.stopId)); assert.equal(stop.quantity, 25);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "e1");
});
await t("7 entry cancelled by the exchange after part of it traded → the part is kept, not flattened", async () => {
  const S = add("e2", { risk: null });
  dhan.ltp["35001"] = 25000;
  await E.queueDhan(S(), set, "ENTRY", [leg("B")], "Buy", { c: 25000 });
  Object.assign(S(), { position: "LONG", pos_qty: 1, pos_lots: 1 });
  const r = ordersOf("e2")[0]; fill(r.broker_order_id, 25001, "CANCELLED", 50);
  await E.runOrders(1);
  assert.equal(S().position, "LONG"); assert.equal(S().pos_broker.legs[0].qty, 50); assert.equal(S().active, true);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "e2");
});

// ---------------- 8. overnight broker stops ----------------
await t("8 after the close no stop is placed (Dhan day orders); expiry at the close isn't an alert; at the open it goes in", async () => {
  const S = add("o1", longPos());
  clock = Date.parse("2026-10-15T10:30:00Z"); // 16:00 IST
  const n = dhan.next;
  await E.syncStop(S(), set);
  assert.equal(dhan.next, n); assert.equal(S().pos_broker.stopId ?? null, null);
  // a stop that expired at the close
  const id = String(dhan.next++); dhan.orders.set(id, { orderId: id, orderStatus: "EXPIRED", quantity: 75 });
  S().pos_broker = { ...S().pos_broker, stopId: id };
  db.live_orders.push({ id: 7201, user_id: "u1", strategy_id: "o1", broker: "DHAN", batch: "b-o1", purpose: "stop", state: "resting", broker_order_id: id, sec: "35001", seg: "NSE_FNO", qty: 75 });
  const k = db.notifications.length;
  await E.runOrders(1);
  assert.equal(S().pos_broker.stopId, null); assert.equal(db.notifications.length, k, "no alert for a stop expiring at the close");
  clock = Date.parse("2026-10-16T03:47:00Z"); // next day 09:17 IST
  dhan.ltp["35001"] = 25000;
  await E.runOrders(1);
  assert.ok(S().pos_broker.stopId, "stop back in at the open");
});
await t("8 an open position without a broker stop 5 minutes into the session → alert", async () => {
  const S = () => db.algo_strategies.find((x) => x.id === "o1");
  S().pos_broker = { ...S().pos_broker, stopId: null, stopErrAt: iso() };
  clock = Date.parse("2026-10-16T04:00:00Z");
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 75 }];
  await E.reconcile();
  assert.ok(note(/No stop order at the broker/));
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "o1");
});

// ---------------- 9. options on their expiry day ----------------
await t("9 a held option is never priced from another expiry", async () => {
  const S = add("x2", { live: false, trade_type: "OPTIONS", position: "LONG", pos_option_type: "CE", pos_option_side: "BUY", pos_strike: 25000, pos_expiry: "2026-10-20", pos_qty: 1, pos_entry_prem: 100, pos_ltp_at: null });
  dhan.chain = { "2026-10-27": { "25000.000000": { ce: { last_price: 140 } } } }; dhan.expiries = ["2026-10-27"];
  dhan.calls = [];
  const s2 = await E.markPrice(S(), set);
  assert.equal(s2.pos_ltp ?? null, null);
  assert.ok(!dhan.calls.some((c) => /expirylist/.test(c)), "no look-up of another expiry");
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "x2");
});
await t("9 an option entry goes to an expiry Dhan lists (holiday-shifted week)", async () => {
  const S = add("x3", { live: false, trade_type: "OPTIONS", option_side: "BUY", strike_step: 50, strike_offset: 0, expiry_flag: "WEEK", expiry_weekday: 2, roll_on_expiry: false, risk: null });
  const e = E.entryLeg(S(), "LONG", 25010, 1, 1);
  assert.equal(e.state.pos_expiry, "2026-10-20"); // the Tuesday worked out from the weekday
  dhan.expiries = ["2026-10-17", "2026-10-24"]; // the 20th is not an expiry this time (moved): the next listed one is the 24th
  dhan.chain = { "2026-10-24": { "25000.000000": { ce: { last_price: 120 } } } };
  const legs = [e.leg].flat(), ns = { ...e.state, position: "LONG" }; delete ns._px;
  const notes = [e.label];
  assert.equal(await E.sizeEntry(S(), set, legs, ns, 25010, notes), true);
  assert.equal(ns.pos_expiry, "2026-10-24"); assert.equal(legs[0].expiry_date, "2026-10-24");
  assert.equal(ns.pos_entry_prem, 120);
  assert.match(notes.join(" | "), /2026-10-20 isn't listed at Dhan: 2026-10-24 used/);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "x3");
});

// ---------------- 10. a broker stop fill is booked and then confirmed ----------------
await t("10 broker stop fill: trade booked and confirmed at Dhan's prices (not left provisional)", async () => {
  const S = add("b1", longPos({ pos_broker: pbOf("35001", 75) }));
  await E.syncStop(S(), set);
  db.live_orders.push({ id: 7301, strategy_id: "b1", purpose: "entry", sec: "35001", state: "filled", avg_px: 25002, qty: 75, created_at: "2026-10-14T05:00:00.000Z" });
  fill(S().pos_broker.stopId, 24880);
  await E.runOrders(1);
  const tr = db.algo_trades.find((x) => x.strategy_id === "b1");
  assert.equal(S().position, "FLAT"); assert.equal(tr.provisional, false); assert.equal(tr.entry_px, 25002); assert.equal(tr.exit_px, 24880);
});

await t("9 an option expiring today is due to close at 14:30, not before; a strategy can opt out", async () => {
  const opt = { ...base, id: "x1", trade_type: "OPTIONS", position: "LONG", pos_option_type: "CE", pos_option_side: "BUY", pos_strike: 25000, pos_expiry: "2026-10-20" };
  clock = Date.parse("2026-10-20T08:30:00Z"); // 14:00 IST on expiry day
  assert.equal(E.expiryExitDue(opt), false);
  clock = Date.parse("2026-10-20T09:01:00Z"); // 14:31
  assert.equal(E.expiryExitDue(opt), true);
  assert.equal(E.expiryExitDue({ ...opt, risk: { ...opt.risk, expiry_exit: false } }), false);
  assert.equal(E.expiryExitDue({ ...opt, pos_expiry: "2026-10-27" }), false);
  assert.equal(E.expiryExitDue({ ...opt, risk: { ...opt.risk, expiry_exit_time: "15:00" } }), false);
});
// ---------------- Phase 2: error circuit breaker per account (paper and live) ----------------
await t("breaker: 5 minutes in a row where every run of the account failed → new trades stop, owner told once", async () => {
  db.algo_strategies = db.algo_strategies.filter((x) => x.owner_id === "u1" && x.position !== "FLAT" ? false : true);
  add("z1", { owner_id: "u2", live: false, exchange: "MCX", data_segment: "MCX_COMM", underlying: "GOLD" }); // u2 has no Dhan account: every run fails
  clock = Date.parse("2026-10-20T05:30:00Z"); db.risk_state = [];
  for (let i = 0; i < 6; i++) { clock += 60000; const r = await tick(); assert.match(String(r.z1), /Connect your Dhan account/); }
  const b = db.risk_state.find((x) => x.user_id === "u2");
  // a paper strategy failing counts on the paper breaker only (12 Nov 2026: live and paper separate)
  assert.equal(b.paper_err_ticks, 6); assert.ok(b.paper_halted_at); assert.match(b.paper_halt_reason, /Connect your Dhan account/);
  assert.ok(!b.err_ticks && !b.halted_at, "live breaker untouched");
  assert.equal(db.notifications.filter((n) => n.user_id === "u2" && /New paper trades stopped/.test(n.title)).length, 1);
});
await t("breaker: a run that works resets the count; the stop stays until it is allowed again", async () => {
  db.broker_accounts.push({ user_id: "u2", broker: "DHAN", client_id: "C2", access_token: "TOK2", webhook_url: null });
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "z1");
  add("z2", { owner_id: "u2", live: false, ...longPos({ pos_broker: null, exec_state: "exit_retry", exec_at: new Date(clock - 120000).toISOString() }) });
  dhan.ltp["13"] = 25010; clock += 60000;
  const r = await tick();
  assert.equal(r.z2, "exit retried");
  const b = db.risk_state.find((x) => x.user_id === "u2");
  assert.equal(b.paper_err_ticks, 0); assert.ok(b.paper_halted_at, "still stopped until allowed");
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "z2");
});
await t("breaker: a paper stop doesn't stop the same account's live entries, and the reverse", async () => {
  const b = db.risk_state.find((x) => x.user_id === "u2");
  assert.ok(b.paper_halted_at && !b.halted_at);
  const { brkOf } = E;
  assert.ok(brkOf(b, false).halted_at, "paper blocked"); assert.equal(brkOf(b, true).halted_at, null, "live free");
  const lv = { user_id: "u3", halted_at: "x", halt_reason: "y", err_ticks: 5 };
  assert.equal(brkOf(lv, false).halted_at, null, "a live stop leaves paper free");
});

// ---------------- options on a stock / an MCX commodity (6 Nov 2026) ----------------
await t("stock option entry: the next listed expiry and the listed strike nearest the price; premium from that contract's own price", async () => {
  const later = (n) => new Date(Date.now() + n * 86400000 + 19800000).toISOString().slice(0, 10), iso = new Date().toISOString(), fno0 = db.fno_contracts;
  db.fno_contracts = [1460, 1480, 1500, 1520].flatMap((k, i) => [
    { seg: "NSE_FNO", sec_id: String(91000 + i), underlying: "RELIANCE", instrument: "OPTSTK", expiry: later(18), strike: k, opt_type: "CE", lot: 500, synced_at: iso },
    { seg: "NSE_FNO", sec_id: String(92000 + i), underlying: "RELIANCE", instrument: "OPTSTK", expiry: later(18), strike: k, opt_type: "PE", lot: 500, synced_at: iso }]);
  dhan.ltp["91002"] = 31.5; // the 1500 CE
  const S = add("so1", { live: false, trade_type: "OPTIONS", option_side: "BUY", underlying: "RELIANCE", data_segment: "NSE_EQ", data_security_id: "2885", exchange: "NSE",
    dhan_symbol: "RELIANCE", lot_size: 500, strike_step: 50, strike_offset: 1, expiry_flag: "MONTH", expiry_weekday: 2, roll_on_expiry: false, risk: null, sizing: null });
  const e = E.entryLeg(S(), "LONG", 1487, 1, 1), legs = [e.leg].flat(), ns = { ...e.state, position: "LONG" }; delete ns._px;
  const notes = [e.label];
  assert.equal(await E.sizeEntry(S(), set, legs, ns, 1487, notes), true);
  assert.equal(ns.pos_strike, 1500, "nearest listed 1480, one out of the money = 1500 (the 50-step guess would have been 1550)");
  assert.equal(ns.pos_expiry, later(18)); assert.equal(ns.pos_option_type, "CE");
  assert.equal(String(legs[0].strike_price), "1500"); assert.equal(legs[0].expiry_date, later(18));
  assert.equal(ns.pos_entry_prem, 31.5, "the premium is that listed contract's last price");
  assert.match(notes[0], /Buy RELIANCE 1500 CE/);
  // nothing listed: no guessing a contract
  db.fno_contracts = [];
  const S2 = add("so2", { live: false, trade_type: "OPTIONS", option_side: "BUY", underlying: "CRUDEOIL", data_segment: "MCX_COMM", data_security_id: "CRUDEOIL", exchange: "MCX",
    dhan_symbol: "CRUDEOIL", lot_size: 100, strike_step: 50, strike_offset: 0, expiry_flag: "MONTH", expiry_weekday: 2, roll_on_expiry: false, risk: null, sizing: null });
  const e2 = E.entryLeg(S2(), "SHORT", 7900, 1, 1), legs2 = [e2.leg].flat(), ns2 = { ...e2.state, position: "SHORT" }; delete ns2._px;
  const n2 = [e2.label];
  assert.equal(await E.sizeEntry(S2(), set, legs2, ns2, 7900, n2), false);
  assert.match(n2.join(" | "), /no CRUDEOIL PE options listed at Dhan/);
  db.algo_strategies = db.algo_strategies.filter((x) => !["so1", "so2"].includes(x.id));
  db.fno_contracts = fno0;
});
// ---------------- lots that follow the typical day's move (4 Nov 2026) ----------------
await t("move sizing: the entry takes target ÷ one lot's typical day, the new lots are saved; inside 20% nothing changes", async () => {
  db.lab_margins = [{ asset: "NIFTY", price: 25000, fut_pct: 0.12, day_move: 0.02 }];
  const S = add("m1", { live: false, risk: null, lots: 1, sizing: { mode: "MOVE", move_amt: 100000 } });
  const e = E.entryLeg(S(), "LONG", 25000, 1, 1), legs = [e.leg].flat(), ns = { ...e.state, position: "LONG" }; delete ns._px;
  const notes = [e.label];
  assert.equal(await E.sizeEntry(S(), set, legs, ns, 25000, notes), true);
  // one lot: 25,000 × 75 × 2% = ₹37,500 a typical day → ₹1,00,000 ÷ 37,500 = 2.67 → 3 lots
  assert.equal(ns.pos_qty, 3); assert.equal(legs[0].quantity, "3"); assert.equal(S().lots, 3);
  assert.match(notes.join(" | "), /→ 3 lots \(was 1\)/);
  // a day later the move is 2.2% (2.42 lots wanted exactly): within 20% of 3 → stays 3, nothing saved
  db.lab_margins[0].day_move = 0.022; S().lots = 3;
  const e2 = E.entryLeg(S(), "LONG", 25000, 1, 3), legs2 = [e2.leg].flat(), ns2 = { ...e2.state, position: "LONG" }; delete ns2._px;
  assert.equal(await E.sizeEntry(S(), set, legs2, ns2, 25000, [e2.label]), true);
  assert.equal(ns2.pos_qty, 3);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "m1");
});

// ---------------- go-live review (12 Nov 2026): Max lots for move sizing, one order's limit for live entries ----------------
await t("move sizing obeys the strategy's max lots when live (paper as sized)", async () => {
  db.lab_margins = [{ asset: "NIFTY", price: 25000, fut_pct: 0.12, day_move: 0.02 }];
  const P = add("mx0", { live: false, risk: null, lots: 1, sizing: { mode: "MOVE", move_amt: 1000000, max_lots: 5 } });
  const p0 = E.entryLeg(P(), "LONG", 25000, 1, 1), lp = [p0.leg].flat(), np = { ...p0.state, position: "LONG" }; delete np._px;
  assert.equal(await E.sizeEntry(P(), set, lp, np, 25000, [p0.label]), true);
  assert.equal(np.pos_qty, 27, "paper: 26.7 → 27 lots, max not applied");
  const S = add("mx1", { live: true, risk: null, lots: 1, sizing: { mode: "MOVE", move_amt: 1000000, max_lots: 5 } });
  const e = E.entryLeg(S(), "LONG", 25000, 1, 1), legs = [e.leg].flat(), ns = { ...e.state, position: "LONG" }; delete ns._px;
  const notes = [e.label];
  assert.equal(await E.sizeEntry(S(), set, legs, ns, 25000, notes), true);
  assert.equal(ns.pos_qty, 5); assert.equal(legs[0].quantity, "5"); // 26.7 lots wanted, max 5
  assert.match(notes.join(" | "), /capped at the strategy's max 5/);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "mx1" && x.id !== "mx0");
});
await t("live and paper capital are separate: a live entry sizes from the live capital, a paper one from the paper capital", async () => {
  db.lab_margins = [{ asset: "NIFTY", price: 25000, fut_pct: 0.12, day_move: 0.02 }];
  // ₹4 lakh live, ₹75 lakh paper, both 100%: one lot needs about ₹2.25 lakh of margin
  const acct = { ...set, capital: 400000, deploy_pct: 100, capital_since: null, paper_capital: 7500000, paper_deploy_pct: 100, paper_since: null };
  const L = add("cp1", { live: true, risk: null, lots: 40 });
  const e = E.entryLeg(L(), "LONG", 25000, 1, 40), legs = [e.leg].flat(), ns = { ...e.state, position: "LONG" }; delete ns._px;
  const notes = [e.label];
  assert.equal(await E.sizeEntry(L(), acct, legs, ns, 25000, notes), true);
  assert.equal(ns.pos_qty, 1, "live: ₹4 lakh holds 1 lot " + notes.join(" | "));
  const P = add("cp2", { live: false, risk: null, lots: 40 });
  const e2 = E.entryLeg(P(), "LONG", 25000, 1, 40), legs2 = [e2.leg].flat(), ns2 = { ...e2.state, position: "LONG" }; delete ns2._px;
  const notes2 = [e2.label];
  assert.equal(await E.sizeEntry(P(), acct, legs2, ns2, 25000, notes2), true);
  assert.ok(ns2.pos_qty > 30 && ns2.pos_qty <= 34, "paper: ₹75 lakh holds about 33 lots, got " + ns2.pos_qty + " " + notes2.join(" | "));
  // a paper position's margin doesn't use up the live room, and the reverse
  Object.assign(P(), { position: "LONG", pos_margin: 7000000 });
  const e3 = E.entryLeg(L(), "LONG", 25000, 1, 40), legs3 = [e3.leg].flat(), ns3 = { ...e3.state, position: "LONG" }; delete ns3._px;
  assert.equal(await E.sizeEntry(L(), acct, legs3, ns3, 25000, [e3.label]), true);
  assert.equal(ns3.pos_qty, 1, "live room unchanged by paper margin");
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "cp1" && x.id !== "cp2");
});
await t("a crypto entry obeys the capital limit saved on the Dhan account row (the Delta row carries none)", async () => {
  db.lab_margins = [{ asset: "SOLUSD", price: 80, fut_pct: 0.1, day_move: 0.04 }];
  const dhanRow = db.broker_accounts.find((x) => x.user_id === "u1" && x.broker === "DHAN");
  Object.assign(dhanRow, { capital: 400000, deploy_pct: 100, paper_capital: 400000, paper_deploy_pct: 100 });
  const dset = { user_id: "u1", broker: "DELTA", dhan_client_id: "K", dhan_access_token: "S", capital: null, deploy_pct: null };
  const C = add("cr1", { live: false, risk: null, lots: 20, exchange: "DELTA", data_segment: "DELTA", underlying: "SOLUSD", futures_symbol: "SOLUSD", dhan_symbol: "SOLUSD", data_security_id: "SOLUSD", lot_size: 4400 });
  const e = E.entryLeg(C(), "SHORT", 80, 1, 20), legs = [e.leg].flat(), ns = { ...e.state, position: "SHORT" }; delete ns._px;
  const notes = [e.label];
  assert.equal(await E.sizeEntry(C(), dset, legs, ns, 80, notes), true);
  // one lot: 80 × 4,400 × 10% = ₹35,200 of margin → ₹4 lakh holds 11, not the 20 asked
  assert.equal(ns.pos_lots, 11, notes.join(" | "));
  for (const k of ["capital", "deploy_pct", "paper_capital", "paper_deploy_pct"]) delete dhanRow[k];
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "cr1");
});
// ---------------- manual orders from Orders › Failed orders (13 Nov 2026) ----------------
const clock0 = clock, ltp0 = dhan.ltp["13"];
const mrow = (sid, side, lots, ref = null) => {
  db.manual_orders = db.manual_orders ?? [];
  const id = db.manual_orders.length + 1;
  db.manual_orders.push({ id, user_id: "u1", strategy_id: sid, ref_signal: ref, side, lots, mode: "x", state: "working", created_at: new Date(clock).toISOString() });
  E.MANUAL.set(sid, { id, side, lots, ref });
  return () => db.manual_orders.find((m) => m.id === id);
};
const mrun = async (S) => { const upd = { last_run_at: new Date(clock).toISOString() }; await E.manualEntry(S(), set, upd, { t: 1, c: 24000 }, undefined); };
await t("manual order (paper): enters at the price now with the lots typed, even while paused; result written back", async () => {
  clock = Date.parse("2026-10-20T06:00:00Z"); dhan.ltp["13"] = 25040;
  const S = add("mo1", { live: false, active: false, lots: 1, sizing: { mode: "MOVE", move_amt: 5000000 }, risk: { basis: "UNDERLYING", sl: { type: "POINTS", value: 100 } } });
  const m = mrow("mo1", "SHORT", 2, 304); await mrun(S);
  assert.equal(S().position, "SHORT", JSON.stringify(m()));
  assert.equal(S().pos_lots, 2); assert.equal(Number(S().pos_entry_px), 25040, "the price now, not the candle's");
  assert.equal(S().pos_risk.stop, 25140, "its stop from the new entry price");
  assert.equal(m().state, "filled"); assert.match(m().result, /Filled \(paper\): 2 lots/);
  assert.ok(db.algo_signals.some((g) => g.strategy_id === "mo1" && /Manual order \(Orders › Failed orders, signal #304\)/.test(g.description)));
  // a second one while it holds the position: refused, nothing changes
  const m2 = mrow("mo1", "LONG", 1); await mrun(S);
  assert.equal(m2().state, "refused"); assert.match(m2().result, /already holds a short position/); assert.equal(S().position, "SHORT");
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "mo1");
});
await t("add missing lots (paper): 80 of 100 held → 20 added at the price now, average entry, stop levels kept", async () => {
  clock = Date.parse("2026-10-20T06:00:00Z"); dhan.ltp["13"] = 25100; db.lab_margins = [{ asset: "NIFTY", price: 25000, fut_pct: 0.12, day_move: 0.02 }];
  const S = add("ad1", { live: false, lots: 100, ...longPos({ pos_qty: 80, pos_lots: 80, pos_entry_px: 25000, pos_margin: 80 * 225000, pos_broker: null }) });
  let res = null;
  await E.manualAdd(S(), set, 20, async (state, result) => { res = { state, result }; });
  assert.equal(res.state, "filled", JSON.stringify(res));
  assert.equal(S().pos_lots, 100); assert.equal(S().pos_qty, 100); assert.equal(S().exec_state, null);
  assert.equal(Number(S().pos_entry_px), 25020, "(80 × 25,000 + 20 × 25,100) ÷ 100");
  assert.equal(S().pos_risk.stop, 24900, "the stop keeps its level");
  assert.ok(S().pos_margin > 80 * 225000);
  // nothing to add to when flat
  Object.assign(S(), { position: "FLAT" });
  await E.manualAdd(S(), set, 5, async (state, result) => { res = { state, result }; });
  assert.equal(res.state, "refused"); assert.match(res.result, /holds no position/);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "ad1");
});
await t("add missing lots (live Dhan): the resting stop is cancelled, one market order, the fill is merged, a new stop follows", async () => {
  clock = Date.parse("2026-10-20T06:30:00Z"); dhan.ltp["13"] = 25100; dhan.ltp["35001"] = 25150; db.lab_margins // never earlier than the test before: the price client's pacing waits on this clock = [{ asset: "NIFTY", price: 25000, fut_pct: 0.12, day_move: 0.02 }];
  const stopId = String(dhan.next++); dhan.orders.set(stopId, { orderId: stopId, orderStatus: "PENDING", quantity: 75, filledQty: 0 });
  const S = add("ad2", { live: true, lots: 2, ...longPos({ pos_broker: pbOf("35001", 75, { stopId, stopTrig: 24900 }) }) });
  dhan.autoFill = 25160; let res = null;
  await E.manualAdd(S(), set, 1, async (state, result) => { res = { state, result }; });
  dhan.autoFill = null;
  assert.equal(res.state, "filled", JSON.stringify(res));
  assert.equal(dhan.orders.get(stopId).orderStatus, "CANCELLED", "the old stop is gone before the order");
  assert.equal(S().pos_lots, 2); assert.equal(S().pos_broker.legs[0].qty, 150); assert.equal(S().pos_broker.stopId, null, "syncStop places a new stop for 150");
  assert.equal(Number(S().pos_broker.fill), 25080, "(25,000 + 25,160) ÷ 2 at the broker");
  assert.equal(Number(S().pos_entry_px), 25050, "(25,000 + 25,100) ÷ 2 on the desk's own price");
  assert.equal(S().exec_state, null); assert.equal(S().position, "LONG");
  const row = db.live_orders.find((o) => o.strategy_id === "ad2" && /manual top-up/.test(o.note || ""));
  assert.ok(row && row.state === "filled" && row.filled_qty === 75);
  // a stop that can't be cancelled: nothing is sent, nothing changes
  const stop2 = String(dhan.next++); dhan.orders.set(stop2, { orderId: stop2, orderStatus: "PENDING", quantity: 150, filledQty: 0 }); dhan.noCancel.add(stop2);
  Object.assign(S(), { lots: 3, pos_broker: { ...S().pos_broker, stopId: stop2 } });
  const n0 = dhan.next; dhan.autoFill = 25170;
  await E.manualAdd(S(), set, 1, async (state, result) => { res = { state, result }; });
  dhan.autoFill = null; dhan.noCancel.delete(stop2);
  assert.equal(res.state, "refused"); assert.match(res.result, /couldn't be cancelled first/);
  assert.equal(dhan.next, n0, "no order went out"); assert.equal(S().pos_lots, 2); assert.equal(S().exec_state, null);
  // Dhan refuses the market order: the position is unchanged
  Object.assign(S(), { pos_broker: { ...S().pos_broker, stopId: null } });
  dhan.rejectAll = "RMS: margin";
  await E.manualAdd(S(), set, 1, async (state, result) => { res = { state, result }; });
  dhan.rejectAll = null;
  assert.equal(res.state, "refused"); assert.match(res.result, /RMS: margin/); assert.equal(S().pos_lots, 2); assert.equal(S().exec_state, null);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "ad2");
  db.live_orders = db.live_orders.filter((x) => x.strategy_id !== "ad2");
});
await t("manual order outside market hours: refused, nothing sent", async () => {
  clock = Date.parse("2026-10-20T13:00:00Z"); // 18:30 IST: NSE shut
  add("mo3", { live: true, active: true, lots: 1, risk: null });
  db.manual_orders.push({ id: 99, user_id: "u1", strategy_id: "mo3", side: "LONG", lots: 1, mode: "LIVE", state: "queued", created_at: new Date(clock).toISOString() });
  const r = await handler(new Request("http://x", { method: "POST", headers: { "x-engine-secret": "SECRET", "content-type": "application/json" }, body: JSON.stringify({ action: "manual_entry", strategy_id: "mo3" }) }));
  await r.json();
  const m = db.manual_orders.find((x) => x.id === 99);
  assert.equal(m.state, "refused"); assert.match(m.result, /market is closed/);
  assert.equal(ordersOf("mo3").length, 0);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "mo3");
  clock = clock0; dhan.ltp["13"] = ltp0;
});
await t("live entry cut to what one exchange order carries (freeze quantity); paper isn't; unknown limit leaves it", async () => {
  db.lab_margins = [{ asset: "NIFTY", price: 25000, fut_pct: 0.12, day_move: 0.02 }];
  for (const c of db.fno_contracts) c.freeze_qty = 1801; // NIFTY: orders below 1,801 units = 24 lots of 75
  const S = add("fz1", { live: true, risk: null, lots: 40 });
  const e = E.entryLeg(S(), "LONG", 25000, 1, 40), legs = [e.leg].flat(), ns = { ...e.state, position: "LONG" }; delete ns._px;
  const notes = [e.label];
  assert.equal(await E.sizeEntry(S(), set, legs, ns, 25000, notes), true);
  assert.equal(ns.pos_qty, 24); assert.equal(ns.pos_lots, 24); assert.equal(legs[0].quantity, "24");
  assert.match(notes.join(" | "), /cut to 24 lots, the most one order can carry .*below 1,801 units/);
  const P = add("fz2", { live: false, risk: null, lots: 40 });
  const e2 = E.entryLeg(P(), "LONG", 25000, 1, 40), legs2 = [e2.leg].flat(), ns2 = { ...e2.state, position: "LONG" }; delete ns2._px;
  assert.equal(await E.sizeEntry(P(), set, legs2, ns2, 25000, [e2.label]), true);
  assert.equal(ns2.pos_qty, 40, "paper keeps its size");
  for (const c of db.fno_contracts) delete c.freeze_qty;
  const e3 = E.entryLeg(S(), "LONG", 25000, 1, 40), legs3 = [e3.leg].flat(), ns3 = { ...e3.state, position: "LONG" }; delete ns3._px;
  assert.equal(await E.sizeEntry(S(), set, legs3, ns3, 25000, [e3.label]), true);
  assert.equal(ns3.pos_qty, 40, "no limit known: as sized");
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "fz1" && x.id !== "fz2");
});
await t("price band: a limit is kept inside the day's band; a stop beyond it isn't placed (the desk watches)", async () => {
  assert.equal(E.inBand(110, "BUY", { lo: 90, hi: 105 }), 105); assert.equal(E.inBand(80, "SELL", { lo: 90, hi: 105 }), 90);
  assert.equal(E.inBand(100, "BUY", null), 100);
  const c = db.fno_contracts.find((x) => x.sec_id === "35001");
  c.band_lo = 24950; c.band_hi = 26000; // the stop at 24,900 is below today's band
  const S = add("bd1", longPos({ pos_broker: pbOf("35001", 75) }));
  const placed0 = dhan.calls.filter((x) => x === "POST /v2/orders").length;
  await E.syncStop(S(), set);
  assert.equal(S().pos_broker.stopId ?? null, null, "no stop order sent");
  assert.equal(dhan.calls.filter((x) => x === "POST /v2/orders").length, placed0);
  c.band_lo = 24000; // now inside the band: placed
  await E.syncStop(S(), set);
  assert.ok(S().pos_broker.stopId);
  delete c.band_lo; delete c.band_hi;
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "bd1");
});
await t("F&O ban: a stock in the ban list takes no new entry; an unreadable list skips nothing", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => /fo_secban/.test(String(url)) ? new Response("Securities in Ban For Trade Date 15-OCT-2026:\n1,SAIL\n2,RELIANCE\n", { status: 200 }) : real(url, init);
  const keep = clock; clock += 31 * 60000; // past the half hour an unreadable list is remembered for
  const S = add("ban1", { live: false, risk: null, underlying: "RELIANCE", dhan_symbol: "RELIANCE", futures_symbol: "RELIANCE1!", data_segment: "NSE_EQ", lot_size: 500 });
  const e = E.entryLeg(S(), "LONG", 1400, 1, 1), legs = [e.leg].flat(), ns = { ...e.state, position: "LONG" }; delete ns._px;
  const notes = [e.label];
  assert.equal(await E.sizeEntry(S(), set, legs, ns, 1400, notes), false);
  assert.match(notes.join(" | "), /RELIANCE is in NSE's F&O ban period today/);
  globalThis.fetch = real; clock = keep;
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "ban1");
});
await t("live entry cut to what Dhan shows free (5% kept spare); nothing free → skipped; unreadable → as sized", async () => {
  db.lab_margins = [{ asset: "NIFTY", price: 25000, fut_pct: 0.12, day_move: 0.02 }];
  const real = globalThis.fetch;
  let free = 1000000;
  globalThis.fetch = async (url, init) => /fundlimit/.test(String(url)) ? new Response(JSON.stringify({ availabelBalance: free }), { status: 200 }) : real(url, init);
  const S = add("fd1", { live: true, risk: null, lots: 10 });
  const run = async () => { const e = E.entryLeg(S(), "LONG", 25000, 1, 10), legs = [e.leg].flat(), ns = { ...e.state, position: "LONG" }; delete ns._px; const notes = [e.label]; const ok = await E.sizeEntry(S(), set, legs, ns, 25000, notes); return { ok, ns, notes: notes.join(" | ") }; };
  // one lot ≈ 25,000 × 75 × 12% = ₹2,25,000; ₹10 lakh × 95% → 4 lots
  let r = await run(); assert.equal(r.ok, true); assert.equal(r.ns.pos_qty, 4); assert.match(r.notes, /Dhan shows ₹10,00,000 free/);
  free = 100000; r = await run(); assert.equal(r.ok, false); assert.match(r.notes, /Entry skipped: Dhan shows ₹1,00,000 free/);
  globalThis.fetch = real; r = await run(); assert.equal(r.ns.pos_qty, 10);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "fd1");
});
await t("lotsPerOrder: units below the freeze on NSE, lots on MCX", async () => {
  assert.equal(E.lotsPerOrder("NSE_FNO", 2761, 120), 23);
  assert.equal(E.lotsPerOrder("MCX_COMM", 48, 1), 47);
  assert.equal(E.lotsPerOrder("NSE_FNO", null, 75), null);
});
// ---------------- positional futures roll the day before expiry (4 Nov 2026) ----------------
await t("roll: due from 15:00 on the trading day before expiry, not before, not for intraday ones", async () => {
  const S = add("rl1", { live: false, intraday: false, product_type: "M", ...longPos({ pos_broker: null, pos_entry_date: "2026-10-14" }) });
  clock = Date.parse("2026-10-26T09:00:00Z"); // Monday 14:30 IST; the Oct contract expires Tuesday 27th
  assert.equal(await E.rollDue(S()), null);
  clock = Date.parse("2026-10-26T09:35:00Z"); // 15:05 IST
  assert.equal(await E.rollDue(S()), "2026-10-27");
  assert.equal(await E.rollDue({ ...S(), intraday: true }), null);
  assert.equal(await E.rollDue({ ...S(), risk: { ...S().risk, roll: false } }), null);
});
await t("roll: stock futures 3 weekdays before expiry, MCX metals 5, risk.roll_days overrides", async () => {
  const keep = clock;
  db.fno_contracts.push({ seg: "NSE_FNO", sec_id: "61633", underlying: "LT", instrument: "FUTSTK", expiry: "2026-10-27", lot: 175, tick: 0.1, display: "LT OCT FUT", synced_at: iso() });
  const S = add("rs1", { live: false, intraday: false, product_type: "M", underlying: "LT", dhan_symbol: "LT", futures_symbol: "LT1!", data_segment: "NSE_EQ", lot_size: 175,
    ...longPos({ pos_broker: null, pos_entry_date: "2026-10-14", pos_expiry: "2026-10-27" }) });
  clock = Date.parse("2026-10-21T09:35:00Z"); // Wednesday 15:05 IST: 4 weekdays before
  assert.equal(await E.rollDue(S()), null);
  clock = Date.parse("2026-10-22T09:35:00Z"); // Thursday 15:05 IST: 3 weekdays before (Thu, Fri, Mon → Tue 27th)
  assert.equal(await E.rollDue(S()), "2026-10-27");
  clock = Date.parse("2026-10-23T05:00:00Z"); // Friday morning, missed: at once
  assert.equal(await E.rollDue(S()), "2026-10-27");
  clock = Date.parse("2026-10-22T09:35:00Z");
  assert.equal(await E.rollDue({ ...S(), risk: { ...S().risk, roll_days: 1 } }), null, "own setting: the day before");
  clock = keep;
  db.fno_contracts = db.fno_contracts.filter((x) => x.sec_id !== "61633");
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "rs1");
});
await t("roll (paper): the old contract's part booked, same side and lots go on in the next month, not rolled twice", async () => {
  const S = () => db.algo_strategies.find((x) => x.id === "rl1");
  dhan.ltp["13"] = 25300;
  const before = db.algo_trades.filter((x) => x.strategy_id === "rl1").length;
  await E.rollFutures(S(), set, "2026-10-27");
  const tr = db.algo_trades.filter((x) => x.strategy_id === "rl1");
  assert.equal(tr.length, before + 1); assert.match(tr.at(-1).exit_why, /Rolled to the next month before the 2026-10-27 expiry/);
  assert.equal(S().position, "LONG"); assert.equal(S().pos_qty, 1); assert.equal(S().pos_entry_px, 25300); assert.equal(S().pos_expiry, "2026-11-24");
  assert.equal(S().pos_risk.stop, 24900, "stops kept");
  assert.equal(await E.rollDue(S()), null, "not rolled twice");
  const g = db.algo_signals.filter((x) => x.strategy_id === "rl1" && x.event === "ROLL");
  assert.equal(g.length, 1); assert.match(g[0].description, /2026-11-24 contract/);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "rl1");
});
await t("roll (live): the exit goes to the expiring contract, the entry to the next month's after the exit fills", async () => {
  for (const r of db.fno_contracts) r.synced_at = iso(); // the contract list as downloaded today
  const S = add("rl2", { intraday: false, product_type: "M", ...longPos({ pos_entry_date: "2026-10-14" }) });
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 75 }];
  dhan.ltp["13"] = 25300; dhan.ltp["35001"] = 25350; dhan.ltp["35002"] = 25420;
  await E.rollFutures(S(), set, "2026-10-27");
  const rows = ordersOf("rl2").filter((r) => r.purpose !== "stop");
  const ex = rows.find((r) => r.purpose === "exit"), en = rows.find((r) => r.purpose === "entry");
  assert.equal(ex.sec, "35001"); assert.equal(ex.side, "SELL"); assert.equal(en.sec, "35002"); assert.equal(en.side, "BUY");
  assert.equal(en.state, "queued", "entry waits for the exit");
  fill(ex.broker_order_id, 25350); await E.runOrders(1);
  const en2 = db.live_orders.find((r) => r.id === en.id); assert.equal(en2.state, "working");
  fill(en2.broker_order_id, 25421); await E.runOrders(1);
  assert.equal(S().position, "LONG"); assert.equal(S().pos_broker.legs[0].sec, "35002"); assert.equal(S().pos_expiry, "2026-11-24"); assert.equal(S().exec_state, null);
  db.algo_strategies = db.algo_strategies.filter((x) => x.id !== "rl2");
});

// ---------------- Shared paper data (temporary, 5 Nov 2026, Papa: close family users only; to be rolled back) ----------------
await t("shared data: a user without Dhan runs paper on the admin's prices; live is refused; no admin token → as before", async () => {
  db.algo_strategies = db.algo_strategies.filter((x) => x.position === "FLAT" || x.owner_id !== "u1");
  db.broker_accounts = db.broker_accounts.filter((x) => x.user_id !== "u3");
  clock = Date.parse("2026-10-28T05:30:00Z"); db.risk_state = []; // Wednesday 11:00 IST, after the roll tests (the clock never goes back)
  add("sp1", { owner_id: "u3", live: false });
  add("sp2", { owner_id: "u3", live: true });
  const prof0 = db.profiles; db.profiles = [];
  clock += 60000; let r = await tick();
  assert.match(String(r.sp1), /Connect your Dhan account/, "no admin account found: still refused");
  db.profiles = [{ user_id: "u1", role: "admin", status: "active", created_at: "2026-01-01T00:00:00Z" }];
  clock += 60000; r = await tick();
  assert.doesNotMatch(String(r.sp1), /Connect your|error/i, `paper runs: ${r.sp1}`);
  assert.match(String(r.sp2), /own Dhan account .* live/, "live on shared data refused");
  assert.equal(db.live_orders.filter((o) => o.strategy_id === "sp2" || o.strategy_id === "sp1").length, 0, "no orders");
  db.profiles = prof0 ?? [];
  db.algo_strategies = db.algo_strategies.filter((x) => !["sp1", "sp2"].includes(x.id));
});

console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
