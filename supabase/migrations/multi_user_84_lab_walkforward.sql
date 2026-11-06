-- 6 Nov 2026 (strategy-research audit, step 11a): the walk-forward "stitched out-of-sample curve" of the Strategy Lab.
-- One row per asset, mode (DAILY / INTRADAY) and k: every calendar quarter the lab's fully tested strategies of that
-- group are re-ranked by the consistency score on their trades BEFORE the quarter, the top k picked, and only the next
-- quarter's result recorded (quarters jsonb: q, from, to, picked ids, net = mean of the k, pool_avg, n_pool); summary =
-- stitched_net, pool_net, max_dd, beat_pool, positive, curve. Computed in instalments by engine lab.ts labWalkForward
-- (state 'working' + cursor between calls; recomputed when computed_at is older than 7 days). The lead wires the router
-- action (e.g. 'lab_walkforward') and a nightly cron. CREATE TABLE only; admins read.
create table if not exists public.lab_walkforward (
  asset text not null,
  mode text not null,
  k integer not null default 3,
  state text,
  cursor integer not null default 0,
  pool integer,
  quarters jsonb,
  summary jsonb,
  computed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (asset, mode, k)
);
alter table public.lab_walkforward enable row level security;
create policy lab_walkforward_admin on public.lab_walkforward for select using ((select public.is_admin()));
