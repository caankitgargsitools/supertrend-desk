-- Migration 94 (12 Nov 2026, Papa: "live and paper have to be separated … my paper capital is 75 lakhs and the live
-- capital is 4 lakhs … no linkage at all"). Until now one capital, one limit and one "count from" date per account were
-- read by both modes. Paper gets its own three; the existing columns stay the Live ones.
alter table public.broker_accounts
  add column if not exists paper_capital numeric,
  add column if not exists paper_since date,
  add column if not exists paper_deploy_pct numeric;

-- Start every account's paper settings from what both modes used until now (Papa's paper capital: ₹75 lakh, his word).
update public.broker_accounts set paper_capital = coalesce(paper_capital, capital), paper_since = coalesce(paper_since, capital_since),
  paper_deploy_pct = coalesce(paper_deploy_pct, deploy_pct) where broker = 'DHAN';
update public.broker_accounts set paper_capital = 7500000
 where broker = 'DHAN' and user_id = (select id from auth.users where email = 'ca.ankitgarg@gmail.com');

create or replace function public.my_capital() returns json language plpgsql stable security definer set search_path to 'public' as $$
declare a public.broker_accounts; u uuid := auth.uid();
begin
  if u is null then raise exception 'Sign in first.'; end if;
  select * into a from public.broker_accounts where user_id = u and broker = 'DHAN';
  return json_build_object(
    -- Live (the original fields keep their names)
    'capital', coalesce(a.capital, 0), 'since', a.capital_since, 'deploy_pct', coalesce(a.deploy_pct, 60),
    'live_net', public.ledger_net_user(u, 'LIVE', a.capital_since),
    -- Paper: its own capital, limit and count-from date
    'paper_capital', coalesce(a.paper_capital, 0), 'paper_since', a.paper_since, 'paper_deploy_pct', coalesce(a.paper_deploy_pct, 60),
    'paper_net', public.ledger_net_user(u, 'PAPER', a.paper_since),
    'live_used', (select coalesce(sum(pos_margin), 0) from public.algo_strategies where owner_id = u and live and position <> 'FLAT'),
    'paper_used', (select coalesce(sum(pos_margin), 0) from public.algo_strategies where owner_id = u and not live and position <> 'FLAT'),
    'funds', a.funds, 'funds_at', a.funds_at, 'funds_error', a.funds_error);
end $$;

-- Save one mode's capital, limit and count-from date; the other mode is never touched.
create or replace function public.save_mode_capital(p_mode text, p_capital numeric, p_since date, p_deploy_pct numeric)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if p_mode not in ('LIVE', 'PAPER') then raise exception 'Mode must be LIVE or PAPER.'; end if;
  if p_capital is null or p_capital < 0 then raise exception 'Capital must be 0 or more.'; end if;
  if p_deploy_pct is null or p_deploy_pct <= 0 or p_deploy_pct > 100 then raise exception 'The limit must be between 1 and 100%%.'; end if;
  insert into public.broker_accounts (user_id, broker) values (auth.uid(), 'DHAN') on conflict (user_id, broker) do nothing;
  if p_mode = 'LIVE' then
    update public.broker_accounts set capital = p_capital, capital_since = p_since, deploy_pct = p_deploy_pct, updated_at = now()
     where user_id = auth.uid() and broker = 'DHAN';
  else
    update public.broker_accounts set paper_capital = p_capital, paper_since = p_since, paper_deploy_pct = p_deploy_pct, updated_at = now()
     where user_id = auth.uid() and broker = 'DHAN';
  end if;
end $$;
grant execute on function public.save_mode_capital(text, numeric, date, numeric) to authenticated;

-- The old save (no mode) now saves Live only, so an old open page can't overwrite the paper settings.
create or replace function public.save_my_capital(p_capital numeric, p_since date, p_deploy_pct numeric)
returns void language plpgsql security definer set search_path to 'public' as $$
begin perform public.save_mode_capital('LIVE', p_capital, p_since, p_deploy_pct); end $$;

-- The error breaker, per mode too: the original columns are Live's, the paper_ ones Paper's (engine brkOf / brkKey).
alter table public.risk_state
  add column if not exists paper_err_ticks int not null default 0,
  add column if not exists paper_last_error text,
  add column if not exists paper_halted_at timestamptz,
  add column if not exists paper_halt_reason text;

-- "Allow new trades again" for one mode; the old breaker_allow() (old open pages) clears both.
create or replace function public.breaker_allow_mode(p_mode text, p_user uuid default null) returns void
language plpgsql security definer set search_path to 'public' as $$
declare u uuid := coalesce(p_user, auth.uid());
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if u <> auth.uid() and not public.is_admin() then raise exception 'Not allowed.'; end if;
  if p_mode = 'LIVE' then update public.risk_state set halted_at = null, halt_reason = null, err_ticks = 0, updated_at = now() where user_id = u;
  elsif p_mode = 'PAPER' then update public.risk_state set paper_halted_at = null, paper_halt_reason = null, paper_err_ticks = 0, updated_at = now() where user_id = u;
  else raise exception 'Mode must be LIVE or PAPER.'; end if;
end $$;
grant execute on function public.breaker_allow_mode(text, uuid) to authenticated;
create or replace function public.breaker_allow(p_user uuid default null) returns void
language plpgsql security definer set search_path to 'public' as $$
begin perform public.breaker_allow_mode('LIVE', p_user); perform public.breaker_allow_mode('PAPER', p_user); end $$;

-- Morning card and Admin › User activity: each mode's breaker; the activity row carries the paper capital too.
do $m$
declare d text;
begin
  d := pg_get_functiondef('public.morning_card'::regproc);
  d := replace(d, 'select halted_at, halt_reason into brk from public.risk_state where user_id = u;',
                  'select halted_at, halt_reason, paper_halted_at, paper_halt_reason into brk from public.risk_state where user_id = u;');
  d := replace(d, '''breaker_halted'', brk.halted_at is not null, ''breaker_reason'', brk.halt_reason,',
    '''breaker_halted'', brk.halted_at is not null or brk.paper_halted_at is not null, ''breaker_live'', brk.halted_at is not null, ''breaker_paper'', brk.paper_halted_at is not null, '
    || '''breaker_reason'', concat_ws('' · '', case when brk.halted_at is not null then ''Live: '' || brk.halt_reason end, case when brk.paper_halted_at is not null then ''Paper: '' || brk.paper_halt_reason end),');
  if position('breaker_paper' in d) = 0 then raise exception 'morning_card not patched'; end if;
  execute d;
  d := pg_get_functiondef('public.admin_activity'::regproc);
  d := replace(d, 'coalesce(b.capital, 0) capital,', 'coalesce(b.capital, 0) capital, coalesce(b.paper_capital, 0) paper_capital,');
  d := replace(d, '(select halted_at is not null from public.risk_state r where r.user_id = p.user_id) halted',
    '(select halted_at is not null or paper_halted_at is not null from public.risk_state r where r.user_id = p.user_id) halted');
  if position('paper_capital' in d) = 0 then raise exception 'admin_activity not patched'; end if;
  execute d;
end $m$;

-- Morning card: today's booked P&L per mode (it was live + paper added together).
do $m$
declare d text;
begin
  d := pg_get_functiondef('public.morning_card'::regproc);
  d := replace(d, 'booked numeric;', 'booked numeric; booked_l numeric; booked_p numeric;');
  d := replace(d, E'select coalesce(sum(t.net), 0) into booked from public.algo_trades t\n    where t.user_id = u and not coalesce(t.hidden, false) and (t.exit_at at time zone ''Asia/Kolkata'')::date = today;',
    E'select coalesce(sum(t.net), 0), coalesce(sum(t.net) filter (where t.mode = ''LIVE''), 0), coalesce(sum(t.net) filter (where t.mode = ''PAPER''), 0)\n      into booked, booked_l, booked_p from public.algo_trades t\n    where t.user_id = u and not coalesce(t.hidden, false) and (t.exit_at at time zone ''Asia/Kolkata'')::date = today;');
  d := replace(d, '''booked_today'', trunc(booked),', '''booked_today'', trunc(booked), ''booked_live_today'', trunc(booked_l), ''booked_paper_today'', trunc(booked_p),');
  if position('booked_paper_today' in d) = 0 or position('into booked, booked_l' in d) = 0 then raise exception 'morning_card booked not patched'; end if;
  execute d;
end $m$;
