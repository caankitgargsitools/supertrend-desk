-- Ideas lab stage 2 (25 Oct 2026): finalists get 100 runs of their whole portfolio on shuffled candles (idea_legs kind
-- 'noise', k = run 1..100, one per asset / year leg) and one random-entry test (kind 'random'); real backtests are
-- kind 'real'. idea_tries.status 'stage2' while they run.
alter table public.idea_legs add column if not exists kind text not null default 'real';
alter table public.idea_legs add column if not exists k integer;
create index if not exists idea_legs_try_kind on public.idea_legs (try_id, kind);
