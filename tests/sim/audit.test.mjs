import { matchTrades } from "./audit.mjs";
import assert from "node:assert";
const T = (d, h, m) => new Date(Date.parse(`${d}T00:00:00+05:30`) + (h * 60 + m) * 60000).toISOString();
const plan = (side, ed, em, xd, xm, pi, po, why = "Trailing stop") => ({ side, entryDay: ed, entryMin: em, exitDay: xd, exitMin: xm, spotIn: pi, spotOut: po, exitWhy: why });
const desk = [
  { id: 1, side: "LONG", entry_day: "2026-10-13", exit_at: T("2026-10-14", 13, 8), entry_px: 22526, exit_px: 22587, units: 65, net: 3095, exit_why: "Trailing" },
  { id: 2, side: "SHORT", entry_day: "2026-10-19", exit_at: T("2026-10-21", 9, 16), entry_px: 22920, exit_px: 23016, units: 65, net: -7126, exit_why: "Trailing" },
  { id: 3, side: "LONG", entry_day: "2026-10-20", exit_at: T("2026-10-20", 14, 0), entry_px: 23000, exit_px: 23100, units: 65, net: 6000, exit_why: "x" },
];
const plans = [
  plan("LONG", "2026-10-13", 13 * 60 + 30, "2026-10-14", 13 * 60 + 15, 22520, 22590), // match, 7 min
  plan("SHORT", "2026-10-19", 600, "2026-10-21", 13 * 60, 22920, 22800),             // exit late + gap
  plan("SHORT", "2026-10-16", 600, "2026-10-16", 900, 22800, 22700),                  // missed
  plan("LONG", "2026-10-21", 800, "2026-10-21", 920, 23100, 23150, "Still open at end of test (valued at the last price)"), // open: ignored
];
const r = matchTrades(desk, plans, { daily: false, tf: 75, options: false, today: "2026-10-21" });
for (const t of r) console.log(t.entry_day, t.side, t.issue, t.rupee_gap);
assert.equal(r.length, 4);
assert.equal(r.find((t) => t.entry_day === "2026-10-13").issue, null);
assert.match(r.find((t) => t.entry_day === "2026-10-19").issue, /Exit differs/);
assert.match(r.find((t) => t.entry_day === "2026-10-16").issue, /desk did not/);
assert.match(r.find((t) => t.entry_day === "2026-10-20").issue, /backtest did not/);
// daily: same day exit ok
const d = matchTrades([{ id: 9, side: "LONG", entry_day: "2026-10-19", exit_at: T("2026-10-20", 17, 1), entry_px: 148393, exit_px: 146641, units: 100, net: -177776, exit_why: "rev" }],
  [plan("LONG", "2026-10-19", 540, "2026-10-20", 540, 148300, 146700)], { daily: true, tf: 375, options: false, today: "2026-10-21" });
console.log(d[0].issue, d[0].rupee_gap); assert.equal(d[0].issue, null);
// a running strategy without desk trades: every finished backtest trade is a miss, an open one is left to the open-position check
const none = matchTrades([], plans, { daily: false, tf: 75, options: false, today: "2026-10-21" });
assert.equal(none.length, 3); assert.ok(none.every((t) => /desk did not/.test(t.issue)));
console.log("ok");
