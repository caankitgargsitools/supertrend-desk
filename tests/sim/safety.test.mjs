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
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
