// The service worker's push handler (12 Nov 2026, after Papa's phone showed nothing): every kind of push must end in a shown
// notification — plain test, live trade (loud, quiet update, exit with P&L), paper trade (silent). Delivered through the
// DevTools protocol (ServiceWorker.deliverPushMessage) to the real sw.js; the notifications are read back with getNotifications().
import { chromium } from "playwright";
const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ permissions: ["notifications"] });
const p = await ctx.newPage();
await p.route(/supabase\.co|fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p.goto("http://localhost:8765/sw-test.html").catch(() => {});
await p.goto("http://localhost:8765/index.html");
const regId = await p.evaluate(async () => { const r = await navigator.serviceWorker.register("sw.js"); await navigator.serviceWorker.ready; return r.scope; });
const cdp = await ctx.newCDPSession(p);
await cdp.send("ServiceWorker.enable");
let reg = null;
cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => { for (const r of e.registrations) if (r.scopeURL === regId) reg = r.registrationId; });
for (let i = 0; i < 40 && !reg; i++) await p.waitForTimeout(100);
if (!reg) fail("no service worker registration");
const base = { live: true, test: true, side: "BUY", asset: "GOLDM", lots: 2, px: 137010, fill: 137020, stop: 135650, tgt: 140450, units: 20, risk: 27400, margin: 25350, dir: 1, now: 137020 };
const pushes = [
  { id: 1, title: "Test notification", body: "hi", kind: "test", tag: "n1" },
  { id: 2, title: "TEST ⚡ LIVE BUY · GOLDM", body: "sent", kind: "live_trade", tag: "lt-test", meta: { ...base, stage: "sent" } },
  { id: 3, title: "TEST 🟢 LIVE BUY · GOLDM @ 1,37,020", body: "stop", kind: "live_trade", tag: "lt-test2", meta: { ...base, stage: "stop", quiet: true } },
  { id: 4, title: "TEST 💰 LIVE EXIT · GOLDM", body: "exit", kind: "live_trade", tag: "lx-test", meta: { live: true, test: true, stage: "closed", asset: "GOLDM", net: 8450, pct: .6, held: "3 h", today: 12300 } },
  { id: 5, title: "Position closed (paper)", body: "paper", kind: "trade", tag: "exit-x" },
];
for (const d of pushes) await cdp.send("ServiceWorker.deliverPushMessage", { origin: "http://localhost:8765", registrationId: reg, data: JSON.stringify(d) });
await p.waitForTimeout(2500);
const shown = await p.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, tag: n.tag, silent: n.silent, sticky: n.requireInteraction, image: !!n.image, vib: n.vibrate.length })));
console.log(JSON.stringify(shown));
const by = (t) => shown.find((n) => n.tag === t);
for (const t of ["n1", "lt-test", "lt-test2", "lx-test", "exit-x"]) if (!by(t)) fail("not shown: " + t, shown);
if (!by("lt-test").sticky || !by("lt-test").vib || by("lt-test").silent) fail("live entry loud and sticky", by("lt-test"));
if (!by("lt-test2").silent) fail("quiet update silent", by("lt-test2"));
if (!by("exit-x").silent) fail("paper silent", by("exit-x"));
console.log("ok service worker push", by("lt-test").image ? "(with picture)" : "(no picture in this browser)");
await b.close();
