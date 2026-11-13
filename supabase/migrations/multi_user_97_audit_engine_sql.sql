-- Migration 97 (13 Nov 2026, audit after the first live orders). Database side of the engine findings.

-- 1. The minute job looked only at ACTIVE strategies in three places, so a paused strategy still holding a position
--    (after the Emergency stop, or a pause by the desk) got no crypto minute run (rule exits, exit retries), no broker
--    match, and its per-second stop loop could stop. A position is watched until it is closed, paused or not.
--    Also: the order manager runs while any strategy is marked "working", not only while order rows are open (a stuck
--    flag with no open rows was never looked at and blocked that strategy's stops).
do $m$
declare d text;
begin
  d := pg_get_functiondef('public.engine_minute'::regproc);
  d := replace(d, $a$if exists (select 1 from public.algo_strategies where active and data_segment = 'DELTA') then perform public.engine_call('tick_crypto');$a$,
                  $a$if exists (select 1 from public.algo_strategies where data_segment = 'DELTA' and not archived and (active or position <> 'FLAT')) then perform public.engine_call('tick_crypto');$a$);
  d := replace(d, $a$if exists (select 1 from public.live_orders where state in ('queued', 'working', 'resting')) then perform public.engine_call('orders');$a$,
                  $a$if exists (select 1 from public.live_orders where state in ('queued', 'working', 'resting'))
       or exists (select 1 from public.algo_strategies where exec_state = 'working') then perform public.engine_call('orders');$a$);
  d := replace(d, $a$if exists (select 1 from public.algo_strategies where live and active) then perform public.engine_call('reconcile');$a$,
                  $a$if exists (select 1 from public.algo_strategies where live and not archived and (active or position <> 'FLAT')) then perform public.engine_call('reconcile');$a$);
  if position($a$(active or position <> 'FLAT')) then perform public.engine_call('tick_crypto')$a$ in d) = 0
     or position($a$exec_state = 'working'$a$ in d) = 0
     or position($a$(active or position <> 'FLAT')) then perform public.engine_call('reconcile')$a$ in d) = 0 then
    raise exception 'engine_minute not patched';
  end if;
  execute d;
end $m$;

-- The 10-second price job: any open position keeps it running, paused or not.
select cron.alter_job(job_id := 24, command := $a$select public.engine_call('prices') where exists (select 1 from public.algo_strategies where not archived and ((position <> 'FLAT')
  or (active and data_segment <> 'DELTA' and extract(dow from (now() at time zone 'Asia/Kolkata')) between 1 and 5 and (now() at time zone 'Asia/Kolkata')::time between '08:55' and '23:59')))$a$);

-- 2. The phone said "Filled" the moment a Dhan order was only queued (the desk writes the position when it sends the
--    order). "Filled" now needs the broker's fill price; until then the "sending to the broker" note stands.
do $m$
declare d text;
begin
  d := pg_get_functiondef('public.trg_live_pos_notify'::regproc);
  d := replace(d, $a$if (old.position is distinct from new.position) or ((new.pos_broker->>'fill') is distinct from (old.pos_broker->>'fill') and new.pos_broker->>'fill' is not null) then$a$,
                  $a$if (new.pos_broker->>'fill') is not null and ((old.position is distinct from new.position) or (new.pos_broker->>'fill') is distinct from (old.pos_broker->>'fill')) then$a$);
  if position($a$if (new.pos_broker->>'fill') is not null and ((old.position$a$ in d) = 0 then raise exception 'trg_live_pos_notify not patched'; end if;
  execute d;
end $m$;

-- 3. A manual order (Orders › Failed orders) stayed "Sent to broker" after Dhan filled or refused it: the order row's
--    final state now updates it.
create or replace function public.trg_manual_order_sync() returns trigger language plpgsql security definer set search_path to 'public' as $f$
begin
  if new.state is not distinct from old.state or new.purpose not in ('entry', 'exit') then return new; end if;
  if new.state = 'filled' then
    update public.manual_orders set state = 'filled', done_at = now(),
      result = 'Filled at the broker: ' || coalesce(new.filled_qty, new.qty) || ' of ' || new.label || coalesce(' at ' || new.avg_px, '')
     where strategy_id = new.strategy_id and state in ('sent', 'working') and created_at > now() - interval '1 day'
       and ((new.purpose = 'entry' and side in ('LONG', 'SHORT')) or (new.purpose = 'exit' and side = 'EXIT'));
  elsif new.state in ('failed', 'gave_up', 'cancelled') and coalesce(new.filled_qty, 0) = 0 then
    update public.manual_orders set state = 'refused', done_at = now(), result = left('Not filled: ' || coalesce(new.note, new.state), 400)
     where strategy_id = new.strategy_id and state in ('sent', 'working') and created_at > now() - interval '1 day'
       and ((new.purpose = 'entry' and side in ('LONG', 'SHORT')) or (new.purpose = 'exit' and side = 'EXIT'));
  end if;
  return new;
exception when others then return new;
end $f$;
create or replace trigger manual_order_sync after update of state on public.live_orders for each row execute function public.trg_manual_order_sync();
revoke execute on function public.trg_manual_order_sync() from public, anon, authenticated;

-- The one already filled (13 Nov, LT).
update public.manual_orders m set state = 'filled', done_at = now(),
  result = (select 'Filled at the broker: ' || coalesce(o.filled_qty, o.qty) || ' of ' || o.label || coalesce(' at ' || o.avg_px, '')
              from public.live_orders o where o.strategy_id = m.strategy_id and o.purpose = 'entry' and o.state = 'filled' and o.created_at >= m.created_at order by o.id limit 1)
 where m.state = 'sent' and exists (select 1 from public.live_orders o where o.strategy_id = m.strategy_id and o.purpose = 'entry' and o.state = 'filled' and o.created_at >= m.created_at);
