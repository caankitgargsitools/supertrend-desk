alter table public.algo_strategies
  add column if not exists strategy_kind text not null default 'FLIP' check (strategy_kind in ('FLIP','TIMED')),
  add column if not exists bias_timeframe text not null default 'D' check (bias_timeframe ~ '^(D|[0-9]{1,3})$'),
  add column if not exists bias_source text not null default 'COMPLETED' check (bias_source in ('COMPLETED','LIVE')),
  add column if not exists entry_time time not null default '14:30',
  add column if not exists exit_time time not null default '09:20',
  add column if not exists exit_next_day boolean not null default true,
  add column if not exists pos_entry_date date,
  add column if not exists last_entry_day date;

create table if not exists public.algo_backtests (
  id bigint generated always as identity primary key,
  strategy_id uuid not null references public.algo_strategies(id) on delete cascade,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'queued' check (status in ('queued','running','done','partial','failed')),
  params jsonb not null,
  progress text,
  summary jsonb,
  trades jsonb,
  error text
);
create index if not exists algo_backtests_strategy_idx on public.algo_backtests(strategy_id, id desc);
alter table public.algo_backtests enable row level security;
revoke all on public.algo_backtests from anon, authenticated;

create or replace function public.engine_backtest(p_backtest bigint)
returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://umryzxusbdttbcshkajt.supabase.co/functions/v1/engine',
    body := jsonb_build_object('action', 'backtest', 'backtest_id', p_backtest),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-engine-secret', (select secret from public.engine_secret)),
    timeout_milliseconds := 20000);
$$;
revoke all on function public.engine_backtest(bigint) from public, anon, authenticated;
select 'ok' as done;

-- After-hours flip handling for flip strategies
alter table algo_strategies add column if not exists after_hours_flip text not null default 'FIRST_CLOSE' check (after_hours_flip in ('FIRST_CLOSE','OPEN'));

-- Heikin Ashi strategy type and breakout entries with a buffer
alter table algo_strategies drop constraint algo_strategies_strategy_kind_check;
alter table algo_strategies add constraint algo_strategies_strategy_kind_check check (strategy_kind in ('FLIP','HA','TIMED'));
alter table algo_strategies
  add column if not exists entry_trigger text not null default 'CLOSE' check (entry_trigger in ('CLOSE','BREAKOUT')),
  add column if not exists buffer_points numeric not null default 0 check (buffer_points >= 0),
  add column if not exists pending_target text check (pending_target in ('LONG','SHORT','FLAT')),
  add column if not exists pending_trigger numeric,
  add column if not exists pending_from bigint,
  add column if not exists pending_to bigint;

-- Resumable backtests (Dhan outages / expired token no longer lose the work done)
alter table public.algo_backtests drop constraint algo_backtests_status_check;
alter table public.algo_backtests add constraint algo_backtests_status_check check (status in ('queued','running','done','partial','failed','paused'));
alter table public.algo_backtests add column if not exists resumable boolean generated always as (plans is not null and status in ('failed','paused')) stored;
grant select (resumable) on public.algo_backtests to authenticated;
create or replace function public.resume_backtest(p_backtest bigint) returns bigint
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  update public.algo_backtests
     set status = 'queued', error = null, progress = 'Resuming', finished_at = null,
         acc = coalesce(acc, '{}'::jsonb) - 'busy' || jsonb_build_object('rounds', 0)
   where id = p_backtest and status in ('failed', 'paused') and plans is not null;
  if not found then raise exception 'This backtest can''t be resumed. Run it again instead.'; end if;
  perform public.engine_backtest(p_backtest);
  return p_backtest;
end $$;
revoke all on function public.resume_backtest(bigint) from public, anon;
grant execute on function public.resume_backtest(bigint) to authenticated;

-- ── Commodities, condition strategies and option writing (Oct 2026) ─────────────────────────────
-- MCX futures contracts (security IDs change each expiry); refreshed by the engine from Dhan's instrument list.
create table if not exists public.mcx_contracts (
  sec_id text primary key,
  underlying text not null,
  display text,
  expiry date not null,
  synced_at timestamptz not null default now()
);
create index if not exists mcx_contracts_und_exp on public.mcx_contracts (underlying, expiry);
alter table public.mcx_contracts enable row level security;
drop policy if exists mcx_contracts_owner_read on public.mcx_contracts;
create policy mcx_contracts_owner_read on public.mcx_contracts for select using (public.is_owner());

-- Condition-based strategies (rule sets), option writing and monthly expiries.
alter table public.algo_strategies drop constraint if exists algo_strategies_strategy_kind_check;
alter table public.algo_strategies add constraint algo_strategies_strategy_kind_check check (strategy_kind in ('FLIP','HA','TIMED','RULES'));
alter table public.algo_strategies add column if not exists rules jsonb;
alter table public.algo_strategies add column if not exists option_side text not null default 'BUY' check (option_side in ('BUY','SELL'));
alter table public.algo_strategies add column if not exists pos_option_side text check (pos_option_side in ('BUY','SELL'));
alter table public.algo_strategies add column if not exists expiry_flag text not null default 'WEEK' check (expiry_flag in ('WEEK','MONTH'));

-- Tick every minute 08:30–00:29 IST on weekdays, covering MCX's evening session (the engine skips closed markets).
select cron.unschedule('supertrend-engine-tick');
select cron.schedule('supertrend-engine-tick', '* 3-18 * * 1-5', $$select public.engine_call('tick')$$);
