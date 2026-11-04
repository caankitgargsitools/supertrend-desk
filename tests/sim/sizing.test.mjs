// Fixed lots against the account's "never use more than" limit (2 Nov 2026).
import assert from "node:assert/strict";
import { fixedLotsFit, lotsFor, moveLots } from "./sizing.mjs";
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const F = (...x) => fixedLotsFit(...x);
t("fits inside the limit → all lots", () => assert.deepEqual(F(2, 100000, 1000000, 500000, 80, true), { lots: 2, why: null }));
t("exactly at the limit → all lots", () => assert.equal(F(3, 100000, 1000000, 500000, 80, true).lots, 3));
t("40 wanted, room for 36 → 36 lots with the reason", () => {
  const r = F(40, 100000, 4500000, 0, 80, true);
  assert.equal(r.lots, 36); assert.ok(/40 lots need ₹40,00,000 margin but only ₹36,00,000 is left inside your 80% limit/.test(r.why), r.why);
});
t("room for part of a lot → 0 (skip)", () => assert.equal(F(1, 50000, 1000000, 780000, 80, true).lots, 0));
t("others already above the limit → 0", () => assert.equal(F(5, 50000, 1000000, 900000, 80, true).lots, 0));
t("no capital set → all lots", () => assert.equal(F(100, 100000, 0, 0, 80, false).lots, 100));
t("margin unknown → all lots", () => assert.equal(F(5, 0, 1000000, 0, 80, true).lots, 5));
t("losses shrink the room (equity after P&L)", () => assert.equal(F(2, 100000, 200000, 0, 80, true).lots, 1));
t("automatic lots unchanged", () => assert.equal(lotsFor({ mode: "AUTO", alloc_pct: 20, dd_pct: 25, dd_per_lot: null, dd_mult: 1.5, margin_pct: 10, max_lots: 10 }, 1000000, 50000, 0, 80).lots, 4));
// Same ₹ on a typical day (4 Nov 2026): lots = target ÷ one lot's typical day, changes of 20% or less ignored.
t("move: ₹1,00,000 a day ÷ ₹37,500 a lot → 3 lots (from 1)", () => { const r = moveLots(1, 100000, 37500); assert.equal(r.lots, 3); assert.match(r.why, /→ 3 lots \(was 1\)/); });
t("move: within 20% (10 wanted, 9 now) → keeps 9, no change", () => assert.deepEqual(moveLots(9, 100000, 10000), { lots: 9, why: null }));
t("move: judged before rounding (2.42 wanted, 3 held → keeps 3; 2.3 → 2)", () => { assert.equal(moveLots(3, 2.42, 1).lots, 3); assert.equal(moveLots(3, 2.3, 1).lots, 2); });
t("move: just over 20% (13 wanted, 10 now) → 13", () => assert.equal(moveLots(10, 130000, 10000).lots, 13));
t("move: one lot far bigger than the target → 0 (skip)", () => assert.equal(moveLots(2, 10000, 200000).lots, 0));
t("move: no day's move known → the lots stay", () => assert.deepEqual(moveLots(4, 100000, 0), { lots: 4, why: null }));
if (fails) { console.log(fails, "failed"); process.exit(1); }
