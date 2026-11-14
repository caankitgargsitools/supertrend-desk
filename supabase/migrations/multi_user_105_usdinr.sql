-- 14 Nov 2026 (Papa: "commodities … their price also fluctuates because of the USD INR … for devising any strategy we
-- should factor in both the changes … go ahead with USD INR on MCX first").
-- fx_daily: USD/INR daily candles for the rule book's FX and USDPX conditions (engine fx.ts). Free public data:
-- Yahoo Finance's INR=X chart (years of daily OHLC, today included); FRED's DEXINUS (noon New York rate, a few days late)
-- fills in when Yahoo doesn't answer. Dhan's own NSE currency futures can't be used: its candle API refuses NSE_CURRENCY.
-- A candle's day is the UTC calendar day Yahoo stamps (its daily bar opens 00:00 UTC = 05:30 IST). Never deleted; a day is
-- overwritten while it is still forming. fx_refresh(p_range): '1mo' hourly, 'max' once to load the history.

create table if not exists public.fx_daily (
  pair text not null default 'USDINR', day date not null, o numeric, h numeric, l numeric, c numeric not null,
  src text not null, updated_at timestamptz not null default now(), primary key (pair, day));
alter table public.fx_daily enable row level security;
revoke all on public.fx_daily from public, anon;
grant select on public.fx_daily to authenticated;
create policy fx_daily_read on public.fx_daily for select to authenticated using (true);

create or replace function public.fx_refresh(p_range text default '1mo') returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare r extensions.http_response; j jsonb; ts jsonb; q jsonb; n integer := 0; i integer; c numeric;
begin
  if p_range not in ('5d', '1mo', '3mo', '1y', '5y', '10y', 'max') then raise exception 'Bad range'; end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '20');
  begin
    r := extensions.http_get('https://query1.finance.yahoo.com/v8/finance/chart/INR=X?interval=1d&range=' || p_range);
    if r.status = 200 then
      j := r.content::jsonb -> 'chart' -> 'result' -> 0;
      ts := j -> 'timestamp'; q := j -> 'indicators' -> 'quote' -> 0;
      for i in 0 .. coalesce(jsonb_array_length(ts), 0) - 1 loop
        c := nullif(q -> 'close' ->> i, '')::numeric;
        continue when c is null or c <= 0;
        insert into public.fx_daily (pair, day, o, h, l, c, src)
          values ('USDINR', (to_timestamp((ts ->> i)::bigint) at time zone 'UTC')::date,
                  nullif(q -> 'open' ->> i, '')::numeric, nullif(q -> 'high' ->> i, '')::numeric, nullif(q -> 'low' ->> i, '')::numeric, c, 'yahoo')
        on conflict (pair, day) do update set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, src = excluded.src, updated_at = now()
          where fx_daily.src <> 'yahoo' or fx_daily.c is distinct from excluded.c or fx_daily.h is distinct from excluded.h or fx_daily.l is distinct from excluded.l;
        n := n + 1;
      end loop;
    end if;
  exception when others then n := 0;
  end;
  if n = 0 then
    -- Yahoo didn't answer: FRED's daily rate (close only), for the days Yahoo hasn't given.
    r := extensions.http_get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXINUS&cosd=' || to_char(current_date - case when p_range = 'max' then 7300 else 45 end, 'YYYY-MM-DD'));
    if r.status = 200 then
      insert into public.fx_daily (pair, day, o, h, l, c, src)
        select 'USDINR', split_part(x, ',', 1)::date, v, v, v, v, 'fred' from (
          select x, nullif(split_part(x, ',', 2), '')::numeric v from regexp_split_to_table(r.content, E'\n') x where x ~ '^\d{4}-\d\d-\d\d,\d') z
        where v > 0
      on conflict (pair, day) do nothing;
      get diagnostics n = row_count;
    end if;
  end if;
  return n;
end $$;
revoke all on function public.fx_refresh(text) from public, anon, authenticated;

select public.fx_refresh('max');
select cron.schedule('fx-refresh', '47 * * * *', $c$select public.fx_refresh('1mo')$c$);

-- 105b (same day): Yahoo's range=max returns MONTHLY bars, so the history was loaded in 5-year pieces with period1 /
-- period2 by fx_load_years(p_from, p_to) (same insert as fx_refresh); the 86 monthly rows of the first load were marked
-- src = 'yahoo_month' (never read by the engine). Result: 5,931 daily candles 2004-01-01 → today.
-- 105c (same day): fx_clean(p_from): FRED's DEXINUS stored as pair 'USDINR_FRED'; a Yahoo close more than 1.5% from
-- FRED's same-day rate takes FRED's value (src 'yahoo+fred', 27 days); highs / lows widened to contain open and close.
-- Cron fx-refresh (hourly :47) = fx_refresh('1mo'); fx_clean(current_date - 45). Function bodies: see the database.
