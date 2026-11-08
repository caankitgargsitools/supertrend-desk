// Admin › Users › Manage (8 Nov 2026, Papa): the first-time welcome message (portal link, login email, trial, first steps)
// is shown again to copy later; the old password can't be shown (one-way hash), Set password puts the new one in it.
// Args: theme width.
import { chromium } from "playwright";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message); });
const A = "22222222-2222-2222-2222-222222222222";
const me = { user_id: A, email: "ca.ankitgarg@gmail.com", role: "admin", status: "active", can_build: true, terms_accepted: true, billing: {}, entries: { ok: true } };
const users = [me, { user_id: "u2", email: "client@example.com", full_name: "Ravi", role: "user", status: "active", trial_until: "2099-01-01" }];
const res = { "rpc/whoami": me, "rpc/broker_status": { broker: "DHAN", has_token: true }, "rpc/my_capital": { capital: 0, funds: {} }, "rpc/admin_users": users, "rpc/admin_activity": [] };
const fnCalls = [];
await p.route(/supabase\.co/, (r) => {
  const u = r.request().url().replace(/^.*supabase\.co/, "");
  if (/\/auth\/v1\/user/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: A, email: me.email }) });
  if (/functions\/v1\/admin-users/.test(u)) { fnCalls.push(JSON.parse(r.request().postData())); return r.fulfill({ status: 200, contentType: "application/json", body: "{}" }); }
  const m = u.match(/\/rest\/v1\/(rpc\/[a-z_]+|[a-z_]+)/), key = m && m[1];
  let body = key in res ? res[key] : [];
  if (/application\/vnd\.pgrst\.object/.test(r.request().headers()["accept"] || "") && Array.isArray(body)) body = body[0] ?? null;
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p.addInitScript(([id, email]) => { localStorage.setItem("sb-umryzxusbdttbcshkajt-auth-token", JSON.stringify({ access_token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r", user: { id, email, aud: "authenticated", role: "authenticated" } })); }, [A, me.email]);
const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };
await p.goto("http://localhost:8765/index.html"); await p.waitForTimeout(1500);
await p.evaluate(() => showPage("admin")); await p.waitForTimeout(600);
const btns = p.locator("#au_body button", { hasText: "Manage" });
if ((await btns.count()) !== 2) fail("a Manage button per user", await btns.count());
await btns.nth(1).click(); await p.waitForTimeout(300);
let msg = await p.textContent("#ue_msg pre");
if (!/Hello Ravi,/.test(msg) || !msg.includes("Sign in: http://localhost:8765/index.html") || !/Login \(email\): client@example.com/.test(msg) || !/Free trial till: 2099-01-01/.test(msg) || !/First steps:/.test(msg)
  || !/Password: the one sent to you earlier/.test(msg) || /Temporary password/.test(msg)) fail("welcome message without a password", msg);
if (!/can't be shown again/.test(await p.textContent("#ue_msg p.hint"))) fail("says why the password isn't there");
if (!(await p.locator("#ue_msg [data-c]").isVisible()) || !/wa\.me/.test(await p.getAttribute("#ue_msg [data-w]", "href"))) fail("Copy and WhatsApp");
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:8765" });
await p.click("#ue_msg [data-c]"); await p.waitForTimeout(200);
if (!/Copied/.test(await p.textContent("#ue_msg [data-c]"))) fail("copy");
await p.fill("#up_pass", "NewPass@123"); await p.click("#up_go"); await p.waitForTimeout(400);
if (fnCalls.at(-1)?.action !== "reset_password") fail("password set", fnCalls);
msg = await p.textContent("#ue_msg pre");
if (!/Temporary password: NewPass@123/.test(msg)) fail("the new password goes into the message", msg);
if (await p.locator("#au_edit pre").count() !== 1) fail("one message box, not a second one", await p.locator("#au_edit pre").count());
if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/welcome_${theme}_${width}.png`, fullPage: true });
// Own account: no welcome message (the login part is hidden there).
await btns.nth(0).click(); await p.waitForTimeout(300);
if (await p.locator("#ue_msg").isVisible()) fail("no welcome message for your own account");
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok   welcome message", theme, width);
await b.close();
