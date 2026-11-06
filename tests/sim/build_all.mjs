// Bundles the engine (and its parts) for the Node tests below; npm: imports go to the in-memory fake database.
import { build } from "esbuild";
import fs from "node:fs";
const here = process.cwd(), E = "../../supabase/functions/engine/";
const plug = { name: "npm", setup(b) { b.onResolve({ filter: /^npm:/ }, (a) => a.path.includes("web-push") ? { path: here + "/stub_webpush.mjs", external: true } : { path: here + "/fakesb.mjs", external: true }); } };
const one = (entry, out) => build({ entryPoints: [E + entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error", plugins: [plug] });
await one("lab.ts", "lab.mjs");
await one("execution.ts", "exec.mjs");
await one("audit.ts", "audit.mjs");
await one("dhan.ts", "dhan.mjs");
await one("owncandles.ts", "own.mjs");
await one("stats.ts", "stats.mjs");
await one("noise.ts", "noise.mjs");
await one("kill.ts", "kill.mjs");
await one("ideas.ts", "ideas.mjs");
await one("prediction.ts", "pred.mjs");
await one("sizing.ts", "sizing.mjs");
await one("margins.ts", "margins.mjs");
// Pure parts used by the strategy-research tests (6 Nov 2026): rules, indicators, calendar maths, the backtester, risk.
await one("rules.ts", "rules.mjs");
await one("indicators.ts", "indicators.mjs");
await one("logic.ts", "logic.mjs");
await one("backtest.ts", "backtest.mjs");
await one("risk.ts", "risk.mjs");
console.log("built parts");
