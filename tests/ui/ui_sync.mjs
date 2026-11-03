import { chromium } from "playwright";
// The same figures on every page (Capital, Desk, Strategies, Trades) and fresh data on coming back (3 Nov 2026). Args: theme width.
// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message); });
const A = "22222222-2222-2222-2222-222222222222", now = new Date().toISOString();
const base = { data_instrument: "FUTCOM", timeframe_min: 1440, strategy_kind: "RULES", trade_type: "FUTURES", direction: "BOTH", lots: 1, qty_mode: "LOTS", product_type: "M", exchange: "MCX",
  option_side: "BUY", leg_template_opt: "{}", leg_template_fut: "{}", position: "FLAT", archived: false, created_at: now, owner_id: A, active: true, live: false, intraday: false };
const S = (id, u, seg, lot, dd, extra = {}) => ({ ...base, id, name: `Lab #${id} · Futures · ${u} daily · test rule`, underlying: u, data_segment: seg, data_security_id: u, futures_symbol: u, lot_size: lot,
  sizing: { mode: "FIXED", dd_per_lot: dd }, ...extra });
const strategies = [
  S("g1", "GOLD", "MCX_COMM", 100, 1597170, { position: "SHORT", pos_lots: 1, pos_qty: 1, pos_upnl: 52000, pos_margin: 1342777, pos_ltp: 140222, pos_entry_date: "2026-10-30" }),
  S("g2", "GOLD", "MCX_COMM", 100, 571957),
  S("gm", "GOLDM", "MCX_COMM", 10, 34438),
  S("cu", "COPPER", "MCX_COMM", 2500, 184130),
  S("sol", "SOLUSD", "DELTA", 4400, 44550, { exchange: "DELTA" }),
  S("mid", "MIDCPNIFTY", "IDX_I", 120, 38248, { exchange: "NSE" }),
  S("nodd", "ZINC", "MCX_COMM", 5000, null, { sizing: { mode: "AUTO", alloc_pct: 20, max_lots: 3 } }),
  S("x", "GOLD", "MCX_COMM", 100, null, { archived: true, active: false }),
];
const rates = [["GOLD", 138485, .0925], ["GOLDM", 137010, .0925], ["COPPER", 1383.05, .09203], ["SOLUSD", 94.98, .1], ["MIDCPNIFTY", 13184.5, .11993], ["ZINC", 415.9, .08944]]
  .map(([asset, price, fut_pct]) => ({ asset, price, fut_pct, fut_pct_i: fut_pct, sell_pct: null, sell_pct_i: null, checked_at: now }));
const me = { user_id: A, email: "ca.ankitgarg@gmail.com", role: "admin", status: "active", can_build: true, terms_accepted: true, billing: {}, entries: { ok: true } };
const res = {
  "rpc/whoami": me, "rpc/broker_status": { broker: "DHAN", has_token: true, token_tail: "abcd", has_url: true, url_host: "x", has_secret: true },
  "rpc/my_capital": { capital: 10000000, since: null, deploy_pct: 60, live_net: 0, paper_net: 0, live_used: 0, paper_used: 0, funds: {} },
  "algo_strategies": strategies, "lab_margins": rates,
  "algo_trades": [...[100000, -300000, 50000, -200000].map((net, i) => ({ id: i + 1, strategy_id: "x", user_id: A, mode: "PAPER", net, exit_at: `2026-10-2${i}T10:00:00Z`, contract: "X", lots: 1, side: "LONG" })),
    { id: 10, strategy_id: "gm", user_id: A, mode: "PAPER", net: 40000, exit_at: "2026-11-01T10:00:00Z", contract: "GOLDM", lots: 1, side: "SHORT" },
    { id: 11, strategy_id: "gm", user_id: A, mode: "PAPER", net: -15000, exit_at: "2026-11-02T10:00:00Z", contract: "GOLDM", lots: 1, side: "LONG" }],
};
const writes = [];
await p.route(/supabase\.co/, (r) => {
  const u = r.request().url().replace(/^.*supabase\.co/, ""), meth = r.request().method();
  if (meth !== "GET" && meth !== "HEAD" && !/\/auth\//.test(u)) writes.push({ meth, u: decodeURIComponent(u), body: r.request().postData() });
  if (/\/auth\/v1\/user/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: A, email: me.email }) });
  if (meth === "PATCH") return r.fulfill({ status: 204, body: "" });
  const m = u.match(/\/rest\/v1\/(rpc\/[a-z_]+|[a-z_]+)/), key = m && m[1];
  let body = key in res ? res[key] : [];
  if (/application\/vnd\.pgrst\.object/.test(r.request().headers()["accept"] || "") && Array.isArray(body)) body = body[0] ?? null;
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await p.addInitScript(([uid, email]) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem("sb-umryzxusbdttbcshkajt-auth-token", JSON.stringify({ access_token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y", token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r", user: { id: uid, email, aud: "authenticated", role: "authenticated" } }));
}, [A, me.email]);
await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p.goto("http://localhost:8765/index.html"); await p.waitForTimeout(1500);
const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };

const num = (t) => { const m = String(t).match(/[−-]?₹[\d,]+/); return m ? Number(m[0].replace(/,/g, "").replace("−", "-").replace("₹", "")) : NaN; };
const want = 100000 - 300000 + 50000 - 200000 + 40000 - 15000; // −₹3,25,000: every paper trade, the archived strategy's too
// Capital
await p.evaluate(() => openCap()); await p.waitForTimeout(700); await p.click('#cap_mode [data-m="PAPER"]'); await p.waitForTimeout(700);
const capTiles = await p.$$eval("#cap_stats .stat .v", (x) => x.map((e) => e.textContent));
const capNet = num(capTiles[1]), capUsed = num(capTiles[2]);
if (capNet !== want) fail("Capital booked", capTiles);
if (capUsed !== 1342777) fail("Capital in use = open positions' margin", capTiles);
// Desk
await p.evaluate(() => showPage("desk")); await p.waitForTimeout(900);
if (await p.evaluate(() => desk.mode) !== "PAPER") await p.click('#dk_mode [data-m="PAPER"]'), await p.waitForTimeout(700);
const dkBook = num(await p.textContent("#dk_book")), dkRun = num(await p.textContent("#dk_run")), dkMargin = await p.textContent("#dk_margin");
if (dkBook !== want) fail("Desk booked = Capital", [dkBook, want]);
if (dkRun !== 52000) fail("Desk running", dkRun);
if (!/13\.42L/.test(dkMargin)) fail("Desk margin = Capital in use", dkMargin);
// Strategies totals show the account figure too
await p.evaluate(() => { showPage("list"); lpView = "full"; renderList(); }); await p.waitForTimeout(500);
if (width > 700 && !/account: paper −₹3,25,000/.test(await p.textContent("#lp_tfoot"))) fail("Strategies total shows the account figure", await p.textContent("#lp_tfoot"));
// Trades tab: archived included by default → same total
await p.evaluate(() => setLpTab("trades")); await p.waitForTimeout(900);
await p.evaluate(() => { const el = document.getElementById("tf_mode"); el.value = "PAPER"; el.dispatchEvent(new Event("change")); }); await p.waitForTimeout(300);
if (!/−₹3,25,000/.test(await p.textContent("#tf_stats"))) fail("Trades total = Capital", (await p.textContent("#tf_stats")).slice(0, 300));
// Fresh data on coming back: a new trade and a moved price on the server show without a reload
await p.evaluate(() => showPage("desk")); await p.waitForTimeout(600);
res["algo_trades"].push({ id: 12, strategy_id: "gm", user_id: A, mode: "PAPER", net: 25000, exit_at: new Date().toISOString(), contract: "GOLDM", lots: 1, side: "SHORT" });
res["algo_strategies"].find((x) => x.id === "g1").pos_upnl = 61000;
await p.evaluate(() => { lastRefresh = 0; window.dispatchEvent(new Event("focus")); }); await p.waitForTimeout(1500);
if (num(await p.textContent("#dk_book")) !== want + 25000) fail("Desk booked refreshed on coming back", await p.textContent("#dk_book"));
if (num(await p.textContent("#dk_run")) !== 61000) fail("Desk running refreshed", await p.textContent("#dk_run"));
await p.evaluate(() => openCap()); await p.waitForTimeout(800);
if (num((await p.$$eval("#cap_stats .stat .v", (x) => x.map((e) => e.textContent)))[1]) !== want + 25000) fail("Capital matches after the refresh");
if (errs.length) fail("page errors", errs);
console.log("ok same figures everywhere, fresh on return", theme, width);
await b.close();
