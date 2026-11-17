// Auto update (17 Nov 2026, Papa: an open Desk ran a page from before a change and showed LT's share price instead of the
// future's): the app notices a new version of the page (HEAD /, ETag) and reloads by itself when nothing would be lost;
// otherwise a bar offers "Refresh now". Args: theme width.
import { openApp, fail } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const { b, p, errs } = await openApp({ theme, width });
let tag = '"v1"', heads = 0;
await p.route((u) => u.origin === "http://localhost:8765" && (u.pathname === "/" || u.pathname === ""), (r) => {
  if (r.request().method() !== "HEAD") return r.continue();
  heads++; r.fulfill({ status: 200, headers: { etag: tag }, body: "" });
});
const mark = () => p.evaluate(() => window.__mark === 1);
const check = async () => { await p.evaluate(() => updCheck()).catch(() => {}); await p.waitForTimeout(1500); };
await p.evaluate(() => { window.__mark = 1; upd.tag = null; upd.ready = false; });
await check();
if (!heads) fail("asks the site for its version");
if (!(await mark()) || !(await p.isHidden("#updAlert"))) fail("same version: nothing happens");
// 1. New version while a strategy form has unsaved changes: the bar, no reload.
await p.evaluate(() => { formDirty = true; }); tag = '"v2"'; await check();
if (!(await mark())) fail("no reload with unsaved changes");
if (await p.isHidden("#updAlert") || !/new version of the portal is ready/i.test(await p.textContent("#updAlert"))) fail("the bar is shown", await p.textContent("#updAlert"));
await p.screenshot({ path: `update_${theme}_${width}.png` });
// 2. Typed a moment ago (lots, a search …): still no reload.
await p.evaluate(() => { formDirty = false; upd.typed = Date.now() - 60000; }); await check();
if (!(await mark())) fail("no reload while typing recently");
// 3. A dialog or live card open: no reload.
await p.evaluate(() => { upd.typed = 0; $("confirmBox").hidden = false; }); await check();
if (!(await mark())) fail("no reload with a dialog open");
// 4. Nothing to lose: it reloads by itself.
await p.evaluate(() => { $("confirmBox").hidden = true; }); await check(); await p.waitForTimeout(1500);
if (await mark().catch(() => false)) fail("reloads by itself when nothing would be lost");
// 5. After the reload: the version is the current one, no bar; "Refresh now" reloads.
await p.waitForTimeout(500); await p.evaluate(() => { window.__mark = 1; }); await check();
if (!(await mark()) || !(await p.isHidden("#updAlert"))) fail("current version after the reload: nothing happens");
tag = '"v3"'; await p.evaluate(() => { formDirty = true; }); await check();
if (await p.isHidden("#updAlert")) fail("bar for the next version");
await p.click("#upd_now"); await p.waitForTimeout(2000);
if (await mark().catch(() => false)) fail("Refresh now reloads");
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok update", theme, width);
await b.close();
