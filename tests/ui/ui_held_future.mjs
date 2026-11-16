// Live stock / index futures show the future's own prices (16 Nov 2026, Papa: "L&T still showing as 4139.9" — the share's
// price at the signal; Dhan filled the future at 4154.1): entry = Dhan's fill, now = the future's price, stop moved by the
// gap at the fill; the desk's own share price is named once; paper positions and MCX are unchanged. Args: theme width.
import { openApp, fail, strategies, S } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const lt = S("lt1", "LT", "NSE_EQ", 75, 306159, { exchange: "NSE", lot_size: 175, data_instrument: "EQUITY", futures_symbol: "LT1!", live: true, position: "SHORT", pos_lots: 1, pos_qty: 1,
  pos_entry_px: 4139.9, pos_ltp: 4155, pos_bk_ltp: 4170, pos_upnl: -2782, pos_entry_date: "2026-11-13", pos_ltp_at: new Date().toISOString(), pos_margin: 128168,
  pos_broker: { broker: "DHAN", fill: 4154.1, offset: 14.2, legs: [{ seg: "NSE_FNO", sec: "61633", qty: -175, product: "MARGIN" }], tick: 0.1, step: 0.8, option: false },
  pos_risk: { dir: -1, stop: 4200, tgt: null, basis: "UNDERLYING", best: 4139.9 } });
const paper = S("lp1", "LT", "NSE_EQ", 75, 306160, { exchange: "NSE", lot_size: 175, data_instrument: "EQUITY", live: false, position: "SHORT", pos_lots: 1, pos_qty: 1,
  pos_entry_px: 4139.9, pos_ltp: 4155, pos_upnl: -2642, pos_entry_date: "2026-11-13", pos_ltp_at: new Date().toISOString(), pos_risk: { dir: -1, stop: 4200, best: 4139.9 } });
const { b, p, errs } = await openApp({ theme, width, strategies: [...strategies, lt, paper], res: { "live_marks": [] } });
const fn = await p.evaluate(() => { const lt = state.strategies.find((s) => s.id === "lt1"), pp = state.strategies.find((s) => s.id === "lp1"), g = state.strategies.find((s) => s.id === "g1");
  return { e: dispEntry(lt), n: dispNow(lt), lv: dispLevels(lt), lock: Math.trunc(lockedOf(lt)), pe: dispEntry(pp), pn: dispNow(pp), ge: dispEntry(g), gn: dispNow(g), price: posPriceText(lt) }; });
if (fn.e !== 4154.1 || fn.n !== 4170 || Math.abs(fn.lv.stop - 4214.2) > 1e-6) fail("live LT on the future's prices", fn);
if (fn.pe !== 4139.9 || fn.pn !== 4155 || fn.ge !== 138100 || fn.gn !== 138500) fail("paper and MCX unchanged", fn);
if (fn.lock !== -10517) fail("locked by the stop: (4200 − 4139.9) × 175 lost = −₹10,517", fn);
if (!/in 4,154\.1 · now 4,170/.test(fn.price)) fail("price text", fn.price);
// The strategy page: in / now / SL on the future's prices, the share named once.
await p.evaluate(() => openStrat("lt1")); await p.waitForTimeout(900);
const sub = (await p.textContent("#st_pos_sub")).replace(/\s+/g, " ");
if (!/in 4,154\.1/.test(sub) || !/now 4,170/.test(sub) || !/SL 4,214\.2/.test(sub) || !/signals run on the share \(entry 4,139\.9\)/.test(sub) || /in 4,139\.9/.test(sub)) fail("strategy page", sub);
const lad = (await p.textContent("#st_pos_meter")).replace(/\s+/g, " ");
if (!/Entry ?4,154\.1/.test(lad) || !/Now 4,170/.test(lad) || !/Stop ?4,214\.2/.test(lad)) fail("ladder on the future's prices", lad);
// A live price arrives: the future's price moves the screen; the share's alone doesn't change "now".
await p.evaluate(() => onMark({ strategy_id: "lt1", ltp: 4150, upnl: -1907, at: new Date().toISOString(), bk_ltp: 4165 })); await p.waitForTimeout(400);
const sub2 = (await p.textContent("#st_pos_sub")).replace(/\s+/g, " ");
if (!/now 4,165/.test(sub2) || !/−₹1,907/.test(await p.textContent("#st_pos"))) fail("live future price", [sub2, await p.textContent("#st_pos")]);
// Trades tab: the open row's entry and price.
const tr = await p.evaluate(() => tradesHtml([], { withStrategy: true }, [state.strategies.find((s) => s.id === "lt1")]));
if (!/4,154\.1/.test(tr) || /4,139\.9/.test(tr) || !/4,165/.test(tr)) fail("trades tab open row", tr.slice(0, 600));
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok held future", theme, width);
await b.close();
