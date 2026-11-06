// Order-path safety from the 6 Nov 2026 audit: a partly filled exit is never re-sent in full, a claim left by a dead
// worker is taken over, a signal decided on a stale position sends nothing, one failing strategy among clean ones
// doesn't trip the account breaker, and a write on the money path that keeps failing throws instead of passing quietly.
import assert from "node:assert/strict";
// A weekday, 11:00 IST (market open).
const T0 = Date.parse("2026-10-15T05:30:00Z"); let clock = T0;
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
globalThis.Deno = { env: { get: (k) => k === "SUPABASE_URL" ? "http://x" : "k" }, serve: () => {} };
globalThis.EdgeRuntime = { waitUntil() {} };
const dhan = { orders: new Map(), ltp: {}, positions: [], log: [], next: 1, reject: null };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), m = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : null;
  const J = (x, s = 200) => new Response(JSON.stringify(x), { status: s, headers: { "content-type": "application/json" } });
  dhan.log.push(`${m} ${u.pathname}`);
  if (u.pathname === "/v2/marketfeed/ltp") { const seg = Object.keys(body).find((k) => k !== "dhanClientId"); const sec = String(body[seg][0]); return J({ data: { [seg]: { [sec]: { last_price: dhan.ltp[sec] ?? 0 } } } }); }
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
    if (m === "DELETE") { if (o.orderStatus === "TRADED") return J({ errorMessage: "already traded" }, 400); o.orderStatus = "CANCELLED"; return J({ orderId: o.orderId, orderStatus: "CANCELLED" }); }
  }
  if (u.pathname === "/v2/positions") return J(dhan.positions);
  if (u.pathname === "/functions/v1/engine") return J({ accepted: true });
  return J({ errorMessage: "not simulated: " + u.pathname }, 404);
};
const { db, rpcs } = await import("./fakesb.mjs");
rpcs.dhan_send = async (a) => { const r = await fetch("https://api.dhan.co" + a.p_path, { method: a.p_method, body: a.p_body || undefined }); return { data: { status: r.status, body: await r.text() }, error: null }; };
const E0 = await import("./engine.mjs");
const E = { ...E0, runOrders: async (n) => { clock += 16000; const r = await E0.runOrders(n); if (r.skipped) throw new Error(r.skipped); return r; } };
const iso = () => new Date().toISOString();
db.broker_accounts = [{ user_id: "u1", broker: "DHAN", client_id: "C1", access_token: "TOK", webhook_url: null }];
db.live_lock = [{ id: 1, until: "2000-01-01T00:00:00Z" }];
db.fno_contracts = [{ seg: "NSE_FNO", sec_id: "35001", underlying: "NIFTY", instrument: "FUTIDX", expiry: "2026-10-27", lot: 75, tick: 0.05, display: "NIFTY OCT FUT", synced_at: iso() }];
db.algo_signals = []; db.algo_trades = []; db.notifications = []; db.risk_state = [];
/** The entry's fill at Dhan (what the ledger correction reads the entry price from). */
const entryRow = () => ({ id: 1, user_id: "u1", strategy_id: "s1", broker: "DHAN", batch: "b0", seq: 0, purpose: "entry", event: "ENTRY", side: "BUY", sec: "35001", seg: "NSE_FNO", product: "MARGIN", qty: 150, lots: 2, lot: 75,
  tick: 0.05, option: false, label: "NIFTY OCT FUT", state: "filled", avg_px: 25000, filled_qty: 150, broker_order_id: "0", created_at: new Date(T0 - 3600000).toISOString() });
db.live_orders = [entryRow()];
const tpl = '{"transactionType":"{side}","orderType":"MKT","quantity":"{qty}","exchange":"{exchange}","symbol":"{symbol}","instrument":"FUT","productType":"{product}","sort_order":"{sort}","price":"0"}';
const base = { id: "s1", owner_id: "u1", name: "Nifty test", live: true, active: true, archived: false, exchange: "NSE", futures_symbol: "NIFTY1!", dhan_symbol: "NIFTY", underlying: "NIFTY", data_segment: "IDX_I",
  data_security_id: "13", trade_type: "FUTURES", qty_mode: "LOTS", lots: 2, lot_size: 75, product_type: "M", leg_template_fut: tpl, risk: { basis: "UNDERLYING", sl: { type: "POINTS", value: 100 } }, position: "FLAT", strategy_kind: "FLIP" };
const held = () => ({ position: "LONG", pos_qty: 2, pos_lots: 2, pos_entry_px: 25000, pos_entry_date: "2026-10-14", pos_margin: 300000, exec_state: null, last_error: null,
  pos_risk: { basis: "UNDERLYING", dir: 1, stop: 24900, tgt: null, trail: null, best: 25000, scanFrom: 0 },
  pos_broker: { broker: "DHAN", legs: [{ sec: "35001", seg: "NSE_FNO", qty: 150, product: "MARGIN" }], tick: 0.05, step: 5, option: false, offset: 0, fill: 25000, stopId: null } });
db.algo_strategies = [{ ...base, ...held() }];
const S = () => db.algo_strategies.find((x) => x.id === "s1");
const lo = () => db.live_orders;
const set = { user_id: "u1", broker: "DHAN", dhan_client_id: "C1", dhan_access_token: "TOK" };
const leg = (side, qty = "2") => ({ transactionType: side, orderType: "MKT", quantity: qty, exchange: "NSE", symbol: "NIFTY1!", instrument: "FUT", productType: "M" });
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message, (e.stack || "").split("\n")[1] || ""); } };
/** The desk's booking after an exit went out (what finishNow / bookPnl do), so the order manager has a trade to correct. */
const bookedExit = () => {
  const r = lo().find((x) => x.purpose === "exit" && x.state !== "filled");
  db.algo_trades.push({ id: 900 + db.algo_trades.length, strategy_id: "s1", user_id: "u1", mode: "LIVE", exit_at: iso(), units: 150, lots: 2, entry_px: 25000, exit_px: 25080, gross: 12000, costs: 200, net: 11800,
    exit_why: "Exit", provisional: true, hidden: false, order_batch: r.batch, created_at: iso() });
  Object.assign(S(), { position: "FLAT", pos_broker: null, pos_risk: null, pos_qty: null, pos_lots: null });
};
const partFill = (id, filled, px, status) => Object.assign(dhan.orders.get(String(id)), { orderStatus: status, filledQty: filled, averageTradedPrice: px });

await t("partial exit: the filled part is kept, only the rest goes again at market, the ledger uses both fills", async () => {
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 150 }];
  dhan.ltp["35001"] = 25200;
  assert.equal(await E.queueDhan(S(), set, "EXIT", [leg("S")], "Sell NIFTY1! x 2 to close long", { c: 25080 }), true);
  const ex = dhan.orders.get("1"); assert.equal(ex.quantity, 150); assert.equal(ex.transactionType, "SELL");
  bookedExit();
  // 75 traded, then the exchange cancelled the rest
  partFill(1, 75, 25190, "CANCELLED"); dhan.orders.get("1").omsErrorDescription = "cancelled by RMS";
  await E.runOrders(1);
  const first = lo().find((x) => x.purpose === "exit" && x.broker_order_id === "1");
  assert.equal(first.state, "filled"); assert.equal(first.filled_qty, 75); assert.equal(first.avg_px, 25190);
  const rest = lo().find((x) => x.purpose === "exit" && x.id !== first.id);
  assert.ok(rest, "a row for the rest"); assert.equal(rest.qty, 75); assert.equal(rest.market_retry, true); assert.equal(rest.state, "working");
  const mk = dhan.orders.get("2"); assert.equal(mk.orderType, "MARKET"); assert.equal(mk.quantity, 75);
  // the rest fills: the trade is corrected to the average of both fills, on the whole quantity
  partFill(2, 75, 25180, "TRADED");
  await E.runOrders(1);
  const tr = db.algo_trades[0];
  assert.equal(tr.provisional, false); assert.equal(tr.exit_px, 25185); assert.equal(tr.units, 150);
  assert.equal(S().exec_state, null); assert.equal(S().position, "FLAT");
});

await t("partial exit, then the rest rejected too: the part is booked, the position shrinks to the rest and waits for a retry", async () => {
  db.algo_trades = []; db.live_orders = [entryRow()]; db.notifications = []; dhan.orders.clear(); dhan.next = 1;
  Object.assign(S(), held());
  dhan.positions = [{ exchangeSegment: "NSE_FNO", securityId: "35001", netQty: 150 }];
  dhan.ltp["35001"] = 25200;
  assert.equal(await E.queueDhan(S(), set, "EXIT", [leg("S")], "Sell NIFTY1! x 2 to close long", { c: 25080 }), true);
  bookedExit();
  partFill(1, 75, 25190, "CANCELLED"); dhan.orders.get("1").omsErrorDescription = "cancelled by RMS";
  await E.runOrders(1);
  partFill(2, 0, 0, "REJECTED"); dhan.orders.get("2").omsErrorDescription = "RMS: insufficient margin";
  await E.runOrders(1);
  // the provisional trade for the whole quantity is hidden; a real trade for the 75 that closed is in the ledger
  const prov = db.algo_trades.find((x) => x.units === 150); assert.equal(prov.hidden, true);
  const part = db.algo_trades.find((x) => x.units === 75 && !x.hidden);
  assert.ok(part, "the part that closed is booked"); assert.equal(part.exit_px, 25190); assert.equal(part.gross, Math.trunc((25190 - 25000) * 75)); assert.equal(part.provisional, undefined);
  // the desk holds the rest: 1 lot, 75 at Dhan, and tries the exit again
  const s = S();
  assert.equal(s.position, "LONG"); assert.equal(s.pos_qty, 1); assert.equal(s.pos_lots, 1); assert.equal(s.pos_broker.legs[0].qty, 75); assert.equal(s.pos_margin, 150000);
  assert.equal(s.exec_state, "exit_retry");
  assert.ok(db.notifications.some((n) => /Exit not done yet/.test(n.title) && /75 of 150 had already closed/.test(n.body)), "the owner is told what closed");
});

await t("a signal decided on a stale copy of the position sends nothing", async () => {
  db.algo_signals = []; db.live_orders = []; dhan.orders.clear(); dhan.next = 1;
  Object.assign(S(), { ...held(), position: "FLAT", pos_broker: null, pos_qty: null }); // the row says FLAT (the stop watcher exited)
  const stale = { ...S(), ...held() }; // the tick's copy still says LONG
  const update = { last_run_at: iso() };
  await E.finishNow(stale, set, update, [leg("S")], "EXIT", ["Exit rule"], { position: "FLAT" }, { t: Math.floor(T0 / 1000), c: 25100 });
  assert.equal(dhan.next, 1, "no order went to Dhan");
  assert.ok(db.algo_signals.some((g) => g.event === "INFO" && /position changed/.test(g.description)));
  assert.equal(S().last_run_at, update.last_run_at);
  assert.equal(S().position, "FLAT");
});

await t("breaker: one failing strategy among ones that ran cleanly does not stop the account", async () => {
  db.risk_state = [];
  db.algo_strategies.push({ ...base, id: "s2", name: "second", last_error: "Dhan /charts request failed (HTTP 401)" });
  S().last_error = null;
  await E.breakerAfterTick(new Set(), new Map([["u1", "Dhan /charts request failed (HTTP 401)"]]), new Map());
  assert.equal(db.risk_state.length, 0, "not counted while s1 is fine");
  S().last_error = "Dhan /charts request failed (HTTP 401)";
  await E.breakerAfterTick(new Set(), new Map([["u1", "Dhan /charts request failed (HTTP 401)"]]), new Map());
  assert.equal(db.risk_state[0]?.err_ticks, 1, "counted once every active strategy has failed");
});

await t("must(): a write that keeps failing throws; one that works returns", async () => {
  let n = 0;
  await assert.rejects(E.must(() => { n++; return Promise.resolve({ error: { message: "boom" } }); }, "test write"), /Database write failed \(test write\): boom/);
  assert.equal(n, 3, "tried three times");
  const r = await E.must(() => Promise.resolve({ error: null, data: 1 }), "x");
  assert.equal(r.data, 1);
});

await t("a claim left behind by a dead worker is taken over after two minutes; a fresh one is not", async () => {
  db.algo_signals = [];
  const candle = { t: Math.floor(T0 / 1000) - 60, c: 25000 };
  const ct = new Date(candle.t * 1000).toISOString();
  db.algo_signals.push({ id: 1, strategy_id: "s1", event: "SQUARE_OFF", mode: "LIVE", status: "PENDING", description: "sending…", candle_time: ct, created_at: new Date(T0 - 30000).toISOString() });
  assert.equal(await E.claimSignal(S(), "SQUARE_OFF", candle), false, "a claim 30 s old is someone else's work");
  db.algo_signals[0].created_at = new Date(T0 - 180000).toISOString();
  assert.equal(await E.claimSignal(S(), "SQUARE_OFF", candle), true, "a claim 3 min old is taken over");
  assert.match(db.algo_signals[0].description, /taken over/);
  assert.equal(db.algo_signals.length, 1);
});

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
