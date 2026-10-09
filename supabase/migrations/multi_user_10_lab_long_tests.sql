-- Long tests: every night (00:30 IST) the lab's strongest winners are backtested once over the longest history Dhan has
-- (10 years for once-a-day futures strategies, 5 years for intraday and option versions), and the results are cut into
-- 3M, 6M, 1Y … 10Y windows. They run at low priority, only between midnight and 8 am IST.

create table if not exists public.lab_periods (
  id bigserial primary key,
  lab_id bigint not null,
  fingerprint text not null,
  version text not null check (version in ('FUT', 'BUY', 'SELL')),
  variant integer,
  strategy_id uuid,
  backtest_id bigint,
  status text not null default 'queued',
  from_day date,
  to_day date,
  windows jsonb,
  summary jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lab_periods_fp on public.lab_periods (fingerprint, version, id desc);
create index if not exists lab_periods_lab on public.lab_periods (lab_id);
alter table public.lab_periods enable row level security;
create policy lab_periods_admin on public.lab_periods for select using ((select public.is_admin()));
alter table public.lab_settings add column if not exists long_per_night integer not null default 10;

-- An admin-owned private copy of a lab strategy (futures, or one tested option version), used to run it.
create or replace function public.lab_master(p_id bigint, p_side text, p_variant int, p_name text) returns uuid language plpgsql security definer set search_path = public as $$
declare l public.lab_results; c jsonb; v jsonb; adm uuid; m uuid;
begin
  select * into l from public.lab_results where id = p_id;
  if not found then raise exception 'Lab strategy not found.'; end if;
  select user_id into adm from public.profiles where role = 'admin' and status = 'active' order by created_at limit 1;
  if adm is null then select user_id into adm from public.app_owner limit 1; end if;
  c := (select coalesce(jsonb_object_agg(k, l.config->k), '{}'::jsonb) from unnest(array['strategy_kind', 'underlying', 'data_security_id', 'data_segment', 'data_instrument', 'exchange',
    'dhan_symbol', 'futures_symbol', 'timeframe_min', 'rules', 'direction', 'entry_mode', 'session_start', 'last_entry', 'square_off', 'intraday', 'trade_type', 'option_side',
    'lot_size', 'qty_mode', 'product_type', 'strike_step', 'strike_offset', 'expiry_weekday', 'expiry_flag', 'roll_on_expiry', 'atr_period', 'factor', 'entry_trigger',
    'buffer_points', 'after_hours_flip', 'risk']) k where l.config ? k);
  if p_side in ('BUY', 'SELL') then
    v := (case when p_side = 'BUY' then l.opt_buy else l.opt_sell end)->'variants'->(greatest(1, coalesce(p_variant, 1)) - 1);
    if v is null then raise exception 'That option version was not tested.'; end if;
    c := c || jsonb_build_object('trade_type', 'OPTIONS', 'option_side', p_side, 'risk', v->'risk', 'strike_offset', 0);
  else
    c := c || jsonb_build_object('trade_type', 'FUTURES');
  end if;
  perform set_config('app.bypass', 'on', true);
  insert into public.algo_strategies (name, owner_id, is_master, active, live) values (p_name, adm, true, false, false) returning id into m;
  update public.algo_strategies t set (strategy_kind, underlying, data_security_id, data_segment, data_instrument, exchange, dhan_symbol, futures_symbol, timeframe_min, rules,
      direction, entry_mode, session_start, last_entry, square_off, intraday, trade_type, option_side, lot_size, qty_mode, product_type, strike_step, strike_offset,
      expiry_weekday, expiry_flag, roll_on_expiry, atr_period, factor, entry_trigger, buffer_points, after_hours_flip, risk, lots) =
    (select x.strategy_kind, x.underlying, x.data_security_id, x.data_segment, x.data_instrument, x.exchange, x.dhan_symbol, x.futures_symbol, x.timeframe_min, x.rules,
      x.direction, x.entry_mode, x.session_start, x.last_entry, x.square_off, x.intraday, x.trade_type, x.option_side, x.lot_size, x.qty_mode, x.product_type, x.strike_step, x.strike_offset,
      x.expiry_weekday, x.expiry_flag, x.roll_on_expiry, x.atr_period, x.factor, x.entry_trigger, x.buffer_points, x.after_hours_flip, x.risk, 1
     from jsonb_populate_record(t, c) x)
  where t.id = m;
  return m;
end $$;
revoke all on function public.lab_master(bigint, text, int, text) from public, anon, authenticated;

-- Queue one long test (one version of one lab strategy).
create or replace function public.lab_long_test(p_id bigint, p_side text, p_variant int) returns bigint language plpgsql security definer set search_path = public as $$
declare l public.lab_results; m uuid; lp bigint; b bigint; today date := (now() at time zone 'Asia/Kolkata')::date; yrs int; s public.algo_strategies;
begin
  select * into l from public.lab_results where id = p_id;
  if not found then return null; end if;
  m := public.lab_master(p_id, p_side, p_variant, format('[Lab #%s long test] %s', p_id, case p_side when 'BUY' then 'Option buying' when 'SELL' then 'Option writing' else 'Futures' end));
  select * into s from public.algo_strategies where id = m;
  -- Dhan keeps about 5 years of intraday and expired-option data; once-a-day futures strategies get 10 years of daily candles.
  yrs := case when p_side = 'FUT' and l.config->'rules'->>'daily' = 'true' then 10 else 5 end;
  insert into public.lab_periods (lab_id, fingerprint, version, variant, strategy_id, status, from_day, to_day)
  values (l.id, l.fingerprint, p_side, p_variant, m, 'queued', (today - make_interval(years => yrs))::date + 1, today - 1) returning id into lp;
  insert into public.algo_backtests (strategy_id, user_id, status, waiting, progress, params)
  values (m, s.owner_id, 'queued', true, 'Waiting for the night slot', jsonb_build_object(
    'from', (today - make_interval(years => yrs))::date + 1, 'to', today - 1, 'capital', 500000, 'brokerage', 20,
    'charges', public.charge_rates(s.exchange), 'near_code', 1, 'low', true, 'lab_period', lp, 'long', yrs > 5))
  returning id into b;
  update public.lab_periods set backtest_id = b where id = lp;
  return lp;
end $$;
revoke all on function public.lab_long_test(bigint, text, int) from public, anon, authenticated;

-- Nightly pick: the strongest winners of the last 30 days (most nights passed, then score) not long-tested in the last 7 days.
create or replace function public.lab_long_queue() returns integer language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; lim int; bv int;
begin
  select coalesce(long_per_night, 10) into lim from public.lab_settings where id = 1;
  for r in
    with p as (select fingerprint, count(*) as nights, max(score) as best from public.lab_results where passed and created_at > now() - interval '30 days' group by fingerprint),
    latest as (select distinct on (l.fingerprint) l.* from public.lab_results l join p using (fingerprint) where l.passed order by l.fingerprint, l.id desc)
    select latest.id, latest.fingerprint, latest.opt_buy, latest.opt_sell, latest.asset from latest join p using (fingerprint)
    where not exists (select 1 from public.lab_periods x where x.fingerprint = latest.fingerprint and x.created_at > now() - interval '7 days')
    order by p.nights desc, p.best desc limit coalesce(lim, 10)
  loop
    perform public.lab_long_test(r.id, 'FUT', null);
    if r.opt_buy is not null then bv := coalesce((r.opt_buy->>'best')::int, 0) + 1; perform public.lab_long_test(r.id, 'BUY', bv); end if;
    if r.opt_sell is not null then bv := coalesce((r.opt_sell->>'best')::int, 0) + 1; perform public.lab_long_test(r.id, 'SELL', bv); end if;
    n := n + 1;
  end loop;
  perform public.kick_backtests();
  return n;
end $$;
revoke all on function public.lab_long_queue() from public, anon, authenticated;

select cron.schedule('strategy-lab-long-tests', '0 19 * * *', $$select public.lab_long_queue()$$);
