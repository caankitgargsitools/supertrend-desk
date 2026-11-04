-- Phase 1 "stop silent losses" (4 Nov 2026, Papa). Additive only.
-- * algo_trades.provisional / order_batch: a live Dhan exit is booked at the desk's price as an estimate
--   (provisional = true) tied to its order batch; fixLedger puts Dhan's fill prices on it and confirms it, and if Dhan
--   rejects the exit the row is hidden (the position is still open).
-- * live_orders.restore: on exit rows, the position as it was before the exit (put back if Dhan rejects the exit).
-- * algo_strategies.exec_state takes a new value 'exit_retry' (an exit that didn't go is tried again every minute);
--   exec_at is now also set with 'working' (orders stuck for over 10 minutes are read again from Dhan).
alter table public.algo_trades add column if not exists provisional boolean not null default false;
alter table public.algo_trades add column if not exists order_batch uuid;
create index if not exists algo_trades_order_batch on public.algo_trades (order_batch) where order_batch is not null;
alter table public.live_orders add column if not exists restore jsonb;
