import { build } from "../sim/node_modules/esbuild/lib/main.js";
const here = new URL("../sim", import.meta.url).pathname;
await build({ entryPoints: [new URL("../../supabase/functions/engine/backtest.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: process.argv[2], logLevel: "error",
  plugins: [{ name: "npm", setup(b) { b.onResolve({ filter: /^npm:/ }, (a) => ({ path: here + "/fakesb.mjs", external: true })); } }] });
