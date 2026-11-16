// A live entry that isn't filling (16 Nov 2026, Papa: "It should not cancel the order. It should wait and ask me … show a
// notification, create a sound … options, change price further or cancel the entry"): the app shows a full-screen card with
// the two choices (and "Decide later"), a banner on every page until the order is answered or filled, and sends the
// owner's choice through order_decide. Args: theme width.
import { openApp, fail } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const row = (x = {}) => ({ id: 4, strategy_id: "s-ag", name: "Lab #294435 (live) · Futures · SILVERMIC daily", underlying: "SILVERMIC", side: "SELL", label: "SILVERMIC NOV FUT", lots: 2, qty: 2,
  limit_px: 172700, steps: 4, asks: 1, ask_at: "2026-11-16T03:32:00Z", ask_px: 172576, ask_why: null, decision: null, placed_at: "2026-11-16T03:31:20Z", tick: 1, now_px: 172560, ...x });
let rows = [row()];
const { b, p, writes, errs } = await openApp({ theme, width, res: {
  "rpc/orders_asking": () => rows,
  "rpc/order_decide": (req) => { const a = JSON.parse(req.postData() || "{}"); rows = rows.map((o) => o.id === a.p_order ? { ...o, decision: a.p_action } : o); return { ok: true, action: a.p_action }; },
} });
const text = (sel) => p.textContent(sel);
await p.evaluate(() => askPoll(true)); await p.waitForTimeout(300);
// 1. The card: what is waiting, where the price is, the two choices; nothing is done until one is pressed.
if (await p.isHidden("#lt_over")) fail("the card is shown");
if (!/\bask\b/.test(await p.getAttribute("#lt_card", "class"))) fail("card look", await p.getAttribute("#lt_card", "class"));
const card = await text("#lt_card");
for (const x of ["needs your decision", "Sell 2 lots SILVERMIC: not filled", "moved the price 4 times", "SILVERMIC NOV FUT", "₹1,72,700", "₹1,72,560", "₹140", "can still fill by itself",
  "Change the price to the market (₹1,72,560)", "Cancel the entry", "Decide later"]) if (!card.includes(x)) fail("card text: " + x, card);
if (writes.some((w) => /order_decide/.test(w.u))) fail("nothing is sent before a choice");
if (await p.evaluate(() => { try { ltSound("ask"); return false; } catch { return true; } })) fail("the sound plays without an error");
await p.screenshot({ path: `ask_card_${theme}_${width}.png` });
// 2. The banner on the page behind it, with the same two choices.
const ban = await text("#askAlert");
if (await p.isHidden("#askAlert") || !/Not filled: Sell 2 lots SILVERMIC/.test(ban) || !/waiting at ₹1,72,700 · price now ₹1,72,560/.test(ban) || (await p.$$("#askAlert [data-askdo]")).length !== 2) fail("banner", ban);
// 3. "Decide later" closes the card; the banner stays; the same question isn't shown again, a reminder (asked again) is.
await p.click("#ask_later");
if (!(await p.isHidden("#lt_over")) || (await p.isHidden("#askAlert"))) fail("decide later: card closed, banner stays");
await p.evaluate(() => askPoll(true)); await p.waitForTimeout(200);
if (!(await p.isHidden("#lt_over"))) fail("the same question isn't shown twice");
rows = [row({ asks: 2, ask_at: "2026-11-16T03:37:00Z", now_px: 172480 })];
await p.evaluate(() => askPoll(true)); await p.waitForTimeout(200);
if (await p.isHidden("#lt_over") || !/₹1,72,480/.test(await text("#lt_card"))) fail("a reminder shows the card again with the price now");
// the price on an open card follows the market
rows = [row({ asks: 2, ask_at: "2026-11-16T03:37:00Z", now_px: 172455 })];
await p.evaluate(() => askPoll(true)); await p.waitForTimeout(200);
if (!/₹1,72,455/.test(await text("[data-asknow]")) || !/₹245/.test(await text("[data-askgap]")) || !/\(₹1,72,455\)/.test(await text("#ask_chase"))) fail("open card follows the price", await text("#lt_card"));
// 4. "Change the price": the choice goes to the server for this order; the card closes; the banner says it is being done.
await p.click("#ask_chase"); await p.waitForTimeout(500);
let sent = writes.filter((w) => /rpc\/order_decide/.test(w.u)).map((w) => JSON.parse(w.body));
if (sent.length !== 1 || sent[0].p_order !== 4 || sent[0].p_action !== "chase") fail("change the price sent", sent);
if (!(await p.isHidden("#lt_over"))) fail("card closes after the choice");
if (!/Changing the price to the market/.test(await text("#askAlert")) || (await p.$$("#askAlert [data-askdo]")).length) fail("banner while the choice is carried out", await text("#askAlert"));
// the desk changed the price and is working the order again → nothing waits, the banner goes
rows = []; await p.evaluate(() => askPoll(true)); await p.waitForTimeout(200);
if (!(await p.isHidden("#askAlert"))) fail("banner goes when nothing waits");
// 5. Asked again later (still not filled): the notification from the phone push opens the card; cancel from the banner.
rows = [row({ id: 7, limit_px: 172455, steps: 4, asks: 1, ask_at: "2026-11-16T03:41:00Z", now_px: 172300, ask_why: "Missing required fields, bad values for parameters etc." })];
await p.evaluate(() => { lt.init = true; ltShow({ id: 77, title: "❓ LIVE SELL · SILVERMIC · not filled: what should the desk do?", body: "x", url: "/?s=s-ag", meta: { live: true, stage: "ask", order: 7, at: "a1" } }); });
await p.waitForTimeout(400);
if (await p.isHidden("#lt_over") || !/The broker refused the desk's price change \(Missing required fields/.test(await text("#lt_card"))) fail("push opens the card, with the broker's reason", await text("#lt_card"));
await p.keyboard.press("Escape"); if (!(await p.isHidden("#lt_over"))) fail("Escape = decide later");
await p.click('#askAlert [data-askdo="cancel"]'); await p.waitForTimeout(500);
sent = writes.filter((w) => /rpc\/order_decide/.test(w.u)).map((w) => JSON.parse(w.body));
if (sent.length !== 2 || sent[1].p_order !== 7 || sent[1].p_action !== "cancel") fail("cancel sent from the banner", sent);
if (!/Cancelling the entry/.test(await text("#askAlert"))) fail("banner: cancelling", await text("#askAlert"));
// 6. A card for an order that filled meanwhile closes by itself.
rows = [row({ id: 9, ask_at: "2026-11-16T03:50:00Z" })];
await p.evaluate(() => askPoll(true)); await p.waitForTimeout(200);
if (await p.isHidden("#lt_over")) fail("card for order 9");
rows = []; await p.evaluate(() => askPoll(true)); await p.waitForTimeout(200);
if (!(await p.isHidden("#lt_over")) || !(await p.isHidden("#askAlert"))) fail("filled meanwhile: card and banner go");
// A live-trade card after it still works (the two share the overlay).
await p.evaluate(() => ltShow({ id: 901, title: "🔻 LIVE SELL · SILVERMIC · 2 lots @ ₹1,72,455", body: "Filled.", url: "/?s=s-ag", meta: { live: true, stage: "filled", side: "SELL", asset: "SILVERMIC", fill: 172455, now: 172400, units: 2, at: "f1" } }));
if (await p.isHidden("#lt_over") || !/Got it/.test(await text("#lt_card"))) fail("trade card after the question");
await p.click("#lt_ok");
// The sample under Connections › Phone notifications: the same card, marked TEST; its buttons send nothing.
await p.click("#openSettings"); await p.waitForSelector("#ask_test", { timeout: 8000 }).catch(() => fail("no sample button on Connections"));
const n0 = writes.filter((w) => /order_decide/.test(w.u)).length;
await p.click("#ask_test");
if (await p.isHidden("#lt_over") || !/TEST/.test(await text("#lt_card")) || !/Buy 2 lots GOLDM: not filled/.test(await text("#lt_card"))) fail("sample card", await text("#lt_card"));
await p.evaluate(() => askPoll(true)); await p.waitForTimeout(200);
if (await p.isHidden("#lt_over")) fail("the sample stays open while the app polls");
await p.click("#ask_chase"); await p.waitForTimeout(200);
if (writes.filter((w) => /order_decide/.test(w.u)).length !== n0 || !(await p.isHidden("#lt_over")) || !/Sample only/.test(await text("#toast"))) fail("the sample sends nothing", await text("#toast"));
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok order ask", theme, width);
await b.close();
