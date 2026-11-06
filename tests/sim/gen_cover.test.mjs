// Generator coverage (6 Nov 2026, audit step 6): the index / MCX / stock generator now draws Donchian, pivots, Keltner,
// gaps, Fibonacci, divergences, range setups, squeezes, volatility / time / calendar / VIX filters; MCX gets intraday
// strategies; every generated strategy is valid, its label follows the digits-stripped family convention, and the
// luck-test family key stays meaningful.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { generate, labelFor, fingerprint, mirror } = await import("./lab.mjs");
const { validateRules, allConds, describeCond } = await import("./rules.mjs");
let fails = 0;
const t = (n, f) => { try { f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

const many = (asset, n = 1500) => { const out = []; for (let s = 1; s <= n; s++) { try { out.push(generate(asset, s, 500000, 0)); } catch (e) { throw new Error(`seed ${s}: ${e.message}`); } } return out; };
const nifty = many("NIFTY"), gold = many("GOLD"), rel = many("RELIANCE", 800);
const inds = (cfgs) => { const m = new Map(); for (const c of cfgs) for (const x of allConds(c.rules)) m.set(x.ind, (m.get(x.ind) ?? 0) + 1); return m; };
t("every generated strategy validates, with a label and a fingerprint", () => {
  for (const c of [...nifty, ...gold, ...rel]) { validateRules(c.rules); assert.ok(labelFor(c).length > 10); assert.equal(fingerprint(c).length, 16); }
});
t("the new indicators appear in index strategies (DON, PIV, KC, GAP, FIB, DIV, RANGE, VOL, TIME, CAL, VIX)", () => {
  const m = inds(nifty);
  for (const k of ["DON", "PIV", "KC", "GAP", "FIB", "DIV", "RANGE", "VOL", "TIME", "CAL", "VIX", "BB"]) assert.ok((m.get(k) ?? 0) > 0, `${k} never drawn (${[...m.keys()].join(",")})`);
  // no single new family swamps the old ones: Supertrend / EMA still common
  assert.ok(m.get("ST") > m.get("FIB") / 3 && m.get("EMA") > 20);
});
t("VIX and calendar filters are drawn for indices and stocks, never for MCX; GAP / TIME / cpr_narrow only intraday", () => {
  assert.equal(inds(gold).get("VIX") ?? 0, 0); assert.equal(inds(gold).get("CAL") ?? 0, 0);
  assert.ok((inds(rel).get("CAL") ?? 0) > 0); assert.equal(inds(rel).get("VIX") ?? 0, 0, "VIX filters only for indices");
  for (const c of [...nifty, ...gold]) if (c.rules.daily) for (const x of allConds(c.rules)) { assert.ok(!["GAP", "TIME"].includes(x.ind), `${x.ind} in a once-a-day strategy`); assert.ok(!(x.ind === "PIV" && /cpr/.test(x.op)), "cpr filter in a daily strategy"); }
});
t("MCX now gets intraday strategies too (about 30%), with MCX session times", () => {
  const intra = gold.filter((c) => !c.rules.daily);
  assert.ok(intra.length > gold.length * 0.2 && intra.length < gold.length * 0.4, `${intra.length} of ${gold.length}`);
  for (const c of intra) { assert.equal(c.session_start, "09:00"); assert.ok(c.timeframe_min < 375); }
});
t("a direction-free primary (squeeze release, gap filled …) always comes with a directional condition", () => {
  const NONDIR = new Set(["squeeze_release", "squeeze", "nr_n", "inside_bar", "gap_filled", "gap_held", "cpr_narrow", "cpr_wide"]);
  for (const c of [...nifty, ...gold]) {
    const L = c.rules.long.conds.length ? c.rules.long.conds : c.rules.short.conds;
    if (NONDIR.has(L[0].op)) assert.ok(L.some((x) => !NONDIR.has(x.op) && !["VOL", "TIME", "CAL", "VIX", "RANGE", "ADX"].includes(x.ind)), `only direction-free conditions: ${L.map(describeCond).join(" & ")}`);
  }
});
t("Fibonacci entries use the limit-at-level fill about half the time, never in once-a-day strategies", () => {
  const fib = nifty.filter((c) => c.rules.long.conds.some((x) => x.ind === "FIB") || c.rules.short.conds.some((x) => x.ind === "FIB"));
  const lv = fib.filter((c) => c.rules.long.fill === "LEVEL" || c.rules.short.fill === "LEVEL");
  assert.ok(fib.length >= 20, `${fib.length} FIB strategies`);
  assert.ok(lv.length > fib.length * 0.25 && lv.length < fib.length * 0.75, `${lv.length} of ${fib.length} with LEVEL`);
  for (const c of lv) assert.ok(!c.rules.daily);
  for (const c of nifty) if (c.rules.daily) assert.ok(!c.rules.long.fill && !c.rules.short.fill);
});
t("mirror: directional new ops swap, filters stay; VIX / CAL / RANGE unchanged", () => {
  assert.equal(mirror({ ind: "PIV", tf: "base", op: "cross_up_r1" }).op, "cross_down_s1");
  assert.equal(mirror({ ind: "FIB", tf: "base", op: "pullback_to_618" }).op, "rally_to_618");
  assert.equal(mirror({ ind: "GAP", tf: "base", op: "gap_dn_gt" }).op, "gap_up_gt");
  assert.equal(mirror({ ind: "DIV", tf: "base", op: "rsi_bull_div" }).op, "rsi_bear_div");
  assert.equal(mirror({ ind: "KC", tf: "base", op: "squeeze_release" }).op, "squeeze_release");
  assert.equal(mirror({ ind: "VIX", tf: "D", op: "vix_lt", v: 15 }).op, "vix_lt");
  assert.equal(mirror({ ind: "CAL", tf: "base", op: "turn_of_month" }).op, "turn_of_month");
  assert.equal(mirror({ ind: "RANGE", tf: "base", op: "nr_n" }).op, "nr_n");
});
t("labels: digits stripped give one family per indicator / op pair (the luck test's count), parameters don't split them", () => {
  const fam = (c) => labelFor(c).split(" · ")[1].replace(/[0-9.,]+/g, "");
  const a = generate("NIFTY", 11, 500000, 0), b = JSON.parse(JSON.stringify(a));
  for (const x of allConds(b.rules)) if (x.p?.len) x.p.len += 1;
  assert.equal(fam(a), fam(b), "a nudged length keeps the family");
  const fams = new Set(nifty.map(fam));
  assert.ok(fams.size > 150 && fams.size < nifty.length * 0.9, `${fams.size} families among ${nifty.length}`);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
