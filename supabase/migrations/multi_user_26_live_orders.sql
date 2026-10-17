-- Live order safety (applied to project umryzxusbdttbcshkajt as multi_user_26_live_orders and multi_user_27_live_lock).
-- fno_contracts: Dhan's NSE/BSE index futures and options (security id, lot, tick), synced with sync_instruments.
-- mcx_contracts: + lot, tick.
-- algo_strategies: exec_state ('working' while a live order is being worked), pos_broker (the position as the broker holds it,
--   with the stop-loss order resting there).
-- live_orders: every live order leg (entry / exit / broker stop), its limit, steps, state and fill.
-- live_lock: one order manager at a time.
-- cron: live-orders (every minute, the engine checks every 15 s inside it), live-reconcile (every 5 minutes).
create table if not exists public.fno_contracts (
  seg text not null, sec_id text not null, underlying text not null, instrument text not null, expiry date not null,
  strike numeric, opt_type text, lot integer, tick numeric, display text, synced_at timestamptz not null default now(),
  primary key (seg, sec_id));
create index if not exists fno_contracts_find on public.fno_contracts (seg, underlying, instrument, expiry);
alter table public.fno_contracts enable row level security;
create policy fno_contracts_read on public.fno_contracts for select to authenticated using (true);
alter table public.mcx_contracts add column if not exists lot integer, add column if not exists tick numeric;
alter table public.algo_strategies add column if not exists exec_state text, add column if not exists pos_broker jsonb;
create table if not exists public.live_orders (
  id bigserial primary key,
  user_id uuid not null, strategy_id uuid not null references public.algo_strategies(id) on delete cascade,
  signal_id bigint, batch text not null, seq integer not null default 0, broker text not null default 'DHAN',
  purpose text not null check (purpose in ('entry','exit','stop')), event text,
  side text not null check (side in ('BUY','SELL')), sec text not null, seg text not null, product text, qty integer not null,
  lots numeric, lot integer, tick numeric, option boolean not null default false, label text,
  ref_px numeric, limit_px numeric, trigger_px numeric, step numeric, steps integer not null default 0,
  state text not null default 'queued' check (state in ('queued','working','resting','filled','failed','cancelled','gave_up')),
  market_retry boolean not null default false, broker_order_id text, correlation_id text unique,
  filled_qty integer, avg_px numeric, note text,
  created_at timestamptz not null default now(), placed_at timestamptz, done_at timestamptz, updated_at timestamptz not null default now());
create index if not exists live_orders_open on public.live_orders (state) where state in ('queued','working','resting');
create index if not exists live_orders_strategy on public.live_orders (strategy_id, created_at desc);
alter table public.live_orders enable row level security;
create policy live_orders_own on public.live_orders for select to authenticated using (user_id = auth.uid());
create table if not exists public.live_lock (id integer primary key, until timestamptz not null default now());
insert into public.live_lock (id, until) values (1, now()) on conflict do nothing;
alter table public.live_lock enable row level security;
select cron.schedule('live-orders', '* * * * *',
  $$select public.engine_call('orders') where exists (select 1 from public.live_orders where state in ('queued','working','resting'))$$);
select cron.schedule('live-reconcile', '*/5 * * * *',
  $$select public.engine_call('reconcile') where exists (select 1 from public.algo_strategies where live and active)$$);
