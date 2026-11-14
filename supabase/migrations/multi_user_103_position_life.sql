-- 14 Nov 2026 (Papa: "we should also keep a track as to the trailing stop loss. It is keeping on changing, so upon
-- clicking on this positions tab, it should have a full page view and should show me all the information that has changed
-- over the course of the life cycle of this trade … very very detailed and very very explanatory").
-- position_log: what changed on an open position, written by a trigger on algo_strategies (no engine change):
--   open / close / flip (position), lots (lots held), entry (average entry price), target, stop (the effective stop:
--   the fixed stop or the trailing one = best price ∓ trail distance, whichever is tighter), broker_stop (a stop order
--   placed at / removed from the broker). Stop moves are kept to one row per strategy per minute (the minute's first old
--   value and last new value) so a fast trend can't flood the table. Never deleted.
-- position_life(strategy): the strategy, the current (or last) trade's start, its log rows, signals, broker orders,
-- booked part-trades and the strategy's chart candles — everything the website's "Trade life" page draws. Owner or admin.

create table if not exists public.position_log (
  id bigserial primary key, strategy_id uuid not null, owner_id uuid, live boolean,
  at timestamptz not null default now(), kind text not null, price numeric, old_v numeric, new_v numeric,
  info jsonb, bucket bigint);
create index if not exists position_log_strat_idx on public.position_log (strategy_id, id);
create unique index if not exists position_log_stop_bucket on public.position_log (strategy_id, bucket) where kind = 'stop';
alter table public.position_log enable row level security;
revoke all on public.position_log from public, anon, authenticated;

create or replace function public.pos_eff_stop(r jsonb) returns numeric language sql immutable as $$
  select case
    when r is null or r->>'dir' is null then null
    when r->'trail' is null or jsonb_typeof(r->'trail') = 'null' or r->>'best' is null then (r->>'stop')::numeric
    else (select case when (r->>'stop') is null then tr
                      when (r->>'dir')::int = 1 then greatest((r->>'stop')::numeric, tr) else least((r->>'stop')::numeric, tr) end
          from (select (r->>'best')::numeric - (r->>'dir')::int * case r->'trail'->>'type'
                   when 'POINTS' then (r->'trail'->>'value')::numeric
                   when 'PCT' then (r->>'best')::numeric * (r->'trail'->>'value')::numeric / 100
                   else (r->'trail'->>'value')::numeric * coalesce((r->>'trailAtr')::numeric, 0) end as tr) x)
  end $$;

create or replace function public.trg_position_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare s0 numeric; s1 numeric; px numeric := coalesce(new.pos_ltp, old.pos_ltp);
begin
  begin
    if old.position is distinct from new.position then
      insert into public.position_log (strategy_id, owner_id, live, kind, price, info) values (new.id, new.owner_id, new.live,
        case when old.position = 'FLAT' then 'open' when new.position = 'FLAT' then 'close' else 'flip' end, px,
        jsonb_build_object('from', old.position, 'to', new.position, 'lots', new.pos_lots, 'entry', new.pos_entry_px,
          'stop', public.pos_eff_stop(new.pos_risk), 'tgt', new.pos_risk->'tgt', 'risk', new.pos_risk, 'upnl', old.pos_upnl));
      return new;
    end if;
    if new.position = 'FLAT' then return new; end if;
    if old.pos_lots is distinct from new.pos_lots then
      insert into public.position_log (strategy_id, owner_id, live, kind, price, old_v, new_v) values (new.id, new.owner_id, new.live, 'lots', px, old.pos_lots, new.pos_lots);
    end if;
    if old.pos_entry_px is distinct from new.pos_entry_px then
      insert into public.position_log (strategy_id, owner_id, live, kind, price, old_v, new_v) values (new.id, new.owner_id, new.live, 'entry', px, old.pos_entry_px, new.pos_entry_px);
    end if;
    if (old.pos_risk->>'tgt') is distinct from (new.pos_risk->>'tgt') then
      insert into public.position_log (strategy_id, owner_id, live, kind, price, old_v, new_v) values (new.id, new.owner_id, new.live, 'target', px, (old.pos_risk->>'tgt')::numeric, (new.pos_risk->>'tgt')::numeric);
    end if;
    s0 := public.pos_eff_stop(old.pos_risk); s1 := public.pos_eff_stop(new.pos_risk);
    if s1 is not null and s0 is distinct from s1 then
      insert into public.position_log as l (strategy_id, owner_id, live, kind, price, old_v, new_v, info, bucket)
        values (new.id, new.owner_id, new.live, 'stop', px, s0, s1, jsonb_build_object('best', new.pos_risk->'best', 'trailAtr', new.pos_risk->'trailAtr', 'trail', new.pos_risk->'trail', 'fixed', new.pos_risk->'stop'), floor(extract(epoch from now()) / 60)::bigint)
      on conflict (strategy_id, bucket) where kind = 'stop' do update set new_v = excluded.new_v, price = excluded.price, info = excluded.info, at = now();
    end if;
    if (old.pos_broker->>'stopId') is distinct from (new.pos_broker->>'stopId') then
      insert into public.position_log (strategy_id, owner_id, live, kind, price, info) values (new.id, new.owner_id, new.live, 'broker_stop', px,
        jsonb_build_object('placed', new.pos_broker->>'stopId' is not null, 'trigger', new.pos_broker->'stopTrig'));
    end if;
  exception when others then null;  -- never block the engine's write
  end;
  return new;
end $$;
create or replace trigger position_log_trg after update of position, pos_lots, pos_entry_px, pos_risk, pos_broker on public.algo_strategies
  for each row execute function public.trg_position_log();

create or replace function public.position_life(p_strategy uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare s public.algo_strategies; t0 timestamptz; res json;
begin
  select * into s from public.algo_strategies where id = p_strategy;
  if not found or not (public.is_admin() or s.owner_id = auth.uid()) then raise exception 'Not allowed.'; end if;
  -- The trade's start: the latest entry / reversal that went through (or the latest 'open' log row, whichever is newer).
  select max(x) into t0 from (
    select max(created_at) x from public.algo_signals where strategy_id = p_strategy and event in ('ENTRY', 'REVERSE') and not coalesce(hidden, false)
      and coalesce(status, '') <> 'FAILED' and description not ilike '%Entry skipped%'
    union all select max(at) from public.position_log where strategy_id = p_strategy and kind in ('open', 'flip')) q;
  t0 := coalesce(t0, (s.pos_entry_date::timestamp at time zone 'Asia/Kolkata'), now() - interval '1 day');
  select json_build_object(
    'start', t0,
    'strategy', json_build_object('id', s.id, 'name', s.name, 'underlying', s.underlying, 'live', s.live, 'active', s.active, 'position', s.position,
      'lots', s.lots, 'pos_lots', s.pos_lots, 'lot_size', s.lot_size, 'pos_entry_px', s.pos_entry_px, 'pos_entry_date', s.pos_entry_date, 'pos_ltp', s.pos_ltp,
      'pos_ltp_at', s.pos_ltp_at, 'pos_upnl', s.pos_upnl, 'pos_margin', s.pos_margin, 'pos_risk', s.pos_risk, 'risk', s.risk, 'timeframe_min', s.timeframe_min,
      'strategy_kind', s.strategy_kind, 'rules', s.rules, 'trade_type', s.trade_type, 'data_segment', s.data_segment, 'exec_state', s.exec_state,
      'lab_id', s.lab_id, 'sizing', s.sizing, 'stop_id', s.pos_broker->>'stopId', 'stop_trig', s.pos_broker->'stopTrig', 'fill', s.pos_broker->'fill'),
    'log', (select coalesce(json_agg(l order by l.id), '[]') from (select id, at, kind, price, old_v, new_v, info from public.position_log
             where strategy_id = p_strategy and at >= t0 - interval '1 minute' order by id limit 2000) l),
    'signals', (select coalesce(json_agg(g order by g.id), '[]') from (select id, created_at, candle_time, event, status, close, description, lag_ms, fills
             from public.algo_signals where strategy_id = p_strategy and created_at >= t0 - interval '1 minute' and not coalesce(hidden, false) order by id limit 500) g),
    'orders', (select coalesce(json_agg(o order by o.id), '[]') from (select id, purpose, side, qty, lots, state, limit_px, trigger_px, avg_px, filled_qty, ref_px, note,
             created_at, placed_at, done_at, steps, market_retry from public.live_orders where strategy_id = p_strategy and created_at >= t0 - interval '1 minute' order by id limit 500) o),
    'trades', (select coalesce(json_agg(t order by t.id), '[]') from (select id, side, lots, entry_px, exit_px, net, gross, costs, exit_at, exit_why
             from public.algo_trades where strategy_id = p_strategy and exit_at >= t0 and not coalesce(hidden, false) order by id) t),
    'bars', (select bars from public.algo_chart where strategy_id = p_strategy)
  ) into res;
  return res;
end $$;
revoke all on function public.position_life(uuid) from public, anon;
grant execute on function public.position_life(uuid) to authenticated;
