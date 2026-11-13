// Orders › Failed orders (13 Nov 2026, Papa): every order that didn't go through, live and paper, strategy-wise, with the
// signal's price, the price now, "Send again" (side + lots) / "Exit now", and the status after. Args: theme width.
import { openApp, fail } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const now = new Date().toISOString();
const row = (o) => ({ strategy_id: "g2", name: "Lab #902 · Futures · GOLD daily · rule g2", underlying: "GOLD", now_live: true, active: true, now_position: "FLAT", now_lots: null, lots: 1,
  now_at: now, trade_type: "FUTURES", data_segment: "MCX_COMM", exec_state: null, mode: "LIVE", at: now, kind: "refused", manual: null, manual_order_row: null, ...o });
const rows = [
  // 13 Nov 2026: a position holding fewer lots than planned (80 of 100) is listed with the missing 20 and "Add the missing lots".
  row({ key: "short-g1", sig_id: null, kind: "short", event: "SHORT_FILL", side: "ADD", lots_wanted: 20, now_lots: 80, lots: 100, now_position: "LONG", signal_px: 138100, now_px: 138500,
    reason: "80 of 100 filled; the rest was cancelled", strategy_id: "g1", name: "Lab #901 · Futures · GOLD daily · rule g1" }),
  row({ sig_id: 304, event: "ENTRY", side: "SHORT", lots_wanted: 1, signal_px: 4143.6, now_px: 4133.5, reason: "Dhan didn't accept the order: Invalid IP", name: "Lab #306159 (live) · Futures · LT 75m", strategy_id: "n1" }),
  row({ sig_id: 292, event: "INFO", kind: "skipped", side: "SHORT", lots_wanted: 10, signal_px: 137190, now_px: 136750, reason: "Entry skipped: 10 lots need ₹1,24,15,694 margin but only ₹4,00,000 is left" }),
  row({ sig_id: 310, event: "ENTRY", side: "LONG", lots_wanted: 2, signal_px: 25000, now_px: 25100, reason: "insufficient margin", mode: "PAPER", now_live: false, strategy_id: "c1", name: "Lab #921 · Futures · SOLUSD daily" }),
  row({ sig_id: 311, event: "EXIT", side: "EXIT", signal_px: 80, now_px: 79, reason: "exit refused", strategy_id: "x9", name: "Old exit one", now_position: "LONG", now_lots: 2, manual: { id: 5, side: "EXIT", state: "filled", result: "Closed (paper)", at: now } }),
];
let sent = null;
for (const r of rows) r.key = r.key || `sig-${r.sig_id}`;
const { b, p, errs } = await openApp({ theme, width, res: {
  "rpc/failed_orders": () => rows,
  "rpc/manual_order": (req) => { sent = JSON.parse(req.postData()); const r = sent.p_side === "ADD" ? rows[0] : rows.find((x) => x.sig_id === sent.p_ref); r.manual = { id: 9, side: sent.p_side, lots: sent.p_lots, state: "sent", result: "Sent to the broker: 1 lot", at: now }; return 9; },
} });
await p.evaluate(() => { showPage("list"); setLpTab("orders"); }); await p.waitForTimeout(1500);
const t = await p.textContent("#fo_card");
if (!/Failed and short orders · 4 to look at/.test(t)) fail("header count (sent-again ones hidden)", t.slice(0, 200));
if (!/Holding 80 of 100 lots/.test(t) || !/20 lots missing/.test(t)) fail("short fill row", t.slice(0, 500));
if (!/Invalid IP/.test(t) || !/Entry skipped/.test(t)) fail("reasons shown", t.slice(0, 400));
if (!/Signal\s*4,143\.6/.test(t) || !/Now\s*4,133\.5/.test(t)) fail("signal and current price", t.slice(0, 400));
if ((await p.$$("#fo_card .fo-strat")).length !== 4) fail("one block per strategy");
// Add 15 of the 20 missing lots (live): a real-money confirmation, then manual_order with side ADD.
await p.fill('#fo_card [data-folots="short-g1"]', "15"); await p.click('#fo_card [data-fosend="short-g1"]'); await p.waitForTimeout(300);
if (!/Add 15 lots to the long position/.test(await p.evaluate(() => document.body.innerText))) fail("add confirmation");
await p.click("text=Send live order"); await p.waitForTimeout(1000);
if (!sent || sent.p_side !== "ADD" || sent.p_lots !== 15 || sent.p_strategy !== "g1" || sent.p_ref !== null) fail("manual_order ADD call", sent);
sent = null; rows[0].manual = null;
if (/Old exit one/.test(t)) fail("already done hidden by default");
// Paper only
await p.click('#fo_card [data-fom="PAPER"]'); await p.waitForTimeout(200);
if ((await p.$$("#fo_card .fo-row")).length !== 1) fail("paper filter");
await p.click('#fo_card [data-fom=""]'); await p.waitForTimeout(200);
// Send the LT one again, 1 lot sell, live → confirmation → manual_order
await p.click('#fo_card [data-fosend="sig-304"]'); await p.waitForTimeout(300);
const dlg = await p.evaluate(() => document.body.innerText);
if (!/LIVE: a real order goes to the broker now/.test(dlg)) fail("live confirmation", dlg.slice(-400));
await p.click("text=Send live order"); await p.waitForTimeout(1200);
if (!sent || sent.p_strategy !== "n1" || sent.p_side !== "SHORT" || sent.p_lots !== 1 || sent.p_ref !== 304) fail("manual_order call", sent);
await p.click("#fo_done"); await p.waitForTimeout(300);
const t2 = await p.textContent("#fo_card");
if (!/Sent to broker/.test(t2) || !/Sent to the broker: 1 lot/.test(t2) || !/Old exit one/.test(t2)) fail("status after sending", t2.slice(0, 600));
await p.screenshot({ path: `fo_${theme}_${width}.png`, fullPage: false });
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok failed orders", theme, width);
await b.close();
