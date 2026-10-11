-- Twins: passed strategies of the same asset with 80%+ of their trades opened on the same day in the same direction
-- (10-year test) are one group on the Lab page. lab_assign_twin(id) runs when a strategy passes the tougher test.
alter table public.lab_results add column if not exists twin_of bigint;
alter table public.lab_results add column if not exists trade_keys text[];
create index if not exists lab_results_twins on public.lab_results (asset, twin_of) where passed;
-- functions: lab_trade_keys(jsonb) (entry day + side of every trade), lab_assign_twin(bigint) (service role only).
