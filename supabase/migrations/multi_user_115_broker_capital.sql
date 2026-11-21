-- 21 Nov 2026 (Papa: "fetch margin from Dhan as we are fetching the funds … fetch balance from delta also … in the lots
-- wizard separate … Dhan capital … crypto capital … as soon as we end up getting some profits, the lots should
-- automatically be increased as per the total margin available … whatever profit we have locked, we can use that much of
-- reserved capital").
--
-- broker_accounts.cap_src: 'broker' = the live capital of this broker follows the broker's own balance (Dhan: the
-- start-of-day balance sodLimit; Delta: the wallet balance in rupees), kept in cap_base and moved only in steps of 10% or
-- more (engine brokerMoney, every 5 minutes); 'fixed' = the capital typed on the Capital page plus that broker's booked
-- live P&L since the count-from date (as before). Live Dhan sizing uses the DHAN row, live crypto the DELTA row; paper
-- keeps paper_capital on the DHAN row.
-- funds: the broker's figures (Dhan: sod / available / utilized …, plus pos = {strategy id: Dhan's margin for that open
-- position today}; Delta: balance_inr, available_inr, margin_inr, usd …), refreshed every 5 minutes.
alter table public.broker_accounts add column if not exists cap_src text not null default 'broker';
alter table public.broker_accounts add column if not exists cap_base numeric;
alter table public.broker_accounts add column if not exists cap_base_at timestamptz;
do $$ begin
  alter table public.broker_accounts add constraint broker_accounts_cap_src_chk check (cap_src in ('broker', 'fixed'));
exception when duplicate_object then null; end $$;

-- The room to deploy for one user, mode and broker: one figure for the engine (every entry) and the website.
-- equity  = the capital (broker's balance, or typed capital + booked P&L);
-- limit   = equity × "never use more than" %; reserve = equity − limit;
-- locked  = profit locked in by the stops of this broker's open positions (what stays if every stop is hit now);
-- bonus   = the part of the reserve the locked profit frees: least(reserve, locked) (Papa, 21 Nov 2026);
-- used    = margin of the open positions (the broker's own figure when fresh, else the desk's estimate);
-- room    = limit + bonus − used.
create or replace function public.capital_room(p_user uuid, p_live boolean, p_broker text default 'DHAN', p_exclude uuid default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  a public.broker_accounts; d public.broker_accounts; crypto boolean := p_live and p_broker = 'DELTA';
  src text; cap numeric; since date; pct numeric; equity numeric; net numeric := 0; used numeric := 0; est numeric := 0;
  locked numeric := 0; nwith int := 0; nopen int := 0; fresh boolean; lim numeric; reserve numeric; bonus numeric;
begin
  select * into d from public.broker_accounts where user_id = p_user and broker = 'DHAN';
  if crypto then select * into a from public.broker_accounts where user_id = p_user and broker = 'DELTA'; else a := d; end if;
  if p_live then
    src := coalesce(a.cap_src, 'broker');
    cap := coalesce(a.capital, 0); since := a.capital_since;
    pct := coalesce(a.deploy_pct, d.deploy_pct, 100);
    if src = 'broker' and coalesce(a.cap_base, 0) > 0 then
      equity := a.cap_base;
    else
      src := 'fixed';
      select coalesce(sum(t.net), 0) into net from public.algo_trades t
       where t.user_id = p_user and t.mode = 'LIVE' and not t.hidden
         and (since is null or t.exit_at >= (since::timestamp at time zone 'Asia/Kolkata'))
         and (exists (select 1 from public.algo_strategies x where x.id = t.strategy_id and x.data_segment = 'DELTA')) = crypto;
      equity := cap + net;
    end if;
  else
    src := 'paper'; cap := coalesce(d.paper_capital, 0); since := d.paper_since; pct := coalesce(d.paper_deploy_pct, 100);
    net := public.ledger_net_user(p_user, 'PAPER', since); equity := cap + net;
  end if;
  fresh := a.funds_at is not null and a.funds_at > now() - interval '15 minutes';
  select coalesce(sum(case when p_live and fresh and (a.funds->'pos'->>s.id::text) is not null then (a.funds->'pos'->>s.id::text)::numeric else coalesce(s.pos_margin, 0) end), 0),
         coalesce(sum(coalesce(s.pos_margin, 0)), 0),
         coalesce(sum(case when s.trade_type = 'FUTURES' and public.pos_eff_stop(s.pos_risk) is not null and s.pos_ltp is not null and s.pos_entry_px is not null
                             and s.pos_ltp <> s.pos_entry_px and s.pos_upnl is not null
                           then s.pos_upnl * (public.pos_eff_stop(s.pos_risk) - s.pos_entry_px) / (s.pos_ltp - s.pos_entry_px) else 0 end), 0),
         count(*) filter (where s.trade_type = 'FUTURES' and public.pos_eff_stop(s.pos_risk) is not null), count(*)
    into used, est, locked, nwith, nopen
    from public.algo_strategies s
   where s.owner_id = p_user and s.live = p_live and s.position <> 'FLAT' and not s.is_master
     and (p_exclude is null or s.id <> p_exclude)
     and (not p_live or (s.data_segment = 'DELTA') = crypto);
  lim := equity * pct / 100; reserve := greatest(0, equity - lim);
  bonus := least(reserve, greatest(0, locked));
  return jsonb_build_object('broker', case when crypto then 'DELTA' else 'DHAN' end, 'live', p_live, 'src', src, 'capital', cap, 'since', since,
    'net', net, 'equity', equity, 'pct', pct, 'limit', lim, 'reserve', reserve, 'locked', locked, 'bonus', bonus,
    'used', used, 'used_desk', est, 'room', lim + bonus - used, 'pct_eff', case when equity > 0 then (lim + bonus) / equity * 100 else pct end,
    'open', nopen, 'with_stop', nwith, 'base_at', a.cap_base_at, 'funds', a.funds, 'funds_at', a.funds_at, 'funds_error', a.funds_error, 'fresh', fresh);
end $$;
revoke execute on function public.capital_room(uuid, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.capital_room(uuid, boolean, text, uuid) to service_role;

-- The Capital page: the same figures for the signed-in user (Live · Dhan, Live · Delta, Paper), plus the old fields.
create or replace function public.my_capital()
returns json language plpgsql stable security definer set search_path to 'public' as $$
declare a public.broker_accounts; dl public.broker_accounts; u uuid := auth.uid();
begin
  if u is null then raise exception 'Sign in first.'; end if;
  select * into a from public.broker_accounts where user_id = u and broker = 'DHAN';
  select * into dl from public.broker_accounts where user_id = u and broker = 'DELTA';
  return json_build_object(
    'capital', coalesce(a.capital, 0), 'since', a.capital_since, 'deploy_pct', coalesce(a.deploy_pct, 60),
    'live_net', public.ledger_net_user(u, 'LIVE', a.capital_since),
    'paper_capital', coalesce(a.paper_capital, 0), 'paper_since', a.paper_since, 'paper_deploy_pct', coalesce(a.paper_deploy_pct, 60),
    'paper_net', public.ledger_net_user(u, 'PAPER', a.paper_since),
    'live_used', (select coalesce(sum(pos_margin), 0) from public.algo_strategies where owner_id = u and live and position <> 'FLAT'),
    'paper_used', (select coalesce(sum(pos_margin), 0) from public.algo_strategies where owner_id = u and not live and position <> 'FLAT'),
    'funds', a.funds, 'funds_at', a.funds_at, 'funds_error', a.funds_error,
    'cap_src', coalesce(a.cap_src, 'broker'), 'delta_cap_src', coalesce(dl.cap_src, 'broker'),
    'delta_capital', coalesce(dl.capital, 0), 'delta_since', dl.capital_since, 'delta_deploy_pct', coalesce(dl.deploy_pct, a.deploy_pct, 60),
    'delta_connected', dl.access_token is not null and dl.access_token <> '',
    'room_dhan', public.capital_room(u, true, 'DHAN', null), 'room_delta', public.capital_room(u, true, 'DELTA', null),
    'room_paper', public.capital_room(u, false, 'DHAN', null));
end $$;
revoke execute on function public.my_capital() from public, anon;
grant execute on function public.my_capital() to authenticated;

-- Live capital of one broker: follow the broker's balance, or a typed capital (+ that broker's booked P&L since a date).
create or replace function public.save_broker_capital(p_broker text, p_src text, p_capital numeric, p_since date, p_deploy_pct numeric)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_broker not in ('DHAN', 'DELTA') then raise exception 'Broker must be DHAN or DELTA.'; end if;
  if p_src not in ('broker', 'fixed') then raise exception 'Capital must follow the broker or be a fixed figure.'; end if;
  if p_src = 'fixed' and (p_capital is null or p_capital < 0) then raise exception 'Capital must be 0 or more.'; end if;
  if p_deploy_pct is null or p_deploy_pct <= 0 or p_deploy_pct > 100 then raise exception 'The limit must be between 1 and 100%%.'; end if;
  insert into public.broker_accounts (user_id, broker) values (auth.uid(), p_broker) on conflict (user_id, broker) do nothing;
  update public.broker_accounts set cap_src = p_src, deploy_pct = p_deploy_pct,
         capital = case when p_src = 'fixed' then p_capital else capital end,
         capital_since = case when p_src = 'fixed' then p_since else capital_since end, updated_at = now()
   where user_id = auth.uid() and broker = p_broker;
end $$;
revoke execute on function public.save_broker_capital(text, text, numeric, date, numeric) from public, anon;
grant execute on function public.save_broker_capital(text, text, numeric, date, numeric) to authenticated;
