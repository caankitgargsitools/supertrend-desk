-- 16 Nov 2026 (Papa: "It should not cancel the order. It should wait and ask me … show a notification, create a sound …
-- options, change price further or cancel the entry. And the user will select what to do").
-- A live Dhan ENTRY order that stays unfilled after the desk's own price steps (or whose price change Dhan refuses) is
-- no longer cancelled by the desk. The order rests at the broker, the desk asks the owner (live_orders.ask_at, the
-- entry's live-trade notification with stage "ask"), and the owner's answer (decision: chase / cancel) is carried out by
-- the order manager. Exits are unchanged (they go at market after 3 steps).
alter table public.live_orders
  add column if not exists ask_at timestamptz,          -- when the owner was (last) asked; null = not waiting for an answer
  add column if not exists ask_px numeric,              -- the market price when asked
  add column if not exists ask_why text,                -- Dhan's reason when a price change was refused; null = the price ran away
  add column if not exists asks integer not null default 0,
  add column if not exists fails integer not null default 0,   -- price changes refused in a row
  add column if not exists decision text check (decision in ('chase', 'cancel')),
  add column if not exists decision_at timestamptz,
  add column if not exists decision_by uuid;

-- The owner's (or an admin's) answer. The order manager acts on it within seconds (it is called at once; one that is
-- already running picks the answer up at its next look, at most 15 seconds later).
create or replace function public.order_decide(p_order bigint, p_action text) returns json
language plpgsql security definer set search_path to 'public' as $$
declare o public.live_orders;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_action not in ('chase', 'cancel') then raise exception 'Choose to change the price or to cancel the entry.'; end if;
  select * into o from public.live_orders where id = p_order;
  if o.id is null or not (public.is_admin() or o.user_id = auth.uid()) then raise exception 'Order not found.'; end if;
  if o.purpose <> 'entry' or o.state <> 'working' then raise exception 'This order is no longer waiting: it was filled or closed meanwhile.'; end if;
  if o.ask_at is null then raise exception 'The desk is still working this order by itself.'; end if;
  if o.decision is not null then raise exception 'Your choice is already being carried out.'; end if;
  update public.live_orders set decision = p_action, decision_at = now(), decision_by = auth.uid() where id = p_order;
  perform public.engine_call('orders', null);
  return json_build_object('ok', true, 'action', p_action);
end $$;
revoke all on function public.order_decide(bigint, text) from public, anon;
grant execute on function public.order_decide(bigint, text) to authenticated;

-- The caller's entry orders waiting for an answer (the app shows its card and banner from this).
create or replace function public.orders_asking() returns json
language sql stable security definer set search_path to 'public' as $$
  select coalesce(json_agg(x order by x.ask_at), '[]'::json) from (
    select o.id, o.strategy_id, s.name, s.underlying, o.side, o.label, o.lots, o.qty, o.limit_px, o.steps, o.asks, o.ask_at, o.ask_px, o.ask_why,
           o.decision, o.placed_at, o.tick,
           (select p.px from public.live_prices p where p.seg = o.seg and p.sec = o.sec and p.at > now() - interval '2 minutes') now_px
    from public.live_orders o join public.algo_strategies s on s.id = o.strategy_id
    where auth.uid() is not null and o.user_id = auth.uid() and o.purpose = 'entry' and o.state = 'working' and o.ask_at is not null
  ) x $$;
revoke all on function public.orders_asking() from public, anon;
grant execute on function public.orders_asking() to authenticated;

-- The entry's notification when the order ends without a fill: also when the owner chose to cancel it (state gave_up).
create or replace function public.trg_live_order_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.purpose = 'entry' and new.state in ('failed', 'cancelled', 'rejected', 'gave_up') and old.state is distinct from new.state and coalesce(new.filled_qty, 0) = 0 then
    perform public.live_note(new.user_id, new.strategy_id, 'le-' || new.strategy_id, false,
      case when new.state = 'gave_up' then '❌ LIVE entry cancelled · ' else '❌ LIVE entry not filled · ' end || coalesce((select underlying from public.algo_strategies where id = new.strategy_id), ''),
      case when new.state = 'gave_up' then 'The entry order was cancelled as you chose. No position was opened.'
           else 'The broker did not fill the entry' || coalesce(': ' || nullif(new.note, ''), '') || '. No position was opened.' end,
      jsonb_build_object('live', true, 'stage', 'failed', 'quiet', new.state = 'gave_up'));
  end if;
  return new;
exception when others then return new;
end $$;
