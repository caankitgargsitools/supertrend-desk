// Go-live confirmation (6 Nov 2026): a summary table (asset · lots · margin · stop · expiry / roll), the charges note, the same-asset
// warning inline, and "LIVE" typed for the first go-live of an account.
import { openApp, fail, strategies } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
// No strategy of this account is or has been live: the first go-live.
const list = strategies.map((s) => ({ ...s, live: false, live_since: null, risk: s.id === "g2" ? { sl: { type: "PCT", value: 1 } } : s.risk }));
// 13 Nov 2026 (Papa, migration 101): going live never takes the strategy out of Paper — a separate live copy is made.
let liveAns = { live: false, copy: "g2-live", copy_mode: "LIVE" }; const liveCalls = [];
const { b, p, errs } = await openApp({ theme, width, strategies: list, res: { "rpc/set_live": (req) => { liveCalls.push(JSON.parse(req.postData())); return liveAns; } } });
await p.evaluate(() => openStrat("g2")); await p.waitForTimeout(900);
await p.click("#b_live"); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
const txt = (await p.textContent("#confirmBox")).replace(/\s+/g, " ");
if (!/Send real orders to Dhan\?/.test(txt)) fail("title", txt.slice(0, 200));
const cells = await p.$$eval("#confirmBox table.golive tbody tr", (r) => r.map((x) => [...x.children].map((c) => c.textContent.replace(/\s+/g, " ").trim())));
if (cells.length !== 1) fail("one summary row", cells);
const [asset, lots, margin, stop, exp] = cells[0];
if (!/GOLD · Daily/.test(asset) || lots !== "1 lot" || !/≈ ₹1,30,000/.test(margin) || !/1%/.test(stop) || !/rolls the day before expiry/.test(exp)) fail("summary cells", cells[0]);
if (!/charges apply to every order/.test(txt)) fail("charges note");
if (!/The paper strategy stays in Paper and keeps running; a separate live copy is made/.test(txt)) fail("dialog says the paper one stays", txt.slice(0, 500));
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
// A strategy with a stop has no "no stop-loss" box; one without needs the tick (Papa, 7 Nov 2026).
await p.click("#b_live"); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
if (await p.$("#cf_nostop")) fail("no stop warning for a strategy with a stop");
await p.click("#cf_no");
await p.evaluate(() => { const g2 = stratOf("g2"); g2.risk = { sl: null, tgt: null, trail: null }; });
await p.click("#b_live"); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
if (!(await p.$("#cf_nostop")) || !/No stop-loss/.test(await p.textContent("#confirmBox"))) fail("no-stop warning shown");
if (!(await p.$eval("#cf_yes", (b) => b.disabled))) fail("Go live disabled until the no-stop tick");
await p.check("#cf_nostop"); if (await p.$eval("#cf_yes", (b) => b.disabled)) fail("enabled after the tick");
// Confirmed: a live copy was made, and the strategy on screen is still the paper one.
await p.click("#cf_yes"); await p.waitForTimeout(1200);
if (liveCalls.length !== 1 || liveCalls[0].p_strategy !== "g2" || liveCalls[0].p_live !== true) fail("set_live call", liveCalls);
let toastTxt = await p.textContent("#toast");
if (!/A separate live copy was made/.test(toastTxt) || !/The paper one stays in Paper and keeps running/.test(toastTxt)) fail("toast after going live", toastTxt);
if (await p.evaluate(() => stratOf("g2").live)) fail("the paper strategy is still paper");
// It already has a live copy: nothing new is made, and the toast says so.
liveAns = { live: false, copy: "g2-live", copy_mode: "LIVE", existing: true, copy_active: true };
await p.click("#b_live"); await p.waitForSelector("#confirmBox:not([hidden]) .confirm"); if (await p.$("#cf_nostop")) await p.check("#cf_nostop"); if (await p.$("#cf_live")) await p.fill("#cf_live", "LIVE"); await p.click("#cf_yes"); await p.waitForTimeout(1200);
toastTxt = await p.textContent("#toast");
if (!/already runs live as a separate copy/.test(toastTxt)) fail("toast when a live copy exists", toastTxt);
// Switch to paper on a live strategy that has a paper copy: it is paused in Live, nothing is added to Paper.
liveAns = { live: true, paused: true, copy: "g1-paper", copy_mode: "PAPER", existing: true, holding: true };
await p.evaluate(() => { stratOf("g1").live = true; openStrat("g1"); }); await p.waitForTimeout(700);
await p.click("#b_live"); await p.waitForTimeout(1200);
toastTxt = await p.textContent("#toast");
if (!/Paused in Live: no new live orders/.test(toastTxt) || !/keeps its stops and exits/.test(toastTxt) || !/paper copy keeps running/.test(toastTxt)) fail("toast after switching to paper", toastTxt);
await p.evaluate(() => openStrat("g2")); await p.waitForTimeout(500);
// The bulk Go live carries the same table.
await p.evaluate(() => { showPage("list"); lsel.add("n1"); renderList(); }); await p.waitForTimeout(400);
await p.click('#lp_bulk [data-bulk="live"]'); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
const bulk = await p.$$eval("#confirmBox table.golive tbody tr", (r) => r.map((x) => x.textContent.replace(/\s+/g, " ")));
if (bulk.length !== 1 || !/NIFTY/.test(bulk[0]) || !/squared off daily at 23:15/.test(bulk[0])) fail("bulk summary", bulk);
await p.click("#cf_no");
if (errs.length) fail("page errors", errs);
console.log("ok go-live dialog", theme, width);
await b.close();
