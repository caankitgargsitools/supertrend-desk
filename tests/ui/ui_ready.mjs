// "Ready to trade?" on the Home (13 Nov 2026, Papa: checks that tell us before a hazard happens): the stored result shows
// Live and Paper apart; red and amber checks are open with what to do, green ones folded; "Check now" runs it afresh; the
// All | Live | Paper switch narrows it. Args: theme width.
import { openApp, fail } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const at = new Date(Date.now() - 3 * 60000).toISOString();
const stored = { at, worst_live: "fail", worst_paper: "ok",
  live: [{ key: "token", status: "ok", title: "Dhan access token", detail: "Valid for 23 h more." },
    { key: "ip", status: "fail", title: "Dhan refuses orders from the desk's address", detail: "Dhan sees the desk at 2406:x but has 13.2.3.4 registered.", fix: "Register the address Dhan sees." },
    { key: "sizing", status: "fail", title: "22 live strategies are sized far beyond your live capital", detail: "GOLD Daily (10 lots ≈ ₹21,27,874 a day)", fix: "Capital › Live › Lots wizard: Autofill and Apply." },
    { key: "stops", status: "warn", title: "7 of 28 live strategies have no stop-loss", detail: "They exit only on their rules.", fix: "Add a stop-loss if you want one." }],
  paper: [{ key: "capital", status: "ok", title: "Paper capital has room", detail: "₹12 Cr of ₹60 Cr in use." }] };
let checks = 0;
const fresh = { ...stored, at: new Date().toISOString(), worst_live: "warn", live: stored.live.map((e) => e.status === "fail" ? { ...e, status: "ok", fix: null } : e) };
const { b, p, errs } = await openApp({ theme, width, res: { "rpc/readiness_latest": () => stored, "rpc/readiness_check": () => { checks++; return fresh; } } });
await p.waitForSelector("#lp_ready .rd-part", { timeout: 8000 }).catch(() => fail("no readiness card"));
const t = (await p.textContent("#lp_ready")).replace(/\s+/g, " ");
if (!/Ready to trade\?/.test(t) || !/Live · Not ready/.test(t) || !/Paper · Ready/.test(t)) fail("header and the two modes", t.slice(0, 300));
if (!/Dhan refuses orders from the desk's address/.test(t) || !/Register the address Dhan sees/.test(t) || !/sized far beyond your live capital/.test(t)) fail("red checks open with their fix", t.slice(0, 600));
if (/Dhan access token/.test(t) || /Paper capital has room/.test(t)) fail("green checks folded by default", t.slice(0, 600));
if (checks !== 0) fail("a fresh stored result isn't re-run", checks);
await p.click("#rd_all"); if (!/Dhan access token/.test(await p.textContent("#lp_ready"))) fail("show every check");
// The All | Live | Paper switch narrows it.
if (width > 700) { await p.click('#lp_modeseg [data-m="PAPER"]'); await p.waitForTimeout(300);
  const tp = await p.textContent("#lp_ready"); if (/Live ·/.test(tp) || !/Paper · Ready/.test(tp)) fail("paper only", tp.slice(0, 300));
  await p.click('#lp_modeseg [data-m=""]'); await p.waitForTimeout(200); }
// Check now runs it afresh.
await p.click("#rd_now"); await p.waitForTimeout(900);
const t2 = (await p.textContent("#lp_ready")).replace(/\s+/g, " ");
if (checks !== 1 || !/Live · Look at/.test(t2) || /Not ready/.test(t2)) fail("check now", { checks, t2: t2.slice(0, 300) });
await p.screenshot({ path: `ready_${theme}_${width}.png` });
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok ready to trade", theme, width);
await b.close();
