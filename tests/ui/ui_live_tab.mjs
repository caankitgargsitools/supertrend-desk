// Live performance tab (6 Nov 2026): figures from the one trade store, columns with no figure hidden, 8 at most by default with
// "Show every column", one hint when no strategy has a capital.
import { openApp, fail, S, strategies } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const list = strategies.map((s) => s.id === "n1" ? { ...s, live: true, live_since: "2026-10-20T04:00:00Z" } : s);
const { b, p, errs } = await openApp({ theme, width, strategies: list });
await p.evaluate(() => { showPage("list"); setLpTab("live"); }); await p.waitForTimeout(1000);
const heads = () => p.$$eval("#lv_head th", (x) => x.map((t) => t.textContent));
let h = await heads();
if (h.length > 8) fail("at most 8 columns by default", h);
for (const want of ["Strategy", "Asset", "Live since", "Booked P&L", "Running P&L", "Trades", "Win %", "Max drawdown"]) if (!h.includes(want)) fail(`column ${want}`, h);
if (h.includes("Profit factor") || h.includes("CAGR")) fail("later columns hidden by default", h);
const rows = await p.$$eval("#lv_body tr.lvrow", (r) => r.map((x) => x.textContent.replace(/\s+/g, " ")));
if (rows.length !== 2) fail("two live rows", rows);
// Gold: two live trades (+12,000 −3,000) → Booked ₹9,000, 2 trades, 50%; running +₹4,250 from the open position.
if (!rows.some((t) => /Gold/.test(t) && /₹9,000/.test(t) && /50%/.test(t) && /\+₹4,250/.test(t))) fail("gold figures", rows);
const foot = (await p.textContent("#lv_foot")).replace(/\s+/g, " ");
if (!/Total \(2 live\)/.test(foot) || !/₹9,000/.test(foot)) fail("totals", foot);
// "Show every column (N more)" reveals the rest; Capital / Return need a capital (Gold has one).
const more = await p.textContent("#lv_more");
if (!/Show every column \(\d+ more\)/.test(more)) fail("more-columns button", more);
await p.click("#lv_more"); await p.waitForTimeout(300);
h = await heads();
if (!h.includes("Capital") || !h.includes("Return") || !h.includes("CAGR") || !h.includes("Profit factor")) fail("every column", h);
if (/Set a capital/.test(await p.textContent("#lv_top"))) fail("no capital hint while one strategy has a capital");
await p.click("#lv_more"); await p.waitForTimeout(200); if ((await heads()).length > 8) fail("back to 8");
// Without any capital figure: Return / CAGR / Capital columns go and the one hint says why.
await p.evaluate(() => { for (const s of state.strategies) { s.capital = null; s.sizing = null; } todayMarg = {}; return renderLive(); }); await p.waitForTimeout(300);
h = await heads();
if (h.includes("Return") || h.includes("Capital")) fail("return / capital hidden without a capital", h);
if (!/Set a capital per strategy to see Return \/ CAGR/.test(await p.textContent("#lv_top"))) fail("capital hint", await p.textContent("#lv_top"));
// Clicking a row opens its trades.
await p.click("#lv_body tr.lvrow:first-child"); await p.waitForTimeout(300);
if (!(await p.$("#lv_body tr.lvdet"))) fail("detail row");
if (errs.length) fail("page errors", errs);
console.log("ok live tab", theme, width);
await b.close();
