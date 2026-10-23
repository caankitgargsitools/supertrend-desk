-- 23 Oct 2026: the daytime lab re-test plus per-second price-bar writes used up the database's disk allowance (the app
-- and the cron jobs timed out for ~18 minutes). The price loop now builds the minute candles in memory and writes them
-- once per 10-second run: price_bars_merge takes whole candles (o, h, l, c and the time of the close).
create or replace function public.price_bars_merge(p_rows jsonb) returns void
language sql security definer set search_path to 'public' as $$
  insert into public.price_bars as b (seg, sec, t, o, h, l, c, c_at)
  select r->>'seg', r->>'sec', (r->>'t')::bigint, (r->>'o')::numeric, (r->>'h')::numeric, (r->>'l')::numeric, (r->>'c')::numeric, (r->>'at')::timestamptz
  from jsonb_array_elements(p_rows) r
  on conflict (seg, sec, t) do update set
    h = greatest(b.h, excluded.h), l = least(b.l, excluded.l),
    c = case when excluded.c_at >= b.c_at then excluded.c else b.c end,
    c_at = greatest(b.c_at, excluded.c_at);
$$;
revoke all on function public.price_bars_merge(jsonb) from public, anon, authenticated;
