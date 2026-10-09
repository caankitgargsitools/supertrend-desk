-- Strategy Lab for users: results and trades of every lab strategy, without its parameters. A user who picks one gets
-- a locked copy (its rules stay in an admin-owned master that the engine reads at run time).

create or replace function public.lab_can_use() returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (select 1 from public.profiles where user_id = (select auth.uid()) and status = 'active' and can_build);
$$;

-- "Similar strategies" key (same asset, decision style, direction and indicator/condition types), hashed so it shows nothing.
create or replace function public.lab_family(p_asset text, c jsonb) returns text language sql immutable as $$
  select md5(p_asset || '|' || case when c->'rules'->>'daily' = 'true' then 'D' else 'I' end || '|' || coalesce(c->>'direction', '') || '|' ||
    coalesce((select string_agg((x->>'ind') || ':' || (x->>'op'), '+' order by (x->>'ind') || ':' || (x->>'op')) from jsonb_array_elements(coalesce(c->'rules'->'long'->'conds', '[]'::jsonb)) x), '-') || '|' ||
    coalesce((select string_agg((x->>'ind') || ':' || (x->>'op'), '+' order by (x->>'ind') || ':' || (x->>'op')) from jsonb_array_elements(coalesce(c->'rules'->'short'->'conds', '[]'::jsonb)) x), '-'));
$$;

-- Trade list without entry reasons; exit reasons only when they don't describe the rules.
create or replace function public.lab_clean_trades(p jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg((t - 'why' - 'exit_why') || jsonb_build_object('exit_why',
    case when t->>'exit_why' ~* '(stop|target|square|still open|trail|timed|daily loss|end of test)' then t->>'exit_why' else 'Strategy exit' end)), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) t;
$$;

create or replace function public.lab_public(p_view text, p_asset text, p_period text, p_only boolean) returns json language plpgsql stable security definer set search_path = public as $$
declare r public.lab_runs; since timestamptz;
begin
  if not public.lab_can_use() then raise exception 'The Strategy Lab is not enabled for your account.'; end if;
  select * into r from public.lab_runs order by id desc limit 1;
  since := case when p_period = 'run' then null else now() - make_interval(days => greatest(1, least(60, coalesce(nullif(p_period, '')::int, 30)))) end;
  return json_build_object(
    'run', case when r.id is null then null else json_build_object('id', r.id, 'created_at', r.created_at, 'status', r.status, 'phase', r.phase, 'progress', r.progress,
      'counts', r.counts, 'from_day', r.from_day, 'split_day', r.split_day, 'to_day', r.to_day) end,
    'rows', coalesce((select json_agg(x order by x.score desc) from (
      select l.id, l.run_id, l.created_at, l.asset, l.stage, l.passed, l.score, l.champion, l.metrics,
        md5(coalesce(l.fingerprint, l.id::text)) as fingerprint, public.lab_family(l.asset, l.config) as family, (l.config->'risk') is not null and l.config->'risk' <> 'null'::jsonb as has_risk,
        case when l.opt_buy is null then null else jsonb_build_object('metrics', l.opt_buy->'summary'->'metrics') end as ob,
        case when l.opt_sell is null then null else jsonb_build_object('metrics', l.opt_sell->'summary'->'metrics') end as os
      from public.lab_results l
      where l.stage in ('screened', 'opt_queue', 'pricing', 'priced')
        and (case when p_period = 'run' then l.run_id = r.id else l.created_at >= since end)
        and (p_view <> 'FUT' or not coalesce(p_only, true) or l.passed)
        and (p_view = 'FUT' or (p_view = 'BUY' and l.opt_buy is not null) or (p_view = 'SELL' and l.opt_sell is not null))
        and (p_asset = 'ALL' or l.asset = p_asset)
      order by l.score desc limit 2000) x), '[]'::json));
end $$;

create or replace function public.lab_public_detail(p_id bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare l public.lab_results; r public.lab_runs; v jsonb; vs jsonb := '[]'::jsonb; i int;
begin
  if not public.lab_can_use() then raise exception 'The Strategy Lab is not enabled for your account.'; end if;
  select * into l from public.lab_results where id = p_id;
  if not found or not (l.requested_by is null or l.requested_by = auth.uid() or public.is_admin()) then raise exception 'Not found.'; end if;
  select * into r from public.lab_runs where id = l.run_id;
  vs := vs || jsonb_build_object('key', 'FUT', 'side', null, 'i', 0, 'label', case when l.config->>'data_segment' = 'MCX_COMM' then 'Futures' else 'Index futures' end,
    'metrics', l.metrics, 'trades', public.lab_clean_trades(l.trades));
  i := 0;
  for v in select * from jsonb_array_elements(coalesce(l.opt_buy->'variants', '[]'::jsonb)) loop
    i := i + 1;
    vs := vs || jsonb_build_object('key', 'BUY', 'side', 'BUY', 'i', i, 'label', 'Option buying' || case when jsonb_array_length(l.opt_buy->'variants') > 1 then ' · version ' || i else '' end,
      'metrics', v->'metrics', 'trades', public.lab_clean_trades(v->'trades'), 'skipped', v->'skipped');
  end loop;
  i := 0;
  for v in select * from jsonb_array_elements(coalesce(l.opt_sell->'variants', '[]'::jsonb)) loop
    i := i + 1;
    vs := vs || jsonb_build_object('key', 'SELL', 'side', 'SELL', 'i', i, 'label', 'Option writing' || case when jsonb_array_length(l.opt_sell->'variants') > 1 then ' · version ' || i else '' end,
      'metrics', v->'metrics', 'trades', public.lab_clean_trades(v->'trades'), 'skipped', v->'skipped');
  end loop;
  return json_build_object('id', l.id, 'run_id', l.run_id, 'created_at', l.created_at, 'asset', l.asset, 'champion', l.champion,
    'cfg', jsonb_build_object('lot_size', l.config->'lot_size', 'data_segment', l.config->'data_segment', 'underlying', l.config->'underlying', 'exchange', l.config->'exchange'),
    'run', json_build_object('from_day', r.from_day, 'split_day', r.split_day, 'to_day', r.to_day, 'created_at', r.created_at), 'versions', vs);
end $$;

-- Use a lab strategy: an admin-owned master holds the rules; the user gets a locked copy that runs on them.
create or replace function public.lab_adopt(p_id bigint, p_side text, p_variant int, p_name text, p_capital numeric, p_lots int, p_max_lots int) returns uuid language plpgsql security definer set search_path = public as $$
declare l public.lab_results; c jsonb; v jsonb; adm uuid; m uuid; d uuid; u uuid := auth.uid(); lbl text; nm text;
begin
  if u is null then raise exception 'Sign in first.'; end if;
  if not public.lab_can_use() then raise exception 'The Strategy Lab is not enabled for your account.'; end if;
  select * into l from public.lab_results where id = p_id;
  if not found then raise exception 'Not found.'; end if;
  c := l.config;
  select user_id into adm from public.profiles where role = 'admin' and status = 'active' order by created_at limit 1;
  if adm is null then select user_id into adm from public.app_owner limit 1; end if;
  lbl := case when p_side = 'BUY' then 'Option buying' when p_side = 'SELL' then 'Option writing' else 'Futures' end;
  c := (select coalesce(jsonb_object_agg(k, c->k), '{}'::jsonb) from unnest(array['strategy_kind', 'underlying', 'data_security_id', 'data_segment', 'data_instrument', 'exchange',
    'dhan_symbol', 'futures_symbol', 'timeframe_min', 'rules', 'direction', 'entry_mode', 'session_start', 'last_entry', 'square_off', 'intraday', 'trade_type', 'option_side',
    'lots', 'lot_size', 'qty_mode', 'product_type', 'strike_step', 'strike_offset', 'expiry_weekday', 'expiry_flag', 'roll_on_expiry', 'atr_period', 'factor', 'entry_trigger',
    'buffer_points', 'after_hours_flip', 'risk']) k where c ? k);
  if p_side in ('BUY', 'SELL') then
    v := (case when p_side = 'BUY' then l.opt_buy else l.opt_sell end)->'variants'->(greatest(1, coalesce(p_variant, 1)) - 1);
    if v is null then raise exception 'That option version was not tested.'; end if;
    c := c || jsonb_build_object('trade_type', 'OPTIONS', 'option_side', p_side, 'risk', v->'risk', 'strike_offset', 0);
  end if;
  perform set_config('app.bypass', 'on', true);
  insert into public.algo_strategies (name, owner_id, is_master, active, live) values (format('[Lab #%s master] %s', l.id, lbl), adm, true, false, false) returning id into m;
  update public.algo_strategies t set (strategy_kind, underlying, data_security_id, data_segment, data_instrument, exchange, dhan_symbol, futures_symbol, timeframe_min, rules,
      direction, entry_mode, session_start, last_entry, square_off, intraday, trade_type, option_side, lot_size, qty_mode, product_type, strike_step, strike_offset,
      expiry_weekday, expiry_flag, roll_on_expiry, atr_period, factor, entry_trigger, buffer_points, after_hours_flip, risk) =
    (select x.strategy_kind, x.underlying, x.data_security_id, x.data_segment, x.data_instrument, x.exchange, x.dhan_symbol, x.futures_symbol, x.timeframe_min, x.rules,
      x.direction, x.entry_mode, x.session_start, x.last_entry, x.square_off, x.intraday, x.trade_type, x.option_side, x.lot_size, x.qty_mode, x.product_type, x.strike_step, x.strike_offset,
      x.expiry_weekday, x.expiry_flag, x.roll_on_expiry, x.atr_period, x.factor, x.entry_trigger, x.buffer_points, x.after_hours_flip, x.risk
     from jsonb_populate_record(t, c) x)
  where t.id = m;
  nm := coalesce(nullif(trim(p_name), ''), format('Lab #%s · %s · %s', l.id, l.asset, lbl));
  d := public.copy_strategy(m, jsonb_build_object('owner_id', u, 'source_id', m, 'listing_id', null, 'locked', true, 'is_master', false, 'name', nm,
    'rules', null, 'risk', null, 'capital', case when coalesce(p_capital, 0) > 0 then p_capital end, 'lots', greatest(1, coalesce(p_lots, 1)),
    'sizing', case when coalesce(p_capital, 0) > 0 then jsonb_build_object('mode', 'CAPITAL', 'max_lots', greatest(1, coalesce(p_max_lots, 10))) end));
  update public.algo_strategies set strategy_kind = default, timeframe_min = default, atr_period = default, factor = default, entry_mode = default,
    entry_trigger = default, buffer_points = default, bias_timeframe = default, bias_source = default, entry_time = default, exit_time = default,
    exit_next_day = default, session_start = default, last_entry = default, square_off = default, strike_offset = default, direction = default,
    after_hours_flip = default, active = false, live = false
  where id = d;
  return d;
end $$;

revoke all on function public.lab_public(text, text, text, boolean) from public, anon;
revoke all on function public.lab_public_detail(bigint) from public, anon;
revoke all on function public.lab_adopt(bigint, text, int, text, numeric, int, int) from public, anon;
revoke all on function public.lab_can_use() from public, anon;
grant execute on function public.lab_public(text, text, text, boolean) to authenticated;
grant execute on function public.lab_public_detail(bigint) to authenticated;
grant execute on function public.lab_adopt(bigint, text, int, text, numeric, int, int) to authenticated;
grant execute on function public.lab_can_use() to authenticated;

-- (requested_by check added with multi_user_8)
