-- A bought strategy keeps none of the publisher's settings in the buyer's row: the engine reads them from the master at
-- run time, so the buyer's copy holds only the instrument, its size and its live state.
create or replace function public.buy_listing(p_listing bigint, p_name text, p_capital numeric, p_lots int, p_max_lots int) returns uuid language plpgsql security definer set search_path = public as $$
declare l public.listings; owned boolean; bal numeric; v uuid; m public.algo_strategies;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from public.profiles where user_id = auth.uid() and status = 'active') and not public.is_admin() then raise exception 'Your account is not active.'; end if;
  select * into l from public.listings where id = p_listing and status = 'published';
  if not found then raise exception 'This strategy is not on offer.'; end if;
  select * into m from public.algo_strategies where id = l.strategy_id;
  owned := exists (select 1 from public.purchases where listing_id = l.id and user_id = auth.uid());
  if not owned then
    if l.price > 0 then
      bal := public.wallet_balance(auth.uid());
      if bal < l.price then raise exception 'This strategy costs ₹%. Your wallet has ₹%. Recharge first.', l.price, bal; end if;
      insert into public.wallet_txns (user_id, amount, kind, note) values (auth.uid(), -l.price, 'PURCHASE', 'Bought strategy: ' || l.title);
    end if;
    insert into public.purchases (user_id, listing_id, price) values (auth.uid(), l.id, l.price);
  end if;
  v := public.copy_strategy(l.strategy_id, jsonb_build_object('owner_id', auth.uid(), 'source_id', l.strategy_id, 'listing_id', l.id, 'locked', true,
    'is_master', false, 'name', coalesce(nullif(trim(p_name), ''), l.title), 'rules', null, 'risk', null,
    'capital', case when coalesce(p_capital, 0) > 0 then p_capital end, 'lots', greatest(1, coalesce(p_lots, 1)),
    'sizing', case when coalesce(p_capital, 0) > 0 then jsonb_build_object('mode', 'CAPITAL', 'max_lots', greatest(1, coalesce(p_max_lots, 10))) end));
  perform set_config('app.bypass', 'on', true);
  update public.algo_strategies set strategy_kind = default, timeframe_min = default, atr_period = default, factor = default, entry_mode = default,
    entry_trigger = default, buffer_points = default, bias_timeframe = default, bias_source = default, entry_time = default, exit_time = default,
    exit_next_day = default, session_start = default, last_entry = default, square_off = default, strike_offset = default, direction = default,
    after_hours_flip = default, active = false, live = false
  where id = v;
  return v;
end $$;
revoke all on function public.buy_listing(bigint, text, numeric, int, int) from public, anon;
grant execute on function public.buy_listing(bigint, text, numeric, int, int) to authenticated;
