// Strategy page (6 Nov 2026): header tiles only with a value, the Position tile in lots with the stop-distance meter, the chart's
// expert fields under "Chart settings", the sticky save bar with "Unsaved changes" / Discard, the read-only lot size with override,
// stop / target boxes shown only once a type is chosen, and the Backtest tab never wider than a phone.
import { openApp, fail } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440), phone = width <= 760;
const { b, p, errs } = await openApp({ theme, width });
await p.evaluate(() => openStrat("g1")); await p.waitForTimeout(900);
// Position tile: "Long 2 lots · +₹4,250", entry / now / SL / T under it, and the meter.
const pos = (await p.textContent("#st_pos")).replace(/\s+/g, " ").trim();
if (pos !== "Long 2 lots · +₹4,250") fail("position tile", pos);
const sub = await p.textContent("#st_pos_sub");
if (!/in 1,38,100 · now 1,38,500 · SL 1,37,000 · T 1,40,000/.test(sub)) fail("position sub-line", sub);
const meter = await p.$eval("#st_pos_meter .pladder", (m) => ({ lbl: m.querySelector(".pl-cells").textContent.replace(/\s+/g, " "), now: m.querySelector(".pl-now").textContent, dot: parseFloat(m.querySelector(".pl-dot").style.left), entry: parseFloat(m.querySelector(".pl-tk:not(.sl):not(.tg)").style.left), sl: parseFloat(m.querySelector(".pl-tk.sl").style.left), tgt: !!m.querySelector(".pl-tk.tg") }));
if (!/Stop ?1,37,000/.test(meter.lbl) || !/₹3,00,000 · 1\.1% away/.test(meter.lbl) || !/Entry ?1,38,100/.test(meter.lbl) || meter.now !== "Now 1,38,500" || !meter.tgt) fail("position ladder", meter);
// Profit to the right: stop, then entry, then the price now (a long in profit).
if (!(meter.sl < meter.entry && meter.entry < meter.dot)) fail("ladder order", meter);
// Tiles with no value are gone; the rules tile stays.
const tiles = await p.$$eval("#st_tiles .stat", (t) => t.map((x) => [x.id, x.hidden]));
if (tiles.find((t) => t[0] === "st_line_t")[1] !== true || tiles.find((t) => t[0] === "st_close_t")[1] !== false || tiles.find((t) => t[0] === "st_trend_t")[1] !== false) fail("tiles shown / hidden", tiles);
// The expert chart fields live under "Chart settings".
if (!(await p.$("details.chartmore #cx_custom"))) fail("chart fields under Chart settings");
// The live price moves: tile and meter follow.
await p.evaluate(() => onMark({ strategy_id: "g1", ltp: 137500, upnl: -1200, at: new Date().toISOString() })); await p.waitForTimeout(300);
if (!/−₹1,200/.test(await p.textContent("#st_pos")) || !/₹1,00,000 · 0\.4% away/.test(await p.textContent("#st_pos_meter"))) fail("meter follows the price", await p.textContent("#st_pos_meter"));
// The list's Simple view carries the meter on the open row (desktop) / card (phone).
await p.evaluate(() => showPage("list")); await p.waitForTimeout(500);
if (!(await p.$(phone ? "#lp_cards .lpc [data-smeter] .smeter" : "#lp_body tr.pick [data-smeter] .smeter"))) fail("meter in the list");
// Form: sticky save bar, dirty state, discard.
await p.evaluate(() => { openStrat("g1"); showTab("set"); }); await p.waitForTimeout(600);
if ((await p.$eval("#stratBar", (e) => getComputedStyle(e).position)) !== "sticky") fail("sticky save bar");
if (!(await p.isHidden("#formDirtyTxt"))) fail("clean form shows no dirty mark");
await p.fill("#f_name", "Renamed"); await p.waitForTimeout(100);
if (await p.isHidden("#formDirtyTxt") || await p.isHidden("#b_discard")) fail("dirty mark + Discard after a change");
await p.click("#b_discard"); await p.waitForTimeout(200);
if ((await p.inputValue("#f_name")) === "Renamed" || !(await p.isHidden("#formDirtyTxt"))) fail("discard restores the form");
// Lot size: Dhan's lot from the preset, read-only until "override".
const preset = await p.evaluate(() => PRESETS.GOLD.lot_size);
await p.evaluate((v) => { stratOf("g1").lot_size = v; fillForm(stratOf("g1")); }, preset);
if (!(await p.$eval("#f_lot_size", (i) => i.readOnly)) || await p.isChecked("#f_lot_override")) fail("lot size read-only at the preset's lot");
await p.check("#f_lot_override"); if (await p.$eval("#f_lot_size", (i) => i.readOnly)) fail("override unlocks the lot size");
await p.fill("#f_lot_size", "50"); await p.uncheck("#f_lot_override");
if ((await p.inputValue("#f_lot_size")) !== String(preset) || !(await p.$eval("#f_lot_size", (i) => i.readOnly))) fail("unticking restores the preset's lot", await p.inputValue("#f_lot_size"));
// Stop / target value boxes only once a type is chosen.
if (!(await p.isHidden("#r_trail_val"))) fail("trailing value box hidden while Off");
await p.selectOption("#r_trail_type", "PCT"); await p.waitForTimeout(100);
if (await p.isHidden("#r_trail_val")) fail("trailing value box shown once a type is chosen");
if (!(await p.$('#r_tgt_type option[value="FIB"]')) || await p.$('#r_sl_type option[value="FIB"]')) fail("Fibonacci on the target type only");
// Backtest tab: nothing wider than the screen.
await p.evaluate(() => showTab("bt")); await p.waitForTimeout(400);
const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, bt: document.getElementById("btView").scrollWidth, bw: document.getElementById("btView").clientWidth }));
if (w.sw > w.iw || w.bt > w.bw + 1) fail("backtest tab overflows sideways", w);
if (errs.length) fail("page errors", errs);
console.log("ok strategy page ux", theme, width);
await b.close();
