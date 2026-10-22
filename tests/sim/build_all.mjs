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
console.log("built parts");
