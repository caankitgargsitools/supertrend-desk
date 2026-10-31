-- Combinations kept up to date in the background (31 Oct 2026, Papa; engine combos.ts, action 'combos').
-- lab_combo_groups: one row per asset, timeframe and size (2 = pairs, 3 = threes): the signature of its passed
-- strategies when last checked, the position of a pass in progress, and when the first full pass finished (the
-- starting point: only combinations first seen after it are "new" and notified).
-- lab_combos: combinations that lessen the drawdown (opposite sides >= 20% of the time together and a better profit ÷
-- biggest fall than each member alone), kept with the time first seen; those that no longer qualify are marked
-- current = false (never deleted).
create table if not exists public.lab_combo_groups (
  asset text not null, tf text not null, size integer not null,
  sig text, cursor integer not null default 0, pass_started timestamptz, state text, done_at timestamptz, baseline_at timestamptz,
  members integer, families integer, checked integer, found integer, updated_at timestamptz not null default now(),
  primary key (asset, tf, size)
);
create table if not exists public.lab_combos (
  key text primary key, asset text not null, tf text not null, size integer not null, ids integer[] not null, labels jsonb,
  opp numeric, together numeric, net numeric, dd numeric, ratio numeric, best_alone numeric, gain numeric, corr numeric,
  y_ok integer, y_n integer, years numeric, from_t timestamptz, to_t timestamptz, alone jsonb,
  current boolean not null default true, first_seen timestamptz not null default now(), checked_at timestamptz not null default now()
);
create index if not exists lab_combos_group on public.lab_combos (asset, tf, size) where current;
alter table public.lab_combo_groups enable row level security;
alter table public.lab_combos enable row level security;
create policy lab_combo_groups_admin on public.lab_combo_groups for select using ((select public.is_admin()));
create policy lab_combos_admin on public.lab_combos for select using ((select public.is_admin()));
-- Every 10 minutes: a cheap check, and an instalment of work only when an asset's list of passed strategies changed.
select cron.schedule('lab-combos', '*/10 * * * *', $$select public.engine_call('combos')$$);
