// Fixed lots against the account's "never use more than" limit (2 Nov 2026).
import assert from "node:assert/strict";
import { fixedLotsFit, lotsFor } from "./sizing.mjs";
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
t("fits inside the limit → allowed", () => assert.equal(fixedLotsFit(2, 100000, 1000000, 500000, 80, true), null));
t("exactly at the limit → allowed", () => assert.equal(fixedLotsFit(3, 100000, 1000000, 500000, 80, true), null));
t("over the limit → skipped with the reason", () => {
  const why = fixedLotsFit(4, 100000, 1000000, 500000, 80, true);
  assert.ok(why && /4 lots need ₹4,00,000 margin but only ₹3,00,000 is left inside your 80% limit/.test(why), why);
});
t("others already above the limit → nothing left", () => assert.ok(/only ₹0 is left/.test(fixedLotsFit(1, 50000, 1000000, 900000, 80, true))));
t("no capital set → no check", () => assert.equal(fixedLotsFit(100, 100000, 0, 0, 80, false), null));
t("margin unknown → no check", () => assert.equal(fixedLotsFit(5, 0, 1000000, 0, 80, true), null));
t("losses shrink the room (equity after P&L)", () => assert.ok(fixedLotsFit(2, 100000, 200000, 0, 80, true)));
t("automatic lots unchanged", () => assert.equal(lotsFor({ mode: "AUTO", alloc_pct: 20, dd_pct: 25, dd_per_lot: null, dd_mult: 1.5, margin_pct: 10, max_lots: 10 }, 1000000, 50000, 0, 80).lots, 4));
if (fails) { console.log(fails, "failed"); process.exit(1); }
