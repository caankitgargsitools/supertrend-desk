// Live trade alerts (12 Nov 2026, Papa chose A + B + C + D, then the test button): the in-app full-screen alert follows one
// live trade through its stages (one card, updated in place), an exit shows the P&L with coins; the test button runs the
// four-step sample through notify_live_test; the notification kinds list live trades (loud) and paper trades (silent).
// Args: theme width.
import { openApp, fail } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const rows = [];
const base = { live: true, test: true, side: "BUY", asset: "GOLDM", lots: 2, px: 137010, fill: 137020, stop: 135650, tgt: 140450, units: 20, risk: 27400, margin: 25350, dir: 1, now: 137020 };
const stage = (k) => {
  const at = new Date().toISOString();
  if (k === 1) rows.push({ id: 501, kind: "live_trade", tag: "lt-test", title: "TEST ⚡ LIVE BUY · GOLDM · 2 lots · sending to the broker", body: "TEST — signal at ₹1,37,010.", url: "/?home=1", created_at: at, meta: { ...base, stage: "sent", at } });
  if (k === 2 || k === 3) Object.assign(rows[0], { title: "TEST 🟢 LIVE BUY · GOLDM · 2 lots @ ₹1,37,020", body: "TEST — filled.", meta: { ...base, stage: k === 2 ? "filled" : "stop", now: k === 3 ? 137380 : 137020, quiet: true, at } });
  if (k === 4) rows.push({ id: 502, kind: "live_trade", tag: "lx-test", title: "TEST 💰 LIVE EXIT · GOLDM · +₹8,450 (+0.6%)", body: "TEST — held 3 h 20 min · today +₹12,300 · Target", url: "/?home=1", created_at: at, meta: { live: true, test: true, stage: "closed", asset: "GOLDM", net: 8450, pct: .6, held: "3 h 20 min", today: 12300, at } });
};
const { b, p, writes, errs } = await openApp({ theme, width, res: {
  "notifications": () => [...rows].sort((x, y) => y.id - x.id),
  "rpc/notify_live_test": (req) => { stage(JSON.parse(req.postData() || "{}").p_stage); return null; },
} });
// The kinds: live trades loud, paper trades silent.
const kinds = await p.evaluate(() => NTF_KINDS.map(([k, t]) => k + ":" + t).join("|"));
if (!/live_trade:Live trades \(real money\)/.test(kinds) || !/trade:Paper trades \(silent\)/.test(kinds)) fail("notification kinds", kinds);
// An alert passed on by the service worker (phone push while the app is open) shows at once.
await p.evaluate(() => { lt.init = true; });
await p.evaluate(() => ltShow({ id: 900, title: "🔻 LIVE SELL · NIFTY · 1 lot @ ₹25,010", body: "Filled. Stop ₹25,200", url: "/?s=n1", meta: { live: true, stage: "filled", side: "SELL", asset: "NIFTY", fill: 25010, stop: 25200, tgt: 24700, now: 24990, dir: -1, units: 65, at: "x" } }));
if (await p.isHidden("#lt_over")) fail("alert from the phone push not shown");
if (!/\bdown\b/.test(await p.getAttribute("#lt_card", "class"))) fail("sell alert colour", await p.getAttribute("#lt_card", "class"));
if (!(await p.$("#lt_card .pladder"))) fail("position bar in the alert");
if (!/Open the strategy/.test(await p.textContent("#lt_card"))) fail("open button");
await p.keyboard.press("Escape"); if (!(await p.isHidden("#lt_over"))) fail("Escape closes");
// The same stage again (the poll finding it) doesn't show it twice.
await p.evaluate(() => ltShow({ id: 900, title: "x", meta: { stage: "filled", at: "x" } }));
if (!(await p.isHidden("#lt_over"))) fail("same stage shown twice");
// The test button: four steps through notify_live_test; one entry card updated in place, then the exit with P&L and coins.
await p.evaluate(() => { lt.init = false; lt.seen.clear(); });
await p.click("#openSettings"); await p.waitForSelector("#lt_test", { timeout: 8000 }).catch(() => fail("no test button on Connections"));
await p.click("#lt_test"); await p.waitForTimeout(600);
if (await p.isHidden("#lt_over")) fail("test step 1 not shown");
if (!/Signal sent/.test(await p.textContent("#lt_card .lt-steps li.now")) || !/TEST/.test(await p.textContent("#lt_card .lt-badge"))) fail("step 1 card", await p.textContent("#lt_card"));
await p.screenshot({ path: `lt_entry_${theme}_${width}.png` });
await p.waitForTimeout(8800);
if (!/Stop at the broker/.test(await p.textContent("#lt_card .lt-steps li.now"))) fail("step 3 updates the same card", await p.textContent("#lt_card"));
if ((await p.$$("#lt_card .lt-steps li.done")).length !== 2) fail("two steps done");
await p.waitForTimeout(6500);
if (!/\+₹8,450/.test(await p.textContent("#lt_card .lt-pnl")) || !/\bwin\b/.test(await p.getAttribute("#lt_card", "class"))) fail("exit card", await p.textContent("#lt_card"));
if (!(await p.$$("#lt_coins i")).length) fail("coins on a profit");
await p.screenshot({ path: `lt_exit_${theme}_${width}.png` });
const calls = writes.filter((w) => /notify_live_test/.test(w.u)).map((w) => JSON.parse(w.body).p_stage);
if (calls.join() !== "1,2,3,4") fail("test steps sent", calls);
if (!/Done/.test(await p.textContent("#lt_test_msg"))) fail("done message");
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok live trade alert", theme, width);
await b.close();
