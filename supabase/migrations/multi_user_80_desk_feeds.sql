-- Desk › System feeds (6 Nov 2026, Papa: pulse bars that keep going while each feed works, red on a break). The latest time
-- of each: Dhan NSE/BSE and MCX prices and Delta prices (live_prices), the stop watcher (live_marks), the order manager
-- and broker match cron jobs (18 live-orders, every minute; 19 live-reconcile, every 5 minutes; latest runs by runid),
-- plus open positions, live orders and live strategies (to tell "nothing to do" from "broken"). No extra Dhan / Delta calls.
create or replace function public.desk_feeds() returns json language plpgsql stable security definer set search_path = public as $$
declare mx bigint;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select max(runid) into mx from cron.job_run_details;
  return json_build_object(
    'now', now(),
    'nse', (select max(at) from public.live_prices where seg in ('IDX_I', 'NSE_EQ')),
    'mcx', (select max(at) from public.live_prices where seg = 'MCX_COMM'),
    'crypto', (select max(at) from public.live_prices where seg = 'DELTA'),
    'stops', (select max(at) from public.live_marks),
    'open', (select count(*) from public.algo_strategies where position <> 'FLAT' and not archived and not is_master),
    'live_orders', (select count(*) from public.live_orders where state in ('queued', 'working', 'resting')),
    'live_n', (select count(*) from public.algo_strategies where live and active and not archived),
    'orders', (select max(start_time) from cron.job_run_details where runid > mx - 600 and jobid = 18 and status = 'succeeded'),
    'reconcile', (select max(start_time) from cron.job_run_details where runid > mx - 900 and jobid = 19 and status = 'succeeded'));
end $$;
revoke all on function public.desk_feeds() from public, anon;
grant execute on function public.desk_feeds() to authenticated;
