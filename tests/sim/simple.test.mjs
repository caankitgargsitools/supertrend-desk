// Simple lab rules (rev 5, 27 Oct 2026): all but one year in five profitable, doubled slippage in total, enough trades,
// the held-back months; luck, best-trades cut and the rest shown for information. Ranked by the consistency score.
import assert from "node:assert";
import { consistencyScore, generate, packTrades, robustChecks, robustVerdict } from "./lab.mjs";

const gold = generate("GOLD", 11), daily = { ...gold, rules: { ...gold.rules, daily: true } };
// --- checks: the strategy, its years and the vault only
const cs = robustChecks(daily, new Set(["GOLD", "SILVER", "CRUDEOIL"]), new Set(["GOLD"]));
assert.deepEqual([...new Set(cs.map((c) => c.kind))], ["self", "year", "vault"]);
assert.equal(cs.filter((c) => c.kind === "year").length, 10);
console.log("ok   simple checks: the strategy, 10 years, the held-back months");

// --- ten years of trades; yearNets[k] = net of year k+1 (year 1 = latest), 12 monthly trades a year
const years = (yearNets, xcost = 100) => yearNets.map((yn, k) => {
  const y = 2026 - k, ts = Array.from({ length: 12 }, (_, i) => {
    const d = `${y - 1}-${String(i + 1).padStart(2, "0")}-15`;
    return { entry: `${d} 09:30`, exit: `${d} 15:00`, side: "LONG", entry_px: 100, exit_px: 101, net: Math.trunc(yn / 12), exit_why: "x" };
  });
  const net = ts.reduce((a, t) => a + t.net, 0);
  return { kind: "year", asset: "GOLD", tf: k + 1, result: { ok: net > 0, net, xcost, from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, tr: packTrades(ts) } };
});
const vault = { kind: "vault", asset: "GOLD", tf: null, result: { net: 9000, n: 5, ok: true } };
const self = { kind: "self", asset: "GOLD", tf: null, result: { net: -1000, max_dd: 10000 } };
const verdict = (ys, extra = [vault]) => robustVerdict(daily, [self, ...years(ys), ...extra], { families: 5219 });

// 9 of 10 years profitable, the latest year a loss: passes (strict rules would have failed it on two counts)
const nine = [-12000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000];
const a = verdict(nine);
console.log("9 of 10 →", a.passed, a.why, "consistency", a.consistency.score, a.consistency.parts);
assert.ok(a.passed && a.rev === 5 && !a.needs_stage2 && a.luck && a.top_cut);
const strictA = robustVerdict(daily, [self, ...years(nine), vault], { families: 5219, strict: true });
assert.ok(!strictA.passed && /needs every year/.test(strictA.why.join(" | ")));
// 8 of 10 passes, 7 of 10 fails
assert.ok(verdict([-1, -1, ...Array(8).fill(60000)].map((x) => x === -1 ? -12000 : x)).passed);
assert.match(verdict([-12000, -12000, -12000, ...Array(7).fill(60000)]).why.join(" | "), /profitable in 7 of the past 10 years \(needs 8/);
// the held-back months still decide
assert.match(verdict(nine, [{ ...vault, result: { net: -500, n: 2, ok: false } }]).why.join(" | "), /lost money in the held-back/);
assert.match(verdict(nine, []).why.join(" | "), /not yet tested on the held-back/);
// doubled slippage: only the total counts
assert.ok(robustVerdict(daily, [self, ...years(nine, 20000), vault], { families: 5219 }).passed, "loses a year with slippage doubled, still positive in total");
assert.match(robustVerdict(daily, [self, ...years(nine, 60000), vault], { families: 5219 }).why.join(" | "), /loses money once slippage is doubled/);
console.log("ok   simple verdict: 8 of 10 years, slippage in total, the held-back months");

// --- consistency: steady beats lumpy with the same total
const ys = (nets) => nets.map((n, k) => ({ y: k + 1, net: n, ok: n > 0 }));
const tr = (nets) => nets.flatMap((yn, k) => Array.from({ length: 12 }, (_, i) => ({ exit: `${2025 - k}-${String(i + 1).padStart(2, "0")}-15`, net: yn / 12 })));
const steady = Array(10).fill(50000), lumpy = [250000, -10000, 5000, -10000, 250000, -5000, 10000, -5000, 10000, 5000];
const cS = consistencyScore(ys(steady), tr(steady)), cL = consistencyScore(ys(lumpy), tr(lumpy));
console.log("steady", cS.score, "lumpy", cL.score);
assert.ok(cS.score >= 95 && cS.score - cL.score >= 25, "same total, lumpy scores far lower");
console.log("ok   consistency score: steady profit ranks above lumpy profit");
console.log("all passed");
