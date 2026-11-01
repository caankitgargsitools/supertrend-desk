-- Stock futures across a split / bonus ex-date (1 Nov 2026, Papa: "fix the ex-date handling for held stock futures").
-- ca_day: the last ex-date this strategy was adjusted for (engine stockExDate), so the adjustment happens exactly once.
alter table public.algo_strategies add column if not exists ca_day date;
comment on column public.algo_strategies.ca_day is 'Last split/bonus ex-date applied to this stock strategy (engine stockExDate); once per action.';
