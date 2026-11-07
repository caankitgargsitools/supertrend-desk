-- 7 Nov 2026: the Desk's "Order manager" and "Broker match" pulse bars read cron jobs 18 (live-orders) and 19
-- (live-reconcile), switched off on 6 Nov when engine_minute() took over their work (migration 81) — so both showed
-- "stopped" while the work ran. They now read the dispatcher's own runs (job "engine-minute"): the order manager = its
-- latest successful run, the broker match = its latest successful run on a 5-minute mark (when reconcile is called).
create or replace function public.desk_feeds() returns json
language plpgsql security definer set search_path = public as $$
declare mx bigint; jid bigint;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select max(runid) into mx from cron.job_run_details;
  select jobid into jid from cron.job where jobname = 'engine-minute';
  return json_build_object(
    'now', now(),
    'nse', (select max(at) from public.live_prices where seg in ('IDX_I', 'NSE_EQ')),
    'mcx', (select max(at) from public.live_prices where seg = 'MCX_COMM'),
    'crypto', (select max(at) from public.live_prices where seg = 'DELTA'),
    'stops', (select max(at) from public.live_marks),
    'open', (select count(*) from public.algo_strategies where position <> 'FLAT' and not archived and not is_master),
    'live_orders', (select count(*) from public.live_orders where state in ('queued', 'working', 'resting')),
    'live_n', (select count(*) from public.algo_strategies where live and active and not archived),
    'orders', (select max(start_time) from cron.job_run_details where runid > mx - 600 and jobid = jid and status = 'succeeded'),
    'reconcile', (select max(start_time) from cron.job_run_details where runid > mx - 900 and jobid = jid and status = 'succeeded'
                    and extract(minute from start_time)::int % 5 = 0));
end $$;
