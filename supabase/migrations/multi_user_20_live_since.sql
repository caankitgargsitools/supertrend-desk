-- Live performance tab: the first time a strategy goes live starts its live record (for CAGR).
alter table public.algo_strategies add column if not exists live_since timestamptz;
-- set_live(): on going live, live_since = coalesce(live_since, now()).
