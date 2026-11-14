import { chromium } from "playwright";
// Lighter on the database (14 Nov 2026): live prices are asked for every 2 seconds (no Realtime connection), and the
// 30-second refresh reads only the strategies that changed, plus the id list. Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
const p = await ctx.newPage();
const errs = [], sockets = [];
p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message); });
p.on("websocket", (w) => sockets.push(w.url()));
const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };
const A = "22222222-2222-2222-2222-222222222222", t0 = Date.now(), iso = (ms) => new Date(ms).toISOString();
const base = { data_instrument: "FUTCOM", timeframe_min: 1440, strategy_kind: "RULES", trade_type: "FUTURES", direction: "BOTH", lots: 1, qty_mode: "LOTS", product_type: "M", exchange: "MCX",
  option_side: "BUY", leg_template_opt: "{}", leg_template_fut: "{}", position: "FLAT", archived: false, owner_id: A, active: true, live: false, intraday: false, sizing: { mode: "FIXED" } };
const S = (id, n, u, seg, lot, extra = {}) => ({ ...base, id, name: `Lab #${n} · Futures · ${u} daily · test rule`, underlying: u, data_segment: seg, data_security_id: u, futures_symbol: u, lot_size: lot,
  created_at: iso(t0 - 86400000 + n * 1000), updated_at: iso(t0 - 60000), ...extra });
let list = [
  S("g2", 1, "GOLD", "MCX_COMM", 100),
  S("gm", 2, "GOLDM", "MCX_COMM", 10),
  S("sol", 3, "SOLUSD", "DELTA", 1, { exchange: "DELTA", position: "LONG", pos_lots: 10, pos_qty: 10, pos_entry_px: 100, pos_ltp: 101, pos_upnl: 10, pos_ltp_at: iso(t0 - 20000), pos_entry_date: "2026-11-10" }),
  S("cu", 4, "COPPER", "MCX_COMM", 2500),
];
let delta = [], ids = null, marks = [];
const me = { user_id: A, email: "ca.ankitgarg@gmail.com", role: "admin", status: "active", can_build: true, terms_accepted: true, billing: {}, entries: { ok: true } };
const res = { "rpc/whoami": me, "rpc/broker_status": { broker: "DHAN", has_token: true, token_tail: "abcd", has_url: true, url_host: "x", has_secret: true },
  "rpc/my_capital": { capital: 1000000, since: null, deploy_pct: 60, live_net: 0, paper_net: 0, live_used: 0, paper_used: 0, funds: {} } };
const seen = [];
await p.route(/supabase\.co/, (r) => {
  const u = decodeURIComponent(r.request().url().replace(/^.*supabase\.co/, "")), meth = r.request().method();
  if (/\/auth\/v1\/user/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: A, email: me.email }) });
  if (meth === "PATCH") return r.fulfill({ status: 204, body: "" });
  const m = u.match(/\/rest\/v1\/(rpc\/[a-z_]+|[a-z_]+)/), key = m && m[1];
  let body = key in res ? res[key] : [];
  if (key === "algo_strategies" && meth === "GET") {
    const kind = /updated_at=gt\./.test(u) ? "delta" : /select=id(&|$)/.test(u) ? "ids" : "full";
    seen.push({ kind, u });
    body = kind === "delta" ? delta : kind === "ids" ? (ids || list.map((x) => ({ id: x.id }))) : list;
  }
  if (key === "live_marks") { seen.push({ kind: "marks", u }); body = marks; }
  if (/application\/vnd\.pgrst\.object/.test(r.request().headers()["accept"] || "") && Array.isArray(body)) body = body[0] ?? null;
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await p.addInitScript(([uid, email]) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem("sb-umryzxusbdttbcshkajt-auth-token", JSON.stringify({ access_token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y", token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r", user: { id: uid, email, aud: "authenticated", role: "authenticated" } }));
}, [A, me.email]);
await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p.goto("http://localhost:8765/index.html"); await p.waitForTimeout(1500);
const count = (k) => seen.filter((x) => x.kind === k).length;
const st = () => p.evaluate(() => state.strategies.map((s) => ({ id: s.id, name: s.name, active: s.active, upnl: s.pos_upnl, ltp: s.pos_ltp })));

// 1. the first load reads everything once
if (count("full") < 1 || count("delta") || count("ids")) fail("first load = one full read", seen.map((x) => x.kind));
if ((await st()).map((x) => x.id).join() !== "g2,gm,sol,cu") fail("first list", await st());

// 2. live prices: asked for every 2 seconds, only what changed since the last answer; no Realtime socket
marks = [{ strategy_id: "sol", ltp: 105, upnl: 50, at: iso(Date.now()) }];
await p.waitForTimeout(4600);
const mk = seen.filter((x) => x.kind === "marks");
if (mk.length < 2) fail("live prices asked for every 2 s", mk.length);
if (/at=gt\./.test(mk[0].u)) fail("the first read asks for every open position's price", mk[0].u);
if (!/strategy_id=in\.\(.*sol/.test(mk[0].u)) fail("asked for the open positions", mk[0].u);
if (!/at=gt\./.test(mk[mk.length - 1].u)) fail("later reads ask only for newer prices", mk[mk.length - 1].u);
const sol = (await st()).find((x) => x.id === "sol");
if (Number(sol.upnl) !== 50 || Number(sol.ltp) !== 105) fail("the price and running P&L arrived", sol);
if (!/50/.test(await p.evaluate(() => document.body.innerText))) fail("running P&L on screen");
if (sockets.length) fail("no Realtime connection is opened", sockets);

// 3. background refresh: only changed rows + the id list; a deleted strategy goes, a changed one is replaced, order kept
const fullBefore = count("full");
delta = [{ ...list[0], active: false, name: "Lab #1 · Futures · GOLD daily · renamed", updated_at: iso(Date.now()) }];
ids = [{ id: "g2" }, { id: "sol" }, { id: "cu" }]; // gm was deleted on another device
await p.evaluate(() => refreshAll()); await p.waitForTimeout(400);
if (count("full") !== fullBefore) fail("a background refresh doesn't read every strategy", seen.map((x) => x.kind));
if (count("delta") !== 1 || count("ids") !== 1) fail("it reads the changed rows and the id list", seen.map((x) => x.kind));
let now = await st();
if (now.map((x) => x.id).join() !== "g2,sol,cu") fail("deleted one gone, order kept", now);
if (now[0].active !== false || !/renamed/.test(now[0].name)) fail("changed row replaced", now[0]);
if (Number(now[1].upnl) !== 50) fail("the open position keeps its live price", now[1]);

// 4. an id the app doesn't know and the changed rows don't carry → everything is read again
const n5 = S("new", 5, "ZINC", "MCX_COMM", 5000);
list = [delta[0], list[2], list[3], n5]; delta = []; ids = [{ id: "g2" }, { id: "sol" }, { id: "cu" }, { id: "new" }];
await p.evaluate(() => { lastRefresh = 0; return refreshAll(); }); await p.waitForTimeout(400);
if (count("full") !== fullBefore + 1) fail("unknown id → full read", seen.map((x) => x.kind));
now = await st();
if (now.map((x) => x.id).join() !== "g2,sol,cu,new") fail("new strategy shown", now);

// 5. an action of the user (loadAll without the background flag) reads everything
const f2 = count("full");
await p.evaluate(() => loadAll()); await p.waitForTimeout(300);
if (count("full") !== f2 + 1) fail("loadAll() = full read", seen.map((x) => x.kind));
if (errs.length) fail("page errors", errs);
console.log("OK poll", theme, width, "| reads:", seen.map((x) => x.kind).join(" "));
await b.close();
