-- 16 Nov 2026 (Papa: "L&T, Larsen & Toubro, still showing as 4139.9" — the share's price at the signal; Dhan filled the
-- future at 4154.1). Live stock / index futures are shown in the held future's own prices: the engine prices the future
-- in the same batched request as the share and writes it here; the running P&L (live_marks.upnl, pos_upnl) is the
-- future's move from Dhan's fill. The desk's own figures (pos_entry_px, pos_ltp, stops) stay on the share / index.
alter table public.live_marks add column if not exists bk_ltp numeric;
alter table public.algo_strategies add column if not exists pos_bk_ltp numeric;
