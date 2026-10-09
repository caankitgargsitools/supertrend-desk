-- Multi-user desk: functions the site calls (each checks who is calling).

-- Engine call that names the user it acts for (token / funds / trade-book sync for one account).
create or replace function public.engine_call_user(p_action text, p_user uuid) returns bigint language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := 'https://umryzxusbdttbcshkajt.supabase.co/functions/v1/engine',
    body := jsonb_build_object('action', p_action, 'user_id', p_user),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-engine-secret', (select secret from public.engine_secret)),
    timeout_milliseconds := 55000);
$$;

create or replace function public.wallet_balance(p_user uuid) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from public.wallet_txns where user_id = p_user;
$$;

-- Effective billing terms for a user (their overrides, else the defaults).
create or replace function public.billing_for(p_user uuid) returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'trial_until', p.trial_until,
    'trial_active', p.trial_until is not null and p.trial_until >= (now() at time zone 'Asia/Kolkata')::date,
    'deploy_fee', coalesce(p.deploy_fee, b.deploy_fee), 'deploy_fee_period', b.deploy_fee_period,
    'profit_share_pct', coalesce(p.profit_share_pct, b.profit_share_pct), 'min_balance', b.min_balance,
    'balance', public.wallet_balance(p_user), 'loss_carry', p.loss_carry, 'status', p.status, 'role', p.role,
    'pay_to', b.pay_to, 'pay_note', b.pay_note)
  from public.profiles p, public.billing_settings b where p.user_id = p_user;
$$;

-- Can this user's live strategies open new trades now? (Exits are never blocked.)
create or replace function public.entries_allowed(p_user uuid) returns json language plpgsql stable security definer set search_path = public as $$
declare b json; bal numeric;
begin
  b := public.billing_for(p_user);
  if b is null then return json_build_object('ok', true, 'why', null); end if;
  if b->>'role' = 'admin' then return json_build_object('ok', true, 'why', null); end if;
  if b->>'status' <> 'active' then return json_build_object('ok', false, 'why', 'Account is blocked by the admin.'); end if;
  if (b->>'trial_active')::boolean then return json_build_object('ok', true, 'why', null); end if;
  bal := (b->>'balance')::numeric;
  if bal < 0 then return json_build_object('ok', false, 'why', 'Wallet balance is negative (fees due). Recharge the wallet to resume new trades.'); end if;
  if bal < (b->>'min_balance')::numeric then return json_build_object('ok', false, 'why', format('Wallet balance is below the minimum of ₹%s. Recharge to resume new trades.', (b->>'min_balance'))); end if;
  return json_build_object('ok', true, 'why', null);
end $$;

-- Who am I, and what can I do.
create or replace function public.whoami() returns json language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid(); p public.profiles;
begin
  if u is null then raise exception 'Sign in first.'; end if;
  select * into p from public.profiles where user_id = u;
  if not found then
    if public.is_owner() then return json_build_object('user_id', u, 'role', 'admin', 'status', 'active', 'terms_accepted', true); end if;
    raise exception 'This login has no desk account. Ask the admin to create one.';
  end if;
  return json_build_object('user_id', u, 'email', p.email, 'name', p.full_name, 'role', p.role, 'status', p.status, 'can_build', p.can_build,
    'terms_accepted', p.terms_accepted_at is not null, 'billing', public.billing_for(u), 'entries', public.entries_allowed(u));
end $$;

create or replace function public.accept_terms() returns void language sql security definer set search_path = public as $$
  update public.profiles set terms_accepted_at = now() where user_id = auth.uid();
$$;

-- Broker connection of the caller (secrets never returned in full).
create or replace function public.broker_status() returns json language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  return coalesce((select json_build_object('broker', broker, 'client_id', client_id,
      'has_token', coalesce(access_token,'') <> '', 'token_tail', right(coalesce(access_token,''), 4),
      'token_expires_at', token_expires_at, 'token_renewed_at', token_renewed_at, 'token_checked_at', token_checked_at, 'token_note', token_note,
      'has_url', coalesce(webhook_url,'') <> '', 'url_host', substring(coalesce(webhook_url,'') from '^https?://([^/]+)'),
      'has_secret', coalesce(webhook_secret,'') <> '', 'deploy_pct', deploy_pct, 'synced_at', synced_at, 'sync_note', sync_note)
    from public.broker_accounts where user_id = auth.uid() and broker = 'DHAN'), json_build_object('broker', 'DHAN', 'has_token', false));
end $$;

create or replace function public.save_broker(p_client text, p_token text, p_url text, p_secret text) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_url is not null and p_url <> '' and p_url !~ '^https://' then raise exception 'The webhook URL must start with https://'; end if;
  insert into public.broker_accounts (user_id, broker) values (auth.uid(), 'DHAN') on conflict (user_id, broker) do nothing;
  update public.broker_accounts set
    client_id = coalesce(nullif(trim(p_client), ''), client_id),
    access_token = coalesce(nullif(trim(p_token), ''), access_token),
    webhook_url = coalesce(nullif(trim(p_url), ''), webhook_url),
    webhook_secret = coalesce(nullif(trim(p_secret), ''), webhook_secret),
    updated_at = now()
  where user_id = auth.uid() and broker = 'DHAN';
  if nullif(trim(p_token), '') is not null then perform public.engine_call_user('token', auth.uid()); end if;
end $$;

create or replace function public.ledger_net_user(p_user uuid, p_mode text, p_since date) returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(net), 0) from public.algo_trades
  where user_id = p_user and mode = p_mode and (p_since is null or exit_at >= (p_since::timestamp at time zone 'Asia/Kolkata'));
$$;

create or replace function public.my_capital() returns json language plpgsql stable security definer set search_path = public as $$
declare a public.broker_accounts; u uuid := auth.uid();
begin
  if u is null then raise exception 'Sign in first.'; end if;
  select * into a from public.broker_accounts where user_id = u and broker = 'DHAN';
  return json_build_object(
    'capital', coalesce(a.capital, 0), 'since', a.capital_since, 'deploy_pct', coalesce(a.deploy_pct, 60),
    'live_net', public.ledger_net_user(u, 'LIVE', a.capital_since), 'paper_net', public.ledger_net_user(u, 'PAPER', a.capital_since),
    'live_used', (select coalesce(sum(pos_margin), 0) from public.algo_strategies where owner_id = u and live and position <> 'FLAT'),
    'paper_used', (select coalesce(sum(pos_margin), 0) from public.algo_strategies where owner_id = u and not live and position <> 'FLAT'),
    'funds', a.funds, 'funds_at', a.funds_at, 'funds_error', a.funds_error);
end $$;

create or replace function public.save_my_capital(p_capital numeric, p_since date, p_deploy_pct numeric) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_capital is null or p_capital < 0 then raise exception 'Capital must be 0 or more.'; end if;
  if p_deploy_pct is null or p_deploy_pct <= 0 or p_deploy_pct > 100 then raise exception 'The limit must be between 1 and 100%%.'; end if;
  insert into public.broker_accounts (user_id, broker) values (auth.uid(), 'DHAN') on conflict (user_id, broker) do nothing;
  update public.broker_accounts set capital = p_capital, capital_since = p_since, deploy_pct = p_deploy_pct, updated_at = now()
   where user_id = auth.uid() and broker = 'DHAN';
end $$;

-- Engine actions from the site: refresh / exit a strategy the caller owns; token / funds / trade-book sync on the caller's account.
create or replace function public.desk_engine(p_action text, p_strategy uuid) returns bigint language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_action in ('refresh', 'flatten') then
    if not (public.is_admin() or public.owns_strategy(p_strategy)) then raise exception 'Not allowed.'; end if;
    return public.engine_call(p_action, p_strategy);
  end if;
  if p_action in ('token', 'token_renew', 'funds', 'sync') then return public.engine_call_user(p_action, auth.uid()); end if;
  raise exception 'Unknown action';
end $$;

-- Backtests wait in a queue; at most two run at once across the desk.
create or replace function public.kick_backtests() returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from public.algo_backtests where status = 'waiting' order by id
     limit greatest(0, 2 - (select count(*) from public.algo_backtests where status in ('queued', 'running') and created_at > now() - interval '30 minutes')) loop
    update public.algo_backtests set status = 'queued', progress = 'Starting' where id = r.id;
    perform public.engine_backtest(r.id);
  end loop;
end $$;

create or replace function public.run_backtest(p_strategy uuid, p_params jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; s public.algo_strategies;
begin
  select * into s from public.algo_strategies where id = p_strategy;
  if not found or not (public.is_admin() or s.owner_id = auth.uid()) then raise exception 'Not allowed.'; end if;
  if s.locked then raise exception 'This strategy''s results come from its publisher; see the results tab.'; end if;
  if (select count(*) from public.algo_backtests where user_id = auth.uid() and status in ('waiting', 'queued', 'running') and created_at > now() - interval '30 minutes') >= 3
    then raise exception 'You already have backtests waiting. Let them finish first.'; end if;
  insert into public.algo_backtests (strategy_id, params, user_id, status, progress) values (p_strategy, p_params, s.owner_id, 'waiting', 'Waiting for a free slot') returning id into v_id;
  perform public.kick_backtests();
  return v_id;
end $$;

create or replace function public.rerun_backtest(p_backtest bigint) returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or exists (select 1 from public.algo_backtests where id = p_backtest and user_id = auth.uid())) then raise exception 'Not allowed.'; end if;
  update public.algo_backtests
     set status = 'waiting', error = null, progress = 'Resuming', finished_at = null,
         acc = coalesce(acc, '{}'::jsonb) - 'busy' || jsonb_build_object('rounds', 0)
   where id = p_backtest and status in ('failed', 'paused') and plans is not null;
  if not found then raise exception 'This backtest can''t be resumed. Run it again instead.'; end if;
  perform public.kick_backtests();
  return p_backtest;
end $$;

-- Going live: checks the account and wallet, and charges the deployment fee when due.
create or replace function public.set_live(p_strategy uuid, p_live boolean) returns json language plpgsql security definer set search_path = public as $$
declare s public.algo_strategies; b json; fee numeric; paid date; today date := (now() at time zone 'Asia/Kolkata')::date; e json;
begin
  select * into s from public.algo_strategies where id = p_strategy;
  if not found or not (public.is_admin() or s.owner_id = auth.uid()) then raise exception 'Not allowed.'; end if;
  perform set_config('app.bypass', 'on', true);
  if not p_live then update public.algo_strategies set live = false where id = p_strategy; return json_build_object('live', false); end if;
  if not exists (select 1 from public.broker_accounts where user_id = s.owner_id and coalesce(access_token, '') <> '' and coalesce(webhook_url, '') <> '')
    then raise exception 'Connect your Dhan account first (client ID, access token and webhook URL).'; end if;
  b := public.billing_for(s.owner_id);
  if b is not null and b->>'role' <> 'admin' then
    e := public.entries_allowed(s.owner_id);
    if not (e->>'ok')::boolean then raise exception '%', e->>'why'; end if;
    fee := coalesce((b->>'deploy_fee')::numeric, 0);
    if fee > 0 and not (b->>'trial_active')::boolean and (s.deploy_paid_until is null or s.deploy_paid_until < today) then
      if (b->>'balance')::numeric < fee then raise exception 'Going live needs a deployment fee of ₹%. Your wallet has ₹%. Recharge first.', fee, (b->>'balance'); end if;
      paid := case when b->>'deploy_fee_period' = 'ONE_TIME' then date '9999-12-31' else (today + interval '1 month')::date - 1 end;
      insert into public.wallet_txns (user_id, amount, kind, note, strategy_id) values (s.owner_id, -fee, 'DEPLOY_FEE',
        case when paid = date '9999-12-31' then 'Deployment fee: ' || s.name else format('Deployment fee: %s (till %s)', s.name, paid) end, s.id);
      update public.algo_strategies set deploy_paid_until = paid where id = p_strategy;
    end if;
  end if;
  update public.algo_strategies set live = true where id = p_strategy;
  return json_build_object('live', true);
end $$;
