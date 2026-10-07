-- ── Stop loss / target / trailing stop / daily loss limit (Oct 2026) ─────────────────────────────
alter table public.algo_strategies
  add column if not exists risk jsonb,          -- {basis, sl, tgt, trail, atr_len, max_day_loss}; null = none
  add column if not exists pos_risk jsonb,      -- live levels of the open position
  add column if not exists day_pnl numeric,     -- estimated P&L of today's closed trades (daily loss limit)
  add column if not exists day_pnl_date date;

-- ── Strategy lab ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.lab_settings (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  per_night int not null default 300 check (per_night between 10 and 1000),
  top_options int not null default 20 check (top_options between 0 and 60),
  capital numeric not null default 500000 check (capital > 0),
  assets text[] not null default array['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','SENSEX','GOLD','SILVER','CRUDEOIL','NATURALGAS','COPPER'],
  updated_at timestamptz not null default now()
);
insert into public.lab_settings (id) values (1) on conflict do nothing;

create table if not exists public.lab_runs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  run_day date not null,
  status text not null check (status in ('running','done','failed','stopped')),
  phase text not null default 'data',
  progress text,
  from_day date, split_day date, to_day date,
  cursor int not null default 0,
  counts jsonb not null default '{}',
  settings jsonb,
  trigger text,
  error text,
  lease_until timestamptz,
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.lab_results (
  id bigserial primary key,
  run_id bigint not null references public.lab_runs(id) on delete cascade,
  created_at timestamptz not null default now(),
  asset text not null,
  mode text not null,                 -- INTRADAY | DAILY
  label text not null,
  fingerprint text not null,
  champion boolean not null default false,
  config jsonb not null,              -- every parameter of the strategy as tested
  stage text not null default 'pending' check (stage in ('pending','screened','opt_queue','pricing','priced','error')),
  passed boolean,
  score numeric,
  metrics jsonb,
  trades jsonb,
  opt_buy jsonb,
  opt_sell jsonb,
  opt_job jsonb,
  error text,
  starred boolean not null default false,
  promoted_id uuid references public.algo_strategies(id) on delete set null
);
create index if not exists lab_results_run_stage on public.lab_results (run_id, stage);
create index if not exists lab_results_fp on public.lab_results (fingerprint);
create index if not exists lab_results_rank on public.lab_results (passed, score desc);
create index if not exists lab_results_created on public.lab_results (created_at);

create table if not exists public.lab_candles (
  asset text not null, kind text not null, from_day date, to_day date, bars jsonb not null,
  updated_at timestamptz not null default now(), primary key (asset, kind)
);
create table if not exists public.lab_opt_cache (key text primary key, bars jsonb not null, created_at timestamptz not null default now());

alter table public.lab_settings enable row level security;
alter table public.lab_runs enable row level security;
alter table public.lab_results enable row level security;
alter table public.lab_candles enable row level security;   -- engine only (service role)
alter table public.lab_opt_cache enable row level security; -- engine only (service role)
drop policy if exists lab_settings_owner_read on public.lab_settings;
create policy lab_settings_owner_read on public.lab_settings for select using (public.is_owner());
drop policy if exists lab_settings_owner_write on public.lab_settings;
create policy lab_settings_owner_write on public.lab_settings for update using (public.is_owner()) with check (public.is_owner());
drop policy if exists lab_runs_owner_read on public.lab_runs;
create policy lab_runs_owner_read on public.lab_runs for select using (public.is_owner());
drop policy if exists lab_results_owner_read on public.lab_results;
create policy lab_results_owner_read on public.lab_results for select using (public.is_owner());
drop policy if exists lab_results_owner_update on public.lab_results;
create policy lab_results_owner_update on public.lab_results for update using (public.is_owner()) with check (public.is_owner());
drop policy if exists lab_results_owner_delete on public.lab_results;
create policy lab_results_owner_delete on public.lab_results for delete using (public.is_owner());

-- Portal buttons.
create or replace function public.lab_run_now() returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  return public.engine_call('lab_start_manual');
end $$;
create or replace function public.lab_stop() returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  update public.lab_runs set status = 'stopped', progress = 'Stopped', finished_at = now(), lease_until = null where status = 'running';
end $$;
revoke execute on function public.lab_run_now() from anon;
revoke execute on function public.lab_stop() from anon;

-- Every evening at 16:05 IST (10:35 UTC), plus a watchdog that resumes a run whose chain of instalments broke.
select cron.schedule('strategy-lab-start', '35 10 * * *', $$select public.engine_call('lab_start')$$);
select cron.schedule('strategy-lab-watchdog', '*/5 * * * *', $$select public.engine_call('lab') where exists (
  select 1 from public.lab_runs where status = 'running' and coalesce(lease_until, updated_at + interval '3 minutes') < now())$$);
