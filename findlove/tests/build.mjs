// Bundle match.ts for Node tests (esbuild from ../../tests/sim/node_modules — run `cd tests/sim && npm install` once).
import { build } from "../../tests/sim/node_modules/esbuild/lib/main.js";
await build({ entryPoints: ["../supabase/functions/findlove/match.ts"], bundle: true, format: "esm", platform: "node", outfile: "match.mjs", logLevel: "warning" });
console.log("built");
