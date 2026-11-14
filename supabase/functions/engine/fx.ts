// USD/INR daily candles for the rule book (14 Nov 2026, Papa: an MCX commodity's rupee price moves with its dollar price
// and with the rupee — "for devising any strategy we should factor in both the changes").
// The database keeps them in table fx_daily (migration 105): filled from Yahoo Finance's free public INR=X series by the
// SQL function fx_refresh() (cron hourly), FRED's DEXINUS as a fallback. Public market data, no key, no cost.
// Dhan's NSE currency futures can't be used for this: its historical-candle API refuses NSE_CURRENCY (DH-905, 14 Nov 2026).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { DayBar } from "./logic.ts";

/** Cached per function instance for 10 minutes (the series changes once an hour at most). */
let cache: { at: number; rows: DayBar[] } | null = null;

/** USD/INR daily candles from `from` (YYYY-MM-DD) on, oldest first; [] when none are stored. */
export async function fxDaily(sb: SupabaseClient, from = "2005-01-01"): Promise<DayBar[]> {
  if (!cache || Date.now() - cache.at > 600000) {
    const rows: DayBar[] = [];
    for (let off = 0; off < 20000; off += 1000) {
      const { data, error } = await sb.from("fx_daily").select("day, o, h, l, c").eq("pair", "USDINR").in("src", ["yahoo", "yahoo+fred", "fred"]).order("day").range(off, off + 999);
      if (error) throw new Error(`USD/INR candles: ${error.message}`);
      for (const r of data ?? []) {
        const day = String(r.day), t = Math.floor(Date.parse(`${day}T00:00:00+05:30`) / 1000);
        rows.push({ t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: 0, day });
      }
      if (!data || data.length < 1000) break;
    }
    cache = { at: Date.now(), rows };
  }
  return cache.rows.filter((r) => r.day >= from);
}
/** For tests: forget the cached series. */
export const fxReset = () => { cache = null; };
