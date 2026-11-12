// Live and paper capital are separate (12 Nov 2026, Papa: "my paper capital is 75 lakhs and the live capital is 4 lakhs …
// no linkage at all"): the Capital page, the Lots wizard and the Desk show each mode's own capital, limit and equity; Save
// writes only the mode shown (save_mode_capital). Args: theme width.
import { openApp, fail } from "./_mock.mjs";
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const cap = { capital: 400000, since: null, deploy_pct: 100, live_net: 9000, paper_capital: 7500000, paper_since: null, paper_deploy_pct: 70, paper_net: 5000,
  live_used: 0, paper_used: 0, funds: { available: 400000 } };
const { b, p, writes, errs } = await openApp({ theme, width, res: { "rpc/my_capital": cap } });
await p.evaluate(() => { openCap(); capTab("main"); }); await p.waitForTimeout(900);
const read = () => p.evaluate(() => ({ lbl: $("cap_capLbl").textContent, c: $("cap_capital").value, d: $("cap_deploy").value, lw: $("lw_cap").value, pct: $("lw_capPct").value, stats: $("cap_stats").textContent }));
const live = await read();
if (live.c !== "400000" || live.d !== "100" || !/Live/.test(live.lbl)) fail("live capital form", live);
if (live.lw !== "409000") fail("wizard capital (live): ₹4 lakh + live booked ₹9,000", live);
if (!/4,00,000/.test(live.stats)) fail("live capital tile", live.stats);
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
