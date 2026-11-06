-- 6/7 Nov 2026: the Strategy Lab's walk-forward curve (lab.ts labWalkForward, engine action lab_walkforward, table
-- lab_walkforward from migration 84) runs nightly at 03:30 IST from the minute dispatcher; the engine chains its
-- instalments while a group is half done. Everything else in engine_minute() is as in migrations 81 and 82.
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
  if h = 22 and mi = 0 then
    begin perform public.engine_call('lab_walkforward'); exception when others then raise warning 'engine_minute walk-forward: %', sqlerrm; end;
  end if;
end $$;
