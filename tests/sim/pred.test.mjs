// Prediction Lab engine side: the server key, its write (validated, whole-month figures) and read.
import assert from "node:assert";
import { createHash } from "node:crypto";
import { createClient, db } from "./fakesb.mjs";
import { predKeyOk, predPull, predPush } from "./pred.mjs";

const sb = createClient();
const key = "pk_" + "ab".repeat(24);
db.pred_settings = [{ id: 1, enabled: true, model: "mini", tfs: [5, 15, 30, 60, 240, 1440], horizon: 10, lookback: 256, replay_from: "2025-09-01", key_hash: createHash("sha256").update(key).digest("hex") }];
db.pred_worker = [{ id: 1 }]; db.pred_stats = []; db.pred_latest = []; db.pred_bars = [{ asset: "NIFTY", contract: null, bars: { t: [1], o: [1], h: [1], l: [1], c: [1] } }]; db.market_holidays = []; db.lab_candles = [];

assert.equal(await predKeyOk(sb, key), true);
assert.equal(await predKeyOk(sb, key + "x"), false);
assert.equal(await predKeyOk(sb, null), false);
db.pred_settings[0].key_hash = null;
assert.equal(await predKeyOk(sb, key), false, "no key made yet: nothing opens");
console.log("ok   server key: only the matching key opens the door");

const row = { asset: "NIFTY", tf: 15, h: 1, month: "2025-10", mode: "replay", n: 10, dir_n: 9, hit: 6, hit_mom: 4, ae_k: 1.5, ae_flat: 2, d_sum: 0.5, d_sq: 0.1, re_k: 1, re_atr: 1.2, r_sum: 0.2, r_sq: 0.01 };
const r = await predPush(sb, { worker: { version: "1.0", status: "live", detail: { mem_mb: 600 } },
  stats: [row, { ...row, asset: "NOPE" }, { ...row, tf: 7 }, { ...row, month: "2025-1" }, { ...row, mode: "x" }],
  latest: [{ asset: "NIFTY", tf: 15, made_at: 1793000000, last_close: 25000, path: [{ t: 1, o: 1, h: 1, l: 1, c: 1 }], actual: [], recent: [] }, { asset: "NIFTY", tf: 15, path: "bad" }] });
assert.equal(r.stats, 1, "unknown assets, timeframes, months and modes are refused");
assert.equal(r.latest, 1);
assert.equal(db.pred_stats.length, 1); assert.equal(db.pred_worker[0].status, "live"); assert.ok(db.pred_worker[0].last_seen);
await predPush(sb, { stats: [{ ...row, n: 12 }] });
assert.equal(db.pred_stats.length, 1); assert.equal(db.pred_stats[0].n, 12, "a resend replaces the month's figures, never adds twice");
console.log("ok   server write: heartbeat, latest forecast, monthly totals (validated, idempotent)");

const p = await predPull(sb, { files: false });
assert.equal(p.settings.horizon, 10); assert.ok(p.assets.some((a) => a.key === "NIFTY" && !a.crypto)); assert.equal(p.bars.length, 1); assert.equal(p.files, undefined);
assert.ok(!JSON.stringify(p).includes("key_hash"), "the read never returns the key's fingerprint");
console.log("ok   server read: settings, assets, live bars");
console.log("all passed");
