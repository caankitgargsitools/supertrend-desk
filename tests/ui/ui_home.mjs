// Home card at the top of the Strategies page (6 Nov 2026): open positions with the stop-distance meter, today's Booked P&L,
// expiries today, and the lines that matter only when they do (token, data plan, breaker, kill rule, new lab passes); /?home=1.
import { openApp, fail } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const card = { day: "2026-11-06", booked_today: 1200, active_live: 1, active_paper: 2, kills: 1, token_hours_left: 5, data_plan: "Active", data_valid_until: "2026-11-09", data_days_left: 3, breaker_halted: false, breaker_reason: null, new_lab_passes: 2,
  open: [{ id: "g1", name: "Lab #901 · Futures · GOLD daily · rule g1", asset: "GOLD", live: true, side: "LONG", lots: 2, entry: 138100, ltp: 138500, upnl: 4250, stop: 137000, stop_pct: 1.1, expiry: "2026-11-28", expires_today: false },
    { id: "zz", name: "Lab #999 · Futures · CRUDEOIL 5 min · rule zz", asset: "CRUDEOIL", live: false, side: "SHORT", lots: 1, entry: 5392, ltp: 5400, upnl: -800, stop: 5450, stop_pct: 0.9, expiry: "2026-11-06", expires_today: true }] };
const { b, p, errs } = await openApp({ theme, width, res: { "rpc/morning_card": card } });
await p.evaluate(() => showPage("list")); await p.waitForTimeout(600);
if (await p.isHidden("#lp_morning")) fail("home card shown");
const txt = (await p.textContent("#lp_morning")).replace(/\s+/g, " ");
if (!/Today · 06 Nov 26/.test(txt) || !/Booked P&L today ₹1,200/.test(txt) || !/1 live · 2 paper active/.test(txt)) fail("card header", txt.slice(0, 300));
const rows = await p.$$eval("#lp_morning .mrow", (r) => r.map((x) => ({ t: x.textContent.replace(/\s+/g, " "), meter: !!x.querySelector(".pladder"), lbl: (x.querySelector(".pladder .pl-cells") || {}).textContent?.replace(/\s+/g, " ") || "",
  now: (x.querySelector(".pl-now") || {}).textContent || "", over: x.querySelector(".pladder") ? x.querySelector(".pladder").scrollWidth > x.querySelector(".pladder").clientWidth + 1 : false,
  pos: Object.fromEntries([...x.querySelectorAll(".pl-tk, .pl-dot")].map((e) => [e.className.replace(/^pl-/, ""), parseFloat(e.style.left)])) })));
if (rows.length !== 2) fail("two open positions", rows);
if (!/Gold/.test(rows[0].t) || !/Live/.test(rows[0].t) || !/Long 2 lots/.test(rows[0].t) || !/\+₹4,250/.test(rows[0].t) || !rows[0].meter || !["Stop1,37,000₹3,00,000 · 1.1% away", "loses ₹2,20,000", "Entry1,38,100", "Target1,40,000", "makes ₹3,80,000"].every((x) => rows[0].lbl.includes(x)) || rows[0].now !== "Now 1,38,500") fail("gold row (from the desk's own strategy)", rows[0]);
if (!/Crude/.test(rows[1].t) || !/Paper/.test(rows[1].t) || !/Short 1 lot/.test(rows[1].t) || !/Expires today/.test(rows[1].t) || !rows[1].meter || !/away/.test(rows[1].lbl) || !/loses ₹/.test(rows[1].lbl) || !/Target ?None/.test(rows[1].lbl)) fail("crude row (from the server only)", rows[1]);
// Ladder: profit to the right — long gold: stop left of the entry, the price now right of it; short crude losing: the dot left of the entry.
const g = rows[0].pos, c = rows[1].pos;
if (!(g["tk sl"] < g.tk && g.tk < g["dot"])) fail("gold ladder order stop < entry < now", g);
if (!(c["tk sl"] < c.dot && c.dot < c.tk)) fail("crude ladder order stop < now < entry (losing short)", c);
if (rows.some((r) => r.over)) fail("ladder fits its card", rows.map((r) => r.over));
const lines = await p.$$eval("#lp_morning .mlines li", (l) => l.map((x) => x.textContent.replace(/\s+/g, " ")));
for (const want of [/kill rule/, /Dhan token ends in 5 h/, /Data API plan ends in 3 days/, /1 contract expire today: Crude/, /2 new lab passes/]) if (!lines.some((t) => want.test(t))) fail(`line ${want}`, lines);
if (lines.some((t) => /breaker/.test(t))) fail("no breaker line while it is off", lines);
// A position's row follows the live price.
await p.evaluate(() => onMark({ strategy_id: "g1", ltp: 137500, upnl: -1200, at: new Date().toISOString() })); await p.waitForTimeout(300);
if (!/−₹1,200/.test(await p.textContent("#lp_morning .mrow:first-child"))) fail("row follows the price");
if (await p.textContent("#lp_morning .mrow:first-child .pl-now") !== "Now 1,37,500") fail("ladder follows the price", await p.textContent("#lp_morning .mrow:first-child .pl-now"));
if (process.env.SHOT) await p.screenshot({ path: `${process.env.SHOT}/home_${theme}_${width}.png`, clip: await p.locator("#lp_morning").boundingBox() });
// Nothing to show → the card hides; the breaker line when set.
await p.evaluate((c) => { morning = { ...c, open: [], kills: 0, token_hours_left: 30, data_days_left: 20, new_lab_passes: 0, breaker_halted: true, breaker_reason: "Dhan refused every request" }; renderMorning(); }, card);
const t2 = (await p.textContent("#lp_morning")).replace(/\s+/g, " ");
if (!/No open position/.test(t2) || !/New trades stopped/.test(t2) || /Dhan token/.test(t2)) fail("quiet card with the breaker line", t2.slice(0, 300));
// The notification link opens the Strategies page at the card.
await p.evaluate(() => { showPage("wallet"); openDeepLink("http://localhost:8765/?home=1"); }); await p.waitForTimeout(700);
if ((await p.evaluate(() => page)) !== "list" || await p.isHidden("#lp_morning")) fail("?home=1 opens the Strategies page with the card");
if (errs.length) fail("page errors", errs);
console.log("ok home card", theme, width);
await b.close();
