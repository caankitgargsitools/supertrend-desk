import { chromium } from "playwright";
// Lots wizard on the Capital page (2 Nov 2026): four ways to share capital, live totals, Apply saves fixed lots.
// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message); });
const A = "22222222-2222-2222-2222-222222222222", U = "11111111-1111-1111-1111-111111111111", now = new Date().toISOString();
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
// day_move: each asset's typical day's move (share of price); Zinc has none stored yet.
const rates = [["GOLD", 138485, .0925, .012], ["GOLDM", 137010, .0925, .012], ["COPPER", 1383.05, .09203, .015], ["SOLUSD", 94.98, .1, .04], ["MIDCPNIFTY", 13184.5, .11993, .011], ["ZINC", 415.9, .08944, null]]
  .map(([asset, price, fut_pct, day_move]) => ({ asset, price, fut_pct, fut_pct_i: fut_pct, sell_pct: null, sell_pct_i: null, checked_at: now, day_move }));
const me = { user_id: A, email: "ca.ankitgarg@gmail.com", role: "admin", status: "active", can_build: true, terms_accepted: true, billing: {}, entries: { ok: true } };
const res = {
  "rpc/whoami": me, "rpc/broker_status": { broker: "DHAN", has_token: true, token_tail: "abcd", has_url: true, url_host: "x", has_secret: true },
  "rpc/my_capital": { capital: 10000000, since: null, deploy_pct: 60, live_net: 0, paper_net: 0, live_used: 0, paper_used: 0, funds: {} },
  "algo_strategies": strategies, "lab_margins": rates,
  // The admin's own closed trades belong to the archived "x"; every other strategy carries the same four trades as a client's rows
  // (the trade store is read once and filtered per strategy since 6 Nov 2026, so each strategy needs rows of its own).
  "algo_trades": [["x", A], ["g1", U], ["g2", U], ["gm", U], ["cu", U], ["sol", U], ["mid", U], ["nodd", U]].flatMap(([sid, uid], k) => [100000, -300000, 50000, -200000].map((net, i) => ({ id: k * 4 + i + 1, strategy_id: sid, user_id: uid, mode: "PAPER", net, exit_at: `202${i}-03-01T10:00:00Z`, contract: "X", lots: 1 }))),
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
await p.evaluate(() => openCap()); await p.waitForTimeout(800);
await p.click('#cap_mode [data-m="PAPER"]'); await p.waitForTimeout(800);
// Drawdown check: each strategy (its own trades) falls ₹4.5L = 4.7% of the capital now (₹96.5L = capital + booked P&L, the same figure
// as the Capital tile since 6 Nov 2026); all 7 together ₹31.5L = 32.6% → limit 50%.
await p.waitForSelector("#cap_dd_use", { timeout: 8000 }).catch(() => fail("no drawdown suggestion", null));
const dd = await p.textContent("#cap_dd");
if (!/32\.6%/.test(dd) || !/4\.7%/.test(dd) || !/Use 50%/.test(dd)) fail("drawdown figures", dd.slice(0, 600));
await p.click("#cap_dd_use"); if (await p.inputValue("#cap_deploy") !== "50") fail("use suggestion");
// The Lots wizard is its own tab since 6 Nov 2026 (M5). It prefills capital + booked P&L (₹96.5L here); the lot figures below
// are worked out from a round ₹1 crore typed in.
await p.click('#cap_tabs [data-t="lots"]'); await p.waitForTimeout(200);
await p.fill("#lw_cap", "10000000"); await p.dispatchEvent("#lw_cap", "input"); await p.waitForTimeout(200);
// The capital tile says it includes archived strategies' trades (all the mocked trades belong to archived "x").
if (!/includes −₹3,50,000 from archived/.test(await p.textContent("#cap_stats"))) fail("archived note", await p.textContent("#cap_stats"));
// The wizard's limit above the saved one (60%) warns.
await p.fill("#lw_capPct", "85"); await p.dispatchEvent("#lw_capPct", "input");
if (!/above your saved limit of 60%/.test(await p.textContent("#lw_notes"))) fail("limit warning", await p.textContent("#lw_notes"));
await p.fill("#lw_capPct", "60"); await p.dispatchEvent("#lw_capPct", "input");
const lotsOf = () => p.evaluate(() => Object.fromEntries(lw.plan.map((r) => [r.s.id, r.lots])));
// Same ₹ on a typical day (default, 4 Nov 2026): lots = target ÷ (price × lot × day's move), whole lots, margin inside
// the 60% limit; Zinc has no day's move stored → left out with a note.
let L = await lotsOf();
const plan = await p.evaluate(() => lw.plan.filter((r) => r.on).map((r) => ({ id: r.s.id, lots: r.lots, day: r.day, used: r.used })));
const used = plan.reduce((a, r) => a + (r.used || 0), 0);
if (used > 6e6 + 1) fail("move: margin above the limit", used);
const days = plan.filter((r) => r.lots > 0).map((r) => r.day), mean = days.reduce((a, v) => a + v, 0) / days.length;
if (!(days.length >= 5) || days.some((d) => Math.abs(d / mean - 1) > 0.5)) fail("move: typical-day rupees not alike", plan);
if (L.nodd !== null) fail("move: zinc without a day's move", L);
if (!/no typical day's move/.test(await p.textContent("#lw_notes"))) fail("move: no-move note", await p.textContent("#lw_notes"));
if (!/Typical day at these lots/.test(await p.textContent("#lw_tbl thead"))) fail("move: columns");
// A typed target: ₹1,00,000 each on a typical day.
await p.fill("#lw_moveAmt", "100000"); await p.dispatchEvent("#lw_moveAmt", "input"); L = await lotsOf();
const wantMove = { g1: 1, g2: 1, gm: 6, cu: 2, sol: 6, mid: 6 };
for (const k in wantMove) if (L[k] !== wantMove[k]) fail("move lots " + k, L);
if (!/Target ₹1\.00 L each|Target ₹1,00,000 each|Target ₹1L each/.test(await p.textContent("#lw_moveTxt"))) console.log("note:", await p.textContent("#lw_moveTxt"));
await p.fill("#lw_moveAmt", ""); await p.dispatchEvent("#lw_moveAmt", "input");
// Risk: 2% of ₹1 Cr = ₹2L ÷ (fall × 1.5).
await p.click('[data-lwm="risk"]'); L = await lotsOf();
const want = { g1: 0, g2: 0, gm: 3, cu: 0, sol: 2, mid: 3, nodd: null };
for (const k in want) if (L[k] !== want[k]) fail("risk lots " + k, L);
if (!/0 lots/.test(await p.textContent("#lw_notes"))) fail("zero-lot note");
if (!/no worst fall/.test(await p.textContent("#lw_notes"))) fail("no-dd note");
// Equal: ₹1 Cr ÷ 7 each.
await p.click('[data-lwm="equal"]'); L = await lotsOf();
const eq = 1e7 / 7; if (L.gm !== Math.floor(eq / (137010 * 10 * .0925))) fail("equal gm", L);
// Lots per asset: Gold 2.
await p.click('[data-lwm="asset"]'); await p.fill('[data-lwasset="GOLD"]', "2"); await p.dispatchEvent('[data-lwasset="GOLD"]', "change"); L = await lotsOf();
if (L.g1 !== 2 || L.g2 !== 2 || L.cu !== 1) fail("asset lots", L);
// Percentage: shares filled evenly, total 100%.
await p.click('[data-lwm="pct"]');
const foot = await p.textContent("#lw_tbl tfoot"); if (!/100\.0%|99\.9%/.test(foot)) fail("pct total", foot);
// Untick a type.
await p.click('[data-lwtype="Crypto"]'); L = await lotsOf(); if (L.sol !== null) fail("crypto off", L);
await p.click('[data-lwtype="Crypto"]');
// Back to lots per asset and apply.
await p.click('[data-lwm="asset"]'); await p.waitForTimeout(100);
await p.screenshot({ path: `lw_${theme}_${width}.png`, fullPage: true });
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
const btnTxt = await p.textContent("#lw_apply"); if (!/3 changes/.test(btnTxt)) fail("apply count", btnTxt);
await p.click("#lw_apply"); await p.waitForSelector("#cf_yes");
if (!/next entry/.test(await p.textContent("#confirmBox"))) fail("open-position wording");
await p.click("#cf_yes"); await p.waitForTimeout(1200);
const patches = writes.filter((w) => w.meth === "PATCH" && /algo_strategies/.test(w.u));
if (patches.length !== 3) fail("patches", patches);
for (const w of patches) { const x = JSON.parse(w.body), id = w.u.match(/id=eq\.(\w+)/)[1]; if (x.sizing.mode !== "FIXED" || x.lots !== ({ g1: 2, g2: 2, nodd: 1 })[id]) fail("patch body " + id, x); }
// Same ₹ on a typical day, applied: saved as sizing MOVE with the target, so the lots follow the move by themselves.
writes.length = 0;
await p.click('[data-lwm="move"]'); await p.fill("#lw_moveAmt", "100000"); await p.dispatchEvent("#lw_moveAmt", "input");
await p.click("#lw_apply"); await p.waitForSelector("#cf_yes");
if (!/follow its asset's typical day's move at every new entry/.test(await p.textContent("#confirmBox"))) fail("move confirm wording", await p.textContent("#confirmBox"));
await p.click("#cf_yes"); await p.waitForTimeout(1200);
const mp = writes.filter((w) => w.meth === "PATCH" && /algo_strategies/.test(w.u)).map((w) => ({ id: w.u.match(/id=eq\.(\w+)/)[1], ...JSON.parse(w.body) }));
if (mp.length < 5 || mp.some((x) => x.sizing.mode !== "MOVE" || x.sizing.move_amt !== 100000)) fail("move patches", mp);
if (mp.find((x) => x.id === "gm").lots !== 6) fail("move patch lots gm", mp);
// The strategy form offers the same mode: it reads back as sizing MOVE with its ₹, and refuses an empty amount.
const form = await p.evaluate(() => {
  $("z_mode").value = "MOVE"; $("z_move").value = "50000";
  const ok = readSizing({ qty_mode: "LOTS" });
  $("z_move").value = ""; let err = ""; try { readSizing({ qty_mode: "LOTS" }); } catch (e) { err = e.message; }
  return { ok, err, text: sizeText(ok) };
});
if (form.ok.mode !== "MOVE" || form.ok.move_amt !== 50000 || !/₹ this strategy should make or lose/.test(form.err) || !/typical day/.test(form.text)) fail("form move sizing", form);
if (errs.length) fail("page errors", errs);
console.log("ok lots wizard", theme, width);
await b.close();
