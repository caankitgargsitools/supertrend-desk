-- Pending list, quick items (Papa's answers, 4 Nov 2026).
-- 5. "Send a test notification": at most once a minute per user (real alerts are never limited).
create or replace function public.notify_test() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if exists (select 1 from public.notifications where user_id = auth.uid() and kind = 'test' and created_at > now() - interval '1 minute') then
    raise exception 'A test notification was sent less than a minute ago. Try again in a minute.';
  end if;
  insert into public.notifications (user_id, kind, title, body, url) values (auth.uid(), 'test', 'Test notification', 'Notifications are working on this phone. You will be told about new positions, exits, errors and other actions.', '/');
  perform public.engine_call('push');
end $$;
revoke all on function public.notify_test() from public, anon;
grant execute on function public.notify_test() to authenticated;

-- 7. The 10 backtests stuck "running" since 9–10 Oct 2026 (ids 42, 97, 98, 112, 117–122) marked as stopped; nothing deleted.
update public.algo_backtests set status = 'failed', error = 'Stopped: it never finished (marked stopped on 4 Nov 2026). Run it again if needed.'
  where status = 'running' and id in (42, 97, 98, 112, 117, 118, 119, 120, 121, 122);

-- 6. Anshul (ap.anshulgarg@gmail.com): his two active paper strategies, which can't run without a Dhan account, paused
-- (nothing deleted), his error stop cleared (its cause is gone) and a notification sent to him.
update public.algo_strategies set active = false, last_error = null
  where owner_id = (select id from auth.users where email = 'ap.anshulgarg@gmail.com') and active and position = 'FLAT';
update public.risk_state set halted_at = null, halt_reason = null, err_ticks = 0, updated_at = now()
  where user_id = (select id from auth.users where email = 'ap.anshulgarg@gmail.com');
insert into public.notifications (user_id, kind, title, body, url)
  select id, 'error', 'Connect your Dhan account', 'Your two paper strategies (Nifty Supertrend flip, Silver Mini 30m) need a connected Dhan account to read market prices, so they have been paused. Connect Dhan under Connections, then switch them on again on the Strategies page.', '/?conn=1'
  from auth.users where email = 'ap.anshulgarg@gmail.com';
