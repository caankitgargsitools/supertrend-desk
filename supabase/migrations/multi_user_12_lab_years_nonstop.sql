-- Round 3 of the lab (profitable in each of the past 10 years; 5 for 5-minute strategies), non-stop runs, and
-- failed strategies cleared straight away with a one-line record in lab_tried (never generated again).
create table if not exists public.lab_tried (
  fingerprint text primary key, asset text, label text, mode text, round smallint, why jsonb, net bigint, win_rate numeric, trades integer, score numeric,
  times integer not null default 1, first_at timestamptz not null default now(), last_at timestamptz not null default now());
alter table public.lab_tried enable row level security;
create policy lab_tried_admin on public.lab_tried for select using ((select public.is_admin()));
-- 'nightly' (16:05 IST), 'auto' (non-stop while nothing is live; 23:30–08:30 IST once anything is), 'night' (23:30–08:30 only)
alter table public.lab_settings add column if not exists schedule_mode text not null default 'nightly';
-- lab_robust_public: adds years_ok, years_n and the per-year results.
-- Cron strategy-lab-next also fires when schedule_mode is 'auto' or 'night' (the engine checks the hours).
-- 5-minute candles of earlier years are kept per calendar year in lab_candles (kind 'I5Y:2022' …); daily candles cover 11 years.
