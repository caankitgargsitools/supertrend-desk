-- Prediction Lab step 1 and 2 (27 Oct 2026): several Kronos paths per forecast with a confidence band, and the
-- correction layer (walk-forward logistic model on the server, calib.py). Per month:
--  conf    {"lo":[n,hit], "mid":[n,hit], "hi":[n,hit]} direction calls by the share of paths agreeing with them
--          (under 70% / 70–90% / 90% or more; with 5 paths: 3 or fewer, 4, all 5)
--  cal_n, hit_cal  calls of the correction layer (only months with enough earlier data) and how many were right
-- samples: paths per forecast by timeframe (server default 5 on 1h, 4h, daily; 1 elsewhere: the server is small).
alter table public.pred_stats add column if not exists conf jsonb;
alter table public.pred_stats add column if not exists cal_n integer not null default 0;
alter table public.pred_stats add column if not exists hit_cal integer not null default 0;
alter table public.pred_settings add column if not exists samples jsonb not null default '{"60": 5, "240": 5, "1440": 5}';
