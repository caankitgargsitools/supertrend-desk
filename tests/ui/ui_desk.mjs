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
  S("mid2", "MIDCPNIFTY", "IDX_I", 120, 38248, { exchange: "NSE", position: "LONG", pos_lots: 1, pos_qty: 1, pos_upnl: 3726, pos_margin: 191921, pos_ltp: 13366, pos_entry_date: "2026-11-02" }),
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
  "rpc/desk_series": { first: new Date(Date.now() - 2 * 864e5).toISOString(), step_s: 3600, rows: Array.from({ length: 48 }, (_, i) => ({ t: new Date(Date.now() - (48 - i) * 3600e3).toISOString(), m: 2600000 + i * 1000, u: 300000 + i * 2000, r: 30000 + i * 100, n: 3 })) },
  "algo_strategies": strategies, "lab_margins": rates,
  "algo_trades": [40000, -12000, 5500].map((net, i) => ({ id: i + 1, strategy_id: ["g1", "sol", "cu"][i], user_id: A, side: "SHORT", mode: "PAPER", net, exit_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(), exit_why: "Trailing stop (gap)", lots: 1 })),
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
  if (!sessionStorage.getItem("dkOneSet")) { localStorage.setItem("deskOne", "0"); sessionStorage.setItem("dkOneSet", "1"); } // the stacked layout first; one screen is checked at the end
  localStorage.setItem("sb-umryzxusbdttbcshkajt-auth-token", JSON.stringify({ access_token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y", token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r", user: { id: uid, email, aud: "authenticated", role: "authenticated" } }));
}, [A, me.email]);
await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p.goto("http://localhost:8765/index.html"); await p.waitForTimeout(1500);
const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };

await p.evaluate(() => showPage("desk")); await p.waitForTimeout(1200);
const txt = await p.textContent("#deskPane");
for (const w of ["PAPER", "+₹3,81,954", "+₹33,500", "4 / 10", "2 long · 2 short", "Gold", "Trailing stop"]) if (!txt.includes(w)) fail("missing " + w, txt.slice(0, 400));
const lanes = await p.evaluate(() => desk.lanes.length); if (lanes !== 4) fail("4 streams", lanes);
const before = await p.evaluate(() => desk.pool.length);
// A live price move: Gold short gains ₹30,000 → green dots run into the pool, the total and pool rise.
await p.evaluate(() => onMark({ strategy_id: "g1", ltp: 139922, upnl: 747400, at: new Date().toISOString() }));
await p.waitForTimeout(200);
const m = await p.evaluate(() => ({ movers: desk.movers.length, up: desk.movers.every((x) => x.up), ticks: desk.ticks }));
if (!m.movers || !m.up || m.ticks !== 1) fail("green dots", m);
await p.waitForTimeout(3500);
const after = await p.evaluate(() => desk.pool.length); if (!(after > before)) fail("pool denser", [before, after]);
if (!(await p.textContent("#dk_run")).includes("4,11,954")) fail("total updated", await p.textContent("#dk_run"));
// A loss: Solana short, price up → red dots, pool thins.
await p.evaluate(() => onMark({ strategy_id: "sol2", ltp: 99, upnl: -21000, at: new Date().toISOString() }));
await p.waitForTimeout(200);
if (!(await p.evaluate(() => desk.movers.some((x) => !x.up)))) fail("red dots");
await p.waitForTimeout(3500);
const after2 = await p.evaluate(() => desk.pool.length); if (!(after2 < after)) fail("pool thinner", [after, after2]);
// Capital deployed vs profit: estimated part from trades, recorded part from snapshots, live end; tabs, hover, zoom.
await p.waitForTimeout(400);
if (await p.evaluate(() => dkCvp.range) !== "1D") fail("per-minute day view is the default");
if (!/1 point = \d/.test(await p.textContent("#dk_cvp_step"))) fail("the chart says how far apart its points are", await p.textContent("#dk_cvp_step"));
await p.click('#dk_cvp_rng [data-v="1M"]'); await p.waitForTimeout(500);
const cv = await p.evaluate(() => ({ n: dkCvp.pts.length, est: dkCvp.pts.filter((x) => x.est).length, rec: dkCvp.pts.filter((x) => !x.est && !x.now).length, now: dkCvp.pts.some((x) => x.now) }));
if (!(cv.est > 0 && cv.rec === 48 && cv.now)) fail("capital vs profit series", cv);
if (!/Capital deployed/.test(await p.textContent("#dk_cvp_read"))) fail("read-out");
await p.click('#dk_cvp_tab [data-v="real"]'); if (await p.evaluate(() => dkCvp.tab) !== "real") fail("realised tab");
await p.locator("#dk_cvp").scrollIntoViewIfNeeded(); const box = await p.locator("#dk_cvp").boundingBox();
await p.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await p.waitForTimeout(100);
if (!/estimated|\d{2}:\d{2}/.test(await p.textContent("#dk_cvp_read"))) fail("hover read-out", await p.textContent("#dk_cvp_read"));
await p.mouse.move(box.x + box.width * .45, box.y + 60); await p.mouse.down(); await p.mouse.move(box.x + box.width * .8, box.y + 60, { steps: 5 }); await p.mouse.up(); await p.waitForTimeout(400);
if (!(await p.evaluate(() => dkCvp.zoom))) fail("drag to zoom");
if (await p.locator("#dk_cvp_reset").isHidden()) fail("reset zoom shown");
await p.click("#dk_cvp_reset"); await p.waitForTimeout(300); if (await p.evaluate(() => dkCvp.zoom)) fail("reset zoom");
await p.click("#dk_cvp_big"); if (!(await p.evaluate(() => document.getElementById("dk_cvp_box").classList.contains("big")))) fail("expand");
await p.click('#dk_cvp_rng [data-v="ALL"]'); await p.waitForTimeout(300);
// A shut market: no trickle or agent streams for that asset, others carry on.
await p.evaluate(() => { desk.closedAt = Date.now() + 1e9; desk.closed = new Map([["g1", true], ["g3", true], ["mid2", true], ["sol2", false]]); desk.amb = []; });
await p.waitForTimeout(800);
const amb = await p.evaluate(() => desk.amb.map((a) => desk.lanes[a.lane].s.id));
if (amb.some((id) => id !== "sol2") || !amb.length) fail("closed markets send no stream", amb);
await p.screenshot({ path: `desk_closed_${theme}_${width}.png` });
await p.evaluate(() => { desk.closedAt = 0; });
// Asset names fit inside the panel (no label starts left of the canvas).
const fit = await p.evaluate(() => { const c = document.getElementById("dk_cv").getContext("2d"); c.font = "600 9.5px monospace"; return desk.lanes.every((L) => desk.X0 - 8 - Math.min(c.measureText(dkName(L.s.underlying)).width, desk.X0 - 12) >= 0); });
if (!fit) fail("asset names fit");
// Full screen: the profit flow fills the screen; Esc and the same button close it.
await p.click("#dk_fs"); await p.waitForTimeout(400);
let fs = await p.evaluate(() => ({ full: document.querySelector(".dk-flow").classList.contains("full"), h: desk.H, w: desk.W, vh: innerHeight, vw: innerWidth }));
if (!fs.full || fs.h < fs.vh * .8 || fs.w < fs.vw * .95) fail("full screen fills the screen", fs);
await p.screenshot({ path: `desk_full_${theme}_${width}.png` });
await p.keyboard.press("Escape"); await p.waitForTimeout(300);
if (await p.evaluate(() => document.querySelector(".dk-flow").classList.contains("full"))) fail("Esc closes full screen");
await p.click("#dk_fs"); await p.waitForTimeout(200); await p.click("#dk_fs"); await p.waitForTimeout(300);
if (await p.evaluate(() => document.querySelector(".dk-flow").classList.contains("full"))) fail("the button closes full screen");
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
await p.screenshot({ path: `desk_${theme}_${width}.png`, fullPage: true });
// One screen (Papa, 6 Nov 2026): on big screens every panel fits in the window and the left menu is hidden.
if (width >= 1280) {
  if (await p.evaluate(() => document.body.classList.contains("dk-one"))) fail("one screen off when switched off");
  await p.setViewportSize({ width, height: Number(process.argv[4] || 1000) });
  await p.click("#dk_one"); await p.waitForTimeout(700);
  const one = await p.evaluate(() => {
    const vh = innerHeight, vw = innerWidth, ids = [".dk-acctp", ".dk-flow", ".dk-heat", ".dk-cvp", ".dk-tlp", ".dk-skp", ".dk-actp", ".dk-foot", ".dk-top"];
    const out = ids.map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { q, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), w: Math.round(r.width) }; });
    return { on: document.body.classList.contains("dk-one"), bar: getComputedStyle(document.querySelector(".bar")).display, sh: document.documentElement.scrollHeight, vh, vw, out,
      cv: [desk.W, desk.H], cvp: document.getElementById("dk_cvp").getBoundingClientRect().height, tl: document.getElementById("dk_tl").getAttribute("viewBox"), stored: localStorage.getItem("deskOne") };
  });
  if (!one.on || one.bar !== "none" || one.stored !== "1") fail("one screen on, menu hidden, remembered", one);
  if (one.sh > one.vh + 1) fail("one screen: no page scroll", one);
  const off = one.out.filter((r) => r.bottom > one.vh + 1 || r.right > one.vw + 1 || r.h < 40 || r.w < 150); if (off.length) fail("one screen: every panel inside the window", off);
  if (!(one.cv[1] > 200 && one.cvp > 80)) fail("one screen: charts fill their boxes", one);
  if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/desk_one_${theme}_${width}.png` });
  console.log("ok   one screen", JSON.stringify(one.out.map((r) => `${r.q}:${r.w}x${r.h}`)));
  // 30 open positions at once (Papa, 6 Nov): the lanes keep room, the tiles' amounts stay inside the tiles.
  const many = await p.evaluate(async () => {
    const U = ["GOLD", "GOLDM", "SILVER", "SILVERM", "CRUDEOIL", "NATURALGAS", "COPPER", "ZINC", "ALUMINIUM", "LEAD", "NIFTY", "BANKNIFTY", "MIDCPNIFTY", "FINNIFTY", "SOLUSD"];
    for (let i = 0; i < 30; i++) state.strategies.push({ ...state.strategies[0], id: "m" + i, name: `Lab #9${i} · Futures · ${U[i % U.length]} daily · many`, underlying: U[i % U.length], position: i % 2 ? "LONG" : "SHORT", pos_lots: 3, pos_upnl: (i % 3 ? 1 : -1) * (123456 + i * 2345678), pos_margin: 500000 + i * 1000, pos_entry_date: "2026-11-01" });
    renderDesk && (await renderDesk()); await new Promise((r) => setTimeout(r, 600));
    const tiles = [...document.querySelectorAll("#dk_tiles .dk-tile .p")].filter((x) => x.scrollWidth > x.clientWidth + 1).length;
    return { lanes: desk.lanes.length, laneH: desk.laneH, X0: desk.X0, W: desk.W, H: desk.H, tilesSpill: tiles, sh: document.documentElement.scrollHeight, vh: innerHeight };
  });
  if (many.lanes < 30 || (many.vh >= 900 && many.laneH < 16) || many.tilesSpill || many.sh > many.vh + 1) fail("one screen with 30 open positions", many);
  if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/desk_one30_${theme}_${width}.png` });
  console.log("ok   30 open positions", JSON.stringify(many));
  await p.evaluate(async () => { state.strategies = state.strategies.filter((x) => !/^m\d+$/.test(x.id)); await renderDesk(); });
  await p.click("#dk_one"); await p.waitForTimeout(300);
  if (await p.evaluate(() => document.body.classList.contains("dk-one") || getComputedStyle(document.querySelector(".bar")).display === "none")) fail("Show menu brings the menu back");
  await p.click("#dk_one"); await p.waitForTimeout(200);
}
if (errs.length) fail("page errors", errs);
await p.click('#dk_tiles [data-dk="g1"]'); await p.waitForTimeout(400);
if (await p.evaluate(() => page) !== "strat") fail("tile opens the strategy");
if (await p.evaluate(() => desk.raf)) fail("animation stopped after leaving");
if (await p.evaluate(() => document.body.classList.contains("dk-one"))) fail("menu back after leaving the Desk");
console.log("ok desk", theme, width);
await b.close();
