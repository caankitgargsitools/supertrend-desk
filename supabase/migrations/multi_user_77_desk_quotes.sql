-- Desk quotes strip (6 Nov 2026, Papa: "stop scrolling … show the main indexes with their price, the coins, % up / down
-- today, all the assets we trade, flash what changes"). One row per instrument: which asset a contract belongs to and the
-- previous session's close (today's % = live price ÷ prev_close − 1). Filled by the engine (`tickerRefresh`) daily with
-- the typical-day moves (08:51 IST) and hourly for assets not seen yet; live prices come from live_prices.
create table if not exists public.ticker_ref (seg text not null, sec text not null, asset text not null, prev_close numeric, ref_day date, at timestamptz default now(), primary key (seg, sec));
alter table public.ticker_ref enable row level security;
create policy ticker_ref_read on public.ticker_ref for select to authenticated using (true);
