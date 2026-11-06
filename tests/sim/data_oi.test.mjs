// Volume and open interest as data (6 Nov 2026, audit step 1): candle files keep v for every asset and oi where Dhan
// reports it; older files without them keep working; the session VWAP is volume-weighted where volume exists; the OI
// rules read the candles' open interest.
import assert from "node:assert/strict";
globalThis.Deno = { env: { get: () => "" } };
const { toCol, fromCol } = await import("./lab.mjs");
const { aggregate } = await import("./logic.mjs");
const { vwap } = await import("./indicators.mjs");
const { RuleBook, validateRules, describeCond } = await import("./rules.mjs");
const { Dhan } = await import("./dhan.mjs");
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };

const day = "2026-11-05", t0 = Date.parse(`${day}T09:00:00+05:30`) / 1000;
const rows = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 300, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 * (i + 1), oi: 50000 + 100 * i }));

await t("toCol keeps volume and open interest; fromCol gives them back", () => {
  const col = toCol(rows, true);
  assert.deepEqual(Object.keys(col).sort(), ["c", "h", "l", "o", "oi", "t", "v"]);
  const back = fromCol(col);
  assert.equal(back[3].v, 4000); assert.equal(back[3].oi, 50300); assert.equal(back[3].c, 103.5);
});
await t("an all-zero open interest (indices, shares) is left out of the file", () => {
  const col = toCol(rows.map((r) => ({ ...r, oi: 0 })), true);
  assert.ok(col.v && !col.oi);
});
await t("an older file without v / oi reads as zero volume and unknown open interest", () => {
  const old = { t: [1, 2], o: [1, 1], h: [1, 1], l: [1, 1], c: [1, 1] };
  const back = fromCol(old);
  assert.equal(back[0].v, 0); assert.equal(back[0].oi, undefined); assert.equal(back.length, 2);
});
await t("aggregate sums volume and carries the last base candle's open interest", () => {
  const bars = aggregate(rows, 15, "MCX_COMM");
  assert.equal(bars.length, 4); assert.equal(bars[0].v, 1000 + 2000 + 3000); assert.equal(bars[0].oi, 50200); assert.equal(bars[3].oi, 51100);
});
await t("session VWAP is volume-weighted where volume exists, time-weighted where it is zero", () => {
  const withV = [{ day, h: 10, l: 10, c: 10, v: 1 }, { day, h: 20, l: 20, c: 20, v: 3 }];
  assert.equal(vwap(withV)[1], 17.5);
  const noV = withV.map((x) => ({ ...x, v: 0 }));
  assert.equal(vwap(noV)[1], 15);
});
await t("Dhan's chart answers: open_interest kept where it has values, dropped where it is all zero or missing", async () => {
  const ans = { timestamp: [1760000000, 1760000300], open: [1, 1], high: [2, 2], low: [0.5, 0.5], close: [1.5, 1.5], volume: [10, 20] };
  const bodies = [];
  globalThis.fetch = async (url, o) => { const b = JSON.parse(o.body); bodies.push(b);
    const oi = b.exchangeSegment === "MCX_COMM" ? { open_interest: [1200, 1300] } : b.exchangeSegment === "IDX_I" ? { open_interest: [0, 0] } : {};
    return new Response(JSON.stringify({ ...ans, ...oi })); };
  const d = new Dhan("c", "tok");
  const mcx = await d.intraday("444", "MCX_COMM", "FUTCOM", 5, "2026-10-01 09:00:00", "2026-10-02 09:00:00");
  const idx = await d.daily("13", "IDX_I", "INDEX", "2026-10-01", "2026-10-02");
  const eq = await d.intraday("2885", "NSE_EQ", "EQUITY", 5, "2026-10-01 09:00:00", "2026-10-02 09:00:00");
  assert.equal(mcx[1].oi, 1300); assert.equal(mcx[1].v, 20); assert.equal(idx[0].oi, undefined); assert.equal(eq[0].oi, undefined);
  assert.ok(bodies.every((b) => b.oi === true), "both chart calls ask for open interest");
});
await t("OI rules: rising / falling and the build-ups; unknown open interest never matches", () => {
  const seg = "MCX_COMM", frames = new Map([[5, aggregate(rows, 5, seg)]]);
  const byDay = new Map([[day, rows.map((r) => ({ min: 540 + Math.round((r.t - t0) / 60), h: r.h, l: r.l }))]]);
  const T = frames.get(5)[11].endT;
  const book = (op, n = 3) => new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "OI", tf: "base", p: { n }, op }] } }), 5, frames, [], byDay, seg);
  assert.equal(book("oi_rising").at(T).long, true);
  assert.equal(book("oi_falling").at(T).long, false);
  assert.equal(book("oi_up_price_up").at(T).long, true, "OI up and price up = long build-up");
  assert.equal(book("oi_up_price_down").at(T).long, false);
  const falling = aggregate(rows.map((r, i) => ({ ...r, c: 200 - i, o: 200 - i, h: 201 - i, l: 199 - i })), 5, seg);
  const b2 = new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "OI", tf: "base", p: { n: 3 }, op: "oi_up_price_down" }] } }), 5, new Map([[5, falling]]), [], byDay, seg);
  assert.equal(b2.at(falling[11].endT).long, true, "OI up and price down = short build-up");
  const noOi = aggregate(rows.map(({ oi: _o, ...r }) => r), 5, seg);
  const b3 = new RuleBook(validateRules({ long: { mode: "ALL", conds: [{ ind: "OI", tf: "base", p: { n: 3 }, op: "oi_rising" }] } }), 5, new Map([[5, noOi]]), [], byDay, seg);
  assert.equal(b3.at(noOi[11].endT).long, false);
  assert.match(describeCond({ ind: "OI", tf: "base", p: { n: 5 }, op: "oi_up_price_up" }), /Open interest \(vs 5 candles ago\) own timeframe rising with the price rising/);
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
