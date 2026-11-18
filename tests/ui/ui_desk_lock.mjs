// Desk › Positions: under each position's running P&L, what its stop locks in now — or what it still loses at the stop —
// and nothing when the position has no stop-loss (18 Nov 2026, Papa). Args: theme width.
import { openApp, fail, S } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1920);
const at = new Date().toISOString();
// Gold long 2 lots × 100: entry 1,38,100, stop moved up to 1,38,600 → locks in +₹1,00,000.
const gold = S("g1", "GOLD", "MCX_COMM", 1440, 901, { live: true, active: true, position: "LONG", pos_lots: 2, pos_qty: 2, pos_entry_px: 138100, pos_ltp: 139000, pos_upnl: 180000, pos_ltp_at: at,
  pos_entry_date: "2026-11-16", pos_risk: { dir: 1, stop: 138600, tgt: null, best: 139000 } });
// Crude short 1 lot × 100: entry 6,000, stop 6,100 above it → still −₹10,000 at the stop.
const crude = S("c1", "CRUDEOIL", "MCX_COMM", 5, 921, { live: true, active: true, position: "SHORT", pos_lots: 1, pos_qty: 1, pos_entry_px: 6000, pos_ltp: 5980, pos_upnl: 2000, pos_ltp_at: at,
  pos_entry_date: "2026-11-17", pos_risk: { dir: -1, stop: 6100, tgt: null, best: 5980 } });
// Nifty long, no stop at all → nothing under its P&L.
const nifty = S("n1", "NIFTY", "IDX_I", 15, 911, { exchange: "NSE", lot_size: 65, data_instrument: "INDEX", live: true, active: true, position: "LONG", pos_lots: 1, pos_qty: 1,
  pos_entry_px: 26000, pos_ltp: 26050, pos_upnl: 3250, pos_ltp_at: at, pos_entry_date: "2026-11-17", pos_risk: { dir: 1, stop: null, tgt: null, best: 26050 } });
const { b, p, errs } = await openApp({ theme, width, strategies: [gold, crude, nifty], localStorage: { dkHeat: "pos" }, res: { live_marks: [] } });
await p.evaluate(() => showPage("desk")); await p.waitForTimeout(1800);
const cards = await p.$$eval("#dk_pos .dk-pc", (x) => x.map((c) => ({ id: c.dataset.dk, lock: (c.querySelector("[data-lock]") || {}).textContent || "", cls: ((c.querySelector("[data-lock] span") || {}).className) || "" })));
const card = (id) => cards.find((c) => c.id === id) || fail("card " + id, cards);
if (card("g1").lock !== "Locked +₹1,00,000" || !/pos-num/.test(card("g1").cls)) fail("gold: locked in by the stop", card("g1"));
if (card("c1").lock !== "At stop −₹10,000" || !/neg-num/.test(card("c1").cls)) fail("crude: still a loss at the stop", card("c1"));
if (card("n1").lock !== "") fail("nifty: no stop, blank", card("n1"));
// A live price moves Gold's trailing figures: the line follows (a new stop from the engine's next row).
await p.evaluate(() => { const s = state.strategies.find((x) => x.id === "g1"); s.pos_risk = { ...s.pos_risk, stop: 138800 }; paintMarks(); });
await p.waitForTimeout(200);
const g2 = await p.textContent('#dk_pos [data-lock="g1"]');
if (g2 !== "Locked +₹1,40,000") fail("follows the stop", g2);
await p.screenshot({ path: `desk_lock_${theme}_${width}.png` });
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok desk locked line", theme, width);
await b.close();
