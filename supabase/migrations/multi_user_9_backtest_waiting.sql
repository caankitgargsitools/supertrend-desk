-- Backtests waiting for a free slot are status 'queued' with waiting = true (the table's status check doesn't allow
-- 'waiting'). kick_backtests starts up to two at a time; run_backtest, rerun_backtest and queue_listing_backtests queue
-- with waiting = true. Applied by editing those functions in place (replace 'waiting' status with queued + waiting flag).
alter table public.algo_backtests add column if not exists waiting boolean not null default false;
select cron.schedule('backtest-queue', '* * * * *', $$select public.kick_backtests() where exists (select 1 from public.algo_backtests where status = 'queued' and waiting)$$);
