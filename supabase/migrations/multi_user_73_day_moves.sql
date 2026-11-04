-- Lots by a typical day's move (4 Nov 2026, Papa: "the lots are selected so each strategy makes or loses the same on a
-- typical day; equal per strategy while we trial several strategies per asset"). lab_margins.day_move = the average
-- true range of the last 20 daily candles ÷ the previous close (engine margins.ts dayMovePct), refreshed every morning
-- by engine action day_moves (cron day-moves, 08:51 IST, every day: crypto trades on weekends too).
alter table public.lab_margins add column if not exists day_move numeric;
alter table public.lab_margins add column if not exists day_move_at timestamptz;
select cron.schedule('day-moves', '21 3 * * *', $$select public.engine_call('day_moves')$$);
