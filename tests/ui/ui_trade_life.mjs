// Trade life (14 Nov 2026, Papa: a full page for one open position — what changed over its life, the trailing stop's moves,
// lots added, every signal / order, in plain words) and the ladder's ₹ figures (lots × lot size, not lots). Args: theme width.
import { openApp, fail, strategies } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const day = 86400, t0 = Date.parse("2026-11-04T18:31:05Z"), d0 = Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000);
const closes = [2500, 2470, 2450, 2433, 2380, 2300, 2250, 2200, 2150, 2100, 2000, 1960, 1890, 1904];
const bars = closes.map((c, i) => ({ t: d0 + i * day, o: c + 15, h: c + 40, l: c - 30, c }));
const risk = { dir: -1, tgt: null, best: 1875.55, stop: null, basis: "UNDERLYING", entry: 2433.85, trail: { type: "ATR", value: 2 }, trailAtr: 93.2416, scanFrom: 0 };
const eth = { ...strategies[0], id: "eth1", name: "Lab #297273 · Futures · ETHUSD daily · HA strength", underlying: "ETHUSD", data_segment: "DELTA", timeframe_min: 1440,
  strategy_kind: "RULES", rules: { daily: true, buy: [] }, live: false, active: true, position: "SHORT", lots: 596, pos_lots: 596, pos_qty: 596, lot_size: "176",
  pos_entry_px: "2139.4549", pos_ltp: "1903", pos_upnl: "24803173", pos_margin: "22442025", pos_risk: risk, pos_entry_date: "2026-11-05", lab_id: 297273, trade_type: "FUTURES" };
const life = { start: new Date(t0).toISOString(), strategy: eth, bars,
  signals: [{ id: 207, created_at: new Date(t0).toISOString(), event: "ENTRY", status: "LOGGED", close: 2433.85, lag_ms: 5221, description: "Sell rules met on yesterday's daily candle (HA strength weekly is red): Sell ETHUSD x 227 | Levels: stop –, target –, trailing" },
    { id: 315, created_at: "2026-11-13T12:28:00Z", event: "INFO", status: "LOGGED", close: 1958.35, description: "Manual order (Orders › Failed orders): 369 lots added at 1958.35; the position is now 596 lots. Stops and targets keep their levels." }],
  log: [{ id: 1, at: new Date().toISOString(), kind: "stop", price: 1903, old_v: 2065.1, new_v: 2062.03, info: { best: 1875.55 } }], orders: [], trades: [] };
const list = [...strategies, eth];
const { b, p, errs } = await openApp({ theme, width, strategies: list, res: { "rpc/position_life": () => life } });
// The ladder on the strategy page: ₹ figures use lots × lot size (596 × 176), and plain words.
await p.evaluate(() => openStrat("eth1")); await p.waitForTimeout(900);
const lad = (await p.textContent("#st_pos_meter")).replace(/\s+/g, " ");
if (!/if hit: you keep ₹81,2\d,\d\d\d/.test(lad)) fail("stop keeps ≈ ₹81 lakh (77.42 × 596 × 176)", lad);
if (/locks in/.test(lad) || !/gives back/.test(lad) || !/now \+₹2,4\d,\d\d,\d\d\d/.test(lad)) fail("ladder wording / profit now", lad);
// Trade life from the strategy page.
await p.click("#st_tl"); await p.waitForSelector("#tl_over:not([hidden]) .tl-tiles", { timeout: 6000 }).catch(() => fail("trade life didn't open"));
const t = (await p.textContent("#tl_page")).replace(/\s+/g, " ");
if (!/Short 596 lots · Paper/.test(t) || !/Opened 05 Nov, 00:01/.test(t)) fail("title", t.slice(0, 300));
if (!/Running P&L now\+₹2,48,03,173/.test(t) || !/596 lots × 176 per point/.test(t)) fail("running P&L tile", t.slice(0, 600));
if (!/Stop hit now: you keep₹81,2/.test(t) || !/Would give back₹1,6\d,\d\d,\d\d\d/.test(t)) fail("stop tiles", t.slice(0, 800));
if (!/Trailing stop\. The stop sits 2 × ATR = 186\.48 points/.test(t) || !/stop is at 2,062\.03/.test(t)) fail("explanation", t.slice(0, 1600));
if (!/Lots held227 lots596 lots\+369 by hand/.test(t) || !/Average entry2,433\.852,139\.45/.test(t) || !/Stop2,620\.332,062\.03moved 558\.3 points/.test(t)) fail("what changed", t.slice(t.indexOf("What changed"), t.indexOf("What changed") + 700));
if (!/Short 227 lots at 2,433\.85/.test(t) || !/Stop set at 2,620\.33/.test(t) || !/Stop moved .* → /.test(t) || !/369 lots added at 1958\.35/.test(t) || !/recorded/.test(t) || !/from candles/.test(t)) fail("events", t.slice(t.indexOf("Everything"), t.indexOf("Everything") + 1500));
if (!(await p.$("#tl_page svg path"))) fail("stop path drawn");
await p.screenshot({ path: `tradelife_${theme}_${width}.png`, fullPage: false });
const sw = await p.evaluate(() => document.getElementById("tl_over").scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
await p.keyboard.press("Escape"); await p.waitForTimeout(200);
if (!(await p.$eval("#tl_over", (x) => x.hidden))) fail("Esc closes");
if (errs.length) fail("page errors", errs);
console.log("ok trade life", theme, width);
await b.close();
