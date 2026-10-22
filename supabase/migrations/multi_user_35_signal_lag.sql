alter table public.algo_signals add column if not exists lag_ms integer;
comment on column public.algo_signals.lag_ms is 'Milliseconds from the minute the candle closed (tick start) to the decision being logged';
