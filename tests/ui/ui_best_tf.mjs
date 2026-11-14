// Strategies › "Best passed strategy per asset and timeframe" (14 Nov 2026, Papa: the lab's best passed strategy for every
// asset and timeframe, which of them aren't on paper yet, and a button to put the ticked ones on paper to test them in
// real time). Args: theme width.
import { openApp, fail, strategies } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const at = new Date(Date.now() - 4 * 60000).toISOString();
const row = (o) => ({ cons: 80, n_passed: 3, newest: at, first_seen: at, best_since: at, paper_best: null, live_best: null, paper_n: 0, paper_active_n: 0, live_n: 0, ...o });
const data = { at, rows: [
  row({ asset: "GOLD", tf: "D", lab_id: 306961, label: "GOLD daily · HA strength (momentum) daily is green", cons: 86.2, n_passed: 952, paper_best: { id: "g1", active: true, position: "LONG" }, live_best: { id: "g2", active: true, position: "FLAT" }, paper_n: 127, paper_active_n: 4, live_n: 4 }),
  row({ asset: "MIDCPNIFTY", tf: "30", lab_id: 317915, label: "MIDCPNIFTY 30m · Supertrend(14,2.5) is up & ADX(12) > 13", cons: 94.1, n_passed: 1031, paper_n: 431, paper_active_n: 1, live_n: 1 }),
  row({ asset: "RELIANCE", tf: "60", lab_id: 318984, label: "RELIANCE 60m · Bollinger(20,2.5) crosses above upper band", cons: 81, n_passed: 1 }),
  row({ asset: "SOLUSD", tf: "240", lab_id: 305005, label: "SOLUSD 240m · HA strength (momentum)", cons: 78.3, paper_best: { id: "c1", active: false, position: "FLAT" }, paper_n: 4, paper_active_n: 1 }),
] };
const labRow = (id, asset, tf) => ({ id, label: `${asset} ${tf}m · rule`, basic_passed: true, robust_status: "done", promoted_id: null, metrics: { full: { max_dd: 12000 } },
  config: { strategy_kind: "RULES", underlying: asset, timeframe_min: tf, rules: { buy: [] }, data_segment: "NSE_EQ", data_security_id: "1", lots: 1, lot_size: 50, trade_type: "FUTURES" } });
let made = 0;
const { b, p, errs, writes } = await openApp({ theme, width, res: {
  "rpc/lab_best_tf_list": () => data,
  "lab_results": () => [labRow(317915, "MIDCPNIFTY", 30), labRow(318984, "RELIANCE", 60)],
  "algo_strategies": (req) => req.method() === "POST" ? { __post: { id: `new-${++made}` } } : strategies,
} });
await p.waitForSelector("#lp_besttf .bt-table", { timeout: 8000 }).catch(() => fail("no card"));
const t = (await p.textContent("#lp_besttf")).replace(/\s+/g, " ");
if (!/Best passed strategy per asset and timeframe/.test(t) || !/4 assets and timeframes have a passed strategy/.test(t)) fail("header", t.slice(0, 300));
if (!/The best of 1 is running on paper; 3 are not \(1 new timeframe\)/.test(t)) fail("summary", t.slice(0, 400));
if ((await p.$$("#lp_besttf tbody tr")).length !== 3) fail("only the ones not running on paper are listed first");
if (!/New timeframe/.test(t) || !/nothing on paper for this timeframe yet/.test(t)) fail("new timeframe row", t.slice(0, 900));
if (!/Not on paper/.test(t) || !/431 other strategies on this timeframe, 1 running/.test(t)) fail("not-on-paper row", t.slice(0, 900));
if (!/On paper, paused/.test(t) || !/60 min/.test(t) || !/best of 1,031 passed/.test(t)) fail("rows", t.slice(0, 900));
if (!(await p.$eval("#bt_add", (x) => x.disabled))) fail("button waits for a tick");
// The ones already running are behind a button.
await p.click("#bt_more"); await p.waitForTimeout(150);
const tAll = await p.textContent("#lp_besttf");
if ((await p.$$("#lp_besttf tbody tr")).length !== 4 || !/Running on paper/.test(tAll) || !/in a trade/.test(tAll)) fail("show all");
if (await p.$('#lp_besttf [data-btpick="GOLD|D"]')) fail("a running one can't be ticked");
await p.click("#bt_more"); await p.waitForTimeout(150);
// Tick all three → confirm → 2 new paper strategies saved, all three started.
await p.check("#bt_allpick"); await p.waitForTimeout(150);
if (!/Put 3 on paper/.test(await p.textContent("#bt_add"))) fail("count on the button");
await p.click("#bt_add"); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
const dlg = (await p.textContent("#confirmBox")).replace(/\s+/g, " ");
if (!/Put 3 strategies on paper\?/.test(dlg) || !/2 new: saved as paper strategies \(futures\) with 1 lot each/.test(dlg) || !/1 already on paper but paused/.test(dlg) || !/no real orders are sent/.test(dlg)) fail("confirmation", dlg.slice(0, 500));
await p.click("#cf_yes"); await p.waitForTimeout(2500);
const posts = writes.filter((w) => w.meth === "POST" && /\/algo_strategies/.test(w.u)).map((w) => JSON.parse(w.body));
if (posts.length !== 2 || posts.some((x) => x.live !== false || x.active !== false || !x.lab_id || !/^Lab #/.test(x.name) || x.lots !== 1)) fail("two paper strategies saved (paused first, 1 lot)", posts);
const on = writes.filter((w) => w.meth === "PATCH" && /\/algo_strategies/.test(w.u) && /"active":true/.test(w.body || ""));
if (on.length !== 1 || !/new-1/.test(on[0].u) || !/new-2/.test(on[0].u) || !/c1/.test(on[0].u)) fail("the two new ones and the paused one are started", on);
const toast = await p.textContent("#toast");
if (!/2 added to Paper and started; 1 started/.test(toast)) fail("toast", toast);
await p.evaluate(() => document.getElementById("lp_besttf").scrollIntoView()); await p.waitForTimeout(200);
await p.screenshot({ path: `besttf_${theme}_${width}.png`, fullPage: false });
const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > width + 1) fail("page scrolls sideways", sw);
if (errs.length) fail("page errors", errs);
console.log("ok best per timeframe", theme, width);
await b.close();
