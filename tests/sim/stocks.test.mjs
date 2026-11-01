// Stock futures (stocks.ts): split / bonus detection and adjustment, adjusted reads of the lab's files and of Dhan's
// candles, the near-month stock future picked for an order, and the F&O list keeping stock futures.
import assert from "node:assert/strict";
import { build } from "esbuild";
const here = process.cwd(), E = "../../supabase/functions/engine/";
const plug = { name: "npm", setup(b) { b.onResolve({ filter: /^npm:/ }, () => ({ path: here + "/fakesb.mjs", external: true })); } };
for (const [e, o] of [["stocks.ts", "stocks.mjs"], ["candles.ts", "candles.mjs"], ["execution.ts", "exec.mjs"], ["dhan.ts", "dhan.mjs"]])
  await build({ entryPoints: [E + e], bundle: true, format: "esm", platform: "node", outfile: o, logLevel: "error", plugins: [plug] });
const S = await import("./stocks.mjs");
const { db, createClient } = await import("./fakesb.mjs");
const sb = createClient();
let fails = 0;
const t = async (n, f) => { try { await f(); console.log("ok  ", n); } catch (e) { fails++; console.log("FAIL", n, "—", e.message); } };
const day = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
const series = (n, jumps) => { let p = 2000; const out = []; for (let i = 0; i < n; i++) { const j = jumps[i]; const o = j ? p * j.o : p * (1 + ((i * 7) % 5 - 2) / 1000); const c = j ? p * j.c : o * 1.001; out.push({ day: day(i), o, c, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998 }); p = c; } return out; };

await t("a 5:1 split and a 1:1 bonus are found; a 10% fall and a gap that recovers are not", async () => {
  const d = series(60, { 10: { o: 0.2, c: 0.201 }, 30: { o: 0.5, c: 0.505 }, 40: { o: 0.9, c: 0.88 }, 50: { o: 0.5, c: 0.95 } });
  const f = S.findSplits(d);
  assert.deepEqual(f.map((x) => [x.day, x.factor]), [[day(10), 1 / 5], [day(30), 1 / 2]]);
});
await t("prices before each action are divided by it (two actions multiply); volume the other way", async () => {
  const acts = [{ day: day(10), factor: 1 / 5, d: true, i: true }, { day: day(30), factor: 1 / 2, d: true, i: false }];
  assert.equal(S.factorBefore(acts, day(5), "d"), 0.1); assert.equal(S.factorBefore(acts, day(20), "d"), 0.5); assert.equal(S.factorBefore(acts, day(30), "d"), 1);
  assert.equal(S.factorBefore(acts, day(5), "i"), 0.2, "the bonus only where that source wasn't adjusted");
  const rows = S.adjustRows([{ day: day(5), o: 1000, h: 1000, l: 1000, c: 1000, v: 10 }, { day: day(31), o: 100, h: 100, l: 100, c: 100, v: 10 }], acts, "d");
  assert.equal(rows[0].c, 100); assert.equal(rows[0].v, 100); assert.equal(rows[1].c, 100);
  const d = series(40, { 10: { o: 0.2, c: 0.2 }, 30: { o: 0.5, c: 0.5 } });
  const adj = S.adjustRows(d, acts, "d");
  for (let i = 1; i < adj.length; i++) assert.ok(Math.abs(adj[i].o / adj[i - 1].c - 1) < 0.01, `no jump left at ${adj[i].day}`);
});
await t("intraday candles give per-day open / close; a split between days is found there too", async () => {
  const rows = []; let p = 1500;
  for (let i = 0; i < 6; i++) { const t0 = Date.parse(`${day(i)}T09:15:00+05:30`) / 1000; if (i === 3) p /= 2; for (let k = 0; k < 75; k++) rows.push({ t: t0 + k * 300, o: p, h: p, l: p, c: p }); }
  const days = S.daysOf(rows); assert.equal(days.length, 6); assert.deepEqual(S.findSplits(days).map((x) => x.day), [day(3)]);
});
await t("the lab's stored candles of a stock are read adjusted (raw on request); an index is left alone", async () => {
  const { saveCandles, readCandles } = await import("./candles.mjs");
  db.lab_candles = []; db.stock_actions = [{ asset: "KOTAKBANK", day: day(10), factor: 0.2, in_daily: true, in_intraday: true }];
  S.setStockActions([]); // force a reload from the table
  await S.loadStockActions(sb, true);
  const bars = { t: [Date.parse(`${day(5)}T00:00:00+05:30`) / 1000, Date.parse(`${day(12)}T00:00:00+05:30`) / 1000], o: [2000, 400], h: [2000, 400], l: [2000, 400], c: [2000, 400] };
  for (const asset of ["KOTAKBANK", "NIFTY"]) await saveCandles(sb, { asset, kind: "D", from_day: day(5), to_day: day(12), bars: JSON.parse(JSON.stringify(bars)) });
  const k = (await readCandles(sb, "KOTAKBANK", ["D"]))[0]; assert.deepEqual(k.bars.c, [400, 400]);
  const raw = (await readCandles(sb, "KOTAKBANK", ["D"], true))[0]; assert.deepEqual(raw.bars.c, [2000, 400]);
  const n = (await readCandles(sb, "NIFTY", ["D"]))[0]; assert.deepEqual(n.bars.c, [2000, 400]);
});
await t("found actions are stored and merged (daily and intraday flags), never removed", async () => {
  db.stock_actions = []; S.setStockActions([]);
  await S.saveStockActions(sb, "HDFCBANK", [{ day: "2025-08-26", factor: 0.5 }], []);
  await S.saveStockActions(sb, "HDFCBANK", [], [{ day: "2025-08-26", factor: 0.5 }]);
  assert.equal(db.stock_actions.length, 1); assert.equal(db.stock_actions[0].in_daily, true); assert.equal(db.stock_actions[0].in_intraday, true);
  assert.deepEqual(S.actionsFor("HDFCBANK"), [{ day: "2025-08-26", factor: 0.5, d: true, i: true }]);
});
await t("Dhan's candles for a stock come back adjusted (raw when the lab asks); an index's are left alone", async () => {
  await build({ stdin: { contents: 'export { Dhan } from "./dhan.ts"; export { setStockActions } from "./stocks.ts";', resolveDir: E, loader: "ts" }, bundle: true, format: "esm", platform: "node", outfile: "dhanS.mjs", logLevel: "error", plugins: [plug] });
  const M = await import("./dhanS.mjs");
  M.setStockActions([{ asset: "KOTAKBANK", day: day(10), factor: 0.2, in_daily: true, in_intraday: true }]);
  const ts = [Date.parse(`${day(5)}T09:15:00+05:30`) / 1000, Date.parse(`${day(12)}T09:15:00+05:30`) / 1000];
  globalThis.fetch = async () => new Response(JSON.stringify({ timestamp: ts, open: [2000, 400], high: [2000, 400], low: [2000, 400], close: [2000, 400], volume: [1, 1] }));
  const d = new M.Dhan("c", "tok");
  assert.deepEqual((await d.intraday("1922", "NSE_EQ", "EQUITY", 5, `${day(5)} 09:00:00`, `${day(12)} 15:30:00`)).map((r) => r.c), [400, 400]);
  assert.deepEqual((await d.daily("1922", "NSE_EQ", "EQUITY", day(5), day(13))).map((r) => r.c), [400, 400]);
  assert.deepEqual((await d.intraday("13", "IDX_I", "INDEX", 5, `${day(4)} 09:00:00`, `${day(12)} 15:30:00`)).map((r) => r.c), [2000, 400]);
  const raw = new M.Dhan("c", "tok"); raw.adjust = false;
  assert.deepEqual((await raw.intraday("1922", "NSE_EQ", "EQUITY", 5, `${day(3)} 09:00:00`, `${day(12)} 15:30:00`)).map((r) => r.c), [2000, 400]);
});
await t("an order for RELIANCE1! goes to the near-month RELIANCE stock future; NIFTY1! still to the index future", async () => {
  const X = await import("./exec.mjs");
  const iso = new Date().toISOString(), today = new Date(Date.now() + 19800000).toISOString().slice(0, 10), later = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  db.fno_contracts = [
    { seg: "NSE_FNO", sec_id: "55001", underlying: "RELIANCE", instrument: "FUTSTK", expiry: later(20), lot: 500, tick: 0.1, display: "RELIANCE NOV FUT", synced_at: iso },
    { seg: "NSE_FNO", sec_id: "55002", underlying: "RELIANCE", instrument: "FUTSTK", expiry: later(50), lot: 500, tick: 0.1, display: "RELIANCE DEC FUT", synced_at: iso },
    { seg: "NSE_FNO", sec_id: "35001", underlying: "NIFTY", instrument: "FUTIDX", expiry: later(20), lot: 65, tick: 0.1, display: "NIFTY NOV FUT", synced_at: iso },
  ];
  const s = { exchange: "NSE", lot_size: 500 };
  const k = await X.resolveLeg(sb, { client: "c", token: "t" }, s, { exchange: "NSE", symbol: "RELIANCE1!", instrument: "FUT" }, today);
  assert.equal(k.sec, "55001"); assert.equal(k.lot, 500); assert.equal(k.option, false);
  const n = await X.resolveLeg(sb, { client: "c", token: "t" }, { exchange: "NSE", lot_size: 65 }, { exchange: "NSE", symbol: "NIFTY1!", instrument: "FUT" }, today);
  assert.equal(n.sec, "35001");
  assert.equal(X.brokerQty("NSE_FNO", 2, 500), 1000, "NSE quantity in shares");
});
await t("Dhan's F&O list: the desk's stock futures are kept (underlying from the trading symbol when the column is empty), other stocks skipped", async () => {
  const X = await import("./exec.mjs");
  const exp = new Date(Date.now() + 25 * 86400000).toISOString().slice(0, 10);
  const csv = ["SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SYMBOL_NAME,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,LOT_SIZE,TICK_SIZE,DISPLAY_NAME",
    `55121,FUTSTK,,RELIANCE-Nov2026-FUT,${exp},-0.01,XX,500,10,RELIANCE NOV FUT`,
    `55122,FUTSTK,KOTAKBANK,KOTAKBANK-Nov2026-FUT,${exp},-0.01,XX,2000,5,KOTAKBANK NOV FUT`,
    `55123,FUTSTK,,YESBANK-Nov2026-FUT,${exp},-0.01,XX,9000,1,YESBANK NOV FUT`,
    `55124,OPTSTK,RELIANCE,RELIANCE-Nov2026-1400-CE,${exp},1400,CE,500,5,RELIANCE 1400 CE`,
    `35001,FUTIDX,NIFTY,NIFTY-Nov2026-FUT,${exp},-0.01,XX,65,10,NIFTY NOV FUT`].join("\n");
  db.fno_contracts = [];
  globalThis.fetch = async (url) => new Response(String(url).includes("NSE_FNO") ? csv : "SECURITY_ID,INSTRUMENT,UNDERLYING_SYMBOL,SM_EXPIRY_DATE\n");
  const n = await X.syncFno(sb, { client: "c", token: "t" });
  assert.equal(n, 3);
  assert.deepEqual(db.fno_contracts.map((r) => [r.underlying, r.instrument, r.lot]).sort(), [["KOTAKBANK", "FUTSTK", 2000], ["NIFTY", "FUTIDX", 65], ["RELIANCE", "FUTSTK", 500]]);
});
await t("the lab's candle download for a stock finds Kotak's 5:1 split in Dhan's raw candles; reads come back smooth; generated strategies are stock futures", async () => {
  const L = await import("./lab.mjs");
  const C = await import("./candles.mjs");
  const split = "2025-12-15", px = (d) => (d < split ? 2000 : 400) * (1 + (Number(d.slice(8, 10)) % 3) / 1000);
  globalThis.fetch = async (url, o) => {
    const b = JSON.parse(o.body), daily = String(url).includes("historical"), ts = [], v = [];
    const from = String(b.fromDate).slice(0, 10), to = String(b.toDate).slice(0, 10);
    for (let d = from; d < (daily ? to : to + "~"); d = new Date(Date.parse(d + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)) {
      const wd = new Date(d + "T00:00:00Z").getUTCDay(); if (wd === 0 || wd === 6) continue;
      if (daily) { ts.push(Date.parse(`${d}T00:00:00+05:30`) / 1000); v.push(px(d)); }
      else for (let k = 0; k < 75; k += 25) { ts.push(Date.parse(`${d}T09:15:00+05:30`) / 1000 + k * 300); v.push(px(d)); }
    }
    return new Response(JSON.stringify({ timestamp: ts, open: v, high: v, low: v, close: v, volume: v.map(() => 1) }));
  };
  db.stock_actions = []; db.lab_candles = [];
  const today = "2026-10-30";
  await L.refreshAsset(sb, { client: "c", token: "t" }, "KOTAKBANK", today);
  const acts = db.stock_actions.filter((r) => r.asset === "KOTAKBANK");
  assert.deepEqual(acts.map((r) => [r.day, r.factor, r.in_daily, r.in_intraday]), [[split, 0.2, true, true]]);
  const [d] = await L.readCandles(sb, "KOTAKBANK", ["D"]);
  for (let i = 1; i < d.bars.c.length; i++) assert.ok(Math.abs(d.bars.c[i] / d.bars.c[i - 1] - 1) < 0.01, "smooth after adjustment");
  const [raw] = await L.readCandles(sb, "KOTAKBANK", ["I5"], true);
  assert.ok(Math.max(...raw.bars.c) > 1900, "the file keeps Dhan's raw prices");
  for (let seed = 1; seed < 30; seed++) {
    const cfg = L.generate("KOTAKBANK", seed);
    assert.equal(cfg.data_segment, "NSE_EQ"); assert.equal(cfg.trade_type, "FUTURES"); assert.equal(cfg.futures_symbol, "KOTAKBANK1!"); assert.equal(cfg.expiry_flag, "MONTH");
    assert.ok(Number(cfg.lot_size) > 0);
  }
});
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
