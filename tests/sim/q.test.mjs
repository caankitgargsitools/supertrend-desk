import { robustVerdict, packTrades } from "./lab.mjs";
const mk = (nets) => { const ts = []; const months = ["2025-11-15","2025-12-15","2026-01-15","2026-02-15","2026-03-15","2026-04-15","2026-05-15","2026-06-15","2026-07-15","2026-08-15","2026-09-15","2026-10-05"]; months.forEach((d, i) => ts.push({ entry: d + " 10:00", exit: d + " 14:00", side: "LONG", entry_px: 100, exit_px: 101, net: nets[i], exit_why: "x" })); return packTrades(ts); };
const base = (nets) => [
  { kind: "self", asset: "SILVERM", tf: null, result: { net: 50000, max_dd: 10000 } },
  { kind: "asset", asset: "GOLD", tf: null, result: { ok: true } },
  { kind: "tf", asset: "SILVERM", tf: 60, result: { ok: true } },
  { kind: "year", asset: "SILVERM", tf: 1, result: { ok: true, net: nets.reduce((a, b) => a + b, 0), xcost: 1000, from: "2025-10-11", to: "2026-10-11", tr: mk(nets) } },
];
const cfg = { underlying: "SILVERM", rules: {}, direction: "BOTH" };
const a = robustVerdict(cfg, base([1000,1000,1000, 1000,1000,1000, -5000,1000,1000, 1000,1000,1000]));
console.log("3 of 4 →", a.passed, a.why, a.quarters.list.map((q) => q.net));
const b = robustVerdict(cfg, base([-1000,-1000,1000, -5000,1000,1000, -5000,1000,1000, 1000,1000,1000]));
console.log("2 of 4 →", b.passed, b.why);
const c = robustVerdict({ ...cfg, rules: { daily: true } }, base(Array(12).fill(1000)));
console.log("daily, 1 yr →", c.passed, c.why);
