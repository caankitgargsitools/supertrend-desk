// Dhan Data API plan warnings (6 Nov 2026, Papa: 7, 5, 3 and 1 day before it ends; at once when Dhan says inactive).
import assert from "node:assert/strict";
let clock = Date.parse("2026-11-30T04:00:00Z"); // 30 Nov, 09:30 IST
Date.now = () => clock;
globalThis.Deno = { env: { get: (k) => k === "SUPABASE_URL" ? "http://x" : "k" }, serve: () => {} };
globalThis.EdgeRuntime = { waitUntil() {} };
const prof = { dataPlan: "Active", dataValidity: "2026-12-07 00:00:00.0", activeSegment: "E, D, C, M, ", tokenValidity: "07/11/2026 08:37" };
globalThis.fetch = async (url) => {
  if (String(url).includes("/v2/profile")) return new Response(JSON.stringify(prof), { status: 200 });
  return new Response("{}", { status: 404 });
};
const { db } = await import("./fakesb.mjs");
const E = await import("./engine.mjs");
db.broker_accounts = [{ id: 1, user_id: "u1", broker: "DHAN", client_id: "C1", access_token: "TOK", data_warned: null }];
db.notifications = [];
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const day = (d) => { clock = Date.parse(`2026-${d}T04:00:00Z`); };
const titles = () => db.notifications.map((n) => n.title);

await t("warnings at 7, 5, 3 and 1 day left, each once; nothing in between or earlier", async () => {
  day("11-29"); await E.dataPlanCheck(1); assert.equal(db.notifications.length, 0, "8 days left: nothing yet");
  day("11-30"); await E.dataPlanCheck(1); await E.dataPlanCheck(1);
  assert.deepEqual(titles(), ["Dhan Data API plan ends in 7 days (7 Dec 2026)"], "7 days, once");
  day("12-01"); await E.dataPlanCheck(1); assert.equal(db.notifications.length, 1, "6 days: nothing new");
  day("12-02"); await E.dataPlanCheck(1); day("12-04"); await E.dataPlanCheck(1); day("12-06"); await E.dataPlanCheck(1); await E.dataPlanCheck(1);
  assert.deepEqual(titles().slice(1), ["Dhan Data API plan ends in 5 days (7 Dec 2026)", "Dhan Data API plan ends in 3 days (7 Dec 2026)", "Dhan Data API plan ends tomorrow (7 Dec 2026)"]);
  const a = db.broker_accounts[0];
  assert.equal(a.data_plan, "Active"); assert.equal(a.data_valid_until, "2026-12-07"); assert.equal(a.data_warned, "2026-12-07|1");
  assert.ok(db.notifications.every((n) => n.user_id === "u1" && n.kind === "error" && /DhanHQ Trading APIs → Data APIs/.test(n.body)));
});
await t("a missed day still warns at the step reached (4 days left → the 5-day warning, then 3)", async () => {
  db.notifications = []; db.broker_accounts[0].data_warned = null; prof.dataValidity = "2027-01-07 00:00:00.0";
  day("12-31"); await E.dataPlanCheck(1);
  clock = Date.parse("2027-01-03T04:00:00Z"); await E.dataPlanCheck(1);
  assert.deepEqual(titles(), ["Dhan Data API plan ends in 7 days (7 Jan 2027)", "Dhan Data API plan ends in 4 days (7 Jan 2027)"]);
  clock = Date.parse("2027-01-04T04:00:00Z"); await E.dataPlanCheck(1);
  assert.equal(titles().at(-1), "Dhan Data API plan ends in 3 days (7 Jan 2027)");
});
await t("inactive plan: told at once, once; renewed → the record restarts for the new date", async () => {
  db.notifications = []; prof.dataPlan = "Deactive"; prof.dataValidity = "NA";
  await E.dataPlanCheck(1); await E.dataPlanCheck(1);
  assert.deepEqual(titles(), ["Dhan Data API plan is inactive"]); assert.equal(db.broker_accounts[0].data_warned, "off");
  prof.dataPlan = "Active"; prof.dataValidity = "2027-02-07 00:00:00.0";
  await E.dataPlanCheck(1);
  assert.equal(db.broker_accounts[0].data_warned, null); assert.equal(db.notifications.length, 1);
  assert.equal(db.broker_accounts[0].data_valid_until, "2027-02-07");
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
