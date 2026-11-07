// Orders tab (6 Nov 2026): the broker's answer in plain words ("Dhan accepted", "Dhan rejected: insufficient margin (DH-905)") with the raw
// text behind ▸, the status chips, the tiles, and the filters behind "Filters ▸".
import { openApp, fail, now } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440), phone = width <= 760;
const sig = (id, sid, mode, event, status, response, close, extra = {}) => ({ id, strategy_id: sid, created_at: new Date(Date.now() - id * 60000).toISOString(), event, mode, status, close, response, fills: null,
  payload: { order_legs: [{ transactionType: event === "EXIT" ? "S" : "B", quantity: 100, symbol: "GOLD25NOVFUT" }] }, ...extra });
const { b, p, errs } = await openApp({ theme, width, res: {
  "algo_signals": [
    sig(1, "g1", "LIVE", "ENTRY", "SENT", '{"status":"success"}', 138100),
    sig(2, "g1", "LIVE", "EXIT", "FAILED", '{"status":"error","message":"DH-905 RMS: insufficient margin available for this order"}', 138400),
    sig(3, "g2", "PAPER", "ENTRY", "LOGGED", null, 138200),
  ],
  "live_orders": [{ id: 11, signal_id: 1, strategy_id: "g1", seq: 1, purpose: "entry", side: "BUY", qty: 100, label: "GOLD25NOVFUT", state: "filled", limit_px: 138100, trigger_px: null, steps: 1, avg_px: 138110, filled_qty: 100, broker_order_id: "112233", note: null, created_at: now, done_at: now, broker: "DHAN" }],
} });
await p.evaluate(() => { showPage("list"); setLpTab("orders"); }); await p.waitForTimeout(1200);
const list = (await p.textContent("#of_list")).replace(/\s+/g, " ");
if (!/Dhan accepted/.test(list)) fail("accepted in plain words", list.slice(0, 400));
if (!/Dhan rejected: insufficient margin \(DH-905\)/.test(list)) fail("rejected in plain words with the code", list.slice(0, 600));
// The raw answer stays, behind ▸ (closed by default).
const raw = await p.$$eval("#of_list details.raw", (d) => d.map((x) => [x.open, x.querySelector("code").textContent]));
if (raw.length < 2 || raw.some((r) => r[0]) || !raw.some((r) => /DH-905 RMS/.test(r[1]))) fail("raw text behind the toggle", raw);
// No raw JSON in the visible text.
const vis = await p.evaluate(() => [...document.querySelectorAll("#of_list .hint.broker")].map((e) => e.firstChild.textContent));
if (vis.some((t) => /[{}"]/.test(t))) fail("no raw JSON in the plain line", vis);
// Status chips and tiles.
const chips = await p.$$eval("#of_list .chip", (c) => c.map((x) => x.textContent));
for (const want of ["Filled", "Problem", "Paper (not sent)"]) if (!chips.includes(want)) fail(`chip ${want}`, chips);
const tiles = (await p.textContent("#of_stats")).replace(/\s+/g, " ");
if (!/Orders\s*3/.test(tiles) || !/Problems\s*1/.test(tiles)) fail("tiles", tiles);
// Filters are folded on every screen; the toggle shows the count of filters in use.
if (await p.$eval("#of_box", (e) => e.classList.contains("open"))) fail("filters folded by default");
if (!/^Filters ▸$/.test((await p.textContent("#of_toggle")).trim())) fail("toggle label", await p.textContent("#of_toggle"));
await p.click("#of_toggle"); await p.waitForTimeout(150);
if (!(await p.$eval("#of_box", (e) => e.classList.contains("open")))) fail("filters open on click");
await p.selectOption("#of_status", "PROBLEM"); await p.waitForTimeout(200);
if (!/Filters \(1\) ▴/.test(await p.textContent("#of_toggle"))) fail("toggle count", await p.textContent("#of_toggle"));
const after = await p.$$eval("#of_list .chip", (c) => c.map((x) => x.textContent)); // the table and the cards both carry the chips
if (!after.includes("Problem") || after.includes("Filled") || after.includes("Paper (not sent)")) fail("status filter", after);
if (errs.length) fail("page errors", errs);
console.log("ok orders tab", theme, width);
await b.close();
