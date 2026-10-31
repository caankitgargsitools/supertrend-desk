-- System health (31 Oct 2026, Papa: "check at least once a day whether everything is running fine"; a page that
-- shows it, with a red dot on its link when something isn't). desk_health() checks every service of the portal from
-- the database's side and keeps the result in health_runs; it runs every hour (cron desk-health), the website is
-- fetched two minutes before (desk-health-ping), admins get a summary every morning and an alert as soon as a check
-- turns red. Status per check: ok / warn / fail / off (switched off on purpose).
create table if not exists public.health_runs (
  id bigserial primary key, run_at timestamptz not null default now(), ok integer, warn integer, fail integer, items jsonb not null
);
create index if not exists health_runs_at on public.health_runs (run_at desc);
create table if not exists public.health_state (k text primary key, v jsonb, at timestamptz not null default now());
alter table public.health_runs enable row level security;
alter table public.health_state enable row level security;
create policy health_runs_admin on public.health_runs for select using ((select public.is_admin()));

-- Is an exchange open now (IST, weekdays, holidays and special sessions from market_holidays)?
create or replace function public.health_market_open(p_exch text) returns boolean language sql stable set search_path = public as $$
  with n as (select now() at time zone 'Asia/Kolkata' t), d as (select t::date dd, extract(isodow from t) wd, t::time tm from n),
  h as (select opens_at from market_holidays, d where market_holidays.day = d.dd and exch = p_exch limit 1)
  select case when (select wd from d) > 5 then false
    when exists (select 1 from h where opens_at is null) then false
    when p_exch = 'MCX' then (select tm from d) between time '09:00' and time '23:55'
    else (select tm from d) between time '09:15' and time '15:30' end;
$$;

-- Dhan tokens are renewed daily: amber only within 3 hours of expiry. Backtests: only those of the last 7 days count.
-- Fetch the website (the answer is read by desk_health a couple of minutes later).
create or replace function public.health_ping() returns void language plpgsql security definer set search_path = public, extensions as $$
declare rid bigint;
begin
  select net.http_get('https://supertrend-desk.vercel.app/') into rid;
  insert into health_state (k, v, at) values ('web_ping', jsonb_build_object('id', rid), now())
    on conflict (k) do update set v = excluded.v, at = excluded.at;
end $$;

create or replace function public.desk_health(p_notify boolean default false) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  it jsonb := '[]'::jsonb; n_ok int; n_warn int; n_fail int; prev jsonb; newly text; a record; x record;
  ist timestamp := now() at time zone 'Asia/Kolkata'; nse boolean := public.health_market_open('NSE'); mcx boolean := public.health_market_open('MCX');
  v_int int; v_int2 int; v_ts timestamptz; v_txt text; ls record;
begin
  -- 1. Website
  select r.status_code, r.created, position('AnkGenie' in coalesce(r.content::text, '')) > 0 as has, r.error_msg into x
    from health_state s left join net._http_response r on r.id = (s.v->>'id')::bigint where s.k = 'web_ping';
  it := it || jsonb_build_object('key', 'web', 'grp', 'Platform', 'name', 'Website (supertrend-desk.vercel.app)',
    'status', case when x is null or x.created is null then 'warn' when x.status_code = 200 and x.has then 'ok' else 'fail' end,
    'detail', case when x is null or x.created is null then 'not fetched yet' when x.status_code = 200 and x.has then 'opens normally'
      else format('answered %s %s', coalesce(x.status_code::text, 'nothing'), coalesce(x.error_msg, '')) end);
  -- 2. Database
  select count(*) into v_int from pg_stat_activity;
  select setting::int into v_int2 from pg_settings where name = 'max_connections';
  it := it || jsonb_build_object('key', 'db', 'grp', 'Platform', 'name', 'Database',
    'status', case when v_int > v_int2 * 0.85 then 'warn' else 'ok' end,
    'detail', format('%s MB · %s of %s connections in use', pg_database_size(current_database()) / 1048576, v_int, v_int2));
  -- 3. Engine: answers to its calls
  select count(*) n0, count(*) filter (where status_code >= 500 or error_msg is not null) n1,
         count(*) filter (where created > now() - interval '1 hour') n2, count(*) filter (where created > now() - interval '1 hour' and (status_code >= 500 or error_msg is not null)) n3
    into a from net._http_response where created > now() - interval '24 hours';
  it := it || jsonb_build_object('key', 'engine', 'grp', 'Platform', 'name', 'Engine (trading and lab server)',
    'status', case when a.n0 = 0 or (select max(created) from net._http_response) < now() - interval '30 minutes' then 'fail'
      when a.n2 > 0 and a.n3::numeric / a.n2 > 0.2 then 'fail' when a.n0 > 0 and a.n1::numeric / a.n0 > 0.02 then 'warn' else 'ok' end,
    'detail', format('%s calls in 24 h, %s failed (%s in the last hour)', a.n0, a.n1, a.n3));
  -- 4. Scheduled jobs
  select string_agg(distinct j.jobname, ', ') into v_txt from cron.job j join cron.job_run_details d on d.jobid = j.jobid
    where j.active and d.start_time > now() - interval '24 hours' and d.status <> 'succeeded';
  select string_agg(j.jobname, ', ') into newly from cron.job j where j.active and (j.schedule like '%seconds' or j.schedule ~ '^\*(/\d+)? \* \* \* \*$')
    and coalesce((select max(start_time) from cron.job_run_details d where d.jobid = j.jobid), 'epoch') < now() - interval '20 minutes';
  it := it || jsonb_build_object('key', 'cron', 'grp', 'Platform', 'name', 'Scheduled jobs',
    'status', case when newly is not null then 'fail' when v_txt is not null then 'warn' else 'ok' end,
    'detail', coalesce('not running: ' || newly, case when v_txt is not null then 'failed in the last 24 h: ' || v_txt end,
      format('%s jobs on schedule', (select count(*) from cron.job where active))));
  newly := null;
  -- 5. Market tick (NSE / MCX strategies)
  select count(*) n0, max(last_run_at) t0 into a from algo_strategies where active and not archived and not is_master and data_segment <> 'DELTA';
  it := it || jsonb_build_object('key', 'tick', 'grp', 'Trading', 'name', 'Market strategies (NSE / MCX)',
    'status', case when a.n0 = 0 then 'off' when (nse or mcx) and coalesce(a.t0, 'epoch') < now() - interval '6 minutes' then 'fail' else 'ok' end,
    'detail', case when a.n0 = 0 then 'no active strategy' else format('%s active · last checked %s IST%s', a.n0, to_char(a.t0 at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'),
      case when nse or mcx then '' else ' (markets closed now)' end) end);
  -- 6. Crypto tick
  select count(*) n0, max(last_run_at) t0 into a from algo_strategies where active and not archived and not is_master and data_segment = 'DELTA';
  it := it || jsonb_build_object('key', 'crypto', 'grp', 'Trading', 'name', 'Crypto strategies (Delta, round the clock)',
    'status', case when a.n0 = 0 then 'off' when coalesce(a.t0, 'epoch') < now() - interval '6 minutes' then 'fail' else 'ok' end,
    'detail', case when a.n0 = 0 then 'no active strategy' else format('%s active · last checked %s IST', a.n0, to_char(a.t0 at time zone 'Asia/Kolkata', 'DD Mon HH24:MI')) end);
  -- 7. Live prices for open positions (every second inside 10-second runs)
  select count(*) filter (where s.data_segment = 'DELTA' or (s.data_segment = 'MCX_COMM' and mcx) or (s.data_segment not in ('DELTA', 'MCX_COMM') and nse)) n0,
         min(m.at) filter (where s.data_segment = 'DELTA' or (s.data_segment = 'MCX_COMM' and mcx) or (s.data_segment not in ('DELTA', 'MCX_COMM') and nse)) t0, count(*) n2
    into a from algo_strategies s left join live_marks m on m.strategy_id = s.id where s.active and not s.archived and s.position <> 'FLAT';
  it := it || jsonb_build_object('key', 'prices', 'grp', 'Trading', 'name', 'Live prices and stops for open positions',
    'status', case when a.n2 = 0 then 'off' when a.n0 > 0 and coalesce(a.t0, 'epoch') < now() - interval '3 minutes' then 'fail' else 'ok' end,
    'detail', case when a.n2 = 0 then 'no open position' when a.n0 = 0 then format('%s open, their markets closed now', a.n2)
      else format('%s open positions priced, oldest price %s s ago', a.n0, greatest(0, extract(epoch from now() - a.t0)::int)) end);
  -- 8. Live orders
  select count(*) filter (where state in ('queued', 'working') and created_at < now() - interval '30 minutes') n0, count(*) filter (where state = 'failed' and created_at > now() - interval '24 hours') n1
    into a from live_orders where created_at > now() - interval '7 days';
  it := it || jsonb_build_object('key', 'orders', 'grp', 'Trading', 'name', 'Live orders at the broker',
    'status', case when a.n0 > 0 then 'fail' when a.n1 > 0 then 'warn' else 'ok' end,
    'detail', case when a.n0 > 0 then format('%s order(s) stuck for over 30 min', a.n0) when a.n1 > 0 then format('%s order(s) failed in the last 24 h', a.n1) else 'nothing stuck or failed' end);
  -- 9. Positions match the broker
  select count(*) into v_int from notifications where title like 'Positions don''t match%' and created_at > now() - interval '24 hours';
  it := it || jsonb_build_object('key', 'reconcile', 'grp', 'Trading', 'name', 'Desk positions match Dhan / Delta',
    'status', case when not exists (select 1 from algo_strategies where live and active) then 'off' when v_int > 0 then 'fail' else 'ok' end,
    'detail', case when not exists (select 1 from algo_strategies where live and active) then 'no live strategy' when v_int > 0 then format('%s mismatch alert(s) in the last 24 h', v_int) else 'checked every 5 min, all match' end);
  -- 10. Dhan login token
  select count(*) filter (where token_expires_at < now()) n0, count(*) filter (where token_expires_at between now() and now() + interval '3 hours') n1, min(token_expires_at) t0
    into a from broker_accounts where broker = 'DHAN' and access_token is not null;
  it := it || jsonb_build_object('key', 'token', 'grp', 'Trading', 'name', 'Dhan connection (access token)',
    'status', case when a.n0 > 0 then 'fail' when a.n1 > 0 then 'warn' else 'ok' end,
    'detail', case when a.t0 is null then 'no expiry date known' else format('next expiry %s IST%s', to_char(a.t0 at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), case when a.n0 > 0 then format(' · %s expired', a.n0) else '' end) end);
  -- 11. Strategies showing an error / stopped by the kill rule
  select count(*) filter (where last_error is not null) n0, count(*) filter (where kill_at is not null) n1 into a from algo_strategies where active and not archived and not is_master;
  it := it || jsonb_build_object('key', 'errors', 'grp', 'Trading', 'name', 'Strategies without errors',
    'status', case when a.n0 > 0 then 'warn' else 'ok' end,
    'detail', format('%s active strateg%s showing an error · %s stopped by the kill rule', a.n0, case when a.n0 = 1 then 'y' else 'ies' end, a.n1));
  -- 12. Daily self-check (07:40 IST)
  select max(created_at) into v_ts from desk_audit;
  it := it || jsonb_build_object('key', 'audit', 'grp', 'Checks', 'name', 'Daily self-check and kill rule (07:40 IST)',
    'status', case when v_ts is null or v_ts < now() - interval '26 hours' then 'warn' else 'ok' end,
    'detail', coalesce('last run ' || to_char(v_ts at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST', 'never run'));
  -- 13. Margin rates from Dhan (weekdays)
  select max(checked_at) into v_ts from lab_margins;
  it := it || jsonb_build_object('key', 'margins', 'grp', 'Checks', 'name', 'Margin rates from Dhan (weekday mornings)',
    'status', case when v_ts is null or v_ts < now() - interval '4 days' then 'warn' else 'ok' end,
    'detail', coalesce('last updated ' || to_char(v_ts at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST', 'never'));
  -- 14. Notifications to phones
  select count(*) into v_int from notifications n where n.pushed_at is null and n.created_at between now() - interval '24 hours' and now() - interval '30 minutes'
    and exists (select 1 from push_subs p where p.user_id = n.user_id);
  it := it || jsonb_build_object('key', 'push', 'grp', 'Checks', 'name', 'Phone notifications',
    'status', case when v_int > 0 then 'warn' else 'ok' end, 'detail', case when v_int > 0 then format('%s not delivered for over 30 min', v_int) else 'delivered' end);
  -- 15. Strategy Lab
  select * into ls from lab_settings where id = 1;
  select count(*) filter (where status = 'done') n0, count(*) filter (where status = 'failed') n1 into a from lab_runs where created_at > now() - interval '24 hours';
  it := it || jsonb_build_object('key', 'lab', 'grp', 'Labs', 'name', 'Strategy Lab',
    'status', case when not coalesce(ls.enabled, false) then 'off' when ls.pause_reason = 'slow' and ls.paused_until > now() then 'warn' when a.n1 > 0 and a.n0 = 0 then 'fail'
      when a.n1 > 0 then 'warn' when a.n0 = 0 and (select max(finished_at) from lab_runs) < now() - interval '3 days' then 'warn' else 'ok' end,
    'detail', case when not coalesce(ls.enabled, false) then 'new strategies switched off' else format('%s runs in 24 h%s%s', a.n0, case when a.n1 > 0 then format(', %s failed', a.n1) else '' end,
      case when ls.pause_reason = 'slow' and ls.paused_until > now() then ' · resting: database slow' else '' end) end);
  -- 16. Luck-test family counts (03:10 IST)
  it := it || jsonb_build_object('key', 'families', 'grp', 'Labs', 'name', 'Strategy Lab family counts (03:10 IST)',
    'status', case when ls.families_at is null or ls.families_at < now() - interval '30 hours' then 'warn' else 'ok' end,
    'detail', coalesce('last ' || to_char(ls.families_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST', 'never'));
  -- 17. Ideas Lab
  select count(*) into v_int from idea_defs where created_at > now() - interval '30 hours';
  it := it || jsonb_build_object('key', 'ideas', 'grp', 'Labs', 'name', 'Ideas Lab',
    'status', case when not coalesce(ls.ideas_enabled, false) then 'off' when v_int = 0 and (select count(*) from idea_defs) > 0 then 'warn' else 'ok' end,
    'detail', case when not coalesce(ls.ideas_enabled, false) then 'switched off' else format('%s new ideas in the last 30 h (%s a day planned)', v_int, coalesce(ls.ideas_per_day, 0)) end);
  -- 18. Combinations (background check)
  select count(*) filter (where state = 'working' and updated_at < now() - interval '1 hour') n0, count(*) filter (where state = 'done') n1, max(updated_at) t0 into a from lab_combo_groups;
  it := it || jsonb_build_object('key', 'combos', 'grp', 'Labs', 'name', 'Combinations (background check every 10 min)',
    'status', case when a.n0 > 0 then 'fail' when a.t0 is null or a.t0 < now() - interval '2 days' then 'warn' else 'ok' end,
    'detail', case when a.n0 > 0 then format('%s group(s) stuck for over an hour', a.n0) else format('%s groups checked, last %s IST', a.n1, to_char(a.t0 at time zone 'Asia/Kolkata', 'DD Mon HH24:MI')) end);
  -- 19. Prediction Lab (AWS server)
  select w.last_seen, w.error, (select enabled from pred_settings where id = 1) en into x from pred_worker w where w.id = 1;
  it := it || jsonb_build_object('key', 'pred', 'grp', 'Labs', 'name', 'Prediction Lab (Chaturbhuj on the AWS server)',
    'status', case when not coalesce(x.en, false) then 'off' when x.last_seen is null or x.last_seen < now() - interval '1 hour' then 'fail' when x.last_seen < now() - interval '10 minutes' or x.error is not null then 'warn' else 'ok' end,
    'detail', case when not coalesce(x.en, false) then 'switched off' when x.last_seen is null then 'never reported'
      else format('last report %s IST%s', to_char(x.last_seen at time zone 'Asia/Kolkata', 'DD Mon HH24:MI'), coalesce(' · ' || left(x.error, 80), '')) end);
  -- 20. Backtests
  select count(*) into v_int from algo_backtests where status in ('queued', 'running') and created_at between now() - interval '7 days' and now() - interval '2 hours';
  it := it || jsonb_build_object('key', 'backtests', 'grp', 'Labs', 'name', 'Backtests',
    'status', case when v_int > 0 then 'warn' else 'ok' end, 'detail', case when v_int > 0 then format('%s waiting for over 2 h', v_int) else 'none stuck' end);

  select count(*) filter (where e->>'status' = 'ok'), count(*) filter (where e->>'status' = 'warn'), count(*) filter (where e->>'status' = 'fail')
    into n_ok, n_warn, n_fail from jsonb_array_elements(it) e;
  select items into prev from health_runs order by id desc limit 1;
  insert into health_runs (ok, warn, fail, items) values (n_ok, n_warn, n_fail, it);
  -- Alerts: a check that has just turned red (at once); every morning, the day's summary.
  select string_agg(format('%s: %s', e->>'name', e->>'detail'), ' · ') into newly from jsonb_array_elements(it) e
    where e->>'status' = 'fail' and not exists (select 1 from jsonb_array_elements(coalesce(prev, '[]'::jsonb)) p where p->>'key' = e->>'key' and p->>'status' = 'fail');
  for a in select user_id from profiles where role = 'admin' loop
    if newly is not null then
      perform public.notify_tagged(a.user_id, 'health', 'System health: something stopped working', newly, '/?health=1', null, 'health-fail-' || to_char(now(), 'YYYYMMDDHH24'));
    end if;
    if p_notify then
      perform public.notify_tagged(a.user_id, 'health', case when n_fail > 0 then format('System health: %s not working, %s to watch', n_fail, n_warn)
          when n_warn > 0 then format('System health: all running, %s to watch', n_warn) else 'System health: everything running fine' end,
        coalesce((select string_agg(format('%s: %s', e->>'name', e->>'detail'), ' · ') from jsonb_array_elements(it) e where e->>'status' in ('fail', 'warn')), format('All %s checks fine.', n_ok)),
        '/?health=1', null, 'health-day-' || to_char(ist, 'YYYYMMDD'));
    end if;
  end loop;
  return jsonb_build_object('ok', n_ok, 'warn', n_warn, 'fail', n_fail);
end $$;
revoke all on function public.desk_health(boolean) from public, anon, authenticated;
revoke all on function public.health_ping() from public, anon, authenticated;

-- “Check now” on the page (admins): fetch the website and run the checks (the website answer is read next time).
create or replace function public.health_check_now() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  perform public.health_ping();
  return public.desk_health(false);
end $$;
revoke all on function public.health_check_now() from public, anon;
grant execute on function public.health_check_now() to authenticated;

select cron.schedule('desk-health-ping', '9 * * * *', $$select public.health_ping()$$);
select cron.schedule('desk-health', '11 * * * *', $$select public.desk_health(false)$$);
-- 08:11 IST: the morning summary (the hourly run at :11 then repeats it without a notification).
select cron.schedule('desk-health-day', '41 2 * * *', $$select public.desk_health(true)$$);
