-- 7 Nov 2026: the morning card counted a position as "without a stop" when it had only a trailing stop (pos_risk.stop
-- null, pos_risk.trail set). The effective stop is now the fixed stop or the trailing one (best ∓ trail), whichever is
-- tighter, as the engine (risk.ts effectiveStop) and the website (stopLevel) compute it.
create or replace function public.eff_stop(p jsonb) returns numeric language sql immutable set search_path = public as $$
  with x as (select (p->>'dir')::int dir, (p->>'stop')::numeric st, (p->>'best')::numeric best, p->'trail' tr, coalesce((p->>'trailAtr')::numeric, 0) atr)
  select case
    when x.tr is null or jsonb_typeof(x.tr) <> 'object' or x.best is null then x.st
    else (select case when x.st is null then t when x.dir = 1 then greatest(x.st, t) else least(x.st, t) end
          from (select x.best - x.dir * case x.tr->>'type' when 'POINTS' then (x.tr->>'value')::numeric
                                                          when 'PCT' then x.best * (x.tr->>'value')::numeric / 100
                                                          else (x.tr->>'value')::numeric * x.atr end t) y)
  end from x
$$;

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
      'entry', s.pos_entry_px, 'ltp', s.pos_ltp, 'upnl', s.pos_upnl, 'stop', public.eff_stop(s.pos_risk),
      'stop_pct', case when public.eff_stop(s.pos_risk) is not null and coalesce(s.pos_ltp, 0) > 0
        then round(abs(s.pos_ltp - public.eff_stop(s.pos_risk)) / s.pos_ltp * 100, 2) end,
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
