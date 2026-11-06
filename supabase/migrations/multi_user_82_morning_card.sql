-- 6 Nov 2026 audit, "delight" items: the morning card, the monthly client statement, lab scores for clients' own
-- strategies, and the 08:30 IST hook in the minute dispatcher.
--
-- morning_card(p_user): what the Home page's card and the 08:30 IST notification (engine action "morning") both read:
-- open positions with how far each stop is, today's booked P&L, expiries today, the Dhan token and data plan, the error
-- breaker, the kill rule, active live / paper counts and (admins) lab passes of the last 24 h.
-- client_statement(p_user, p_month): one month's trades by mode / strategy / asset, the live net to month end and its
-- high-water mark, Shukrana accepted in the month, the current rate and the Shukrana summary — the monthly statement.
-- lab_scores(ids): the lab's consistency score for the lab results behind a client's own strategies (the
-- lab_results_list view is security-invoker, so a client's read of it is refused; admins see every id).

create or replace function public.morning_card(p_user uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := coalesce(p_user, auth.uid());
  today date := (now() at time zone 'Asia/Kolkata')::date;
  opn jsonb; booked numeric; kills int; newlab int; act record; tok record; brk record; adm boolean;
begin
  if u is null then return null; end if;
  if auth.uid() is not null and u <> auth.uid() and not public.is_admin() then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'asset', s.underlying, 'live', s.live, 'side', s.position, 'lots', s.pos_lots,
      'entry', s.pos_entry_px, 'ltp', s.pos_ltp, 'upnl', s.pos_upnl, 'stop', (s.pos_risk->>'stop')::numeric,
      'stop_pct', case when (s.pos_risk->>'stop') is not null and coalesce(s.pos_ltp, 0) > 0
        then round(abs(s.pos_ltp - (s.pos_risk->>'stop')::numeric) / s.pos_ltp * 100, 2) end,
      'expiry', s.pos_expiry, 'expires_today', s.pos_expiry is not null and s.pos_expiry::date = today) order by s.pos_upnl desc nulls last), '[]'::jsonb)
    into opn from public.algo_strategies s where s.owner_id = u and not s.archived and s.position <> 'FLAT';
  select coalesce(sum(t.net), 0) into booked from public.algo_trades t
    where t.user_id = u and not coalesce(t.hidden, false) and (t.exit_at at time zone 'Asia/Kolkata')::date = today;
  select count(*) filter (where live) as live, count(*) filter (where not live) as paper into act
    from public.algo_strategies where owner_id = u and active and not archived;
  select count(*) into kills from public.algo_strategies where owner_id = u and not archived and kill_at is not null;
  select token_expires_at, data_valid_until, data_plan into tok from public.broker_accounts where user_id = u and broker = 'DHAN' limit 1;
  select halted_at, halt_reason into brk from public.risk_state where user_id = u;
  adm := exists (select 1 from public.profiles where user_id = u and role = 'admin') or exists (select 1 from public.app_owner where user_id = u);
  select count(*) into newlab from public.lab_results where passed and superseded_by is null and created_at > now() - interval '24 hours';
  return jsonb_build_object('day', today, 'open', opn, 'booked_today', trunc(booked), 'active_live', act.live, 'active_paper', act.paper, 'kills', kills,
    'token_expires_at', tok.token_expires_at,
    'token_hours_left', case when tok.token_expires_at is not null then round(extract(epoch from (tok.token_expires_at - now())) / 3600, 1) end,
    'data_plan', tok.data_plan, 'data_valid_until', tok.data_valid_until,
    'data_days_left', case when tok.data_valid_until is not null then tok.data_valid_until - today end,
    'breaker_halted', brk.halted_at is not null, 'breaker_reason', brk.halt_reason,
    'new_lab_passes', case when adm then newlab end);
end $$;
grant execute on function public.morning_card(uuid) to authenticated;

create or replace function public.client_statement(p_user uuid default null, p_month date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uuid := coalesce(p_user, auth.uid());
  m0 date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Kolkata')::date))::date;
  m1 date; by_mode jsonb; by_strat jsonb; by_asset jsonb; hwm numeric; live_end numeric; acc numeric; rate numeric; shk jsonb;
begin
  if u is null then return null; end if;
  if auth.uid() is not null and u <> auth.uid() and not public.is_admin() then raise exception 'not allowed'; end if;
  m1 := (m0 + interval '1 month')::date;
  select coalesce(jsonb_object_agg(mode, j), '{}'::jsonb) into by_mode from (
    select t.mode, jsonb_build_object('trades', count(*), 'wins', count(*) filter (where t.net > 0), 'gross', trunc(coalesce(sum(t.gross), 0)),
      'costs', trunc(coalesce(sum(t.costs), 0)), 'net', trunc(coalesce(sum(t.net), 0)), 'best', trunc(coalesce(max(t.net), 0)), 'worst', trunc(coalesce(min(t.net), 0))) j
    from public.algo_trades t where t.user_id = u and not coalesce(t.hidden, false)
      and (t.exit_at at time zone 'Asia/Kolkata')::date >= m0 and (t.exit_at at time zone 'Asia/Kolkata')::date < m1 group by t.mode) x;
  select coalesce(jsonb_agg(jsonb_build_object('strategy_id', sid, 'name', name, 'asset', asset, 'mode', mode, 'trades', n, 'net', net) order by net desc), '[]'::jsonb) into by_strat from (
    select t.strategy_id sid, s.name, s.underlying asset, t.mode, count(*) n, trunc(sum(t.net)) net
    from public.algo_trades t left join public.algo_strategies s on s.id = t.strategy_id
    where t.user_id = u and not coalesce(t.hidden, false) and (t.exit_at at time zone 'Asia/Kolkata')::date >= m0 and (t.exit_at at time zone 'Asia/Kolkata')::date < m1
    group by 1, 2, 3, 4) y;
  select coalesce(jsonb_agg(jsonb_build_object('asset', asset, 'mode', mode, 'trades', n, 'net', net) order by net desc), '[]'::jsonb) into by_asset from (
    select s.underlying asset, t.mode, count(*) n, trunc(sum(t.net)) net
    from public.algo_trades t left join public.algo_strategies s on s.id = t.strategy_id
    where t.user_id = u and not coalesce(t.hidden, false) and (t.exit_at at time zone 'Asia/Kolkata')::date >= m0 and (t.exit_at at time zone 'Asia/Kolkata')::date < m1
    group by 1, 2) z;
  select coalesce(max(cum), 0), coalesce(max(total), 0) into hwm, live_end from (
    select sum(net) over (order by exit_at, id) cum, sum(net) over () total from public.algo_trades
    where user_id = u and mode = 'LIVE' and not coalesce(hidden, false) and (exit_at at time zone 'Asia/Kolkata')::date < m1) w;
  select coalesce(sum(amount), 0) into acc from public.shukrana_accepted where user_id = u and accepted_on >= m0 and accepted_on < m1;
  select pct into rate from public.shukrana_rates where user_id = u and from_at < m1 order by from_at desc limit 1;
  begin shk := public.shukrana_summary(u); exception when others then shk := null; end;
  return jsonb_build_object('user_id', u, 'month', to_char(m0, 'YYYY-MM'), 'from', m0, 'to', m1 - 1, 'by_mode', by_mode, 'by_strategy', by_strat, 'by_asset', by_asset,
    'live_net_to_month_end', trunc(live_end), 'live_high_water_mark', trunc(hwm), 'shukrana_accepted_in_month', trunc(acc), 'shukrana_rate_pct', rate, 'shukrana_now', shk,
    'strategies', (select jsonb_build_object('live', count(*) filter (where live), 'paper', count(*) filter (where not live)) from public.algo_strategies where owner_id = u and active and not archived));
end $$;
grant execute on function public.client_statement(uuid, date) to authenticated;

create or replace function public.lab_scores(p_ids bigint[]) returns table (id bigint, score numeric, consistency numeric)
language sql security definer set search_path = public stable as $$
  select r.id, r.score, (r.robust->'consistency'->>'score')::numeric
  from public.lab_results r
  where r.id = any(p_ids)
    and (public.is_admin() or exists (select 1 from public.algo_strategies s where s.lab_id = r.id and s.owner_id = auth.uid()))
$$;
grant execute on function public.lab_scores(bigint[]) to authenticated;

-- The dispatcher: at 08:30 IST (03:00 UTC) the morning cards.
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
end $$;
