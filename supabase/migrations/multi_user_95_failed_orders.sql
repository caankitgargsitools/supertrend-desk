-- Migration 95 (13 Nov 2026, Papa: "list down all the failed orders, live or paper … the price the order was sent, current
-- price right now, and an option to send a manual order, strategy wise … then see the status whether it is filled").
-- Orders › Failed orders reads failed_orders(); "Send again" calls manual_order() → engine action manual_entry, which goes
-- the engine's own entry path and writes the result back into manual_orders.

create table if not exists public.manual_orders (
  id bigserial primary key,
  user_id uuid not null,
  strategy_id uuid not null,
  ref_signal bigint,                 -- the failed signal this order replaces (null = placed from the strategy itself)
  side text not null check (side in ('LONG', 'SHORT', 'EXIT')),
  lots int not null default 1,
  mode text not null,                -- LIVE / PAPER at the time it was sent
  ref_px numeric,                    -- the signal's price
  sent_px numeric,                   -- the price shown on the page when it was sent
  state text not null default 'queued', -- queued → working → sent / filled / refused
  result text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists manual_orders_strategy_idx on public.manual_orders (strategy_id, id desc);
create index if not exists manual_orders_ref_idx on public.manual_orders (ref_signal);
alter table public.manual_orders enable row level security;
create policy manual_orders_read on public.manual_orders for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Queue one manual order for a strategy the caller owns (admins: any) and wake the engine for it.
create or replace function public.manual_order(p_strategy uuid, p_side text, p_lots int, p_ref bigint default null, p_px numeric default null)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare s public.algo_strategies; v_id bigint; v_px numeric;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not (public.is_admin() or public.owns_strategy(p_strategy)) then raise exception 'Not allowed.'; end if;
  if p_side not in ('LONG', 'SHORT', 'EXIT') then raise exception 'Side must be LONG, SHORT or EXIT.'; end if;
  select * into s from public.algo_strategies where id = p_strategy;
  if s.id is null then raise exception 'Strategy not found.'; end if;
  if exists (select 1 from public.manual_orders where strategy_id = p_strategy and state in ('queued', 'working') and created_at > now() - interval '3 minutes')
    then raise exception 'A manual order for this strategy is already being worked. Wait a minute.'; end if;
  if p_side = 'EXIT' and s.position = 'FLAT' then raise exception 'The strategy holds no position to exit.'; end if;
  if p_side <> 'EXIT' and s.position <> 'FLAT' then raise exception 'The strategy already holds a position.'; end if;
  if p_ref is not null then select close into v_px from public.algo_signals where id = p_ref and strategy_id = p_strategy; end if;
  insert into public.manual_orders (user_id, strategy_id, ref_signal, side, lots, mode, ref_px, sent_px, state)
    values (coalesce(s.owner_id, auth.uid()), p_strategy, p_ref, p_side, greatest(1, coalesce(p_lots, s.lots, 1)),
            case when s.live then 'LIVE' else 'PAPER' end, v_px, p_px, case when p_side = 'EXIT' then 'working' else 'queued' end)
    returning id into v_id;
  -- An exit goes the existing "Exit positions now" way (flatten).
  perform public.engine_call(case when p_side = 'EXIT' then 'flatten' else 'manual_entry' end, p_strategy);
  return v_id;
end $$;
grant execute on function public.manual_order(uuid, text, int, bigint, numeric) to authenticated;

-- Every order that didn't go through in the last p_days, live and paper, for the caller's own strategies:
--   * a signal the broker refused (status FAILED: Dhan / Delta errors, e.g. "Invalid IP", "insufficient margin"),
--   * an entry the desk skipped (not enough room inside the limit, F&O ban, …),
--   * a Dhan order row that failed or was cancelled with nothing filled.
-- With each: the signal's price, the side it wanted, the strategy now (position, current price) and the latest manual
-- order sent for it (its state and result).
create or replace function public.failed_orders(p_days int default 7) returns json
language plpgsql stable security definer set search_path to 'public' as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'Sign in first.'; end if;
  return coalesce((select json_agg(x order by x.at desc) from (
    select g.id sig_id, g.strategy_id, st.name, st.underlying, st.live now_live, st.active, st.position now_position,
      st.pos_lots now_lots, st.lots, coalesce(st.pos_ltp, st.last_close) now_px, coalesce(st.pos_ltp_at, st.last_run_at) now_at,
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
    left join lateral (select o.note, o.ref_px from public.live_orders o
                        where o.signal_id = g.id and o.state in ('failed', 'cancelled') and coalesce(o.filled_qty, 0) = 0
                        order by o.id desc limit 1) lo on true
    where st.owner_id = u and not coalesce(g.hidden, false)
      and g.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 60)))
      and (g.status = 'FAILED'
           or (g.event = 'INFO' and g.description ilike '%Entry skipped:%')
           or lo.note is not null)
  ) x), '[]'::json);
end $$;
grant execute on function public.failed_orders(int) to authenticated;
