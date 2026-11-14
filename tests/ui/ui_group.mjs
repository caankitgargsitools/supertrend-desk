// Strategies grouped by asset + timeframe (Papa, 6 Nov 2026): header rows with counts and P&L, ranks from the lab's
// consistency score, the amber "best isn't live" tag, folding, the toggle, and the Lab table's "On desk · Live" mark.
import { chromium } from "playwright";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440), phone = width <= 760;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message); });
const A = "22222222-2222-2222-2222-222222222222", now = new Date().toISOString();
const base = { data_instrument: "FUTCOM", timeframe_min: 1440, strategy_kind: "RULES", atr_period: 10, factor: 3, trade_type: "FUTURES", direction: "BOTH", lots: 1, qty_mode: "LOTS", product_type: "M", exchange: "MCX",
  option_side: "BUY", leg_template_opt: "{}", leg_template_fut: "{}", position: "FLAT", archived: false, created_at: now, owner_id: A, active: true, live: false, intraday: false, rules: { daily: true, long: { conds: [] } } };
const S = (id, u, seg, tf, lab, extra = {}) => ({ ...base, id, name: `Lab #${lab || id} · Futures · ${u} ${tf === 1440 ? "daily" : tf + " min"} · rule ${id}`, underlying: u, data_segment: seg, data_security_id: u, futures_symbol: u,
  lot_size: 100, timeframe_min: tf, rules: tf === 1440 ? { daily: true, long: { conds: [] } } : { long: { conds: [] } }, lab_id: lab, ...extra });
// Three groups: Gold daily (4: the live one is NOT the best), Nifty 15 min (3: the best IS live), Crude 5 min (3: nothing live).
const strategies = [
  S("g1", "GOLD", "MCX_COMM", 1440, 901, { live: true, position: "LONG", pos_lots: 2, pos_qty: 200, pos_upnl: 4250, pos_ltp: 138500, pos_entry_px: 138100 }),
  S("g2", "GOLD", "MCX_COMM", 1440, 902),
  S("g3", "GOLD", "MCX_COMM", 1440, 903, { active: false }),
  S("g4", "GOLD", "MCX_COMM", 1440, null),
  S("ga", "GOLD", "MCX_COMM", 1440, 904, { archived: true, active: false }),
  S("n1", "NIFTY", "IDX_I", 15, 911, { exchange: "NSE", live: true, intraday: true }),
  S("n2", "NIFTY", "IDX_I", 15, 912, { exchange: "NSE", intraday: true }),
  S("n3", "NIFTY", "IDX_I", 15, 913, { exchange: "NSE", intraday: true }),
  S("c1", "CRUDEOIL", "MCX_COMM", 5, 921, { intraday: true, position: "SHORT", pos_lots: 1, pos_qty: 100, pos_upnl: -800, pos_ltp: 5400, pos_entry_px: 5392 }),
  S("c2", "CRUDEOIL", "MCX_COMM", 5, 922, { intraday: true }),
  S("c3", "CRUDEOIL", "MCX_COMM", 5, null, { intraday: true }),
];
// Consistency scores: Gold's best is 902 (not live; the live one, 901, ranks 2); Nifty's best is 911 (live).
const cons = { 901: 61, 902: 83.5, 903: 40, 904: 70, 911: 77, 912: 52, 913: 66, 921: 71, 922: 58 };
const me = { user_id: A, email: "ca.ankitgarg@gmail.com", role: "admin", status: "active", can_build: true, terms_accepted: true, billing: {}, entries: { ok: true } };
// A lab feed whose results carry the desk strategies' lab ids (so the Lab table shows "On desk").
const labRow = (id, asset, tf, label) => ({ id, run_id: 6, created_at: now, asset, stage: "screened", passed: true, basic_passed: true, score: 5, champion: false, label, fingerprint: `f${id}`, family: `fam${id}`, has_risk: false, robust_status: "done",
  metrics: { passed: true, why: [], score: 3.2, full: { n: 40, win_rate: 55, net: 120000, gross: 130000, costs: 10000, pf: 1.8, max_dd: 30000, avg: 3000, best: 20000, worst: -9000 }, train: { n: 30, win_rate: 55, net: 90000, gross: 1, costs: 1, pf: 1.7, max_dd: 30000, avg: 1, best: 1, worst: 1 },
    test: { n: 10, win_rate: 60, net: 30000, gross: 1, costs: 1, pf: 2, max_dd: 8000, avg: 1, best: 1, worst: 1 }, months: [{ m: "2026-01", net: 10000, n: 4 }], months_n: 12, train_months_n: 9, pos_months: 8, margin_lot: 150000, ret_margin: 80 },
  robust: { passed: true, why: [], rev: 5, status: "done", self: { net: 120000, max_dd: 30000 }, bh: { net: 60000, max_dd: 40000, ratio: 1.5 }, vs_bh: 2, risk_vs_bh: 2.67, assets: { ok: 4, n: 6, list: [] }, tfs: { ok: 2, n: 3, list: [] },
    years: { ok: 9, n: 10, list: [] }, consistency: { score: cons[id] || 50, parts: {} }, daily: tf === 1440, checked_at: "2026-10-09" },
  config: { rules: tf === 1440 ? { daily: true, long: { conds: [] }, short: { conds: [] } } : { long: { conds: [] }, short: { conds: [] } }, underlying: asset, timeframe_min: tf, intraday: tf !== 1440, direction: "BOTH", session_start: "09:15", last_entry: "15:00", square_off: "15:15", lot_size: 100, exchange: "MCX", strike_step: 50 } });
const labRows = [labRow(901, "GOLD", 1440, "Gold rule 1"), labRow(902, "GOLD", 1440, "Gold rule 2"), labRow(911, "NIFTY", 15, "Nifty rule 1"), labRow(921, "CRUDEOIL", 5, "Crude rule 1")];
const res = {
  "rpc/whoami": me, "rpc/broker_status": { broker: "DHAN", has_token: true, token_tail: "abcd", has_url: true, url_host: "x", has_secret: true },
  "rpc/my_capital": { capital: 2000000, since: null, deploy_pct: 60, live_net: 0, paper_net: 0, live_used: 0, paper_used: 0, funds: {} },
  "algo_strategies": strategies,
  "algo_trades": [["g1", "LIVE", 12000], ["g1", "LIVE", -3000], ["g2", "PAPER", 5000], ["n1", "LIVE", 2500], ["c2", "PAPER", -1200]].map(([sid, mode, net], i) => ({ id: i + 1, strategy_id: sid, user_id: A, mode, net, exit_at: `2026-10-0${i + 1}T10:00:00Z`, entry_day: `2026-10-0${i + 1}`, contract: "X", lots: 1, side: "LONG", entry_px: 1, exit_px: 2, gross: net, costs: 0, exit_why: "signal" })),
  "rpc/lab_scores": Object.entries(cons).map(([id, c]) => ({ id: Number(id), score: 5, consistency: c })),
  "rpc/lab_feed": { run: { id: 6, status: "done", counts: { generated: 300, passed: 4 }, from_day: "2025-10-09", split_day: "2026-07-09", to_day: "2026-10-09", created_at: now }, rows: labRows },
  "lab_results": labRows, "rpc/my_lab_requests": [], "rpc/lab_long_map": {}, "rpc/lab_long_results": [], "lab_runs": [{ id: 6, status: "done", phase: "done", counts: {}, created_at: now }], "lab_settings": { id: 1, enabled: true, assets: ["NIFTY"] },
};
await p.route(/supabase\.co/, (r) => {
  const u = r.request().url().replace(/^.*supabase\.co/, ""), meth = r.request().method();
  if (/\/auth\/v1\/user/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: A, email: me.email }) });
  if (meth === "PATCH") return r.fulfill({ status: 204, body: "" });
  const m = u.match(/\/rest\/v1\/(rpc\/[a-z_]+|[a-z_]+)/), key = m && m[1];
  let body = key in res ? res[key] : [];
  if (key === "lab_results_list") body = labRows;
  if (key === "rpc/lab_scores") { const ids = JSON.parse(r.request().postData() || "{}").p_ids || []; body = body.filter((x) => ids.includes(x.id)); }
  if (/application\/vnd\.pgrst\.object/.test(r.request().headers()["accept"] || "") && Array.isArray(body)) body = body[0] ?? null;
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await p.addInitScript(([uid, email]) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem("sb-umryzxusbdttbcshkajt-auth-token", JSON.stringify({ access_token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y", token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r", user: { id: uid, email, aud: "authenticated", role: "authenticated" } }));
  localStorage.removeItem("lpGroup"); localStorage.removeItem("lpFold"); localStorage.removeItem("lpView"); localStorage.removeItem("lastPage");
}, [A, me.email]);
await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await p.goto("http://localhost:8765/index.html"); await p.waitForTimeout(1600);
const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };
await p.evaluate(() => showPage("list")); await p.waitForTimeout(600);

// 1. Header rows: one per asset + timeframe, in asset order, with the counts.
const hdSel = phone ? "#lp_cards .lpgd" : "#lp_body tr.lpg";
let heads = await p.$$eval(hdSel, (x) => x.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
if (heads.length !== 3) fail("3 group headers", heads);
if (!/Crude/.test(heads[0]) || !/Gold/.test(heads[1]) || !/Nifty/.test(heads[2])) fail("group order (asset A–Z)", heads);
if (!/Daily · Futures/.test(heads[1]) || !/4 strategies · 1 live · 3 paper · 1 archived hidden/.test(heads[1])) fail("gold header counts", heads[1]);
if (!/15 min · Futures/.test(heads[2]) || !/3 strategies · 1 live · 2 paper/.test(heads[2])) fail("nifty header counts", heads[2]);
// Group P&L: Gold running +₹4,250 (only the live long is open), booked live ₹9,000 and paper ₹5,000 shown apart, never
// added together (12 Nov 2026, Papa: live and paper have no linkage); Crude running −₹800.
if (!/Running P&L \+₹4,250/.test(heads[1]) || !/Booked P&L Live ₹9,000 · Paper ₹5,000/.test(heads[1]) || /14,000/.test(heads[1])) fail("gold group P&L", heads[1]);
if (!/Running P&L −₹800/.test(heads[0])) fail("crude running P&L", heads[0]);
// 2. Tags: Gold's best (902, consistency 83.5) isn't the live one (901) → amber; Nifty's best is live → green; Crude has nothing live → no tag.
const tags = await p.$$eval(hdSel, (x) => x.map((t) => { const g = t.querySelector(".tag"); return g ? [g.className, g.textContent, g.title] : null; }));
if (tags[0] !== null) fail("crude has no tag", tags[0]);
if (!tags[1] || !/warn/.test(tags[1][0]) || tags[1][1] !== "best isn't live" || !/Lab #902/.test(tags[1][2]) || !/rank 2 of 3/.test(tags[1][2])) fail("gold amber tag", tags[1]);
if (!tags[2] || !/ok/.test(tags[2][0]) || tags[2][1] !== "best is live") fail("nifty green tag", tags[2]);
// 2b. (14 Nov 2026, Papa) The amber header names the best, with ⇄ Compare and "Switch to the best ▸"; the switch pauses the
// live one (it exits on its own) and the best starts after that exit — one rpc, switch_to_best(live, best).
if (!/Best: Lab #902 ★ 83\.5 vs live 61/.test(heads[1]) || !/⇄ Compare/.test(heads[1]) || !/Switch to the best ▸/.test(heads[1])) fail("gold header names the best with its buttons", heads[1]);
if (/Switch to the best/.test(heads[2])) fail("no switch when the best is live", heads[2]);
const swCalls = []; p.on("request", (q) => { if (/rpc\/switch_to_best/.test(q.url())) swCalls.push(JSON.parse(q.postData() || "{}")); });
const goldHead = (await p.$$(hdSel))[1];
await (await goldHead.$("[data-bsw]")).click(); await p.waitForSelector("#confirmBox:not([hidden]) .confirm");
const swTxt = (await p.textContent("#confirmBox")).replace(/\s+/g, " ");
if (!/Switch GOLD · Daily.* to the best strategy\?/.test(swTxt) || !/holds a long position/.test(swTxt) || !/closes the position on its own/.test(swTxt) || !/the best one starts and takes its next entry/.test(swTxt) || !/walk-forward/.test(swTxt)) fail("switch confirmation", swTxt.slice(0, 700));
if (await p.$("#cf_nostop")) await p.check("#cf_nostop");
await p.click("#cf_yes"); await p.waitForTimeout(800);
if (swCalls.length !== 1 || swCalls[0].p_from !== "g1" || swCalls[0].p_to !== "g2") fail("switch_to_best call", swCalls);
if ((await p.$$eval(hdSel, (x) => x.length)) !== 3 || !(await p.$(phone ? "#lp_cards .lpc" : "#lp_body tr.pick"))) fail("the button didn't fold the group");
// 3. Ranks: ★ on the best, "n of N", "lab –" for a strategy without a lab link; the default order inside a group is the rank.
const rowSel = phone ? "#lp_cards .lpc" : "#lp_body tr.pick";
const ranks = await p.$$eval(rowSel, (x) => x.map((t) => { const r = t.querySelector(".rank"); return r ? r.textContent : "(none)"; }));
if (ranks.length !== 10) fail("10 strategy rows", ranks);
if (ranks.slice(3, 7).join("|") !== "★ 1 of 3|2 of 3|3 of 3|lab –") fail("gold ranks in order", ranks);
if (!(await p.$$eval(rowSel, (x) => x.some((t) => /Live/.test(t.textContent) && /2 of 3/.test(t.textContent))))) fail("live chip on the rank-2 gold row");
// 4. Folding: click a header → its rows go, the fold is remembered; "Fold all" / "Unfold all".
await p.click(`${hdSel} >> nth=1`, { position: { x: 12, y: 10 } }); await p.waitForTimeout(250);
if ((await p.$$(rowSel)).length !== 6) fail("gold folded", (await p.$$(rowSel)).length);
const fold = await p.evaluate(() => JSON.parse(localStorage.getItem("lpFold") || "[]"));
if (fold.length !== 1 || !/^GOLD\|D\|F$/.test(fold[0])) fail("fold remembered", fold);
if ((await p.textContent("#lp_fold")) !== "Fold all") fail("fold-all label");
await p.click("#lp_fold"); await p.waitForTimeout(250);
if ((await p.$$(rowSel)).length !== 0 || (await p.textContent("#lp_fold")) !== "Unfold all") fail("fold all");
await p.click("#lp_fold"); await p.waitForTimeout(250);
if ((await p.$$(rowSel)).length !== 10) fail("unfold all");
// 5. The toggle off: no headers, no ranks, remembered.
await p.click("#lp_group"); await p.waitForTimeout(250);
if ((await p.$$(hdSel)).length || (await p.$$(".rank")).length) fail("grouping off");
if ((await p.evaluate(() => localStorage.getItem("lpGroup"))) !== "0") fail("toggle remembered");
await p.click("#lp_group"); await p.waitForTimeout(250);
if ((await p.$$(hdSel)).length !== 3) fail("grouping back on");
// Detailed view carries the ranks too (desktop).
if (!phone) {
  await p.click('#lp_view [data-v="full"]'); await p.waitForTimeout(250);
  if (!(await p.$$eval("#lp_body tr.pick td.nm .rank", (x) => x.length)) || (await p.$$("#lp_body tr.lpg")).length !== 3) fail("detailed view grouped with ranks");
  await p.click('#lp_view [data-v="simple"]'); await p.waitForTimeout(200);
}
await p.screenshot({ path: `group_${theme}_${width}.png`, fullPage: true });
// 6. Strategy Lab: a row whose result is on the desk shows "On desk · Live" (clickable → opens that strategy).
await p.click("#openLab"); await p.waitForTimeout(1400);
const marks = await p.$$eval(".chip.ondesk", (x) => x.map((t) => t.textContent));
if (!marks.includes("On desk · Live") || !marks.includes("On desk · Paper")) fail("lab on-desk marks", marks);
const live = (await p.$$(".chip.ondesk")).find(async () => true);
await p.click(".chip.ondesk:text('On desk · Live') >> nth=0"); await p.waitForTimeout(600);
if (await p.isHidden("#stratPane")) fail("on-desk mark opens the strategy");
// Short name as the title (13 Nov 2026), the full name on hover.
if (!/Lab #90[1]|Lab #911/.test(await p.getAttribute("#sp_name", "title")) || !/^(GOLD|NIFTY) · /.test(await p.textContent("#sp_name"))) fail("opened a live strategy", await p.textContent("#sp_name"));
if (errs.length) fail("page errors", errs);
console.log("ok strategies grouped by asset", theme, width);
await b.close();
