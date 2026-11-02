-- Spread watcher (2 Nov 2026, Papa: "build the spread watcher"). Measures, for 30 days, whether price gaps our speed can
-- use would have paid after every charge: NSE vs BSE (the desk's 10 stocks, every minute in market hours), cash vs
-- futures (all F&O stocks, near and next month, every 15 minutes) and Delta India vs CoinDCX futures (BTC, ETH, SOL,
-- every minute, 24x7). Best bid / ask, never last prices. Engine action 'spreads' (engine spreads.ts), cron every minute.
-- No trading, no orders. Rows are never deleted; the watcher stops itself at spread_state.until.

create table if not exists public.spread_state (
  id int primary key default 1 check (id = 1),
  started_at timestamptz not null default now(),
  until timestamptz not null default now() + interval '30 days',
  ids_day date,                  -- the day the security ids were last downloaded
  ids jsonb,                     -- {nb: [{key, nse, bse}], cf: [{key, eq, lot, near:{sec,exp}, next:{sec,exp}}]}
  last_cf timestamptz,           -- last cash-futures round (every 15 minutes)
  last_run timestamptz, last_error text, runs int not null default 0
);
insert into public.spread_state (id) values (1) on conflict do nothing;

create table if not exists public.spread_ticks (
  id bigserial primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('nb', 'cf', 'cx')),  -- NSE/BSE, cash/futures, crypto exchanges
  key text not null,                                      -- RELIANCE, RELIANCE:near, BTC
  buy numeric,                                            -- price we would buy at (best ask of the cheaper side)
  sell numeric,                                           -- price we would sell at (best bid of the dearer side)
  gap_pct numeric,                                        -- (sell - buy) / buy x 100, before charges
  net_pct numeric,                                        -- after the charges below
  x jsonb                                                 -- extra: which side, days to expiry, yearly %, funding, lot
);
create index if not exists spread_ticks_kind_at on public.spread_ticks (kind, at);

alter table public.spread_state enable row level security;
alter table public.spread_ticks enable row level security;
create policy spread_state_admin on public.spread_state for select using ((select public.is_admin()));
create policy spread_ticks_admin on public.spread_ticks for select using ((select public.is_admin()));

-- Page figures per kind and key over the last p_days (admins): samples, how often the gap beat every charge, averages,
-- best, the sum of the paying minutes, and the latest values.
create or replace function public.spread_summary(p_days int default 30) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return json_build_object(
    'state', (select json_build_object('started_at', started_at, 'until', until, 'last_run', last_run, 'last_error', last_error,
      'runs', runs, 'ids_day', ids_day, 'last_cf', last_cf,
      'nb', jsonb_array_length(coalesce(ids -> 'nb', '[]'::jsonb)), 'cf', jsonb_array_length(coalesce(ids -> 'cf', '[]'::jsonb)))
      from public.spread_state where id = 1),
    'keys', (select coalesce(json_agg(k order by k.kind, k.key), '[]'::json) from (
      select kind, key, count(*) n, count(*) filter (where net_pct > 0) n_pos,
        round(avg(gap_pct), 4) avg_gap, round(avg(net_pct), 4) avg_net, round(max(net_pct), 4) best_net,
        round(coalesce(sum(net_pct) filter (where net_pct > 0), 0), 4) sum_pos,
        round(avg((x ->> 'yearly')::numeric), 2) avg_yearly, max(at) last_at,
        (array_agg(gap_pct order by at desc))[1] last_gap, (array_agg(net_pct order by at desc))[1] last_net,
        (array_agg(x order by at desc))[1] last_x, (array_agg(buy order by at desc))[1] last_buy, (array_agg(sell order by at desc))[1] last_sell
      from public.spread_ticks where at > now() - make_interval(days => greatest(1, least(p_days, 60)))
      group by kind, key) k));
end $$;
revoke all on function public.spread_summary(int) from public, anon;
grant execute on function public.spread_summary(int) to authenticated;

-- Scheduled after the engine with action 'spreads' was deployed:
select cron.schedule('spread-watch', '* * * * *', $$select public.engine_call('spreads')$$);
