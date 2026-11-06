-- 6 Nov 2026 audit (database): one dispatcher per minute instead of seven cron jobs starting at second :00 (the
-- pile-up behind both outages: 548 "job startup timeout" runs on 6 Nov), the price loop only in market hours, policies
-- that call is_owner() once per statement instead of once per row (36 M scans of the one-row app_owner table),
-- the indexes two slow lab queries and every "Delete permanently" needed, one error notification per cause per
-- account per hour (not one per strategy), the retired deploy-fee job switched off, and the stale Dhan token in the
-- dead portal_settings table blanked.
--
-- Applied in two steps: everything below first; two minutes later, once engine-minute had run, the old jobs were
-- switched off with cron.alter_job(active := false) — jobs 1 (tick), 6 (backtest-queue), 13 (crypto-tick), 16 (push),
-- 18 (live-orders), 19 (live-reconcile), 28 (pred-feed), 35 (spread-watch), 36 (desk-snapshot). Nothing is dropped:
-- cron.alter_job(jobid, active := true) brings any of them back.

create or replace function public.engine_minute() returns void
language plpgsql security definer set search_path = public as $$
declare
  h int := extract(hour from now())::int; dw int := extract(dow from now())::int; mi int := extract(minute from now())::int;
begin
  -- The market tick: Mon–Fri 03:00–18:59 UTC (08:30–00:29 IST), as job 1 had it.
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
    -- the spread watcher runs only until its watch period ends
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
end $$;
revoke all on function public.engine_minute() from public, anon, authenticated;

select cron.schedule('engine-minute', '* * * * *', $$select public.engine_minute()$$);

-- The 10-second price loop only in market hours (it ran through nights and weekends): any open position, or an active
-- Dhan strategy Mon–Fri 08:55–23:59 IST.
select cron.alter_job(24, command := $$select public.engine_call('prices') where exists (select 1 from public.algo_strategies where not archived and ((active and position <> 'FLAT')
  or (active and data_segment <> 'DELTA' and extract(dow from (now() at time zone 'Asia/Kolkata')) between 1 and 5 and (now() at time zone 'Asia/Kolkata')::time between '08:55' and '23:59')))$$);

-- The retired deploy-fee job (Shukrana replaced the wallet fees; it failed every night anyway).
select cron.alter_job(7, active := false);

-- Policies: is_owner() / auth.uid() evaluated once per statement, not once per row.
alter policy crypto_assets_owner_insert on public.crypto_assets with check ((select public.is_owner()));
alter policy crypto_assets_owner_update on public.crypto_assets using ((select public.is_owner())) with check ((select public.is_owner()));
alter policy lab_margins_owner_read on public.lab_margins using ((select public.is_owner()));
alter policy lab_results_owner_delete on public.lab_results using ((select public.is_owner()));
alter policy lab_results_owner_read on public.lab_results using ((select public.is_owner()));
alter policy lab_results_owner_update on public.lab_results using ((select public.is_owner())) with check ((select public.is_owner()));
alter policy lab_runs_owner_read on public.lab_runs using ((select public.is_owner()));
alter policy lab_settings_owner_read on public.lab_settings using ((select public.is_owner()));
alter policy lab_settings_owner_write on public.lab_settings using ((select public.is_owner())) with check ((select public.is_owner()));
alter policy mcx_contracts_owner_read on public.mcx_contracts using ((select public.is_owner()));
alter policy live_orders_own on public.live_orders using (user_id = (select auth.uid()));

-- Indexes: the robust-status lookup (58 ms full scan × 40 k calls), the backtest-queue guard, the FK behind
-- "Delete permanently".
create index if not exists lab_results_robust_status_idx on public.lab_results (robust_status, id desc);
create index if not exists algo_backtests_waiting_idx on public.algo_backtests (status) where waiting;
create index if not exists lab_results_promoted_idx on public.lab_results (promoted_id) where promoted_id is not null;

-- One error notification per cause per account per hour (46 on 6 Nov for one Dhan 401, one per strategy).
create or replace function public.trg_strategy_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.is_master, false) then return new; end if;
  if new.last_error is not null and new.last_error is distinct from old.last_error
     and not exists (select 1 from public.notifications where user_id = new.owner_id and kind = 'error' and body = left(new.last_error, 400) and created_at > now() - interval '1 hour') then
    perform public.notify_tagged(new.owner_id, 'error', 'Error · ' || left(new.name, 60), new.last_error, '/?s=' || new.id, new.id, null);
  end if;
  if new.live is distinct from old.live then
    perform public.notify_tagged(new.owner_id, 'live', case when new.live then 'Now live: real orders · ' else 'Back to paper · ' end || left(new.name, 60),
      case when new.live then 'From its next signal this strategy sends real orders.' else 'Orders are now only logged, not sent.' end, '/?s=' || new.id, new.id, null);
  end if;
  return new;
end $$;

-- A Dhan token in a table nothing reads any more.
update public.portal_settings set dhan_access_token = null, webhook_secret = null where dhan_access_token is not null or webhook_secret is not null;
