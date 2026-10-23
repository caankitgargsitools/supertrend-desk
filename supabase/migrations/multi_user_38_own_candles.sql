-- Own 1-minute candles from the per-second prices (Dhan's candle API stopped answering on 23 Oct 2026, DH-905 on
-- /charts/intraday and /charts/historical while quotes kept working). When Dhan's candles fail, the engine builds
-- candles from the lab's stored history plus these. One row per instrument and minute (t = the minute's start).
create table if not exists public.price_bars (
  seg text not null,
  sec text not null,
  t bigint not null,
  o numeric not null,
  h numeric not null,
  l numeric not null,
  c numeric not null,
  c_at timestamptz not null,
  primary key (seg, sec, t)
);
alter table public.price_bars enable row level security;

-- One call per price round: each price joins its minute's candle (the first price opens it; of two overlapping
-- rounds, the later-started one's price closes it).
create or replace function public.price_bars_tick(p_rows jsonb, p_at timestamptz) returns void
language sql security definer set search_path to 'public' as $$
  insert into public.price_bars as b (seg, sec, t, o, h, l, c, c_at)
  select r->>'seg', r->>'sec', (floor(extract(epoch from p_at) / 60) * 60)::bigint,
         (r->>'px')::numeric, (r->>'px')::numeric, (r->>'px')::numeric, (r->>'px')::numeric, p_at
  from jsonb_array_elements(p_rows) r
  on conflict (seg, sec, t) do update set
    h = greatest(b.h, excluded.h), l = least(b.l, excluded.l),
    c = case when excluded.c_at >= b.c_at then excluded.c else b.c end,
    c_at = greatest(b.c_at, excluded.c_at);
$$;
revoke all on function public.price_bars_tick(jsonb, timestamptz) from public, anon, authenticated;

-- Prices run whenever a Dhan strategy is active (not only while a position is open), so the minute candles have no
-- gaps; the engine itself prices only inside each instrument's trading hours.
select cron.unschedule('live-prices');
select cron.schedule('live-prices', '10 seconds',
  $$select public.engine_call('prices') where exists (select 1 from public.algo_strategies where not archived and ((active and position <> 'FLAT') or (active and data_segment <> 'DELTA')))$$);
