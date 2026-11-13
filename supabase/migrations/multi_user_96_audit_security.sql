-- Migration 96 (13 Nov 2026, audit after the first live orders). Security findings of the database review.

-- 1. Report functions readable WITHOUT a login: trade_story / morning_card / client_statement / slippage_summary are
--    SECURITY DEFINER and their guard is skipped when there is no JWT (so the engine can call them); PUBLIC and anon
--    still had EXECUTE, so the public anon key could read every user's trades, positions and statements.
--    Only signed-in users (their own data, checked inside) and the engine (service_role) may call them now.
revoke execute on function public.trade_story(bigint), public.morning_card(uuid), public.client_statement(uuid, date),
  public.slippage_summary(uuid) from public, anon;
grant execute on function public.trade_story(bigint), public.morning_card(uuid), public.client_statement(uuid, date),
  public.slippage_summary(uuid) to authenticated, service_role;

-- 2. Nothing a visitor without a login needs: the rest of the functions anon could still call (each already refuses
--    without auth.uid(), this closes the door as well).
revoke execute on function public.manual_order(uuid, text, integer, bigint, numeric), public.failed_orders(integer),
  public.save_mode_capital(text, numeric, date, numeric), public.save_my_capital(numeric, date, numeric),
  public.breaker_allow_mode(text, uuid), public.breaker_allow(uuid), public.lab_scores(bigint[]), public.audit_now(),
  public.lab_run_focus(text[], integer), public.lab_refresh_status(), public.notify_live_test(integer),
  public.request_lab_variations(bigint, uuid, integer, text[], text[]),
  public.request_lab_variations(bigint, uuid, integer, text[], text[], integer[], boolean) from public, anon;
grant execute on function public.manual_order(uuid, text, integer, bigint, numeric), public.failed_orders(integer),
  public.save_mode_capital(text, numeric, date, numeric), public.save_my_capital(numeric, date, numeric),
  public.breaker_allow_mode(text, uuid), public.breaker_allow(uuid), public.lab_scores(bigint[]), public.audit_now(),
  public.lab_run_focus(text[], integer), public.lab_refresh_status(), public.notify_live_test(integer),
  public.request_lab_variations(bigint, uuid, integer, text[], text[]),
  public.request_lab_variations(bigint, uuid, integer, text[], text[], integer[], boolean) to authenticated, service_role;
-- The quiet-prices check is for the minute job only.
revoke execute on function public.engine_quiet_check() from public, anon, authenticated;

-- New functions: no EXECUTE for visitors without a login unless a migration grants it.
alter default privileges for role postgres in schema public revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon;

-- 3. Marketplace listings (and the admin's user id in created_by) were readable without a login.
revoke select on public.listings from anon;

-- 4. The outgoing-request queue (its headers carry the engine secret) is not for app users.
revoke all on all tables in schema net from anon, authenticated;
revoke usage on schema net from anon, authenticated;

-- 5. An open position can't be orphaned from the app: no switch back to paper and no archive while the strategy holds a
--    position (the price / stop loop skips archived strategies, and a live position booked as paper would leave the real
--    one at the broker with nobody watching it). The pages already check this; now the database does too, for admins too.
do $m$
declare d text;
begin
  d := pg_get_functiondef('public.guard_strategy'::regproc);
  if position('Exit the open position first' in d) = 0 then
    d := regexp_replace(d, E'\\nbegin\\n', E'\nbegin\n  if tg_op = ''UPDATE'' and current_user = ''authenticated'' and old.position is distinct from ''FLAT''\n     and ((old.live and not new.live) or (new.archived and not old.archived)) then\n    raise exception ''Exit the open position first: a strategy holding a position can''''t be archived or switched to paper.'';\n  end if;\n', '');
    if position('Exit the open position first' in d) = 0 then raise exception 'guard_strategy not patched'; end if;
    execute d;
  end if;
end $m$;

-- 6. A strategy with live trades can't be deleted by its owner (the trades, orders and signals cascade with it, and
--    Shukrana due is worked out from those trades).
alter policy strategies_user_delete on public.algo_strategies using (
  owner_id = (select auth.uid()) and position = 'FLAT' and not live
  and not exists (select 1 from public.algo_trades t where t.strategy_id = algo_strategies.id and t.mode = 'LIVE'));
