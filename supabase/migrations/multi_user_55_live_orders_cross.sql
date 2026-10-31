-- Opposite orders matched inside the desk (31 Oct 2026; engine crossInside): when two live strategies of the same
-- account want opposite orders in the same contract at the same time, the part they share is matched by the desk at
-- the last traded price instead of going to Dhan (where the exchange's self-trade check would cancel one of them).
-- cross_qty = quantity matched inside the desk; cross_px = its average price. qty keeps what was sent to Dhan.
alter table public.live_orders add column if not exists cross_qty integer not null default 0;
alter table public.live_orders add column if not exists cross_px numeric;
