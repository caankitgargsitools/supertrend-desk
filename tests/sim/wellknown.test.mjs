// Well-known strategy ideas added to the Ideas Lab (4 Nov 2026, Papa): every setting builds valid lab configs, the
// intraday ones square off (product I, their own candle size), the daily ones run on every market.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { IDEAS, legsFor, ideaRules } = await import("./ideas.mjs");
const { LAB_ASSETS } = await import("./lab.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const wk = IDEAS.filter((i) => i.key.startsWith("wk-"));
const have = new Set(Object.keys(LAB_ASSETS));
t("nine well-known ideas, four settings each, written down in fixed order after the research list", () => {
  assert.equal(wk.length, 9); assert.ok(wk.every((i) => i.settings.length === 4 && i.source === "research"));
  assert.deepEqual(wk.map((i) => i.order), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
});
for (const idea of wk) t(`${idea.key}: every setting gives valid configs (${idea.daily ? "daily" : "intraday"})`, () => {
  for (const s of idea.settings) {
    const legs = legsFor(idea, s, "2026-11-04", have, have);
    assert.ok(legs.length > 0, `${s.key}: no legs`);
    for (const l of legs) {
      const c = l.config;
      if (idea.daily) { assert.equal(c.rules.daily, true); assert.equal(c.intraday, false); }
      else {
        assert.equal(c.intraday, true, `${s.key} intraday`); assert.equal(c.product_type, "I");
        assert.equal(c.timeframe_min, Number(s.p.tf)); assert.equal(c.square_off, "15:15");
      }
    }
  }
});
t("ideaRules keeps the intraday flag of a setting that carries its rules", () => {
  const s = wk.find((i) => i.key === "wk-vwap").settings[0];
  assert.equal(ideaRules("wk-vwap", s.p).intraday, true);
  const g = wk.find((i) => i.key === "wk-52w").settings[0];
  assert.equal(ideaRules("wk-52w", g.p).intraday, false);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
