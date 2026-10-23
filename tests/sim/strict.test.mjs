// Stricter lab (23 Oct 2026): vault, luck adjustment (Deflated Sharpe), neighbouring settings, best-trades cut,
// trade minimum, doubled slippage for daily strategies.
import assert from "node:assert";
import { generate, packTrades, preVault, robustChecks, robustVerdict, vaultDays } from "./lab.mjs";
import { deflatedSharpe, median, normCdf, normInv } from "./stats.mjs";

// --- statistics
assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5 && Math.abs(normCdf(1.959964) - 0.975) < 1e-6 && Math.abs(normInv(0.01) + 2.326348) < 1e-5);
assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 2, 3]), 2.5);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const noise = Array.from({ length: 200 }, () => (rnd() - 0.5) * 2000); // no edge
const strong = Array.from({ length: 120 }, (_, i) => (i % 10 < 7 ? 900 : -300)); // 70% wins of 3:1
const dNoise = deflatedSharpe(noise, 5000), dStrong = deflatedSharpe(strong, 5000), dOne = deflatedSharpe(strong.slice(0, 12), 5000);
console.log("DSR noise", dNoise.dsr, "strong", dStrong.dsr, "strong but 12 trades", dOne.dsr, "bar", dStrong.sr0);
assert.ok(dNoise.dsr < 0.5 && dStrong.dsr > 0.99 && dOne.dsr < dStrong.dsr);
// more tries raise the bar
assert.ok(deflatedSharpe(strong, 10).sr0 < deflatedSharpe(strong, 10000).sr0);
console.log("ok   statistics");

// --- the vault window
const win = { from: "2025-10-23", split: "2026-07-23", to: "2026-10-23" };
const gold = generate("GOLD", 11);
const daily = { ...gold, rules: { ...gold.rules, daily: true } }, minuteMcx = { ...gold, rules: { ...gold.rules, daily: false } };
assert.equal(vaultDays(daily), 182); assert.equal(vaultDays(minuteMcx), 92); assert.equal(vaultDays({ underlying: "NIFTY", rules: {} }), 182);
assert.deepEqual(preVault(win, daily), { from: "2025-04-24", split: "2026-01-22", to: "2026-04-24" });
assert.equal(preVault(win, { ...minuteMcx, vault_days: 182 }).to, "2026-04-24", "a check keeps its strategy's vault");
console.log("ok   vault: 6 months (3 for MCX minute strategies), windows end where it starts");

// --- checks: the vault is last, and every check carries the strategy's vault length
const cs = robustChecks(gold, new Set(["GOLD", "SILVER", "CRUDEOIL", "COPPER"]), new Set(["GOLD"]));
assert.equal(cs.at(-1).kind, "vault"); assert.ok(cs.every((c) => c.config.vault_days === vaultDays(gold)));
console.log("ok   checks end with the vault; transferred checks keep the original's vault");

// --- verdicts
const years = (nets, per = 12) => Array.from({ length: 10 }, (_, k) => {
  const y = 2026 - k, ts = Array.from({ length: per }, (_, i) => {
    const d = `${y - 1}-${String((i % 12) + 1).padStart(2, "0")}-${String(10 + (i % 5)).padStart(2, "0")}`;
    return { entry: `${d} 09:30`, exit: `${d} 15:00`, side: "LONG", entry_px: 100, exit_px: 101, net: nets[(k * per + i) % nets.length], exit_why: "x" };
  });
  return { kind: "year", asset: "GOLD", tf: k + 1, result: { ok: ts.reduce((a, t) => a + t.net, 0) > 0, net: ts.reduce((a, t) => a + t.net, 0), xcost: 100, from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, tr: packTrades(ts) } };
});
const steps = (oks, net = 40000) => oks.map((ok, i) => ({ kind: "step", asset: "GOLD", tf: null, result: { ok, net: ok ? net : -5000, n: 20, pf: 1.5, note: `step ${i}` } }));
const good = (over = {}) => [
  { kind: "self", asset: "GOLD", tf: null, result: { net: 50000, max_dd: 10000 } },
  { kind: "asset", asset: "SILVER", tf: null, result: { ok: true } },
  { kind: "tf", asset: "GOLD", tf: 60, result: { ok: true } },
  ...years(over.nets ?? strong),
  ...steps(over.steps ?? [true, true, true, true, true, true, true, false]),
  ...(over.vault === null ? [] : [{ kind: "vault", asset: "GOLD", tf: null, result: over.vault ?? { net: 12000, n: 4, ok: true } }]),
];
const v = (over) => robustVerdict(daily, good(over), { families: 5219 });
const pass = v();
console.log("strong strategy →", pass.passed, pass.why, "luck", pass.luck.dsr);
// everything in phase 1 passed: it now waits for the phase-2 noise tests (phase23.test.mjs)
assert.ok(!pass.passed && pass.needs_stage2 && pass.why.length === 1 && pass.vault.net === 12000 && pass.luck.dsr > 0.95 && pass.plateau.ok === 7 && pass.rev === 4);
const why = (over) => v(over).why.join(" | ");
assert.match(why({ vault: { net: -3000, n: 3, ok: false } }), /lost money in the held-back last 6 months/);
assert.match(why({ vault: { net: 0, n: 0, ok: false } }), /no trade in the held-back/);
assert.match(why({ vault: null }), /not yet tested on the held-back/);
assert.match(why({ steps: [true, true, true, true, false, false, false, false] }), /works only near this exact setting: 4 of 8/);
assert.match(robustVerdict(daily, [...good().filter((c) => c.kind !== "step"), ...steps([true, true, true, true], 10000)], { families: 5219 }).why.join(" | "), /nearby settings made much less/);
// carried by a few big trades: 1 huge winner, the rest small losers (every year still profitable)
const lucky = Array.from({ length: 12 }, (_, i) => (i === 0 ? 12000 : -1000)); // +1,000 a year, from one trade
assert.match(why({ nets: lucky }), /the profit comes from a few trades: without its best 6/);
assert.match(robustVerdict(daily, good().map((c) => c.kind === "year" ? { ...c, result: { ...c.result, tr: packTrades([{ entry: "2025-01-10 09:30", exit: "2025-01-10 15:00", side: "LONG", entry_px: 100, exit_px: 101, net: 5000, exit_why: "x" }]) } } : c), { families: 5219 }).why.join(" | "), /only 10 trades over the years tested \(needs 30\)/);
// no edge: half the trades win, half lose about the same (each year forced profitable to isolate the luck rule)
const coin = Array.from({ length: 120 }, (_, i) => (i % 2 ? 1150 : -1000));
const cv = robustVerdict(daily, good({ nets: coin }), { families: 5219 });
console.log("coin flip →", cv.luck.dsr, cv.why);
assert.match(cv.why.join(" | "), /could be luck: \d+% confidence it beats the best of 5219 rule families/);
// daily strategies now face doubled slippage too
const thin = good().map((c) => c.kind === "year" ? { ...c, result: { ...c.result, xcost: c.result.net + 1 } } : c);
assert.match(robustVerdict(daily, thin, { families: 5219 }).why.join(" | "), /slippage is doubled/);
console.log("ok   verdicts: vault, neighbours, best-trades cut, trade minimum, luck, daily slippage stress");
console.log("all passed");
