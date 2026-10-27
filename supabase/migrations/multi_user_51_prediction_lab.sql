-- Prediction Lab (27 Oct 2026; engine prediction.ts, server predictor/): Kronos-mini forecasts every lab asset on
-- 5m, 15m, 30m, 1h, 4h and daily candles, 1–10 candles ahead, scored against simple baselines. The forecasts run on
-- Papa's AWS server (Dhandha's t4g.small, Mumbai), which talks only to the engine with its own key (x-pred-key):
-- it reads public candles and writes these tables, nothing else. Tables stay small: per-month totals, the latest
-- forecast per asset and timeframe, and one heartbeat row; each forecast's detail stays on the server.

create table if not exists public.pred_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default true,
  model text not null default 'mini',          -- Kronos-mini; small/base are pending (server size)
  tfs integer[] not null default '{5,15,30,60,240,1440}',
  horizon integer not null default 10,
  lookback integer not null default 256,
  replay_from date not null default '2025-09-01', -- after Kronos's training data (paper 2 Aug 2025)
  key_hash text,                                -- sha256 of the server key (the key itself is shown once)
  key_created_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.pred_settings (id) values (1) on conflict do nothing;

-- Live 5-minute candles of the Dhan assets, refreshed by the engine every 5 minutes in market hours (action
-- pred_feed); the last few days only (older history comes from the lab's candle files).
create table if not exists public.pred_bars (
  asset text primary key,
  contract text,
  bars jsonb not null,
  updated_at timestamptz not null default now()
);

-- Totals per asset, timeframe, candles ahead (h) and month: replayed months and live forecasts kept apart.
create table if not exists public.pred_stats (
  asset text not null,
  tf integer not null,
  h integer not null,
  month text not null,              -- 'YYYY-MM' of the forecast
  mode text not null,               -- 'replay' | 'live'
  n integer not null default 0,     -- forecasts scored
  dir_n integer not null default 0, -- of them, with a real move (not flat)
  hit integer not null default 0,   -- Kronos's direction right
  hit_mom integer not null default 0, -- 'last move continues' right
  ae_k double precision not null default 0,    -- sum of |close error| in % of price, Kronos
  ae_flat double precision not null default 0, -- same for 'price stays the same'
  d_sum double precision not null default 0,   -- sum of (flat error − Kronos error): > 0 = Kronos better
  d_sq double precision not null default 0,    -- sum of squares, for the confidence
  re_k double precision not null default 0,    -- sum of |range error| in %, Kronos
  re_atr double precision not null default 0,  -- same for ATR
  r_sum double precision not null default 0,   -- sum of (ATR error − Kronos error)
  r_sq double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (asset, tf, h, month, mode)
);

-- The newest forecast per asset and timeframe, with the candles around it, for the chart.
create table if not exists public.pred_latest (
  asset text not null,
  tf integer not null,
  made_at timestamptz not null,     -- close of the last candle Kronos saw
  last_close double precision,
  path jsonb not null,              -- predicted candles {t,o,h,l,c,v}
  actual jsonb,                     -- recent real candles {t,o,h,l,c}, including any after made_at
  recent jsonb,                     -- recent forecasts and how they turned out
  updated_at timestamptz not null default now(),
  primary key (asset, tf)
);

-- The server's heartbeat: shows on the page that it is working (or not).
create table if not exists public.pred_worker (
  id integer primary key default 1 check (id = 1),
  last_seen timestamptz,
  version text,
  status text,
  detail jsonb,                     -- replay progress, lag per timeframe, memory, CPU, forecasts per hour
  error text
);
insert into public.pred_worker (id) values (1) on conflict do nothing;

alter table public.pred_settings enable row level security;
alter table public.pred_bars enable row level security;
alter table public.pred_stats enable row level security;
alter table public.pred_latest enable row level security;
alter table public.pred_worker enable row level security;
create policy pred_settings_admin on public.pred_settings for select using ((select public.is_admin()));
create policy pred_stats_admin on public.pred_stats for select using ((select public.is_admin()));
create policy pred_latest_admin on public.pred_latest for select using ((select public.is_admin()));
create policy pred_worker_admin on public.pred_worker for select using ((select public.is_admin()));
-- pred_bars: engine only (service role).

-- A new server key (admins only): returned once, only its hash is kept. Making a new one stops the old one.
create or replace function public.pred_create_key() returns text language plpgsql security definer set search_path = public, extensions as $$
declare k text;
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  k := 'pk_' || encode(gen_random_bytes(24), 'hex');
  update public.pred_settings set key_hash = encode(digest(k, 'sha256'), 'hex'), key_created_at = now(), updated_at = now() where id = 1;
  return k;
end $$;
revoke all on function public.pred_create_key() from public, anon;
grant execute on function public.pred_create_key() to authenticated;

-- Admins switch it on or off from the page.
create or replace function public.pred_set_enabled(p_on boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  update public.pred_settings set enabled = p_on, updated_at = now() where id = 1;
end $$;
revoke all on function public.pred_set_enabled(boolean) from public, anon;
grant execute on function public.pred_set_enabled(boolean) to authenticated;

-- Live candles every 5 minutes (the engine skips closed markets itself).
select cron.schedule('pred-feed', '*/5 * * * *', $$select public.engine_call('pred_feed') where exists (select 1 from public.pred_settings where id = 1 and enabled)$$);
