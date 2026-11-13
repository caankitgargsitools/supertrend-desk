-- Migration 98 (applied as multi_user_98_statement_columns, 13 Nov 2026): client_statement's by_strategy / by_asset rows
-- now carry wins, gross and costs (the statement printed "Win 0% · Gross ₹0 · Charges ₹0" for every strategy).

-- Migration 99 (13 Nov 2026, Papa: "the order was filled only for 80 lots … there has to be an option to fill … we should
-- show that 20 lots"). Orders › Failed orders also lists every open single-futures position holding FEWER lots than the
-- strategy's plan (a partial fill, or lots the desk cut for the limit / one-order cap / Dhan's free funds), with the
-- missing lots and "Add the missing lots" → manual_order(…, 'ADD', n) → engine manualAdd.

alter table public.manual_orders add column if not exists add_to boolean not null default false;

create or replace function public.manual_order(p_strategy uuid, p_side text, p_lots int, p_ref bigint default null, p_px numeric default null)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare s public.algo_strategies; v_id bigint; v_px numeric; v_add boolean := p_side = 'ADD';
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not (public.is_admin() or public.owns_strategy(p_strategy)) then raise exception 'Not allowed.'; end if;
  if p_side not in ('LONG', 'SHORT', 'EXIT', 'ADD') then raise exception 'Side must be LONG, SHORT, EXIT or ADD.'; end if;
  select * into s from public.algo_strategies where id = p_strategy;
  if s.id is null then raise exception 'Strategy not found.'; end if;
  if exists (select 1 from public.manual_orders where strategy_id = p_strategy and state in ('queued', 'working') and created_at > now() - interval '3 minutes')
    then raise exception 'A manual order for this strategy is already being worked. Wait a minute.'; end if;
  if p_side in ('EXIT', 'ADD') and s.position = 'FLAT' then raise exception 'The strategy holds no position.'; end if;
  if p_side in ('LONG', 'SHORT') and s.position <> 'FLAT' then raise exception 'The strategy already holds a position.'; end if;
  if v_add and (s.trade_type <> 'FUTURES' or s.pos_legs is not null) then raise exception 'Lots can be added only to a single futures position.'; end if;
  if v_add and coalesce(p_lots, 0) < 1 then raise exception 'Lots must be 1 or more.'; end if;
  if p_ref is not null then select close into v_px from public.algo_signals where id = p_ref and strategy_id = p_strategy; end if;
  insert into public.manual_orders (user_id, strategy_id, ref_signal, side, lots, mode, ref_px, sent_px, state, add_to)
    values (coalesce(s.owner_id, auth.uid()), p_strategy, p_ref, case when v_add then s.position else p_side end, greatest(1, coalesce(p_lots, s.lots, 1)),
            case when s.live then 'LIVE' else 'PAPER' end, coalesce(v_px, case when v_add then s.pos_entry_px end), p_px,
            case when p_side = 'EXIT' then 'working' else 'queued' end, v_add)
    returning id into v_id;
  perform public.engine_call(case when p_side = 'EXIT' then 'flatten' else 'manual_entry' end, p_strategy);
  return v_id;
end $$;
revoke execute on function public.manual_order(uuid, text, int, bigint, numeric) from public, anon;
grant execute on function public.manual_order(uuid, text, int, bigint, numeric) to authenticated, service_role;

create or replace function public.failed_orders(p_days int default 7) returns json
language plpgsql stable security definer set search_path to 'public' as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'Sign in first.'; end if;
  return coalesce((select json_agg(x order by x.at desc) from (
    -- orders that didn't go through
    select 'sig-' || g.id key, g.id sig_id, g.strategy_id, st.name, st.underlying, st.live now_live, st.active, st.position now_position,
      st.pos_lots now_lots, st.lots, coalesce(lp.px, st.pos_ltp, st.last_close) now_px, coalesce(lp.at, st.pos_ltp_at, st.last_run_at) now_at,
      st.trade_type, st.data_segment, st.exec_state,
      g.mode, g.event, g.created_at at, coalesce(lo.ref_px, g.close) signal_px,
      case when g.event = 'INFO' then 'skipped' else 'refused' end kind,
      case
        when g.event in ('EXIT', 'STOP', 'TARGET', 'TRAIL_STOP', 'SQUARE_OFF', 'FLATTEN') then 'EXIT'
        when g.description ~* '(sell rules met|flipped down|turned down|trend (is )?down|short)' then 'SHORT'
        when g.description ~* '(buy rules met|flipped up|turned up|trend (is )?up|long)' then 'LONG'
        when g.description ~ '(^|: |\| )Sell ' then 'SHORT'
        when g.description ~ '(^|: |\| )Buy ' then 'LONG'
        else null end side,
      nullif(substring(g.description from ' x ([0-9]+)'), '')::int lots_wanted,
      left(coalesce(
        lo.note,
        nullif(substring(g.description from '(Entry skipped:.*)$'), ''),
        nullif(substring(g.response::text from '(HTTP [0-9]{3}[^"\\]{0,120})'), ''),
        left(g.response::text, 200),
        g.description), 300) reason,
      g.description,
      (select json_build_object('id', m.id, 'side', m.side, 'lots', m.lots, 'state', m.state, 'result', m.result, 'at', m.created_at, 'sent_px', m.sent_px)
         from public.manual_orders m where m.ref_signal = g.id order by m.id desc limit 1) manual,
      (select json_build_object('state', o.state, 'note', o.note, 'avg_px', o.avg_px, 'at', o.created_at)
         from public.live_orders o join public.manual_orders m on m.ref_signal = g.id
        where o.strategy_id = g.strategy_id and o.created_at >= m.created_at order by o.id desc limit 1) manual_order_row
    from public.algo_signals g
    join public.algo_strategies st on st.id = g.strategy_id
    left join lateral (select p.px, p.at from public.ticker_ref r join public.live_prices p on p.seg = r.seg and p.sec = r.sec
                        where r.asset = st.underlying order by p.at desc limit 1) lp on true
    left join lateral (select o.note, o.ref_px from public.live_orders o
                        where o.signal_id = g.id and o.state in ('failed', 'cancelled') and coalesce(o.filled_qty, 0) = 0
                        order by o.id desc limit 1) lo on true
    where st.owner_id = u and not coalesce(g.hidden, false)
      and g.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 60)))
      and g.description not ilike 'Manual order (Orders › Failed orders)%lot% added%'
      and (g.status = 'FAILED'
           or (g.event = 'INFO' and g.description ilike '%Entry skipped:%')
           or lo.note is not null)
    union all
    -- open positions holding fewer lots than planned
    select 'short-' || st.id key, null::bigint sig_id, st.id strategy_id, st.name, st.underlying, st.live now_live, st.active, st.position now_position,
      st.pos_lots now_lots, st.lots, coalesce(lp.px, st.pos_ltp, st.last_close) now_px, coalesce(lp.at, st.pos_ltp_at, st.last_run_at) now_at,
      st.trade_type, st.data_segment, st.exec_state,
      case when st.live then 'LIVE' else 'PAPER' end mode, 'SHORT_FILL' event, coalesce(lo.created_at, st.pos_ltp_at, now()) at, st.pos_entry_px signal_px,
      'short' kind, 'ADD' side, (st.lots - st.pos_lots)::int lots_wanted,
      left(coalesce(lo.note, sg.cut, 'Holding ' || st.pos_lots || ' of the ' || st.lots || ' lots planned.'), 300) reason,
      'Holding ' || st.pos_lots || ' of ' || st.lots || ' lots' description,
      (select json_build_object('id', m.id, 'side', m.side, 'lots', m.lots, 'state', m.state, 'result', m.result, 'at', m.created_at, 'sent_px', m.sent_px)
         from public.manual_orders m where m.strategy_id = st.id and m.add_to and m.created_at > now() - interval '1 day' order by m.id desc limit 1) manual,
      null::json manual_order_row
    from public.algo_strategies st
    left join lateral (select p.px, p.at from public.ticker_ref r join public.live_prices p on p.seg = r.seg and p.sec = r.sec
                        where r.asset = st.underlying order by p.at desc limit 1) lp on true
    left join lateral (select o.note, o.created_at from public.live_orders o
                        where o.strategy_id = st.id and o.purpose = 'entry' and o.note ilike '% of % filled%' and o.created_at > now() - interval '30 days'
                        order by o.id desc limit 1) lo on true
    left join lateral (select substring(g.description from '(Size: [^|]*)') cut from public.algo_signals g
                        where g.strategy_id = st.id and g.event in ('ENTRY', 'REVERSE') order by g.id desc limit 1) sg on true
    where st.owner_id = u and not st.archived and not coalesce(st.is_master, false) and st.position <> 'FLAT'
      and st.trade_type = 'FUTURES' and st.pos_legs is null and st.pos_lots is not null and st.lots > st.pos_lots
  ) x), '[]'::json);
end $$;
revoke execute on function public.failed_orders(int) from public, anon;
grant execute on function public.failed_orders(int) to authenticated, service_role;

-- 99b: a failed manual order is not listed as a new failed order of its own (its result shows on the row it was sent for).
--   failed_orders(): and g.description not ilike 'Manual order (Orders › Failed orders%'
