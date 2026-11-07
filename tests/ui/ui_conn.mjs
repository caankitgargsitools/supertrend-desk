// Connections page (6 Nov 2026): the help link to DhanHQ, the notifications card under the Dhan form, saved secrets never shown.
import { openApp, fail } from "./_mock.mjs";

// Args: theme (dark|light) width.
const theme = process.argv[2] || "dark", width = Number(process.argv[3] || 1440);
const { b, p, errs } = await openApp({ theme, width });
await p.evaluate(() => openConn()); await p.waitForTimeout(800);
if (await p.isHidden("#connCard")) fail("connections card open");
const link = await p.$eval('#connForm a[href^="https://dhanhq.co"]', (a) => [a.textContent, a.target, a.rel]).catch(() => null);
if (!link || !/DhanHQ/.test(link[0]) || link[1] !== "_blank" || !/noopener/.test(link[2])) fail("where-do-I-get-these link", link);
if (!/Where do these come from\?/.test(await p.textContent("#connForm"))) fail("help text");
// The notifications card sits under the Dhan form, not first.
const order = await p.evaluate(() => { const f = document.getElementById("connForm"), n = document.getElementById("ntf_card"); return f.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING; });
if (!order) fail("notifications card after the form");
// Saved state is shown as "saved, ends …abcd"; the inputs are empty password boxes; no secret anywhere on the page.
if (!/saved, ends …abcd/.test(await p.textContent("#tokState"))) fail("token state", await p.textContent("#tokState"));
if (!/saved, tv-webhook\.dhan\.co/.test(await p.textContent("#urlState"))) fail("url state", await p.textContent("#urlState"));
const inputs = await p.$$eval("#c_token, #c_url, #c_secret, #d_key, #d_secret", (x) => x.map((i) => [i.type, i.value]));
if (inputs.some(([t, v]) => t !== "password" || v !== "")) fail("secret inputs empty password boxes", inputs);
if (await p.$('#connCard input[data-eye]')) fail("no eye button on broker keys");
if (/eyJ|access_token/.test(await p.textContent("#connCard"))) fail("a token leaked on the page");
// The client ID is a plain field, prefilled.
if ((await p.inputValue("#c_client")) !== "1100012345") fail("client id prefilled", await p.inputValue("#c_client"));
// The compare tray never shows here.
await p.evaluate(() => { cmpSet([{ k: "desk", id: "g1", name: "x" }]); renderCmpTray(); });
if (!(await p.isHidden("#cmpTray"))) fail("no compare tray on Connections");
if (errs.length) fail("page errors", errs);
console.log("ok connections", theme, width);
await b.close();
