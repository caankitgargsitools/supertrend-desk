-- 6 Nov 2026 audit, "delight" item 2 (and the open item "slippage column + per-strategy slippage summary"):
-- trade_story(p_trade): one closed trade's story — the entry and exit signals (what fired, when, the decision delay),
-- the broker orders of each leg (Dhan / Delta ids, states, fills, limit steps), the fill prices beside the desk's own
-- prices (slippage in points and rupees), and the trade row itself. Paper trades have signals but no orders.
-- slippage_summary(p_user): per strategy, the live fills' slippage against the desk's signal prices (from
-- algo_signals.fills where the broker price is known): trades, average and worst slippage in points and the rupee total.
-- Both callable by the owner of the trade / strategies or an admin.

create or replace function public.trade_story(p_trade bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t record; ex record; en record; orders jsonb; fills jsonb; dir int; units numeric;
  slip_in numeric; slip_out numeric;
begin
  select * into t from public.algo_trades where id = p_trade;
  if t is null then return null; end if;
  if auth.uid() is not null and t.user_id is distinct from auth.uid() and not public.is_admin() then raise exception 'not allowed'; end if;
  -- The exit signal: the strategy's closest exit-type signal within 3 minutes of the trade's exit.
  select id, event, description, created_at, candle_time, lag_ms, status, close, fills into ex from public.algo_signals
    where strategy_id = t.strategy_id and event in ('EXIT', 'REVERSE', 'SQUARE_OFF', 'STOP_LOSS', 'TRAIL_STOP', 'TARGET', 'FLATTEN', 'ROLL')
      and created_at between t.exit_at - interval '3 minutes' and t.exit_at + interval '3 minutes' and not coalesce(hidden, false)
    order by abs(extract(epoch from (created_at - t.exit_at))) limit 1;
  -- The entry signal: the latest entry-type signal before the exit, on or after the entry day.
  select id, event, description, created_at, candle_time, lag_ms, status, close, fills into en from public.algo_signals
    where strategy_id = t.strategy_id and event in ('ENTRY', 'REVERSE', 'ROLL') and not coalesce(hidden, false)
      and created_at >= (t.entry_day::timestamp at time zone 'Asia/Kolkata') and created_at < coalesce(ex.created_at, t.exit_at)
    order by created_at desc limit 1;
  -- Broker orders: the exit's batch, and the entry's orders around the entry signal.
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'purpose', o.purpose, 'event', o.event, 'side', o.side, 'qty', o.qty, 'label', o.label, 'state', o.state,
      'limit_px', o.limit_px, 'avg_px', o.avg_px, 'filled_qty', o.filled_qty, 'steps', o.steps, 'market_retry', o.market_retry, 'broker_order_id', o.broker_order_id,
      'placed_at', o.placed_at, 'done_at', o.done_at, 'note', o.note) order by o.created_at, o.seq), '[]'::jsonb) into orders
    from public.live_orders o
    where o.strategy_id = t.strategy_id and (
      (t.order_batch is not null and o.batch = t.order_batch)
      or (en.created_at is not null and o.purpose = 'entry' and o.created_at between en.created_at - interval '1 minute' and en.created_at + interval '10 minutes'));
  dir := case when t.side = 'LONG' then 1 else -1 end;
  units := coalesce(t.units, 0);
  -- Slippage: broker fill against the desk's own price on the same leg (positive = worse for the trader).
  select (f->>'broker_px')::numeric - (f->>'px')::numeric into slip_in from jsonb_array_elements(coalesce(en.fills, '[]'::jsonb)) f
    where f->>'leg' = 'Entry' and f->>'broker_px' is not null and f->>'px' is not null limit 1;
  select (f->>'broker_px')::numeric - (f->>'px')::numeric into slip_out from jsonb_array_elements(coalesce(ex.fills, '[]'::jsonb)) f
    where f->>'leg' = 'Exit' and f->>'broker_px' is not null and f->>'px' is not null limit 1;
  slip_in := case when slip_in is null then null else slip_in * dir end;      -- a long pays more on entry: worse
  slip_out := case when slip_out is null then null else -slip_out * dir end;  -- a long gets less on exit: worse
  return jsonb_build_object(
    'trade', jsonb_build_object('id', t.id, 'strategy_id', t.strategy_id, 'mode', t.mode, 'side', t.side, 'contract', t.contract, 'lots', t.lots, 'units', t.units,
      'entry_day', t.entry_day, 'exit_at', t.exit_at, 'entry_px', t.entry_px, 'exit_px', t.exit_px, 'gross', t.gross, 'costs', t.costs, 'net', t.net, 'exit_why', t.exit_why,
      'provisional', t.provisional, 'verified', t.verified),
    'entry', case when en.id is null then null else jsonb_build_object('signal_id', en.id, 'event', en.event, 'description', en.description, 'at', en.created_at, 'candle', en.candle_time,
      'lag_ms', en.lag_ms, 'status', en.status, 'price', en.close, 'fills', en.fills) end,
    'exit', case when ex.id is null then null else jsonb_build_object('signal_id', ex.id, 'event', ex.event, 'description', ex.description, 'at', ex.created_at, 'candle', ex.candle_time,
      'lag_ms', ex.lag_ms, 'status', ex.status, 'price', ex.close, 'fills', ex.fills) end,
    'orders', orders,
    'slippage', jsonb_build_object('entry_pts', slip_in, 'exit_pts', slip_out,
      'total_pts', case when slip_in is null and slip_out is null then null else coalesce(slip_in, 0) + coalesce(slip_out, 0) end,
      'rupees', case when slip_in is null and slip_out is null then null else trunc((coalesce(slip_in, 0) + coalesce(slip_out, 0)) * units) end));
end $$;
grant execute on function public.trade_story(bigint) to authenticated;

create or replace function public.slippage_summary(p_user uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u uuid := coalesce(p_user, auth.uid()); res jsonb;
begin
  if u is null then return null; end if;
  if auth.uid() is not null and u <> auth.uid() and not public.is_admin() then raise exception 'not allowed'; end if;
  with f as (
    select g.strategy_id, s.name, g.id signal_id, g.created_at,
      ((x->>'broker_px')::numeric - (x->>'px')::numeric) * case when x->>'side' = 'BUY' then 1 else -1 end slip_pts,  -- paying more / getting less = worse
      (x->>'broker_qty')::numeric qty
    from public.algo_signals g join public.algo_strategies s on s.id = g.strategy_id, jsonb_array_elements(coalesce(g.fills, '[]'::jsonb)) x
    where s.owner_id = u and g.mode = 'LIVE' and not coalesce(g.hidden, false) and x->>'broker_px' is not null and x->>'px' is not null)
  select coalesce(jsonb_agg(jsonb_build_object('strategy_id', strategy_id, 'name', name, 'legs', n, 'avg_pts', avg_pts, 'worst_pts', worst_pts, 'rupees', rupees, 'last', last_at) order by rupees desc), '[]'::jsonb)
    into res
  from (select strategy_id, name, count(*) n, round(avg(slip_pts), 2) avg_pts, round(max(slip_pts), 2) worst_pts, trunc(sum(slip_pts * coalesce(qty, 0))) rupees, max(created_at) last_at from f group by 1, 2) y;
  return jsonb_build_object('user_id', u, 'strategies', res);
end $$;
grant execute on function public.slippage_summary(uuid) to authenticated;
