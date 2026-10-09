-- Prices on orders (market price when sent; Dhan's fill for live orders) and the open position's current price.
alter table public.algo_signals add column if not exists fills jsonb;
alter table public.algo_strategies add column if not exists pos_ltp numeric, add column if not exists pos_ltp_at timestamptz, add column if not exists pos_upnl numeric;
