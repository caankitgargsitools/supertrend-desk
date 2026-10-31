// In-memory stand-in for supabase-js (the subset the engine uses).
export const db = {};
let seq = 1000;
const T = (n) => (db[n] ??= []);
// Column defaults the real tables have (only where a test needs them).
const DEFAULTS = { lab_combos: { first_seen: () => new Date().toISOString(), current: () => true } };
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = "select"; this.ord = null; this.lim = null; this.one = null; this.ret = false; }
  select(_cols, opts) { if (this.op !== "select") this.ret = true; if (opts && opts.count) { this.cnt = true; this.head = !!opts.head; } return this; }
  insert(rows) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows, opts) { this.op = "upsert"; this.rows = Array.isArray(rows) ? rows : [rows]; this.conflict = opts && opts.onConflict ? String(opts.onConflict).split(",").map((x) => x.trim()) : null; return this; }
  update(v) { this.op = "update"; this.v = v; return this; }
  delete() { this.op = "delete"; return this; }
  eq(k, v) { this.f.push((r) => r[k] === v || (r[k] != null && v != null && String(r[k]) === String(v))); return this; }
  neq(k, v) { this.f.push((r) => r[k] !== v); return this; }
  like(k, v) { const re = new RegExp("^" + String(v).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*") + "$"); this.f.push((r) => re.test(String(r[k] ?? ""))); return this; }
  is(k, v) { this.f.push((r) => v === null ? r[k] == null : r[k] === v); return this; }
  in(k, v) { this.f.push((r) => v.includes(r[k])); return this; }
  lt(k, v) { this.f.push((r) => r[k] != null && r[k] < v); return this; }
  lte(k, v) { this.f.push((r) => r[k] != null && r[k] <= v); return this; }
  gt(k, v) { this.f.push((r) => r[k] != null && r[k] > v); return this; }
  gte(k, v) { this.f.push((r) => r[k] != null && r[k] >= v); return this; }
  not(k, op, v) { this.f.push((r) => !(r[k] === v || (v === null && r[k] == null))); return this; }
  or(expr) {
    const split = (x) => { const out = []; let d = 0, cur = ""; for (const ch of x) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && !d) { out.push(cur); cur = ""; } else cur += ch; } if (cur) out.push(cur); return out; };
    const term = (x) => {
      const m = x.match(/^(and|or)\((.*)\)$/);
      if (m) { const parts = split(m[2]).map(term); return m[1] === "and" ? (r) => parts.every((f) => f(r)) : (r) => parts.some((f) => f(r)); }
      const [k, op, ...rest] = x.split("."); const v = rest.join(".");
      if (op === "is") return (r) => v === "null" ? r[k] == null : String(r[k]) === v;
      if (op === "eq") return (r) => String(r[k]) === v;
      if (op === "neq") return (r) => String(r[k]) !== v;
      if (op === "like") { const re = new RegExp("^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/%/g, ".*") + "$"); return (r) => re.test(String(r[k] ?? "")); }
      if (op === "lt") return (r) => r[k] != null && r[k] < v;
      if (op === "gt") return (r) => r[k] != null && r[k] > v;
      throw new Error("or: unsupported " + x);
    };
    const parts = split(expr).map(term);
    this.f.push((r) => parts.some((f) => f(r))); return this;
  }
  order(k, o = {}) { this.ord = [k, o.ascending !== false]; return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.off = a; this.lim = b - a + 1; return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  run() {
    const tab = T(this.t);
    let out;
    if (this.op === "insert" || this.op === "upsert") {
      out = this.rows.map((r) => {
        const row = { id: r.id ?? ++seq, created_at: new Date().toISOString(), ...(this.t === 'live_orders' ? { steps: 0, market_retry: false } : {}), ...JSON.parse(JSON.stringify(r)) };
        if (this.op === "upsert") {
          const same = this.conflict ? (x) => this.conflict.every((k) => String(x[k]) === String(row[k])) : (x) => x.sec_id === row.sec_id && x.seg === row.seg;
          const i = tab.findIndex(same);
          if (i >= 0) { const keep = { ...tab[i] }; tab[i] = { ...keep, ...JSON.parse(JSON.stringify(r)), id: keep.id, created_at: keep.created_at }; return tab[i]; }
        }
        const d = DEFAULTS[this.t]; if (d) for (const [k, f] of Object.entries(d)) if (row[k] === undefined) row[k] = f();
        tab.push(row); return row;
      });
    } else {
      out = tab.filter((r) => this.f.every((f) => f(r)));
      if (this.op === "update") out.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(this.v))));
      if (this.op === "delete") db[this.t] = tab.filter((r) => !out.includes(r));
      if (this.ord) { const [k, a] = this.ord; out = [...out].sort((x, y) => (x[k] > y[k] ? 1 : x[k] < y[k] ? -1 : 0) * (a ? 1 : -1)); }
      if (this.lim != null) out = out.slice(this.off ?? 0, (this.off ?? 0) + this.lim);
    }
    out = out.map((r) => ({ ...r }));
    if (this.cnt) return { data: this.head ? null : out, count: out.length, error: null };
    if (this.one) return { data: out[0] ?? null, error: this.one === "single" && !out[0] ? { message: "no row" } : null };
    return { data: this.op === "select" || this.ret ? out : null, error: null };
  }
  then(res, rej) { try { res(this.run()); } catch (e) { rej(e); } }
}
export const rpcCalls = [];
export const rpcs = {};
export const files = {};
export function createClient() {
  return {
    from: (t) => new Q(t),
    storage: { from: (bucket) => ({
      upload: async (path, body) => { files[bucket + "/" + path] = body; return { error: null }; },
      download: async (path) => files[bucket + "/" + path] ? { data: new Blob([files[bucket + "/" + path]]), error: null } : { data: null, error: { message: "missing" } },
    }) },
    rpc: async (n, a) => { rpcCalls.push([n, a]); if (rpcs[n]) return rpcs[n](a); if (n === "notify_tagged") { T("notifications").push({ id: ++seq, created_at: new Date().toISOString(), user_id: a.p_user, kind: a.p_kind, title: a.p_title, body: a.p_body, tag: a.p_tag, strategy_id: a.p_strategy }); } return { data: 0, error: null }; },
  };
}
