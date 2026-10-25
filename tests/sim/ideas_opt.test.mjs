// Ideas lab, option selling: weekly expiries (Thursday → Tuesday in Sept 2025, holidays), strikes from volatility,
// the stop on a short strike, lots by risk, and the real option backtester pricing every leg from cached series.
import assert from "node:assert";
import { createClient, db } from "./fakesb.mjs";
import { combineTry, IDEA_CAPITAL, optLegs, optLots, optPlans, optionSlice, weeklyExpiries } from "./ideas.mjs";

const days = (from, to, skip = []) => { const out = []; for (let d = Date.parse(from); d <= Date.parse(to); d += 86400000) { const s = new Date(d).toISOString().slice(0, 10), wd = new Date(d).getUTCDay(); if (wd && wd < 6 && !skip.includes(s)) out.push(s); } return out; };

// --- expiries: Thursdays until 28 Aug 2025, Tuesdays from September 2025; a holiday moves it a day earlier
assert.deepEqual(weeklyExpiries(days("2025-08-18", "2025-09-12"), "NIFTY", 2), ["2025-08-21", "2025-08-28", "2025-09-02", "2025-09-09"]);
assert.deepEqual(weeklyExpiries(days("2024-03-25", "2024-04-05", ["2024-03-28"]), "NIFTY", 2), ["2024-03-27", "2024-04-04"], "holiday on Thursday: expiry on Wednesday");
console.log("ok   weekly expiries (weekday change, holidays)");

// --- legs and lots
assert.deepEqual(optLegs("ic", 6, 2).map((l) => `${l.act}${l.opt}${l.k}`), ["SCE6", "BCE8", "SPE-6", "BPE-8"]);
assert.deepEqual(optLegs("bps", 5, 2).map((l) => `${l.act}${l.opt}${l.k}`), ["SPE-5", "BPE-7"]);
assert.equal(optLots({ w: 2 }, IDEA_CAPITAL, 50, 65), 10, "2-strike wings: ₹6,500 risk per lot → 10 lots on ₹35 lakh");
assert.equal(optLots({ w: 4 }, IDEA_CAPITAL, 50, 65), 5);
console.log("ok   legs and lots");

// --- synthetic Nifty: 5-minute candles 09:15–15:25 and daily candles; a calm market with one sharp week
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const at = (d, m) => Date.parse(`${d}T00:00:00+05:30`) / 1000 + m * 60;
const D = days("2023-10-02", "2024-03-29"), I5 = [], daily = [];
let px = 21000;
for (const d of D) {
  const o = px;
  const shock = d >= "2024-02-05" && d <= "2024-02-08" ? 120 : 0;
  for (let m = 555; m < 930; m += 5) { const c = px + (rnd() - 0.5) * 12 + shock / 75; I5.push({ t: at(d, m), o: px, h: Math.max(px, c) + 3, l: Math.min(px, c) - 3, c }); px = c; }
  daily.push({ t: at(d, 0), o, h: Math.max(o, px) + 20, l: Math.min(o, px) - 20, c: px });
}
const col = (rows) => ({ t: rows.map((r) => r.t), o: rows.map((r) => r.o), h: rows.map((r) => r.h), l: rows.map((r) => r.l), c: rows.map((r) => r.c) });
db.lab_candles = [{ asset: "NIFTY", kind: "D", from_day: D[0], to_day: D.at(-1), stored: false, bars: col(daily) }, { asset: "NIFTY", kind: "I5", from_day: D[0], to_day: D.at(-1), stored: false, bars: col(I5) }];

// The data as the lab loads it (sessions, by day), for the plan checks.
const byDay = new Map(); for (const b of I5) { const d = new Date((b.t + 19800) * 1000).toISOString().slice(0, 10), min = Math.round(((b.t + 19800) % 86400) / 60); const x = { ...b, day: d, min }; byDay.set(d, [...(byDay.get(d) ?? []), x]); }
const sim = { raw: [...byDay.values()].flat(), byDay, daily: daily.map((x, i) => ({ ...x, day: D[i] })) };
const plans = optPlans(sim, { form: "ic", sd: 1, w: 2, stop: 0 }, "2024-01-01", "2024-03-28", 50);
assert.ok(plans.length >= 11 && plans.length <= 13, `about one trade a week (${plans.length})`);
assert.ok(plans.every((p) => new Date(p.exitDay).getUTCDay() === 4 || p.exitDay === "2024-03-27"), "out on expiry Thursdays");
assert.ok(plans.every((p) => p.entryMin === 570 && p.sk.length === 4 && p.sk[0].k >= 1 && p.sk[1].k <= 10), "short strikes inside Dhan's 10 strikes");
const wide = optPlans(sim, { form: "ic", sd: 30, w: 4, stop: 0 }, "2024-01-01", "2024-03-28", 50);
assert.ok(wide.every((p) => p.sk[1].k === 10 && p.sk[0].k === 6), "30 SD would be beyond the data: capped at 10 − wing");
const stopped = optPlans(sim, { form: "ic", sd: 1, w: 2, stop: 1 }, "2024-01-01", "2024-03-28", 50);
const hit = stopped.filter((p) => p.exitWhy === "Nifty touched a short strike").find((p) => p.entryDay >= "2024-02-01" && p.entryDay <= "2024-02-08");
assert.ok(hit && hit.entryDay >= "2024-02-01" && hit.entryDay <= "2024-02-08", "the sharp week touches a short strike");
console.log("ok   weekly plans, strikes from volatility, stop on a short strike");

// --- pricing through the real backtester from cached option series (no Dhan calls)
const ANCHOR = Date.parse("2020-01-01");
const winStart = (d) => new Date(ANCHOR + Math.floor((Date.parse(d) - ANCHOR) / 86400000 / 30) * 30 * 86400000).toISOString().slice(0, 10);
const thursdayOnOrAfter = (d) => { let x = Date.parse(d); while (new Date(x).getUTCDay() !== 4) x += 86400000; return x; };
db.lab_opt_cache = [];
const series = new Map();
for (const d of D) for (const b of byDay.get(d)) {
  if (b.min !== 570 && b.min !== 870 && b.min % 30 !== 0) continue;
  const spot = b.o, atm = Math.round(spot / 50) * 50, dte = Math.max(0, (thursdayOnOrAfter(d) - Date.parse(d)) / 86400000);
  for (const type of ["CALL", "PUT"]) for (let k = -10; k <= 10; k++) {
    const K = atm + k * 50, intr = Math.max(0, type === "CALL" ? spot - K : K - spot);
    const prem = +(intr + 60 * Math.exp(-Math.abs(K - spot) / 150) * Math.sqrt((dte + 0.2) / 5)).toFixed(2);
    const key = `13|NSE_FNO|W|${type}|${k}|1|${winStart(d)}`;
    const s = series.get(key) ?? { t: [], o: [], h: [], l: [], c: [], s: [], p: [] };
    s.t.push(b.t); s.o.push(prem); s.h.push(prem); s.l.push(prem); s.c.push(prem); s.s.push(K); s.p.push(spot); series.set(key, s);
  }
}
for (const [key, bars] of series) db.lab_opt_cache.push({ key, bars });
db.margin_rates = [];
const real = Date.now; Date.now = () => Date.parse("2026-10-24T12:00:00+05:30");
const sb = createClient();
const leg = { id: 1, try_id: 1, asset: "NIFTY", win_from: "2024-01-01", win_to: "2024-03-28", config: { idea: "optsell", setting: "ic-1sd", p: { form: "ic", sd: 1, w: 2, stop: 0 } }, result: null };
let r, slices = 0;
for (; slices < 50; slices++) { r = await optionSlice(sb, leg, { client: "x", token: "y" }, IDEA_CAPITAL, Date.now()); if (r.done) break; leg.result = r.result; }
Date.now = real;
console.log("priced in", slices + 1, "slices:", r.result.n, "trades, unpriced", r.result.unpriced, r.result.skipped, "edge legs", r.result.edge, "net per lot", r.result.t.n.slice(0, 6));
assert.ok(r.done && !r.result.error && r.result.unpriced === 0 && r.result.n === r.result.planned && r.result.n >= 11, "every week priced, the sharp one too");
assert.ok(r.result.edge > 0, "the sharp week needed strikes beyond the data");
const sharp = r.result.t.n.find((_, i) => r.result.t.e[i] >= "2024-02-01" && r.result.t.e[i] <= "2024-02-08");
assert.ok(sharp < 0, `the sharp week loses (${sharp} per lot)`);
assert.ok(r.result.t.q.every((q) => q === 10), "10 lots on every trade");
const calm = r.result.t.n.filter((_, i) => !(r.result.t.e[i] >= "2024-02-01" && r.result.t.e[i] <= "2024-02-08"));
assert.ok(calm.filter((x) => x > 0).length >= calm.length * 0.7, "premium sellers keep most of the premium in calm weeks");
const c = combineTry([{ asset: "NIFTY", result: r.result }], { today: "2026-10-24" });
assert.equal(c.lots.NIFTY, 10); assert.equal(c.trades, r.result.n); assert.equal(c.net, r.result.t.n.reduce((a, x) => a + x * 10, 0)); assert.equal(c.planned, r.result.n); assert.equal(c.unpriced, 0);
console.log("ok   option pricing from cached series, lots fixed by risk, portfolio totals");
console.log("all passed");
