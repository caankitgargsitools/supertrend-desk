// The morning card (6 Nov 2026): one note per user with active strategies, from the SQL function morning_card, once a day.
import assert from "node:assert/strict";
const T0 = Date.parse("2026-10-15T03:00:00Z"); let clock = T0;
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
globalThis.Deno = { env: { get: () => "k" }, serve: () => {} }; globalThis.EdgeRuntime = { waitUntil() {} };
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const { db, rpcs } = await import("./fakesb.mjs");
const E = await import("./engine.mjs");
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
db.algo_strategies = [{ id: "s1", owner_id: "u1", active: true, archived: false }, { id: "s2", owner_id: "u2", active: true, archived: false }, { id: "s3", owner_id: "u3", active: false, archived: false }];
db.notifications = [];
const cards = {
  u1: { open: [{ name: "Gold", asset: "GOLD", live: true, side: "LONG", lots: 1, upnl: 12340, stop_pct: 0.3, expires_today: true }, { name: "Silver", asset: "SILVERM", live: false, side: "SHORT", lots: 2, upnl: -2100, stop_pct: null, expires_today: false }],
    booked_today: 5500, booked_live_today: 6000, booked_paper_today: -500, active_live: 1, active_paper: 3, kills: 1, token_hours_left: 2.5, data_days_left: 3, breaker_halted: true, new_lab_passes: 2 },
  u2: { open: [], booked_today: 0, active_live: 0, active_paper: 2, kills: 0, token_hours_left: 20, data_days_left: 30, breaker_halted: false, new_lab_passes: null },
};
rpcs.morning_card = async (a) => ({ data: cards[a.p_user] ?? null, error: null });
await t("one card per user with active strategies, with the day's facts", async () => {
  const r = await E.morningCards();
  assert.equal(r.sent, 2); assert.equal(r.users, 2);
  const n1 = db.notifications.find((n) => n.user_id === "u1");
  assert.equal(n1.kind, "morning"); assert.match(n1.title, /Good morning · live 1 open \+₹12,340 · paper 1 open −₹2,100 · 1 live, 3 paper active/);
  assert.match(n1.body, /live: 1 open, running \+₹12,340; paper: 1 open, running −₹2,100/); assert.match(n1.body, /1 without a stop/); assert.match(n1.body, /booked today: live \+₹6,000, paper −₹500/); // live and paper apart (12 Nov 2026)
  assert.match(n1.body, /GOLD expires today/); assert.match(n1.body, /new trades are stopped/); assert.match(n1.body, /1 stopped by the kill rule/);
  assert.match(n1.body, /Dhan token expires in 2.5 h/); assert.match(n1.body, /data plan 3 days left/); assert.match(n1.body, /2 new lab passes/);
  const n2 = db.notifications.find((n) => n.user_id === "u2");
  assert.match(n2.body, /^nothing open · booked today ₹0 · Dhan token 20 h left$/);
  assert.equal(db.notifications.some((n) => n.user_id === "u3"), false, "no active strategy, no card");
});
await t("not twice a day", async () => {
  const r = await E.morningCards();
  assert.equal(r.sent, 0); assert.equal(db.notifications.length, 2);
});
console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
