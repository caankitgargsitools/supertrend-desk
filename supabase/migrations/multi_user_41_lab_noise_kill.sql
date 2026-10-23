-- Stricter lab phase 2 and the kill rule (23 Oct 2026).
-- Phase 2 checks (lab_checks kinds 'noise' tf 0..100 and 'random') are queued only for finalists by the engine.
-- lab_months: month-by-month results of every fresh try in a run (not re-tests), for the overfitting gauge.
-- lab_pbo: Probability of Backtest Overfitting per run, asset and mode (CSCV), shown on the Lab page.
create table if not exists public.lab_months (
  id bigserial primary key,
  run_id bigint not null,
  asset text not null,
  mode text,
  nets integer[] not null,
  created_at timestamptz not null default now()
);
create index if not exists lab_months_run on public.lab_months (run_id);
alter table public.lab_months enable row level security;

create table if not exists public.lab_pbo (
  run_id bigint not null,
  asset text not null,
  mode text not null,
  pbo numeric not null,
  strategies integer not null,
  slices integer not null,
  computed_at timestamptz not null default now(),
  primary key (run_id, asset, mode)
);
alter table public.lab_pbo enable row level security;
create policy lab_pbo_read on public.lab_pbo for select to authenticated using (true);

-- Kill rule: set by the engine's daily check; "Allow new trades again" clears kill_at and sets kill_override_trades to
-- the number of trades so far (the strategy is then judged on the trades made after that).
alter table public.algo_strategies add column if not exists kill_at timestamptz;
alter table public.algo_strategies add column if not exists kill_note text;
alter table public.algo_strategies add column if not exists kill_override_trades integer;

-- Owner (or admin) allows a stopped strategy to take new trades again.
create or replace function public.kill_allow(p_strategy uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not exists (select 1 from public.algo_strategies where id = p_strategy and (owner_id = auth.uid() or public.is_admin())) then
    raise exception 'Not allowed';
  end if;
  update public.algo_strategies set kill_at = null, kill_note = null,
    kill_override_trades = (select count(*) from public.algo_trades where strategy_id = p_strategy and not hidden)
  where id = p_strategy;
end $$;
revoke all on function public.kill_allow(uuid) from public, anon;
grant execute on function public.kill_allow(uuid) to authenticated;
