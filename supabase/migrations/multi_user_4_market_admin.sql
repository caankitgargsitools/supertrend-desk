-- Marketplace, admin tools, wallet and profit share.

-- Copy of a strategy row with some fields replaced (position state always cleared).
create or replace function public.copy_strategy(p_src uuid, p_patch jsonb) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := gen_random_uuid(); j jsonb;
begin
  select to_jsonb(s) into j from public.algo_strategies s where id = p_src;
  if j is null then raise exception 'Strategy not found.'; end if;
  j := j || jsonb_build_object('id', v_id, 'created_at', now(), 'updated_at', now(), 'active', false, 'live', false, 'archived', false, 'archived_at', null,
    'position', 'FLAT', 'pos_option_type', null, 'pos_option_side', null, 'pos_strike', null, 'pos_expiry', null, 'pos_qty', null, 'pos_entry_date', null,
    'pos_risk', null, 'pos_entry_px', null, 'pos_entry_prem', null, 'pos_lots', null, 'pos_margin', null,
    'last_candle_ts', null, 'last_trend', null, 'last_close', null, 'last_supertrend', null, 'last_run_at', null, 'last_error', null, 'last_entry_day', null,
    'pending_target', null, 'pending_trigger', null, 'pending_from', null, 'pending_to', null, 'day_pnl', null, 'day_pnl_date', null,
    'deploy_paid_until', null) || p_patch;
  perform set_config('app.bypass', 'on', true);
  insert into public.algo_strategies select * from jsonb_populate_record(null::public.algo_strategies, j);
  return v_id;
end $$;

-- Charge rates (%) used for listing backtests.
create or replace function public.charge_rates(p_exchange text) returns jsonb language sql immutable as $$
  select case when p_exchange = 'MCX' then '{"brk_pct":0.03,"stt_fut":0.01,"stt_opt":0.05,"exch_fut":0.0021,"exch_opt":0.0418,"sebi":0.0001,"gst":18,"stamp_fut":0.002,"stamp_opt":0.003}'::jsonb
    when p_exchange = 'BSE' then '{"brk_pct":0.03,"stt_fut":0.05,"stt_opt":0.15,"exch_fut":0,"exch_opt":0.0325,"sebi":0.0001,"gst":18,"stamp_fut":0.002,"stamp_opt":0.003}'::jsonb
    else '{"brk_pct":0.03,"stt_fut":0.05,"stt_opt":0.15,"exch_fut":0.00183,"exch_opt":0.03553,"sebi":0.0001,"gst":18,"stamp_fut":0.002,"stamp_opt":0.003}'::jsonb end;
$$;

-- 1- to 5-year backtests of a listing's master, queued.
create or replace function public.queue_listing_backtests(p_listing bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare l public.listings; s public.algo_strategies; ids jsonb := '{}'::jsonb; n int; v bigint; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into l from public.listings where id = p_listing;
  select * into s from public.algo_strategies where id = l.strategy_id;
  for n in 1..5 loop
    insert into public.algo_backtests (strategy_id, user_id, listing_id, years, status, progress, params)
    values (s.id, s.owner_id, l.id, n, 'waiting', 'Waiting for a free slot', jsonb_build_object(
      'from', (today - make_interval(years => n))::date + 1, 'to', today - 1, 'capital', 500000, 'brokerage', 20,
      'charges', public.charge_rates(s.exchange), 'near_code', 1))
    returning id into v;
    ids := ids || jsonb_build_object(n::text, v);
  end loop;
  update public.listings set bt_ids = ids, updated_at = now() where id = p_listing;
  perform public.kick_backtests();
  return ids;
end $$;

-- Admin: publish a strategy (anyone's) as a marketplace listing. A private master copy is made so later edits
-- to the original don't change what buyers run.
create or replace function public.publish_strategy(p_strategy uuid, p_title text, p_summary text, p_price numeric) returns bigint language plpgsql security definer set search_path = public as $$
declare m uuid; v bigint; s public.algo_strategies;
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  select * into s from public.algo_strategies where id = p_strategy;
  if not found then raise exception 'Strategy not found.'; end if;
  if s.locked then raise exception 'A bought strategy can''t be published again.'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Give the listing a title.'; end if;
  m := public.copy_strategy(p_strategy, jsonb_build_object('owner_id', auth.uid(), 'is_master', true, 'name', '[Listing] ' || p_title,
    'source_id', null, 'listing_id', null, 'locked', false));
  insert into public.listings (strategy_id, source_strategy, title, summary, price, status, asset, instrument, created_by)
  values (m, p_strategy, trim(p_title), p_summary, greatest(0, coalesce(p_price, 0)), 'draft', s.underlying,
    case when s.trade_type = 'OPTIONS' then case when s.option_side = 'SELL' then 'Option writing' else 'Option buying' end else 'Futures' end, auth.uid())
  returning id into v;
  perform set_config('app.bypass', 'on', true);
  update public.algo_strategies set listing_id = v where id = m;
  perform public.queue_listing_backtests(v);
  return v;
end $$;

create or replace function public.update_listing(p_listing bigint, p_title text, p_summary text, p_price numeric, p_status text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  if p_status not in ('draft', 'published', 'hidden') then raise exception 'Unknown status.'; end if;
  update public.listings set title = coalesce(nullif(trim(p_title), ''), title), summary = p_summary, price = greatest(0, coalesce(p_price, price)),
    status = p_status, updated_at = now() where id = p_listing;
end $$;

create or replace function public.rerun_listing(p_listing bigint) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  return public.queue_listing_backtests(p_listing);
end $$;

-- Trades as buyers see them: no entry reasons (those reveal the rules).
create or replace function public.clean_trades(p jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg((t - 'why' - 'chg' - 'equity') || jsonb_build_object('exit_why',
    case when t->>'exit_why' ~* '(stop|target|square|still open|trail|timed|daily loss)' then t->>'exit_why' else 'Strategy exit' end)), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) t;
$$;

-- Marketplace cards: every published listing with its 1-5 year headline results.
create or replace function public.market_listings() returns json language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  return coalesce((select json_agg(x order by x.id desc) from (
    select l.id, l.title, l.summary, l.price, l.status, l.asset, l.instrument, l.created_at, l.updated_at,
      exists (select 1 from public.purchases p where p.listing_id = l.id and p.user_id = auth.uid()) as owned,
      (select count(*) from public.algo_strategies d where d.listing_id = l.id and not d.is_master) as users,
      (select json_object_agg(b.years, json_build_object('status', b.status, 'progress', b.progress, 'from', b.params->>'from', 'to', b.params->>'to',
          'net', b.summary->'net', 'return_pct', b.summary->'return_pct', 'max_dd', b.summary->'max_dd', 'max_dd_pct', b.summary->'max_dd_pct',
          'win_rate', b.summary->'win_rate', 'trades', b.summary->'trades', 'profit_factor', b.summary->'profit_factor', 'avg_net', b.summary->'avg_net'))
        from public.algo_backtests b where b.id in (select (v)::bigint from jsonb_each_text(l.bt_ids) e(k, v))) as results
    from public.listings l where l.status = 'published' or public.is_admin()) x), '[]'::json);
end $$;

-- One listing's full results (each period's summary and trades), without anything that reveals its rules.
create or replace function public.listing_results(p_listing bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare l public.listings;
begin
  select * into l from public.listings where id = p_listing;
  if not found or not (l.status = 'published' or public.is_admin()) then raise exception 'Not found.'; end if;
  return json_build_object('id', l.id, 'title', l.title, 'summary', l.summary, 'price', l.price, 'asset', l.asset, 'instrument', l.instrument,
    'owned', exists (select 1 from public.purchases p where p.listing_id = l.id and p.user_id = auth.uid()),
    'periods', (select json_object_agg(b.years, json_build_object('status', b.status, 'progress', b.progress, 'error', b.error,
        'from', b.params->>'from', 'to', b.params->>'to', 'capital', b.params->'capital',
        'summary', b.summary - 'notes', 'trades', public.clean_trades(b.trades)))
      from public.algo_backtests b where b.id in (select (v)::bigint from jsonb_each_text(l.bt_ids) e(k, v))));
end $$;

-- Buy (or re-use) a listing and add it to the caller's strategies. Rules stay with the publisher.
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
  return v;
end $$;

-- Recharges: the user reports a payment, the admin approves it.
create or replace function public.request_recharge(p_amount numeric, p_ref text, p_note text) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount you paid.'; end if;
  if coalesce(trim(p_ref), '') = '' then raise exception 'Enter the UPI / bank reference (UTR) of the payment.'; end if;
  insert into public.recharge_requests (user_id, amount, ref, note) values (auth.uid(), p_amount, trim(p_ref), p_note) returning id into v;
  return v;
end $$;

create or replace function public.decide_recharge(p_id bigint, p_approve boolean, p_note text) returns void language plpgsql security definer set search_path = public as $$
declare r public.recharge_requests;
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  select * into r from public.recharge_requests where id = p_id and status = 'PENDING' for update;
  if not found then raise exception 'Already decided.'; end if;
  update public.recharge_requests set status = case when p_approve then 'APPROVED' else 'REJECTED' end, decided_at = now(), decided_by = auth.uid(),
    note = coalesce(p_note, note) where id = p_id;
  if p_approve then
    insert into public.wallet_txns (user_id, amount, kind, note, ref, created_by) values (r.user_id, r.amount, 'RECHARGE', 'Recharge', r.ref, auth.uid());
  end if;
end $$;

create or replace function public.admin_wallet(p_user uuid, p_amount numeric, p_kind text, p_note text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  if p_kind not in ('RECHARGE', 'ADJUST', 'REFUND') then raise exception 'Use recharge, adjustment or refund.'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Enter an amount.'; end if;
  insert into public.wallet_txns (user_id, amount, kind, note, created_by) values (p_user, p_amount, p_kind, p_note, auth.uid());
end $$;

create or replace function public.save_billing(p jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  if (p->>'trial_days')::int < 0 or (p->>'deploy_fee')::numeric < 0 or (p->>'profit_share_pct')::numeric < 0 or (p->>'profit_share_pct')::numeric > 100
    then raise exception 'Check the values (no negatives; profit share 0-100%%).'; end if;
  update public.billing_settings set trial_days = (p->>'trial_days')::int, deploy_fee = (p->>'deploy_fee')::numeric,
    deploy_fee_period = p->>'deploy_fee_period', profit_share_pct = (p->>'profit_share_pct')::numeric, min_balance = (p->>'min_balance')::numeric,
    pay_to = p->>'pay_to', pay_note = p->>'pay_note', updated_at = now() where id;
end $$;

create or replace function public.admin_users() returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select p.user_id, p.email, p.full_name, p.phone, p.role, p.status, p.trial_until, p.profit_share_pct, p.deploy_fee, p.can_build, p.loss_carry,
      p.terms_accepted_at, p.note, p.created_at, public.wallet_balance(p.user_id) as balance,
      (select count(*) from public.algo_strategies s where s.owner_id = p.user_id and not s.is_master and not s.archived) as strategies,
      (select count(*) from public.algo_strategies s where s.owner_id = p.user_id and s.live and s.active) as live,
      (select coalesce(sum(net), 0) from public.algo_trades t where t.user_id = p.user_id and t.mode = 'LIVE') as live_net,
      (select coalesce(-sum(amount), 0) from public.wallet_txns w where w.user_id = p.user_id and w.kind in ('PROFIT_SHARE', 'DEPLOY_FEE', 'PURCHASE')) as fees_paid,
      (select coalesce(access_token, '') <> '' from public.broker_accounts b where b.user_id = p.user_id and b.broker = 'DHAN') as broker_ok,
      (select count(*) from public.recharge_requests r where r.user_id = p.user_id and r.status = 'PENDING') as pending
    from public.profiles p) x), '[]'::json);
end $$;

create or replace function public.admin_set_user(p_user uuid, p jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  if p_user = auth.uid() and (p->>'status' = 'blocked' or p->>'role' = 'user') then raise exception 'You can''t block or demote yourself.'; end if;
  update public.profiles set
    full_name = coalesce(p->>'full_name', full_name), phone = coalesce(p->>'phone', phone),
    role = coalesce(p->>'role', role), status = coalesce(p->>'status', status),
    trial_until = case when p ? 'trial_until' then nullif(p->>'trial_until', '')::date else trial_until end,
    profit_share_pct = case when p ? 'profit_share_pct' then nullif(p->>'profit_share_pct', '')::numeric else profit_share_pct end,
    deploy_fee = case when p ? 'deploy_fee' then nullif(p->>'deploy_fee', '')::numeric else deploy_fee end,
    can_build = coalesce((p->>'can_build')::boolean, can_build), note = coalesce(p->>'note', note)
  where user_id = p_user;
end $$;

-- Profit share, trade by trade in order: a loss is carried forward and earned back before any fee is charged again.
create or replace function public.charge_profit_share(p_user uuid) returns numeric language plpgsql security definer set search_path = public as $$
declare b json; pct numeric; carry numeric; t record; v_fee numeric; total numeric := 0; trial boolean; chargeable numeric;
begin
  b := public.billing_for(p_user);
  if b is null or b->>'role' = 'admin' then return 0; end if;
  pct := coalesce((b->>'profit_share_pct')::numeric, 0);
  trial := (b->>'trial_active')::boolean;
  select loss_carry into carry from public.profiles where user_id = p_user for update;
  for t in select id, net, contract, exit_at from public.algo_trades where user_id = p_user and mode = 'LIVE' and fee is null order by exit_at, id loop
    if t.net <= 0 then carry := carry - t.net; v_fee := 0;
    else
      chargeable := greatest(0, t.net - carry); carry := greatest(0, carry - t.net);
      v_fee := case when trial then 0 else trunc(chargeable * pct / 100) end;
    end if;
    update public.algo_trades set fee = v_fee where id = t.id;
    if v_fee > 0 then
      insert into public.wallet_txns (user_id, amount, kind, note, trade_id) values (p_user, -v_fee, 'PROFIT_SHARE',
        format('%s%% of ₹%s profit on %s', pct, trunc(chargeable), t.contract), t.id);
      total := total + v_fee;
    end if;
  end loop;
  update public.profiles set loss_carry = carry where user_id = p_user;
  return total;
end $$;

-- Monthly deployment fees falling due: taken from the wallet if it can pay; otherwise the strategy stops opening trades.
create or replace function public.renew_deploy_fees() returns int language plpgsql security definer set search_path = public as $$
declare s record; b json; fee numeric; n int := 0; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  perform set_config('app.bypass', 'on', true);
  for s in select a.* from public.algo_strategies a join public.profiles p on p.user_id = a.owner_id
           where a.live and p.role <> 'admin' and a.deploy_paid_until is not null and a.deploy_paid_until < today loop
    b := public.billing_for(s.owner_id);
    if (b->>'trial_active')::boolean or b->>'deploy_fee_period' <> 'MONTHLY' then continue; end if;
    fee := coalesce((b->>'deploy_fee')::numeric, 0);
    if fee <= 0 then continue; end if;
    if (b->>'balance')::numeric >= fee then
      insert into public.wallet_txns (user_id, amount, kind, note, strategy_id) values (s.owner_id, -fee, 'DEPLOY_FEE',
        format('Deployment fee: %s (till %s)', s.name, ((today + interval '1 month')::date - 1)), s.id);
      update public.algo_strategies set deploy_paid_until = (today + interval '1 month')::date - 1 where id = s.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
