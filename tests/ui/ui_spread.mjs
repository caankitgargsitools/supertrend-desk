import { chromium } from "playwright";
// Spread watcher page (admins, 2 Nov 2026): state, the three sections, top 25 / all. Args: theme width.
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
  S("g1", "GOLD", "MCX_COMM", 100, 1597170, { position: "SHORT", pos_lots: 1, pos_qty: 1 }),
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
  "rpc/spread_summary": { state: { started_at: now, until: new Date(Date.now() + 29 * 86400000).toISOString(), last_run: now, runs: 812, ids_day: "2026-11-02", nb: 10, cf: 30, last_error: JSON.stringify({ cx: "public.coindcx.com HTTP 503" }) },
    keys: [
      { kind: "nb", key: "RELIANCE", n: 300, n_pos: 3, avg_gap: -0.012, avg_net: -0.053, best_net: 0.021, sum_pos: 0.05, last_gap: -0.01, last_net: -0.051, last_x: { buy_at: "NSE", sell_at: "BSE" }, last_buy: 1400.1, last_sell: 1400 },
      ...Array.from({ length: 30 }, (_, i) => ({ kind: "cf", key: `STK${i}:near`, n: 20, avg_gap: 0.6, avg_yearly: 5 + i / 10, last_gap: 0.62, last_x: { days: 22, yearly: 6.1, exp: "2026-11-24", lot: 500 } })),
      { kind: "cx", key: "BTC", n: 1400, n_pos: 12, avg_gap: 0.05, avg_net: -0.19, best_net: 0.08, sum_pos: 0.4, last_gap: 0.03, last_net: -0.2, last_x: { buy_at: "Delta", sell_at: "CoinDCX", fund_delta_pct: 0.009, fund_dcx_pct: 0.01 }, last_buy: 77481, last_sell: 77500 },
    ] },
  "algo_strategies": strategies, "lab_margins": rates,
  "algo_trades": [100000, -300000, 50000, -200000].map((net, i) => ({ id: i + 1, strategy_id: "x", mode: "PAPER", net, exit_at: `202${i}-03-01T10:00:00Z`, contract: "X", lots: 1 })),
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

await p.evaluate(() => showPage("spread")); await p.waitForTimeout(800);
const txt = await p.textContent("#spreadPane");
for (const w of ["Day 1 of 30", "812 rounds", "coindcx.com HTTP 503", "RELIANCE", "₹500", "STK29", "BTC", "funding Delta 0.009%"]) if (!txt.includes(w)) fail("missing " + w);
if (txt.includes("STK0 ")) fail("only top 25 at first");
const rowsCf = async () => p.$$eval("#sp_body table", (t) => t[1].tBodies[0].rows.length);
if (await rowsCf() !== 25) fail("25 rows", await rowsCf());
await p.click("#sp_allcf"); await p.waitForTimeout(400); if (await rowsCf() !== 30) fail("all rows", await rowsCf());
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
await p.screenshot({ path: `spread_${theme}_${width}.png`, fullPage: true });
if (errs.length) fail("page errors", errs);
console.log("ok spread watcher", theme, width);
await b.close();
