// Trade story expander on the Trades tab and a strategy's Trades tab, the Slippage card, and the Wallet's monthly statement (6 Nov 2026).
import { openApp, fail, now } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440), phone = width <= 760;
const story = { trade: { id: 1, strategy_id: "g1", mode: "LIVE", net: 12000 },
  entry: { signal_id: 10, event: "ENTRY", description: "Buy rules met", at: "2026-10-01T04:05:00Z", candle: "2026-10-01T04:05:00Z", lag_ms: 420, status: "SENT", price: 138100, fills: null },
  exit: { signal_id: 11, event: "EXIT", description: "Target 2% reached", at: "2026-10-01T09:30:00Z", candle: null, lag_ms: 310, status: "SENT", price: 138250, fills: null },
  orders: [{ id: 21, purpose: "entry", event: "ENTRY", side: "BUY", qty: 100, label: "GOLD25NOVFUT", state: "filled", limit_px: 138100, avg_px: 138110, filled_qty: 100, steps: 2, market_retry: false, broker_order_id: "112233", placed_at: "2026-10-01T04:05:02Z", done_at: "2026-10-01T04:05:04Z", note: null },
    { id: 22, purpose: "stop", event: null, side: "SELL", qty: 100, label: "GOLD25NOVFUT", state: "cancelled", limit_px: 137000, avg_px: null, filled_qty: 0, steps: 0, market_retry: false, broker_order_id: "112234", placed_at: "2026-10-01T04:05:05Z", done_at: "2026-10-01T09:30:01Z", note: "cancelled before the exit" },
    { id: 23, purpose: "exit", event: "EXIT", side: "SELL", qty: 100, label: "GOLD25NOVFUT", state: "filled", limit_px: 138250, avg_px: 138240, filled_qty: 100, steps: 1, market_retry: true, broker_order_id: "112235", placed_at: "2026-10-01T09:30:02Z", done_at: "2026-10-01T09:30:06Z", note: null }],
  slippage: { entry_pts: 10, exit_pts: 10, total_pts: 20, rupees: 2000 } };
const paperStory = { trade: { id: 3, strategy_id: "g2", mode: "PAPER", net: 5000 }, entry: null, exit: null, orders: [], slippage: {} };
const statement = { month: "2026-10-01", from: "2026-10-01", to: "2026-10-31", by_mode: { LIVE: { trades: 2, wins: 1, gross: 9120, costs: 120, net: 9000, best: 12000, worst: -3000 }, PAPER: { trades: 1, wins: 1, gross: 5060, costs: 60, net: 5000, best: 5000, worst: 5000 } },
  by_strategy: [{ strategy_id: "g1", name: "Lab #901 · Futures · GOLD daily · rule g1", mode: "LIVE", trades: 2, wins: 1, gross: 9120, costs: 120, net: 9000 }, { strategy_id: "g2", name: "Lab #902", mode: "PAPER", trades: 1, wins: 1, gross: 5060, costs: 60, net: 5000 }],
  by_asset: [{ asset: "GOLD", trades: 3, wins: 2, gross: 14180, costs: 180, net: 14000 }], live_net_to_month_end: 9000, live_high_water_mark: 12000, shukrana_accepted_in_month: 1000, shukrana_rate_pct: 20, shukrana_now: -1400, strategies: { live: 1, paper: 2 } };
const { b, p, errs } = await openApp({ theme, width, res: {
  "rpc/trade_story": (req) => (JSON.parse(req.postData() || "{}").p_trade === 1 ? story : paperStory),
  "rpc/slippage_summary": { strategies: [{ strategy_id: "g1", name: "Lab #901 · Futures · GOLD daily · rule g1", legs: 4, avg_pts: 5, worst_pts: 12, rupees: 2000, last: now }] },
  "rpc/client_statement": statement,
} });
// Trades tab: Story ▸ on a closed trade opens its timeline under the row (card on a phone).
await p.evaluate(() => { showPage("list"); setLpTab("trades"); }); await p.waitForTimeout(1200);
const scope = phone ? "#tf_list .tmob" : "#tf_list .tdesk";
await p.click(`${scope} [data-story="1"]`); await p.waitForTimeout(600);
const st = (await p.textContent(`${scope} .storybox`)).replace(/\s+/g, " ");
for (const want of [/Entry signal · 01 Oct, 09:35 · decided 420 ms after the candle · at 1,38,100/, /Buy order 100 GOLD25NOVFUT · filled 1,38,110 × 100/, /moved|#112233/, /Stop order 100 GOLD25NOVFUT · trigger 1,37,000/, /Exit signal/, /Sell order 100 GOLD25NOVFUT · filled 1,38,240 × 100 · went to market/, /Slippage ₹2,000 \(20 pts: entry 10, exit 10\)/]) if (!want.test(st)) fail(`story line ${want}`, st.slice(0, 500));
if (!/Story ▾/.test(await p.textContent(`${scope} [data-story="1"]`))) fail("button shows open");
await p.click(`${scope} [data-story="1"]`); await p.waitForTimeout(200);
if (await p.$(`${scope} .storybox`)) fail("story closes again");
// A paper trade: no orders, says so.
await p.click(`${scope} [data-story="3"]`); await p.waitForTimeout(500);
if (!/Paper trade · priced by the desk at the signal's close/.test(await p.textContent(`${scope} .storybox`))) fail("paper story", await p.textContent(`${scope} .storybox`));
// The slippage card (live only).
if (await p.isHidden("#tf_slip")) fail("slippage card shown");
const slip = (await p.textContent("#tf_slip")).replace(/\s+/g, " ");
if (!/Slippage · live fills/.test(slip) || !/₹2,000 over 4 legs/.test(slip) || !/Lab #901/.test(slip)) fail("slippage card", slip.slice(0, 300));
// The strategy's own Trades tab has the button too.
await p.evaluate(() => { openStrat("g1"); showTab("tr"); }); await p.waitForTimeout(900);
await p.evaluate(() => { trMode = "LIVE"; return loadStratTrades(); }); await p.waitForTimeout(500);
if (!(await p.$('#tr_list [data-story="1"]'))) fail("story button on the strategy's trades tab");
// Wallet: the monthly statement.
await p.evaluate(() => showPage("wallet")); await p.waitForTimeout(900);
await p.fill("#ws_month", "2026-10"); await p.click("#ws_show"); await p.waitForTimeout(700);
if (await p.isHidden("#wl_statement")) fail("statement shown");
const sm = (await p.textContent("#wl_statement")).replace(/\s+/g, " ");
// Table cells run together in textContent, so the figures are matched with optional spaces between them.
for (const want of [/01 Oct 26 – 31 Oct 26/, /Live\s*2\s*50%\s*₹9,120\s*₹120\s*₹9,000\s*₹12,000\s*−₹3,000/, /Paper\s*1\s*100%\s*₹5,060\s*₹60\s*₹5,000/, /Live Booked P&L to the month's end ₹9,000/, /high-water mark\) ₹12,000/, /1 live, 2 paper/, /rate 20% of new live profit · accepted in this month ₹1,000 · standing now −₹1,400 \(owed\)/, /By strategy/, /By asset/, /Gold/]) if (!want.test(sm)) fail(`statement ${want}`, sm.slice(0, 900));
if (!(await p.$("#ws_print")) || !(await p.$("#ws_csv"))) fail("print / csv buttons");
const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 5000 }), p.click("#ws_csv")]);
if (!/statement-2026-10\.csv/.test(dl.suggestedFilename())) fail("csv name", dl.suggestedFilename());
await p.click("#ws_close"); if (!(await p.isHidden("#wl_statement"))) fail("statement closes");
if (errs.length) fail("page errors", errs);
console.log("ok trade story, slippage, statement", theme, width);
await b.close();
