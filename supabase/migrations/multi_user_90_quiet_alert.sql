-- 12 Nov 2026 (go-live review): an alert within minutes when the desk stops seeing prices for a LIVE open position while
-- its market is open (the per-second prices / stop watcher stalled, Dhan or Delta refusing, the engine down). Hourly
-- System health was the only check before. engine_quiet_check() runs every minute from engine_minute(); one note per
-- owner (and admins) per 30 minutes, pushed to the phone (kind "error", link /?health=1).
create or replace function public.engine_quiet_check() returns int
language plpgsql security definer set search_path = public as $$
declare
  ist timestamp := now() at time zone 'Asia/Kolkata'; d date := (now() at time zone 'Asia/Kolkata')::date;
  dw int := extract(isodow from (now() at time zone 'Asia/Kolkata'))::int; t time := (now() at time zone 'Asia/Kolkata')::time;
  r record; n int := 0; msg text;
begin
  for r in
    with q as (
      select s.owner_id, s.name, s.underlying, s.data_segment,
             coalesce(m.at, s.pos_ltp_at) last_at
      from public.algo_strategies s left join public.live_marks m on m.strategy_id = s.id
      where s.live and not s.archived and s.position <> 'FLAT')
    select owner_id, string_agg(underlying || ' (' || coalesce(to_char(last_at at time zone 'Asia/Kolkata', 'HH24:MI'), 'never') || ')', ', ') what, count(*) k
    from q
    where (last_at is null or last_at < now() - interval '3 minutes')
      and case
        when data_segment = 'DELTA' then true
        when data_segment = 'MCX_COMM' then dw between 1 and 5 and t between '09:05' and '23:20'
          and not exists (select 1 from public.market_holidays h where h.day = d and h.exch = 'MCX' and h.opens_at is null)
        else dw between 1 and 5 and t between '09:20' and '15:25'
          and not exists (select 1 from public.market_holidays h where h.day = d and h.exch = 'NSE' and h.opens_at is null)
      end
    group by owner_id
  loop
    if exists (select 1 from public.notifications where user_id = r.owner_id and title like 'Live prices stopped%' and created_at > now() - interval '30 minutes') then continue; end if;
    msg := format('No price for %s live position%s for over 3 minutes while the market is open: %s. Stops at the broker still stand, but the desk''s own stops, targets and exits can''t act until prices come back. Check System health and your Dhan / Delta connection.',
      r.k, case when r.k = 1 then '' else 's' end, r.what);
    insert into public.notifications (user_id, kind, url, title, body) values (r.owner_id, 'error', '/?health=1', 'Live prices stopped', msg);
    insert into public.notifications (user_id, kind, url, title, body)
      select p.user_id, 'error', '/?health=1', 'Live prices stopped (a client)', msg from public.profiles p where p.role = 'admin' and p.user_id <> r.owner_id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.engine_minute() returns void
language plpgsql security definer set search_path = public as $$
declare
  h int := extract(hour from now())::int; dw int := extract(dow from now())::int; mi int := extract(minute from now())::int;
begin
  if dw between 1 and 5 and h between 3 and 18 then
    begin perform public.engine_call('tick'); exception when others then raise warning 'engine_minute tick: %', sqlerrm; end;
  end if;
  begin
    if exists (select 1 from public.algo_strategies where active and data_segment = 'DELTA') then perform public.engine_call('tick_crypto'); end if;
  exception when others then raise warning 'engine_minute tick_crypto: %', sqlerrm; end;
  begin
    if exists (select 1 from public.live_orders where state in ('queued', 'working', 'resting')) then perform public.engine_call('orders'); end if;
  exception when others then raise warning 'engine_minute orders: %', sqlerrm; end;
  begin
    if exists (select 1 from public.notifications where pushed_at is null and created_at > now() - interval '6 hours') then perform public.engine_call('push'); end if;
  exception when others then raise warning 'engine_minute push: %', sqlerrm; end;
  begin
    if exists (select 1 from public.spread_state where until > now()) then perform public.engine_call('spreads'); end if;
  exception when others then raise warning 'engine_minute spreads: %', sqlerrm; end;
  begin
    if exists (select 1 from public.algo_backtests where status = 'queued' and waiting) then perform public.kick_backtests(); end if;
  exception when others then raise warning 'engine_minute backtests: %', sqlerrm; end;
  begin perform public.desk_snapshot(); exception when others then raise warning 'engine_minute snapshot: %', sqlerrm; end;
  -- Live positions whose prices stopped coming in while their market is open (12 Nov 2026, go-live review).
  begin perform public.engine_quiet_check(); exception when others then raise warning 'engine_minute quiet: %', sqlerrm; end;
  if mi % 5 = 0 then
    begin
      if exists (select 1 from public.algo_strategies where live and active) then perform public.engine_call('reconcile'); end if;
    exception when others then raise warning 'engine_minute reconcile: %', sqlerrm; end;
    begin
      if exists (select 1 from public.pred_settings where id = 1 and enabled) then perform public.engine_call('pred_feed'); end if;
    exception when others then raise warning 'engine_minute pred_feed: %', sqlerrm; end;
  end if;
  if h = 3 and mi = 0 then
    begin perform public.engine_call('morning'); exception when others then raise warning 'engine_minute morning: %', sqlerrm; end;
  end if;
  if h = 22 and mi = 0 then
    begin perform public.engine_call('lab_walkforward'); exception when others then raise warning 'engine_minute walk-forward: %', sqlerrm; end;
  end if;
end $$;
