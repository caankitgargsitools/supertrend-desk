-- Idempotent signal logging (open item from the 23 Oct outage, done 1 Nov 2026): one signal of an event per strategy,
-- candle and mode. Failed attempts may repeat; hidden rows don't count. The old duplicates were hidden, not deleted:
-- ids 68, 69 (20 Oct double reversal; already hidden, with its first trade) and 102, 104 (23 Oct ENTRY logged twice).
update public.algo_signals set hidden = true where id in (102, 104) and not coalesce(hidden, false);
create unique index if not exists algo_signals_once_per_candle on public.algo_signals (strategy_id, event, candle_time, mode)
  where candle_time is not null and not coalesce(hidden, false) and status <> 'FAILED';
-- A second insert for the same candle now fails; the engine's logSignal ignores the error (no signal id), so nothing breaks.
