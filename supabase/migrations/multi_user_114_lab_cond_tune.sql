-- 18 Nov 2026 (Papa: "analyze our strategies … on the basis of various market parameters that were prevailing when they
-- actually lost the money … not to trade when this condition is there … put it as a parameter in the strategy lab …
-- certain time of the day … certain days of the week").
-- lab_settings.cond_tune: how many passed strategies a run get their entry conditions tuned (0 = off). For each, the lab
-- writes condition versions (lab.ts condTuneVariants: enter only with the 200- / 20-day average, with / without a trend,
-- in calm / lively markets, not on one weekday, minute strategies only before / after noon) into the run, where they are
-- tested like any other strategy. lab_results.cond_tuned_at marks a strategy as done (and its versions).
alter table public.lab_settings add column if not exists cond_tune integer not null default 0;
alter table public.lab_results add column if not exists cond_tuned_at timestamptz;
update public.lab_settings set cond_tune = 5 where id = 1;
