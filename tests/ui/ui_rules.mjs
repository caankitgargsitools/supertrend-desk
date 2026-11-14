// Rule builder (research build, 6 Nov 2026): the new indicators (OI, pivots, Fibonacci, gaps, ranges, Keltner, calendar, VIX,
// divergence), choice drop-downs, the Entry fill select on the Buy / Sell sets only, and the admin's market-event days editor.
import { openApp, fail } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const { b, p, errs, writes } = await openApp({ theme, width, res: { "market_events": [{ day: "2026-11-07", name: "RBI policy" }, { day: "2026-12-05", name: "Fed meeting" }],
  "rpc/lab_feed": { run: null, rows: [] }, "rpc/my_lab_requests": [], "rpc/lab_long_map": {}, "rpc/lab_long_results": [], "lab_runs": [], "lab_settings": { id: 1, enabled: true, assets: ["NIFTY"], stop_tune: 5 } } });
await p.evaluate(() => { openStrat("n1"); showTab("set"); }); await p.waitForTimeout(800);
// Every new indicator is on offer in a condition row.
// The indicator select sits under the "Indicator" label (a set's first select is its ALL / ANY mode).
const indSel = () => [...document.querySelectorAll("#rs_long label")].find((l) => /^Indicator/.test(l.textContent)).querySelector("select");
const opts = await p.evaluate(`[...(${indSel})().options].map((o) => o.value)`);
for (const k of ["OI", "PIV", "FIB", "GAP", "RANGE", "KC", "CAL", "VIX", "DIV", "FX", "USDPX"]) if (!opts.includes(k)) fail(`indicator ${k}`, opts);
// Entry fill: on the Buy and Sell sets, not on the exit sets; LEVEL lands in the rule book.
if (!(await p.$("#rs_long .fillsel")) || !(await p.$("#rs_short .fillsel")) || await p.$("#rs_exitLong .fillsel")) fail("Entry fill select placement");
await p.selectOption("#rs_long .fillsel", "LEVEL"); await p.waitForTimeout(100);
if ((await p.evaluate(() => ruleState.long.fill)) !== "LEVEL") fail("LEVEL saved in the rule book");
await p.selectOption("#rs_long .fillsel", "CLOSE"); if ((await p.evaluate(() => "fill" in ruleState.long))) fail("CLOSE drops the key");
// A pivot condition offers its choices as drop-downs.
await p.evaluate(`(() => { const s = (${indSel})(); s.value = "PIV"; s.dispatchEvent(new Event("change")); })()`); await p.waitForTimeout(250);
const labels = await p.$$eval("#rs_long .crow label, #rs_long label", (ls) => ls.map((l) => l.textContent.replace(/\s+/g, " ")));
const pivSel = await p.$$eval("#rs_long select", (sels) => sels.map((s) => [...s.options].map((o) => o.textContent)).filter((o) => o.includes("Previous week") || o.includes("Camarilla (H3/H4, L3/L4)")).length);
if (pivSel !== 2) fail("pivot choice drop-downs", labels);
const ops = await p.$$eval("#rs_long select", (sels) => sels.flatMap((s) => [...s.options].map((o) => o.textContent)));
if (!ops.includes("central pivot range is narrow")) fail("pivot operators", ops.slice(-12));
// The market-event days editor (admin, Lab settings): lists the days and adds one.
await p.evaluate(() => openLab()); await p.waitForTimeout(900);
await p.click("#lab_settings_btn"); await p.waitForTimeout(600);
const rows = await p.$$eval("#ev_rows tr", (r) => r.map((x) => x.textContent.replace(/\s+/g, " ")));
if (rows.length !== 2 || !/07 Nov 26.*RBI policy/.test(rows[0])) fail("event days listed", rows);
await p.fill("#ev_day", "2026-11-28"); await p.fill("#ev_name", "Budget speech"); await p.click("#ev_add"); await p.waitForTimeout(600);
const w = writes.find((x) => /market_events/.test(x.u) && x.meth === "POST");
if (!w || !/Budget speech/.test(w.body) || !/2026-11-28/.test(w.body)) fail("event day written", writes.map((x) => x.u));
if (!/Added 28 Nov 26/.test(await p.textContent("#ev_msg"))) fail("confirmation", await p.textContent("#ev_msg"));
// Stop tuning (14 Nov 2026): a Lab setting — how many passed strategies a run get their stops tuned (0 = off).
if (await p.inputValue("#ls_stop_tune") !== "5") fail("stop tuning shows the saved figure", await p.inputValue("#ls_stop_tune"));
if (!/tighter first stop/.test(await p.getAttribute("label:has(#ls_stop_tune)", "title"))) fail("stop tuning explains itself");
await p.fill("#ls_stop_tune", "8"); await p.evaluate(() => document.getElementById("labSetForm").requestSubmit()); await p.waitForTimeout(700);
const sw = writes.find((x) => /lab_settings/.test(x.u) && x.meth === "PATCH");
if (!sw || JSON.parse(sw.body).stop_tune !== 8) fail("stop tuning saved", writes.map((x) => x.meth + " " + x.u + " " + String(x.body).slice(0, 200)));
if (errs.length) fail("page errors", errs);
console.log("ok rule builder + event days + stop tuning", theme, width);
await b.close();
