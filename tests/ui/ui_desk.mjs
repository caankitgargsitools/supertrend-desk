import { chromium } from "playwright";
// Desk page (2 Nov 2026): numbers, tiles, the profit flow fed by live price moves, timeline, capital flow. Args: theme width.
// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message, (e.stack || "").split("\n").slice(0, 4).join(" / ")); });
const A = "22222222-2222-2222-2222-222222222222", now = new Date().toISOString();
const base = { data_instrument: "FUTCOM", timeframe_min: 1440, strategy_kind: "RULES", trade_type: "FUTURES", direction: "BOTH", lots: 1, qty_mode: "LOTS", product_type: "M", exchange: "MCX",
  option_side: "BUY", leg_template_opt: "{}", leg_template_fut: "{}", position: "FLAT", archived: false, created_at: now, owner_id: A, active: true, live: false, intraday: false };
const S = (id, u, seg, lot, dd, extra = {}) => ({ ...base, id, name: `Lab #${id} · Futures · ${u} daily · test rule`, underlying: u, data_segment: seg, data_security_id: u, futures_symbol: u, lot_size: lot,
  sizing: { mode: "FIXED", dd_per_lot: dd }, ...extra });
const strategies = [
  S("g1", "GOLD", "MCX_COMM", 100, 1597170, { position: "SHORT", pos_lots: 1, pos_qty: 1, pos_upnl: 717400, pos_margin: 1342777, pos_ltp: 140222, pos_entry_date: "2026-10-20" }),
  S("g3", "GOLD", "MCX_COMM", 100, 1597170, { position: "LONG", pos_lots: 1, pos_qty: 1, pos_upnl: -347800, pos_margin: 1337847, pos_ltp: 140222, pos_entry_date: "2026-10-28" }),
  S("sol2", "SOLUSD", "DELTA", 4400, 44550, { exchange: "DELTA", position: "SHORT", pos_lots: 1, pos_qty: 1, pos_upnl: 8628, pos_margin: 41403, pos_ltp: 92.14, pos_entry_date: "2026-10-31" }),
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
  "algo_trades": [40000, -12000, 5500].map((net, i) => ({ id: i + 1, strategy_id: ["g1", "sol", "cu"][i], side: "SHORT", mode: "PAPER", net, exit_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(), exit_why: "Trailing stop (gap)", lots: 1 })),
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

await p.evaluate(() => showPage("desk")); await p.waitForTimeout(1200);
const txt = await p.textContent("#deskPane");
for (const w of ["PAPER", "+₹3,78,228", "+₹33,500", "3 / 9", "1 long · 2 short", "Gold", "Trailing stop"]) if (!txt.includes(w)) fail("missing " + w, txt.slice(0, 400));
const lanes = await p.evaluate(() => desk.lanes.length); if (lanes !== 3) fail("3 streams", lanes);
const before = await p.evaluate(() => desk.pool.length);
// A live price move: Gold short gains ₹30,000 → green dots run into the pool, the total and pool rise.
await p.evaluate(() => onMark({ strategy_id: "g1", ltp: 139922, upnl: 747400, at: new Date().toISOString() }));
await p.waitForTimeout(200);
const m = await p.evaluate(() => ({ movers: desk.movers.length, up: desk.movers.every((x) => x.up), ticks: desk.ticks }));
if (!m.movers || !m.up || m.ticks !== 1) fail("green dots", m);
await p.waitForTimeout(3500);
const after = await p.evaluate(() => desk.pool.length); if (!(after > before)) fail("pool denser", [before, after]);
if (!(await p.textContent("#dk_run")).includes("4,08,228")) fail("total updated", await p.textContent("#dk_run"));
// A loss: Solana short, price up → red dots, pool thins.
await p.evaluate(() => onMark({ strategy_id: "sol2", ltp: 99, upnl: -21000, at: new Date().toISOString() }));
await p.waitForTimeout(200);
if (!(await p.evaluate(() => desk.movers.some((x) => !x.up)))) fail("red dots");
await p.waitForTimeout(3500);
const after2 = await p.evaluate(() => desk.pool.length); if (!(after2 < after)) fail("pool thinner", [after, after2]);
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
await p.screenshot({ path: `desk_${theme}_${width}.png`, fullPage: true });
if (errs.length) fail("page errors", errs);
await p.click('#dk_tiles [data-dk="g1"]'); await p.waitForTimeout(400);
if (await p.evaluate(() => page) !== "strat") fail("tile opens the strategy");
if (await p.evaluate(() => desk.raf)) fail("animation stopped after leaving");
console.log("ok desk", theme, width);
await b.close();
