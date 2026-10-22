// Thin Dhan v2 data client with pacing and retry on rate limits.
import { type DayBar, ist, normaliseTimestamps, type Raw } from "./logic.ts";
import { cryptoDaily, cryptoIntraday, cryptoLtp } from "./crypto.ts";

export type OptBar = { t: number; o: number; h?: number; l?: number; c: number; strike: number | null; spot: number | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastChainAt = 0; // Dhan allows one option-chain request every 3 seconds

/** Dhan was temporarily unavailable (timeouts, 5xx, rate limits) — worth retrying later, unlike a bad token. */
export class DhanBusyError extends Error {}

/** Per-tick sharing of market-data answers: strategies on the same asset reuse one request (set by the tick loop). */
type Memo = Map<string, Promise<any>>;
/** Pacing per access token, shared by every Dhan object (strategies run side by side within one tick). */
const lastByToken = new Map<string, number>();
const DATA_PATHS = new Set(["/charts/intraday", "/charts/historical"]);
type LtpItem = { seg: string; sec: string; ok: (v: number | null) => void; fail: (e: unknown) => void };
const ltpBatches = new Map<string, { items: LtpItem[]; timer: number }>();

export class Dhan {
  /** Set by the tick loop for the length of one tick; null elsewhere (backtests, lab, orders). */
  static memo: Memo | null = null;
  /** Last prices fetched in one batch at the start of a tick: "SEG|sec" -> price. */
  static ltpSeed: Map<string, number> | null = null;
  private last = 0;
  calls = 0;
  /** Epoch ms after which no more retries are attempted (keeps a backtest round inside the function's time limit). */
  deadline = Infinity;
  private clientId: string;
  private token: string;
  constructor(clientId: string, token: string) {
    this.clientId = clientId;
    this.token = token;
  }

  async post(path: string, body: unknown): Promise<any> {
    const memo = Dhan.memo;
    if (memo && DATA_PATHS.has(path)) {
      // The end of an open-ended candle request is "now + 2 min" down to the second; within one tick it's the same ask.
      const b = { ...(body as Record<string, unknown>) };
      if (typeof b.toDate === "string") b.toDate = b.toDate.slice(0, 13);
      const key = path + JSON.stringify(b);
      let p = memo.get(key);
      if (!p) { p = this.send(path, body); memo.set(key, p); p.catch(() => memo.delete(key)); }
      return p;
    }
    return this.send(path, body);
  }

  private async send(path: string, body: unknown): Promise<any> {
    let lastErr = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0 && Date.now() + 22000 > this.deadline) break; // out of time for another try
      // Dhan's data APIs allow about 5 requests a second per account: requests are spaced 210 ms apart per token.
      const tk = this.token || "-";
      const at = Math.max(Date.now(), (lastByToken.get(tk) ?? 0) + 210);
      lastByToken.set(tk, at);
      if (at > Date.now()) await sleep(at - Date.now());
      this.last = Date.now();
      this.calls++;
      let r: Response, text: string;
      try {
        r = await fetch("https://api.dhan.co/v2" + path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json", Accept: "application/json",
            "access-token": this.token, "client-id": this.clientId,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        text = await r.text();
      } catch (e) { // network error or no answer within 20 s: try again
        lastErr = e instanceof Error ? e.message : String(e);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (r.status === 429 || (!r.ok && /\b805\b|too many/i.test(text))) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (r.status >= 500) { // Dhan's servers busy or timing out (502/503/504): try again
        lastErr = `HTTP ${r.status}`;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!r.ok) {
        const hint = r.status === 401 || r.status === 403
          ? " Your Dhan access token may have expired or your Data API subscription may be inactive."
          : "";
        throw new Error(`Dhan ${path} request failed (HTTP ${r.status}).${hint} ${text.slice(0, 200)}`);
      }
      return text ? JSON.parse(text) : {};
    }
    throw new DhanBusyError(lastErr
      ? `Dhan's server didn't answer ${path} after several tries (${lastErr}).`
      : `Dhan kept rate-limiting ${path}. Try again in a minute.`);
  }

  /** Minute candles (interval 1/5/15/25/60). Dates as "YYYY-MM-DD HH:mm:ss" IST, max ~90 days per call. */
  async intraday(sec: string, seg: string, instr: string, interval: number, fromDate: string, toDate: string): Promise<Raw[]> {
    if (seg === "DELTA") return cryptoIntraday(sec, interval, fromDate, toDate); // crypto: Delta Exchange (no Dhan call)
    const j = await this.post("/charts/intraday", {
      securityId: String(sec), exchangeSegment: seg, instrument: instr, interval: String(interval), oi: false, fromDate, toDate,
    });
    const ts: number[] = j.timestamp ?? [];
    const shift = normaliseTimestamps(ts, seg);
    return ts.map((t, i) => ({ t: t + shift, o: +j.open[i], h: +j.high[i], l: +j.low[i], c: +j.close[i], v: +(j.volume?.[i] ?? 0) }));
  }

  /** Daily candles; toDate is exclusive. */
  async daily(sec: string, seg: string, instr: string, fromDate: string, toDate: string): Promise<DayBar[]> {
    if (seg === "DELTA") return cryptoDaily(sec, fromDate, toDate);
    // For futures, expiryCode 0 returns Dhan's continuous near-month series (years of history).
    const j = await this.post("/charts/historical", {
      securityId: String(sec), exchangeSegment: seg, instrument: instr, expiryCode: 0, oi: false, fromDate, toDate,
    });
    const ts: number[] = j.timestamp ?? [];
    return ts.map((t, i) => ({ t, o: +j.open[i], h: +j.high[i], l: +j.low[i], c: +j.close[i], v: +(j.volume?.[i] ?? 0), day: ist(t).date }))
      .sort((a, b) => a.t - b.t);
  }

  /** Expired index options (weekly or monthly series) by strike relative to spot (ATM, ATM+k). Up to 30 days per call. */
  async rolling(o: {
    sec: string; segment: string; interval: number; code: number; k: number; type: "CALL" | "PUT"; from: string; to: string; flag?: "WEEK" | "MONTH";
  }): Promise<OptBar[]> {
    const strike = o.k === 0 ? "ATM" : o.k > 0 ? `ATM+${o.k}` : `ATM${o.k}`;
    const j = await this.post("/charts/rollingoption", {
      exchangeSegment: o.segment, interval: String(o.interval), securityId: Number(o.sec), instrument: "OPTIDX",
      expiryFlag: o.flag ?? "WEEK", expiryCode: o.code, strike, drvOptionType: o.type,
      requiredData: ["open", "high", "low", "close", "strike", "spot"], fromDate: o.from, toDate: o.to,
    });
    const d = j?.data?.[o.type === "CALL" ? "ce" : "pe"];
    if (!d || !Array.isArray(d.timestamp)) return [];
    const ts: number[] = d.timestamp;
    const shift = normaliseTimestamps(ts);
    return ts.map((t, i) => ({
      t: t + shift, o: +d.open?.[i], c: +d.close?.[i],
      h: Array.isArray(d.high) && d.high[i] != null ? +d.high[i] : undefined, l: Array.isArray(d.low) && d.low[i] != null ? +d.low[i] : undefined,
      strike: Array.isArray(d.strike) && d.strike[i] != null ? +d.strike[i] : null,
      spot: Array.isArray(d.spot) && d.spot[i] != null ? +d.spot[i] : null,
    }));
  }

  /** Option chain for one expiry: strike -> { ce, pe } with last_price and security_id. */
  async optionChain(sec: string, seg: string, expiry: string): Promise<Record<string, any>> {
    const wait = lastChainAt + 3100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastChainAt = Date.now();
    const j = await this.post("/optionchain", { UnderlyingScrip: Number(sec), UnderlyingSeg: seg, Expiry: expiry });
    return j?.data?.oc ?? {};
  }

  /** Live premium of one option; falls back to the next listed expiry if the computed date isn't one (holiday weeks). */
  async premium(sec: string, seg: string, expiry: string, strike: number, type: "CE" | "PE"): Promise<number | null> {
    const find = (oc: Record<string, any>) => {
      for (const [k, v] of Object.entries(oc)) {
        if (Math.abs(Number(k) - strike) < 0.01) { const p = Number(v?.[type === "CE" ? "ce" : "pe"]?.last_price); return p > 0 ? p : null; }
      }
      return null;
    };
    let px: number | null = null;
    try { px = find(await this.optionChain(sec, seg, expiry)); } catch { px = null; }
    if (px !== null) return px;
    try {
      const j = await this.post("/optionchain/expirylist", { UnderlyingScrip: Number(sec), UnderlyingSeg: seg });
      const list: string[] = (j?.data ?? []).map(String).sort();
      const e = list.find((x) => x >= expiry);
      if (e && e !== expiry) return find(await this.optionChain(sec, seg, e));
    } catch { /* no premium available */ }
    return null;
  }

  /** Last traded price for one instrument (Data API; 1 request per second). */
  async ltp(seg: string, sec: string): Promise<number | null> {
    if (seg === "DELTA") return cryptoLtp(sec);
    const seeded = Dhan.ltpSeed?.get(`${seg}|${sec}`);
    if (seeded != null) return seeded;
    if (Dhan.memo) return this.ltpBatched(seg, String(sec));
    const j = await this.post("/marketfeed/ltp", { [seg]: [Number(sec)] });
    const v = j?.data?.[seg]?.[String(sec)]?.last_price;
    return typeof v === "number" ? v : v != null ? Number(v) : null;
  }

  /**
   * During a tick, price requests from strategies running side by side within 40 ms are sent as one request
   * (the quote API allows one request a second, so separate requests would queue up behind each other).
   */
  private ltpBatched(seg: string, sec: string): Promise<number | null> {
    const tk = this.token || "-";
    let b = ltpBatches.get(tk);
    if (!b) {
      b = { items: [], timer: 0 };
      ltpBatches.set(tk, b);
      const batch = b;
      batch.timer = setTimeout(async () => {
        ltpBatches.delete(tk);
        const bySeg: Record<string, string[]> = {};
        for (const it of batch.items) (bySeg[it.seg] ??= []).push(it.sec);
        try {
          const got = await this.ltpMany(bySeg);
          for (const [k, v] of got) Dhan.ltpSeed?.set(k, v);
          for (const it of batch.items) it.ok(got.get(`${it.seg}|${it.sec}`) ?? null);
        } catch (e) { for (const it of batch.items) it.fail(e); }
      }, 40) as unknown as number;
    }
    return new Promise((ok, fail) => b!.items.push({ seg, sec, ok, fail }));
  }

  /** Last prices of many instruments in one request (the quote API allows one request a second). */
  async ltpMany(bySeg: Record<string, string[]>): Promise<Map<string, number>> {
    const body = Object.fromEntries(Object.entries(bySeg).map(([seg, secs]) => [seg, [...new Set(secs)].map(Number)]));
    const j = await this.send("/marketfeed/ltp", body);
    const out = new Map<string, number>();
    for (const [seg, secs] of Object.entries(bySeg)) for (const sec of secs) {
      const v = j?.data?.[seg]?.[String(sec)]?.last_price;
      if (v != null && Number.isFinite(Number(v))) out.set(`${seg}|${sec}`, Number(v));
    }
    return out;
  }
}
