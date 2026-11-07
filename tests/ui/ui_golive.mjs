// Go-live confirmation (6 Nov 2026): a summary table (asset · lots · margin · stop · expiry / roll), the charges note, the same-asset
// warning inline, and "LIVE" typed for the first go-live of an account.
import { openApp, fail, strategies } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
// No strategy of this account is or has been live: the first go-live.
const list = strategies.map((s) => ({ ...s, live: false, live_since: null, risk: s.id === "g2" ? { sl: { type: "PCT", value: 1 } } : s.risk }));
const { b, p, errs } = await openApp({ theme, width, strategies: list });
await p.evaluate(() => openStrat("g2")); await p.waitForTimeout(900);
await p.click("#b_live"); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
const txt = (await p.textContent("#confirmBox")).replace(/\s+/g, " ");
if (!/Send real orders to Dhan\?/.test(txt)) fail("title", txt.slice(0, 200));
const cells = await p.$$eval("#confirmBox table.golive tbody tr", (r) => r.map((x) => [...x.children].map((c) => c.textContent.replace(/\s+/g, " ").trim())));
if (cells.length !== 1) fail("one summary row", cells);
const [asset, lots, margin, stop, exp] = cells[0];
if (!/Gold/.test(asset) || lots !== "1 lot" || !/≈ ₹1,30,000/.test(margin) || !/1%/.test(stop) || !/rolls the day before expiry/.test(exp)) fail("summary cells", cells[0]);
if (!/charges apply to every order/.test(txt)) fail("charges note");
// First go-live: LIVE must be typed; "live" in small letters counts.
if (!(await p.$("#cf_live"))) fail("typed LIVE field for the first go-live");
if (!(await p.$eval("#cf_yes", (b) => b.disabled))) fail("Go live disabled until typed");
await p.fill("#cf_live", "liv"); if (!(await p.$eval("#cf_yes", (b) => b.disabled))) fail("still disabled on a wrong word");
await p.fill("#cf_live", "live"); if (await p.$eval("#cf_yes", (b) => b.disabled)) fail("enabled once LIVE is typed");
await p.click("#cf_no"); await p.waitForTimeout(200);
// With another live strategy on the same asset: the warning sits inside the dialog and no typing is needed.
await p.evaluate(() => { const g1 = stratOf("g1"); g1.live = true; g1.live_since = "2026-10-01T00:00:00Z"; });
await p.click("#b_live"); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
if (await p.$("#cf_live")) fail("no typed LIVE once a strategy has been live");
if (await p.$eval("#cf_yes", (b) => b.disabled)) fail("Go live enabled");
if (!(await p.$("#confirmBox .same-asset")) || !/Two live strategies on one asset/.test(await p.textContent("#confirmBox"))) fail("same-asset warning inline");
await p.click("#cf_no");
// The bulk Go live carries the same table.
await p.evaluate(() => { showPage("list"); lsel.add("n1"); renderList(); }); await p.waitForTimeout(400);
await p.click('#lp_bulk [data-bulk="live"]'); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
const bulk = await p.$$eval("#confirmBox table.golive tbody tr", (r) => r.map((x) => x.textContent.replace(/\s+/g, " ")));
if (bulk.length !== 1 || !/Nifty/.test(bulk[0]) || !/squared off daily at 23:15/.test(bulk[0])) fail("bulk summary", bulk);
await p.click("#cf_no");
if (errs.length) fail("page errors", errs);
console.log("ok go-live dialog", theme, width);
await b.close();
