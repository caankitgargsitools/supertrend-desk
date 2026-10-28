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
await predPush(sb, { stats: [{ ...row, n: 12, conf: { lo: [3, 1], mid: [4, 3], hi: [2, "x"], evil: [9, 9] }, cal_n: 5, hit_cal: 4 }] });
assert.deepEqual(db.pred_stats[0].conf, { lo: [3, 1], mid: [4, 3], hi: [2, 0] }, "confidence bands kept, junk dropped");
assert.equal(db.pred_stats[0].hit_cal, 4);
assert.equal(db.pred_stats.length, 1); assert.equal(db.pred_stats[0].n, 12, "a resend replaces the month's figures, never adds twice");
console.log("ok   server write: heartbeat, latest forecast, monthly totals (validated, idempotent)");

db.pred_models = [];
const mr = await predPush(sb, { model_run: { name: "chaturbhuj-ft-2026-10-28", trained_at: "2026-10-28T10:00:00Z", cutoff: "2025-09-01", weights_url: "https://github.com/caankitgargsitools/supertrend-desk/releases/download/x/chaturbhuj-ft.safetensors", train: { steps: 5 }, eval: { rows: [] } } });
assert.equal(mr.model_run, 1); assert.ok(db.pred_models.some((m) => m.name === "chaturbhuj-ft-2026-10-28" && m.weights_url));
await predPush(sb, { model_run: { name: "chaturbhuj-evil", weights_url: "https://evil.example/w.bin", train: {}, eval: {} } });
assert.equal(db.pred_models.find((m) => m.name === "chaturbhuj-evil").weights_url, null, "weights only from our own GitHub releases");
const bad = await predPush(sb, { model_run: { name: "../../x", train: {} } });
assert.ok(!bad.model_run && !db.pred_models.some((m) => m.name === "../../x"), "bad names are ignored");
console.log("ok   fine-tuning runs: kept, weights link only from our GitHub releases");
const p = await predPull(sb, { files: false });
assert.equal(p.settings.horizon, 10); assert.ok(p.assets.some((a) => a.key === "NIFTY" && !a.crypto)); assert.equal(p.bars.length, 1); assert.equal(p.files, undefined);
assert.ok(!JSON.stringify(p).includes("key_hash"), "the read never returns the key's fingerprint");
console.log("ok   server read: settings, assets, live bars");
console.log("all passed");

// GitHub's signed token for the fine-tuning workflow: only this repository, its main branch and that workflow get in.
{
  const { githubOidcOk } = await import("./pred.mjs");
  const { subtle } = globalThis.crypto;
  const kp = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
  const b64 = (u8) => Buffer.from(u8).toString("base64url");
  const sign = async (claims, kid = "k1", key = kp.privateKey) => {
    const h = b64(Buffer.from(JSON.stringify({ alg: "RS256", kid }))), p = b64(Buffer.from(JSON.stringify(claims)));
    return `${h}.${p}.${b64(new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(`${h}.${p}`))))}`;
  };
  const now = 1793200000, keys = async () => [jwk];
  const good = { iss: "https://token.actions.githubusercontent.com", aud: "ankgenie-prediction", repository: "caankitgargsitools/supertrend-desk", ref: "refs/heads/main",
    job_workflow_ref: "caankitgargsitools/supertrend-desk/.github/workflows/chaturbhuj-finetune.yml@refs/heads/main", exp: now + 300, nbf: now - 10 };
  assert.equal(await githubOidcOk(await sign(good), now, keys), true);
  for (const [why, c] of [["fork", { repository: "someone/supertrend-desk" }], ["branch", { ref: "refs/heads/evil" }], ["workflow", { job_workflow_ref: "caankitgargsitools/supertrend-desk/.github/workflows/other.yml@refs/heads/main" }],
    ["audience", { aud: "sts.amazonaws.com" }], ["issuer", { iss: "https://evil.example" }], ["expired", { exp: now - 1 }]]) {
    assert.equal(await githubOidcOk(await sign({ ...good, ...c }), now, keys), false, why);
  }
  const other = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  assert.equal(await githubOidcOk(await sign(good, "k1", other.privateKey), now, keys), false, "signed by someone else");
  assert.equal(await githubOidcOk("not.a.token", now, keys), false);
  assert.equal(await githubOidcOk(null, now, keys), false);
  console.log("ok   GitHub-signed token: only this repository's main-branch fine-tuning workflow; forks, branches, other workflows, expired or forged tokens refused");
}
