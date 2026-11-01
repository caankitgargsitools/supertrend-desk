-- Stock futures (1 Nov 2026, Papa: start with 10 liquid Nifty 50 stocks).
-- Splits and bonuses found in Dhan's raw share-price candles by the lab's candle download (engine stocks.ts).
-- in_daily / in_intraday: the jump was seen in that kind of candles (Dhan may have adjusted one and not the other);
-- reads multiply prices before `day` by `factor` (new price ÷ old price, e.g. 0.2 for a 5:1 split, 0.5 for a 1:1 bonus).
-- Never deleted; engine only (no browser access).
create table if not exists public.stock_actions (
  asset text not null,
  day date not null,
  factor numeric not null check (factor > 0 and factor < 1),
  in_daily boolean not null default false,
  in_intraday boolean not null default false,
  seen_at timestamptz not null default now(),
  primary key (asset, day)
);
alter table public.stock_actions enable row level security;

-- The 10 stocks join the Strategy Lab's research list.
update public.lab_settings
   set assets = (select array_agg(distinct a order by a) from unnest(coalesce(assets, '{}') || array['RELIANCE','HDFCBANK','ICICIBANK','INFY','TCS','SBIN','BHARTIARTL','AXISBANK','LT','KOTAKBANK']) a)
 where id = 1;
