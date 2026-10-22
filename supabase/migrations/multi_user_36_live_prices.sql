-- Prices every second: the engine's "prices" action fetches every open position's (and every running strategy's)
-- last price in one batched request per account, and the app receives the running P&L through Realtime.
create table if not exists public.live_prices (
  seg text not null,
  sec text not null,
  px numeric not null,
  at timestamptz not null default now(),
  primary key (seg, sec)
);
alter table public.live_prices enable row level security;
create policy live_prices_read on public.live_prices for select to authenticated using (true);

create table if not exists public.live_marks (
  strategy_id uuid primary key,
  owner_id uuid,
  ltp numeric,
  upnl numeric,
  at timestamptz not null default now()
);
alter table public.live_marks enable row level security;
create policy live_marks_read on public.live_marks for select to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_owner()));
alter publication supabase_realtime add table public.live_marks;

-- One price round at a time, at most one a second (Dhan's quote API allows one request a second per account).
create table if not exists public.price_lock (id int primary key, at timestamptz not null default now() - interval '1 hour');
insert into public.price_lock (id) values (1) on conflict do nothing;
alter table public.price_lock enable row level security;

select cron.schedule('live-prices', '1 seconds',
  $$select public.engine_call('prices') where exists (select 1 from public.algo_strategies where active and position <> 'FLAT' and not archived)$$);
