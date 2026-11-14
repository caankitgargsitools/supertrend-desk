-- 14 Nov 2026 (Papa, after the stop / trailing-stop study: "put that as a parameter in the strategy lab").
-- lab_settings.stop_tune: how many passed strategies a run get their stops tuned (0 = off). For each, the lab writes
-- its stop variants (lab.ts stopTuneVariants: a tighter first stop of 0.5–2 × ATR with no trailing stop or a wide one)
-- into the run, where they are tested like any other strategy. lab_results.stop_tuned_at marks a strategy as done (and
-- its variants, so they are never tuned again).
alter table public.lab_settings add column if not exists stop_tune integer not null default 0;
alter table public.lab_results add column if not exists stop_tuned_at timestamptz;
update public.lab_settings set stop_tune = 5 where id = 1;
