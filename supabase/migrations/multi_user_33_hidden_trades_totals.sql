-- Hidden trades (undone, e.g. the Dussehra holiday trades) are already invisible in the browser through the
-- trades_not_hidden policy, but these SECURITY DEFINER totals bypass policies, so they counted them.
create or replace function public.ledger_net_user(p_user uuid, p_mode text, p_since date)
returns numeric language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(net), 0) from public.algo_trades
  where user_id = p_user and mode = p_mode and not hidden and (p_since is null or exit_at >= (p_since::timestamp at time zone 'Asia/Kolkata'));
$$;

create or replace function public.ledger_net(p_mode text, p_since date)
returns numeric language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(net), 0) from public.algo_trades
  where mode = p_mode and not hidden and (p_since is null or exit_at >= (p_since::timestamp at time zone 'Asia/Kolkata'));
$$;

create or replace function public.admin_users()
returns json language plpgsql stable security definer set search_path to 'public' as $function$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select p.user_id, p.email, p.full_name, p.phone, p.role, p.status, p.trial_until, p.profit_share_pct, p.deploy_fee, p.can_build, p.loss_carry,
      p.terms_accepted_at, p.note, p.created_at, public.wallet_balance(p.user_id) as balance,
      (select count(*) from public.algo_strategies s where s.owner_id = p.user_id and not s.is_master and not s.archived) as strategies,
      (select count(*) from public.algo_strategies s where s.owner_id = p.user_id and s.live and s.active) as live,
      (select coalesce(sum(net), 0) from public.algo_trades t where t.user_id = p.user_id and t.mode = 'LIVE' and not t.hidden) as live_net,
      (select coalesce(-sum(amount), 0) from public.wallet_txns w where w.user_id = p.user_id and w.kind in ('PROFIT_SHARE', 'DEPLOY_FEE', 'PURCHASE')) as fees_paid,
      (select coalesce(access_token, '') <> '' from public.broker_accounts b where b.user_id = p.user_id and b.broker = 'DHAN') as broker_ok,
      (select count(*) from public.recharge_requests r where r.user_id = p.user_id and r.status = 'PENDING') as pending
    from public.profiles p) x), '[]'::json);
end $function$;
