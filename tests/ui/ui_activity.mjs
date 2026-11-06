// Admin › User activity (6 Nov 2026, Papa): active time in the last 24 h, capital, money in use, strategies, booked and
// running P&L for live and paper; the app's 5-minute presence mark. Args: theme width.
import { chromium } from "playwright";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme })).newPage();
const errs = []; p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message); });
const A = "22222222-2222-2222-2222-222222222222";
const me = { user_id: A, email: "ca.ankitgarg@gmail.com", role: "admin", status: "active", can_build: true, terms_accepted: true, billing: {}, entries: { ok: true } };
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const act = [
  { user_id: A, email: "ca.ankitgarg@gmail.com", full_name: "Papa", role: "admin", status: "active", last_seen: ago(1), last_sign_in_at: ago(300), active_min: 415, capital: 10000000, dhan_ok: true,
    live_n: 0, paper_n: 30, live_open: 0, paper_open: 14, live_used: 0, paper_used: 18500000, live_real: 0, paper_real: -2385432, live_unreal: 0, paper_unreal: 1462580, trades_24h: 3, halted: false },
  { user_id: "u2", email: "client@example.com", full_name: "", role: "user", status: "active", last_seen: null, last_sign_in_at: null, active_min: 0, capital: 0, dhan_ok: false,
    live_n: 1, paper_n: 2, live_open: 1, paper_open: 0, live_used: 150000, paper_used: 0, live_real: 12500, live_unreal: -800, paper_real: 0, paper_unreal: 0, trades_24h: 0, halted: true },
];
const res = { "rpc/whoami": me, "rpc/broker_status": { broker: "DHAN", has_token: true }, "rpc/my_capital": { capital: 0, funds: {} }, "rpc/admin_users": [], "rpc/admin_activity": act };
const calls = [];
await p.route(/supabase\.co/, (r) => {
  const u = r.request().url().replace(/^.*supabase\.co/, "");
  if (/\/auth\/v1\/user/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: A, email: me.email }) });
  const m = u.match(/\/rest\/v1\/(rpc\/[a-z_]+|[a-z_]+)/), key = m && m[1]; if (key) calls.push(key);
  let body = key in res ? res[key] : [];
  if (/application\/vnd\.pgrst\.object/.test(r.request().headers()["accept"] || "") && Array.isArray(body)) body = body[0] ?? null;
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p.addInitScript(([id, email]) => { localStorage.setItem("sb-umryzxusbdttbcshkajt-auth-token", JSON.stringify({ access_token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id, email, aud: "authenticated", role: "authenticated" } })); }, [A, me.email]);
const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };
await p.goto("http://localhost:8765/index.html"); await p.waitForTimeout(1500);
await p.evaluate(() => refreshAll && refreshAll()); await p.waitForTimeout(400);
if (!calls.includes("rpc/touch_presence")) fail("the app marks its presence", calls.filter((c) => c.startsWith("rpc")));
await p.evaluate(() => showPage("admin")); await p.waitForTimeout(500);
await p.click('#ad_tabs [data-t="activity"]'); await p.waitForTimeout(600);
const rows = await p.$$eval("#aa_body tr", (x) => x.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, " ").trim())));
if (rows.length !== 2) fail("one row per user", rows);
const [a, c] = rows;
if (rows[0].length !== 7) fail("7 columns, not bulky", rows[0]);
if (!/^Papa/.test(a[0]) || !/seen now/.test(a[0]) || a[1] !== "6 h 55 m" || !/1,00,00,000/.test(a[2]) || !/^0 strategies/.test(a[3]) || !/30 strategies · 14 open · ₹1,85,00,000 in use/.test(a[4])
  || !/booked [−-]₹23,85,432 · running ₹14,62,580/.test(a[4]) || a[5] !== "3" || !/Dhan ✓/.test(a[6])) fail("first row", a);
if (c[1] !== "–" || !/1 strategy · 1 open · ₹1,50,000 in use/.test(c[3]) || !/booked ₹12,500 · running [−-]₹800/.test(c[3]) || !/no Dhan/.test(c[6]) || !/new trades stopped/.test(c[6]) || !/seen never/.test(c[0])) fail("second row", c);
if (!/2 users · 1 active in the last 24 h/.test(await p.textContent("#aa_sum"))) fail("summary", await p.textContent("#aa_sum"));
await p.click("#aa_table th:nth-child(2)"); await p.waitForTimeout(150);
const order = await p.$$eval("#aa_body tr td:first-child b", (x) => x.map((e) => e.textContent));
if (order.length !== 2) fail("sorting keeps the rows", order);
if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/activity_${theme}_${width}.png`, fullPage: true });
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok   user activity", theme, width);
await b.close();
