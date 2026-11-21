// Live and paper capital are separate (12 Nov 2026, Papa: "my paper capital is 75 lakhs and the live capital is 4 lakhs …
// no linkage at all"): the Capital page, the Lots wizard and the Desk show each mode's own capital, limit and equity; Save
// writes only the mode shown (save_mode_capital). Args: theme width.
import { openApp, fail } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const cap = { capital: 400000, since: null, deploy_pct: 100, live_net: 9000, paper_capital: 7500000, paper_since: null, paper_deploy_pct: 70, paper_net: 5000,
  live_used: 0, paper_used: 0, funds: { available: 400000 }, funds_at: "2026-11-21T11:40:00Z", delta_connected: true,
  // 21 Nov 2026 (Papa): Live has one card per broker, from capital_room — Dhan follows the account, Delta the wallet.
  room_dhan: { broker: "DHAN", src: "broker", equity: 482955, pct: 90, limit: 434659.5, reserve: 48295.5, locked: 83196, bonus: 48295.5, used: 381881, used_desk: 310228,
    room: 101074, open: 3, with_stop: 1, capital: 400000, net: 0, funds: { available: 162733, utilized: 381841, sod: 482955 }, funds_at: "2026-11-21T11:40:57Z", fresh: true, base_at: "2026-11-21T11:40:57Z" },
  room_delta: { broker: "DELTA", src: "broker", equity: 100000, pct: 60, limit: 60000, reserve: 40000, locked: 0, bonus: 0, used: 0, used_desk: 0, room: 60000, open: 0, with_stop: 0,
    capital: 0, net: 0, funds: { usd: 1176.47, rate: 85, balance_inr: 100000, available_inr: 100000 }, funds_at: "2026-11-21T11:40:57Z", fresh: true } };
const { b, p, writes, errs } = await openApp({ theme, width, res: { "rpc/my_capital": cap } });
await p.evaluate(() => { openCap(); capTab("main"); }); await p.waitForTimeout(900);
const read = () => p.evaluate(() => ({ lbl: $("cap_capLbl").textContent, c: $("cap_capital").value, d: $("cap_deploy").value, lw: $("lw_cap").value, pct: $("lw_capPct").value, stats: $("cap_stats").textContent }));
const live = await read();
// Live: the single capital form is gone; one card per broker with the broker's own figures and the locked-profit reserve.
const cards = await p.evaluate(() => ({ grid: $("cap_grid").hidden, n: document.querySelectorAll("#cap_brokers .cap-bk").length, t: $("cap_brokers").textContent }));
if (!cards.grid || cards.n !== 2) fail("live: broker cards instead of the form", cards);
if (!/Dhan · NSE, BSE, MCX/.test(cards.t) || !/Delta · Crypto/.test(cards.t) || !/4,82,955/.test(cards.t) || !/1,00,000/.test(cards.t) || !/\$1176\.47 at ₹85/.test(cards.t)) fail("broker card figures", cards.t);
if (!/Locked in by stops₹83,196/.test(cards.t) || !/opens ₹48,295 of the reserve/.test(cards.t) || !/Can still deploy₹1,01,074/.test(cards.t)) fail("locked-profit reserve shown", cards.t);
if (!/the desk's estimate at entry ₹3,10,228/.test(cards.t)) fail("broker margin vs the desk's estimate", cards.t);
if (!/5,82,955/.test(live.stats)) fail("live capital tile: Dhan + Delta", live.stats);
// the Lots wizard on Live: a broker switch; Dhan sized from the Dhan capital, its own limit
if (live.lw !== "482955" || live.pct !== "90") fail("wizard capital (live Dhan): the Dhan account's capital and limit", live);
await p.evaluate(() => { capTab("lots"); }); await p.click('#lw_bk [data-bk="DELTA"]'); await p.waitForTimeout(500);
const dl = await read();
if (dl.lw !== "100000" || dl.pct !== "60") fail("wizard capital (live crypto): the Delta wallet and its limit", dl);
await p.click('#lw_bk [data-bk="DHAN"]'); await p.waitForTimeout(400); await p.evaluate(() => capTab("main"));
// Save on the Dhan card: save_broker_capital for Dhan only
writes.length = 0;
await p.evaluate(() => { const f = document.querySelector('[data-bkform="DHAN"]'); f.querySelector("[data-bkpct]").value = "90"; });
await p.click('[data-bkform="DHAN"] button[type="submit"]'); await p.waitForTimeout(700);
const wb = writes.find((x) => /save_broker_capital/.test(x.u));
if (!wb || JSON.parse(wb.body).p_broker !== "DHAN" || JSON.parse(wb.body).p_src !== "broker" || JSON.parse(wb.body).p_deploy_pct !== 90) fail("Dhan card saves Dhan only", wb);
await p.click('#cap_mode [data-m="PAPER"]'); await p.waitForTimeout(900);
const pap = await read();
if (pap.c !== "7500000" || pap.d !== "70" || !/Paper/.test(pap.lbl)) fail("paper capital form", pap);
if (pap.lw !== "7505000" || pap.pct !== "70") fail("wizard capital (paper): ₹75 lakh + paper booked ₹5,000, its own limit", pap);
if (!/75,00,000/.test(pap.stats) || /4,00,000/.test(pap.stats.replace(/Dhan account balance.*/, ""))) fail("paper capital tile", pap.stats);
// Equity everywhere (Desk, strategy form) comes from the same mode's settings.
const eq = await p.evaluate(() => [equityOf(cap.status, "LIVE"), equityOf(cap.status, "PAPER")]);
if (eq[0] !== 409000 || eq[1] !== 7505000) fail("equity per mode", eq);
// Save on the Paper tab writes the paper settings only.
await p.fill("#cap_capital", "7600000"); await p.click('#capForm button[type="submit"]'); await p.waitForTimeout(700);
const w = writes.find((x) => /save_mode_capital/.test(x.u));
if (!w) fail("no save_mode_capital call", writes.map((x) => x.u));
const body = JSON.parse(w.body);
if (body.p_mode !== "PAPER" || body.p_capital !== 7600000) fail("saved for paper only", body);
if (writes.some((x) => /save_my_capital/.test(x.u))) fail("old shared save used");
if (!/Paper only/i.test(await p.textContent("#cap_msg"))) fail("message says paper only", await p.textContent("#cap_msg"));
// Trades tab with "Live and paper": each mode its own figures, never one total (mock trades: live +₹9,000, paper +₹5,000).
const tr = await p.evaluate(() => { deskTrades = myTrades; $("tf_mode").value = ""; renderAllTrades(); return { h: [...document.querySelectorAll("#tf_stats h4")].map((e) => e.textContent), t: $("tf_stats").textContent }; });
if (tr.h.join() !== "Live,Paper" || /14,000/.test(tr.t)) fail("trades tab per mode", tr);
const tr1 = await p.evaluate(() => { $("tf_mode").value = "PAPER"; renderAllTrades(); return document.querySelectorAll("#tf_stats h4").length; });
if (tr1 !== 0) fail("one mode: one set of figures");
if (errs.length) fail("page errors", errs);
console.log("ok capital modes", theme, width);
await b.close();
