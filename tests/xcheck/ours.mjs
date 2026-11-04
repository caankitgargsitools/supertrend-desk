// Our backtester (simulateRules) on the given daily candles; prints its trades as JSON.
globalThis.Deno = { env: { get: () => "" } };
const { simulateRules } = await import("./backtest.mjs");
import fs from "node:fs";
const [file, rulesJson, riskJson] = process.argv.slice(2);
const bars = JSON.parse(fs.readFileSync(file, "utf8"));
const daily = bars.map((b) => ({ ...b, day: new Date((b.t + 19800) * 1000).toISOString().slice(0, 10) }));
const s = { data_segment: "DELTA", underlying: "X", trade_type: "FUTURES", direction: "BOTH", entry_mode: "FLIP", timeframe_min: 1440, strike_step: 1,
  rules: JSON.parse(rulesJson), risk: riskJson ? JSON.parse(riskJson) : null };
const plans = simulateRules(s, { raw: [], byDay: new Map(), daily }, daily[0].day, daily.at(-1).day);
console.log(JSON.stringify(plans.map((p) => ({ side: p.side, in: p.entryDay, out: p.exitDay, pin: p.spotIn, pout: p.spotOut, why: p.exitWhy }))));
