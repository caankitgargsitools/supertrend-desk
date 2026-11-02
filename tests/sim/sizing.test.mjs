// Fixed lots against the account's "never use more than" limit (2 Nov 2026).
import assert from "node:assert/strict";
import { fixedLotsFit, lotsFor } from "./sizing.mjs";
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
if (fails) { console.log(fails, "failed"); process.exit(1); }
