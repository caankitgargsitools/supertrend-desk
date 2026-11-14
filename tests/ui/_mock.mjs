// Shared mock for the UI tests written on 6 Nov 2026 (orders, live tab, connections, go-live, strategy page, rules, home card):
// a signed-in admin with a few strategies, trades and the server answers the app reads. Each test adds or changes what it needs.
import { chromium } from "playwright";

export const A = "22222222-2222-2222-2222-222222222222", U = "11111111-1111-1111-1111-111111111111", now = new Date().toISOString();
const base = { data_instrument: "FUTCOM", timeframe_min: 1440, strategy_kind: "RULES", atr_period: 10, factor: 3, trade_type: "FUTURES", direction: "BOTH", lots: 1, qty_mode: "LOTS", product_type: "M", exchange: "MCX",
  option_side: "BUY", expiry_flag: "WEEK", leg_template_opt: "{}", leg_template_fut: "{}", position: "FLAT", archived: false, created_at: now, owner_id: A, active: true, live: false, intraday: false, last_run_at: now,
  rules: { daily: true, long: { mode: "ALL", conds: [{ ind: "RSI", tf: "D", p: { len: 14 }, op: "gt", v: 55 }] }, short: { mode: "ALL", conds: [] }, exitLong: { mode: "ANY", conds: [] }, exitShort: { mode: "ANY", conds: [] } },
  session_start: "09:15", last_entry: "23:00", square_off: "23:15", entry_time: "09:20", exit_time: "15:15", exit_next_day: false, entry_trigger: "CLOSE", buffer_points: 0, bias_timeframe: "D", strike_step: 100, strike_offset: 0, expiry_weekday: 4, roll_on_expiry: true };
export const S = (id, u, seg, tf, lab, extra = {}) => ({ ...base, id, name: `Lab #${lab || id} · Futures · ${u} ${tf === 1440 ? "daily" : tf + " min"} · rule ${id}`, underlying: u, data_segment: seg, data_security_id: u, futures_symbol: u, dhan_symbol: u,
  lot_size: 100, timeframe_min: tf, rules: tf === 1440 ? base.rules : { ...base.rules, daily: false }, lab_id: lab, ...extra });
export const strategies = [
  S("g1", "GOLD", "MCX_COMM", 1440, 901, { live: true, position: "LONG", pos_lots: 2, pos_qty: 200, pos_upnl: 4250, pos_ltp: 138500, pos_entry_px: 138100, pos_margin: 300000, last_close: 138500, last_trend: 1, live_since: "2026-10-01T04:00:00Z",
    pos_risk: { dir: 1, stop: 137000, tgt: 140000 }, risk: { sl: { type: "PCT", value: 1 }, tgt: { type: "PCT", value: 2 } }, capital: 500000, sizing: { mode: "CAPITAL", max_lots: 3 } }),
  S("g2", "GOLD", "MCX_COMM", 1440, 902),
  S("n1", "NIFTY", "IDX_I", 15, 911, { exchange: "NSE", intraday: true, lot_size: 65, data_instrument: "INDEX", data_security_id: "13" }),
  S("c1", "SOLUSD", "DELTA", 1440, 921, { exchange: "DELTA", lot_size: 1, data_instrument: "PERP" }),
];
export const me = { user_id: A, email: "ca.ankitgarg@gmail.com", role: "admin", status: "active", can_build: true, terms_accepted: true, billing: { balance: 4200, deploy_fee: 0, pay_to: "desk@upi" }, entries: { ok: true } };
export const trades = [["g1", "LIVE", 12000, 1], ["g1", "LIVE", -3000, 2], ["g2", "PAPER", 5000, 3]].map(([sid, mode, net, i]) => ({ id: i, strategy_id: sid, user_id: A, mode, net, exit_at: `2026-10-0${i}T10:00:00Z`, entry_day: `2026-10-0${i}`, contract: "GOLD25NOVFUT", lots: 1, units: 100, side: "LONG", entry_px: 138000, exit_px: 138000 + net / 100, gross: net + 60, costs: 60, exit_why: "Signal" }));
export const res = {
  "rpc/whoami": me, "rpc/broker_status": { broker: "DHAN", has_token: true, token_tail: "abcd", has_url: true, url_host: "tv-webhook.dhan.co", has_secret: true, token_expires_at: new Date(Date.now() + 20 * 3600000).toISOString(), client_id: "1100012345" },
  "rpc/my_capital": { capital: 2000000, since: null, deploy_pct: 60, live_net: 0, paper_net: 0, live_used: 0, paper_used: 0, funds: { available: 400000 } },
  "rpc/delta_status": { has_key: true, has_secret: true },
  "algo_strategies": strategies, "algo_trades": trades,
  "lab_margins": [{ asset: "GOLD", price: 138485, fut_pct: .0925, fut_pct_i: .0925, detail: { fut_margin: 130000, margin: 130000 }, checked_at: now }, { asset: "NIFTY", price: 25000, fut_pct: .12, detail: { fut_margin: 150000 }, checked_at: now }],
  "rpc/lab_scores": [{ id: 901, score: 5, consistency: 61 }, { id: 902, score: 5, consistency: 83 }, { id: 911, score: 5, consistency: 77 }, { id: 921, score: 5, consistency: 71 }],
};
/** Opens the app signed in. Returns { b, p, writes }; writes = every non-GET request (method, url, body). */
export async function openApp({ theme = "dark", width = 1440, res: more = {}, strategies: list = strategies, localStorage: ls = {} } = {}) {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await b.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
  const p = await ctx.newPage();
  const errs = [], writes = [];
  p.on("pageerror", (e) => { errs.push(e.message); console.log("PAGEERR", e.message); });
  const all = { ...res, "algo_strategies": list, ...more };
  await p.route(/supabase\.co/, (r) => {
    const u = r.request().url().replace(/^.*supabase\.co/, ""), meth = r.request().method();
    if (meth !== "GET" && meth !== "HEAD" && !/\/auth\//.test(u)) writes.push({ meth, u: decodeURIComponent(u), body: r.request().postData() });
    if (/\/auth\/v1\/user/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: A, email: me.email }) });
    if (meth === "PATCH" || meth === "DELETE") return r.fulfill({ status: 204, body: "" });
    const m = u.match(/\/rest\/v1\/(rpc\/[a-z_]+|[a-z_]+)/), key = m && m[1];
    let body = key in all ? all[key] : [];
    if (typeof body === "function") body = body(r.request());
    // An insert answers [] unless the table's handler gives the created row as { __post: row }.
    if (meth === "POST" && !/\/rpc\//.test(u)) return r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(body && !Array.isArray(body) && body.__post !== undefined ? body.__post : []) });
    if (/application\/vnd\.pgrst\.object/.test(r.request().headers()["accept"] || "") && Array.isArray(body)) body = body[0] ?? null;
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await p.addInitScript(([uid, email, extra]) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem("sb-umryzxusbdttbcshkajt-auth-token", JSON.stringify({ access_token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y", token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r", user: { id: uid, email, aud: "authenticated", role: "authenticated" } }));
    ["lastPage", "lpView", "lpGroup", "lpFold", "capTab", "cmp"].forEach((k) => localStorage.removeItem(k));
    for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  }, [A, me.email, ls]);
  await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await p.goto("http://localhost:8765/index.html"); await p.waitForTimeout(1600);
  return { b, p, writes, errs };
}
export const fail = (m, x) => { console.log("FAIL", m, JSON.stringify(x ?? "")); process.exit(1); };
