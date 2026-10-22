import { build } from "esbuild";
import fs from "node:fs";
const src = fs.readFileSync("../../supabase/functions/engine/index.ts", "utf8");
fs.writeFileSync("../../supabase/functions/engine/__sim.ts", src + "\nexport { secondRisk, liveTest, queueDhan, runOrders, syncStop, checkStop, reconcile, sendDelta, sb as __sb };\n");
const here = process.cwd();
await build({ entryPoints: ["../../supabase/functions/engine/__sim.ts"], bundle: true, format: "esm", platform: "node", outfile: "engine.mjs", logLevel: "warning",
  plugins: [{ name: "npm", setup(b) {
    b.onResolve({ filter: /^npm:/ }, (a) => a.path.includes("supabase-js") ? { path: here + "/fakesb.mjs", external: true } : a.path.includes("web-push") ? { path: here + "/stub_webpush.mjs", external: true } : { path: a.path, external: true });
  } }] });
fs.unlinkSync("../../supabase/functions/engine/__sim.ts");
console.log("built");
