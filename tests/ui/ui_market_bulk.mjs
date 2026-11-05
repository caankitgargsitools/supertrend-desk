// Marketplace: add several strategies at once (5 Nov 2026, Papa: "for admin and for user both").
// Args: role (admin | user), theme (dark | light), width.
import { chromium } from "playwright";
const role = process.argv[2] || "user", theme = process.argv[3] || "dark", width = Number(process.argv[4] || 1440);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message); });
const U = "11111111-1111-1111-1111-111111111111", A = "22222222-2222-2222-2222-222222222222", uid = role === "admin" ? A : U, now = new Date().toISOString();
const me = { user_id: uid, email: role === "admin" ? "ca.ankitgarg@gmail.com" : "client@example.com", role, status: "active", can_build: role === "admin", terms_accepted: true,
  billing: { trial_active: false, balance: 6000, deploy_fee: 0 }, entries: { ok: true } };
const L = (id, title, price, extra = {}) => ({ id, title, summary: `${title} summary`, price, status: "published", asset: "NIFTY", instrument: "Futures", created_at: now, owned: false, users: 0, results: {}, ...extra });
const listings = [L(1, "Nifty trend", 0), L(2, "Gold swing", 2500), L(3, "Crude breakout", 4999, { owned: true }), L(4, "Silver draft", 0, { status: role === "admin" ? "draft" : "published" })];
const res = {
  "rpc/whoami": me, "rpc/broker_status": { broker: "DHAN", has_token: true, token_tail: "abcd", has_url: true, url_host: "x", has_secret: true },
  "rpc/my_capital": { capital: 500000, since: null, deploy_pct: 60, live_net: 0, paper_net: 0, live_used: 0, paper_used: 0, funds: {} },
  "algo_strategies": [], "rpc/market_listings": role === "admin" ? listings : listings.filter((l) => l.status === "published" && l.id !== 4),
};
const writes = [];
await p.route(/supabase\.co/, (r) => {
  const u = r.request().url().replace(/^.*supabase\.co/, ""), meth = r.request().method();
  if (meth !== "GET" && meth !== "HEAD" && !/\/auth\//.test(u)) writes.push({ meth, u: decodeURIComponent(u), body: r.request().postData() });
  if (/\/auth\/v1\/user/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: uid, email: me.email }) });
  if (/rpc\/buy_listing/.test(u)) { const x = JSON.parse(r.request().postData()); return x.p_listing === 2 ? r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "This strategy costs ₹2500. Your wallet has ₹100. Recharge first." }) }) : r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify("new-" + x.p_listing) }); }
  const m = u.match(/\/rest\/v1\/(rpc\/[a-z_]+|[a-z_]+)/), key = m && m[1];
  let body = key in res ? res[key] : [];
  if (/application\/vnd\.pgrst\.object/.test(r.request().headers()["accept"] || "") && Array.isArray(body)) body = body[0] ?? null;
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await p.addInitScript(([id, email]) => {
  localStorage.setItem("sb-umryzxusbdttbcshkajt-auth-token", JSON.stringify({ access_token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id, email, aud: "authenticated", role: "authenticated" } }));
}, [uid, me.email]);
await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p.goto("http://localhost:8765/index.html"); await p.waitForTimeout(1500);
const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };
await p.evaluate(() => showPage("market")); await p.waitForTimeout(1200);
// Only published listings can be ticked (a draft, seen by the admin, can't).
const picks = await p.$$eval("#mk_cards [data-mkpick]", (x) => x.map((i) => Number(i.dataset.mkpick)));
if (picks.join() !== "1,2,3") fail("tick boxes on published listings", picks);
if (!(await p.evaluate(() => document.getElementById("mk_bulk").hidden))) fail("bar shown before anything is ticked");
await p.click("#mk_pick_all"); await p.waitForTimeout(200);
if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/mk_bar_${role}_${width}.png` });
const bar = await p.textContent("#mk_bulk_n");
if (!/3 selected/.test(bar) || !/₹2,500 in all/.test(bar) || !/1 you own already/.test(bar)) fail("bar text", bar);
await p.click("#mk_bulk_add"); await p.waitForSelector("#bb_go");
if (!(await p.isDisabled("#bb_go"))) fail("needs the risk tick first");
await p.fill("#bb_lots", "2"); await p.check("#bb_ok");
await p.screenshot({ path: `market_bulk_${role}_${theme}_${width}.png`, fullPage: true });
await p.click("#bb_go"); await p.waitForTimeout(1500);
const buys = writes.filter((w) => /rpc\/buy_listing/.test(w.u)).map((w) => JSON.parse(w.body));
if (buys.map((x) => x.p_listing).join() !== "1,2,3" || buys.some((x) => x.p_lots !== 2 || x.p_capital !== 0)) fail("one buy_listing per ticked listing", buys);
const toastTxt = await p.textContent("#toast");
if (!/2 added; 1 not added/.test(toastTxt) || !/Recharge first/.test(toastTxt)) fail("summary toast", toastTxt);
// The one that failed stays ticked so it can be tried again after a recharge.
const left = await p.evaluate(() => [...mk.pick]);
if (left.join() !== "2") fail("failed one stays selected", left);
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok   marketplace: add several at once", role, theme, width);
await b.close();
