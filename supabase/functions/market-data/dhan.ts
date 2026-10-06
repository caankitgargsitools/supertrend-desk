// Thin Dhan v2 data client with pacing and retry on rate limits.
import { type DayBar, ist, normaliseTimestamps, type Raw } from "./logic.ts";

export type OptBar = { t: number; o: number; c: number; strike: number | null; spot: number | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Dhan {
  private last = 0;
  calls = 0;
  private clientId: string;
  private token: string;
  constructor(clientId: string, token: string) {
    this.clientId = clientId;
    this.token = token;
  }

  async post(path: string, body: unknown): Promise<any> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = this.last + 260 - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.calls++;
      const r = await fetch("https://api.dhan.co/v2" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json",
          "access-token": this.token, "client-id": this.clientId,
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (r.status === 429 || (!r.ok && /\b805\b|too many/i.test(text))) {
        await sleep(1500 * (attempt + 1));
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
    throw new Error(`Dhan kept rate-limiting ${path}. Try again in a minute.`);
  }

  /** Minute candles (interval 1/5/15/25/60). Dates as "YYYY-MM-DD HH:mm:ss" IST, max ~90 days per call. */
  async intraday(sec: string, seg: string, instr: string, interval: number, fromDate: string, toDate: string): Promise<Raw[]> {
    const j = await this.post("/charts/intraday", {
      securityId: String(sec), exchangeSegment: seg, instrument: instr, interval: String(interval), oi: false, fromDate, toDate,
    });
    const ts: number[] = j.timestamp ?? [];
    const shift = normaliseTimestamps(ts);
    return ts.map((t, i) => ({ t: t + shift, o: +j.open[i], h: +j.high[i], l: +j.low[i], c: +j.close[i] }));
  }

  /** Daily candles; toDate is exclusive. */
  async daily(sec: string, seg: string, instr: string, fromDate: string, toDate: string): Promise<DayBar[]> {
    const j = await this.post("/charts/historical", {
      securityId: String(sec), exchangeSegment: seg, instrument: instr, expiryCode: 0, oi: false, fromDate, toDate,
    });
    const ts: number[] = j.timestamp ?? [];
    return ts.map((t, i) => ({ t, o: +j.open[i], h: +j.high[i], l: +j.low[i], c: +j.close[i], day: ist(t).date }))
      .sort((a, b) => a.t - b.t);
  }

  /** Expired weekly index options by strike relative to spot (ATM, ATM+k). Up to 30 days per call. */
  async rolling(o: {
    sec: string; segment: string; interval: number; code: number; k: number; type: "CALL" | "PUT"; from: string; to: string;
  }): Promise<OptBar[]> {
    const strike = o.k === 0 ? "ATM" : o.k > 0 ? `ATM+${o.k}` : `ATM${o.k}`;
    const j = await this.post("/charts/rollingoption", {
      exchangeSegment: o.segment, interval: String(o.interval), securityId: Number(o.sec), instrument: "OPTIDX",
      expiryFlag: "WEEK", expiryCode: o.code, strike, drvOptionType: o.type,
      requiredData: ["open", "close", "strike", "spot"], fromDate: o.from, toDate: o.to,
    });
    const d = j?.data?.[o.type === "CALL" ? "ce" : "pe"];
    if (!d || !Array.isArray(d.timestamp)) return [];
    const ts: number[] = d.timestamp;
    const shift = normaliseTimestamps(ts);
    return ts.map((t, i) => ({
      t: t + shift, o: +d.open?.[i], c: +d.close?.[i],
      strike: Array.isArray(d.strike) && d.strike[i] != null ? +d.strike[i] : null,
      spot: Array.isArray(d.spot) && d.spot[i] != null ? +d.spot[i] : null,
    }));
  }

  /** Last traded price for one instrument (Data API; 1 request per second). */
  async ltp(seg: string, sec: string): Promise<number | null> {
    const j = await this.post("/marketfeed/ltp", { [seg]: [Number(sec)] });
    const v = j?.data?.[seg]?.[String(sec)]?.last_price;
    return typeof v === "number" ? v : v != null ? Number(v) : null;
  }
}
