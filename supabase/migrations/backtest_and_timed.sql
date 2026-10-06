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
