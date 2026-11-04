// Reads of more than 1,000 rows (4 Nov 2026): the database caps every answer at 1,000 rows, so a finalist's 1,800
// shuffled-price rows plus its random-entry row were cut off and the random-entry test read as "didn't finish".
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { db, LIMITS, createClient } = await import("./fakesb.mjs");
const { pagedRows } = await import("./lab.mjs");
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const sb = createClient();
LIMITS.maxRows = 1000;
db.idea_legs = [...Array.from({ length: 1800 }, (_, i) => ({ id: i + 1, try_id: 134, kind: "noise", k: i % 100, result: { net: 1 } })), { id: 1801, try_id: 134, kind: "random", k: 0, result: { p: 0.27, runs: 1000 } }];
await t("a plain read stops at 1,000 rows (the random-entry row is lost) — what went wrong", async () => {
  const { data } = await sb.from("idea_legs").select("*").eq("try_id", 134).limit(5000);
  assert.equal(data.length, 1000); assert.ok(!data.some((r) => r.kind === "random"));
});
await t("pagedRows reads all 1,801 rows, the random-entry row included", async () => {
  const rows = await pagedRows((a, b) => sb.from("idea_legs").select("*").eq("try_id", 134).order("id").range(a, b));
  assert.equal(rows.length, 1801); assert.ok(rows.some((r) => r.kind === "random"));
});
await t("pagedRows on fewer than 1,000 rows: one request", async () => {
  let calls = 0;
  const rows = await pagedRows((a, b) => { calls++; return sb.from("idea_legs").select("*").eq("kind", "random").order("id").range(a, b); });
  assert.equal(rows.length, 1); assert.equal(calls, 1);
});
LIMITS.maxRows = Infinity;
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
