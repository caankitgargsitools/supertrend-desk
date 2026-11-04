// An asset's typical day's move for the lots wizard (4 Nov 2026): average true range of the last 20 days ÷ the close before.
import assert from "node:assert/strict";
import { dayMovePct } from "./margins.mjs";
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const flat = (n, c, range) => ({ h: Array(n).fill(c + range / 2), l: Array(n).fill(c - range / 2), c: Array(n).fill(c) });
t("a steady 2% range a day → 2%", () => assert.equal(dayMovePct(flat(30, 100, 2)), 0.02));
t("a gap counts: the move from yesterday's close, not only the day's own range", () => {
  const b = flat(22, 100, 1);
  b.h[21] = 106; b.l[21] = 105; b.c[21] = 105.5; // opened 5% higher, 1-point range
  assert.equal(dayMovePct(b), +((19 * 0.01 + 0.06) / 20).toFixed(5));
});
t("only the last 20 days count", () => {
  const b = flat(60, 100, 10); for (let i = 39; i < 60; i++) { b.h[i] = 101; b.l[i] = 99; }
  assert.equal(dayMovePct(b), 0.02);
});
t("too little history → null", () => { assert.equal(dayMovePct(flat(20, 100, 2)), null); assert.equal(dayMovePct(null), null); });
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
