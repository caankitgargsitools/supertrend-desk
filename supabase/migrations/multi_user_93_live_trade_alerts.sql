-- 12 Nov 2026 (Papa chose A + B + C + D): live trades get their own notification, unlike paper.
-- A: kind 'live_trade', a trade-slip title ("🟢 LIVE BUY · GOLDM · 2 lots @ ₹1,37,010"), its own strong vibration, stays
--    on screen until tapped (sw.js), urgency high; the facts travel in notifications.meta (side, asset, lots, prices,
--    stop, target, ₹ at risk, margin, stage) so the phone can draw the position bar and the app its full-screen alert.
-- B: ONE notification per live entry that changes in place — signal sent → filled → stop placed at the broker — and one
--    per exit — sending → closed with P&L → confirmed with the broker's fills. live_note() inserts a new row (p_new) or
--    updates the latest row with the same tag and sets pushed_at = null so the pusher sends it again (same tag on the phone
--    replaces it; meta.quiet = update without a sound).
-- D: paper trades stay kind 'trade' and are shown silently by sw.js (no sound, no vibration).
alter table public.notifications add column if not exists meta jsonb;

create or replace function public.live_note(p_user uuid, p_sid uuid, p_tag text, p_new boolean, p_title text, p_body text, p_meta jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if p_user is null then return null; end if;
  if not p_new then
    select id into nid from public.notifications where user_id = p_user and tag = p_tag and kind = 'live_trade'
      and created_at > now() - interval '6 hours' order by id desc limit 1;
  end if;
  if nid is null then
    insert into public.notifications (user_id, kind, title, body, url, strategy_id, tag, meta)
    values (p_user, 'live_trade', left(p_title, 120), left(p_body, 400), case when p_sid is null then '/?home=1' else '/?s=' || p_sid end, p_sid, p_tag,
            coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('at', now()))
    returning id into nid;
  else
    update public.notifications set title = left(p_title, 120), body = left(p_body, 400), pushed_at = null, read_at = null, push_note = null,
      meta = coalesce(meta, '{}'::jsonb) || coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('at', now())
    where id = nid;
  end if;
  if exists (select 1 from public.push_subs where user_id = p_user) then perform public.engine_call('push'); end if;
  return nid;
exception when others then return null;
end $$;
revoke all on function public.live_note(uuid, uuid, text, boolean, text, text, jsonb) from public, anon, authenticated;

-- The text of one live position: "🟢 LIVE BUY · GOLDM · 2 lots @ ₹1,37,010" and "Stop ₹1,35,000 · Target ₹1,40,000 · …".
create or replace function public.live_px(v numeric) returns text language sql immutable as $$
  select case when v is null then '–' when abs(v) >= 1000 then public.inr(v) || case when v <> trunc(v) then '.' || lpad((round((abs(v) - trunc(abs(v))) * 100))::int::text, 2, '0') else '' end
              else '₹' || trim(to_char(v, 'FM999990.0099')) end $$;

create or replace function public.trg_signal_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare s record; ev text := upper(coalesce(new.event, '')); t text; k text := 'trade'; side text;
begin
  select id, name, owner_id, is_master, underlying, lots into s from public.algo_strategies where id = new.strategy_id;
  if not found or coalesce(s.is_master, false) then return new; end if;
  if ev = 'INFO' and not (new.description ilike '%skipped%' or new.description ilike '%blocked%' or new.description ilike '%not enough%') then return new; end if;
  -- Live entries and exits: the one notification that follows the trade (live_note).
  if new.mode = 'LIVE' and new.status is distinct from 'FAILED' and ev in ('ENTRY', 'REVERSE') then
    side := case when new.description ~* '\msell rules met' or new.description ~* ': *sell\M' then 'SELL'
                 when new.description ~* '\mbuy rules met' or new.description ~* ': *buy\M' then 'BUY' else null end;
    perform public.live_note(s.owner_id, s.id, 'le-' || s.id, true,
      '⚡ LIVE ' || coalesce(side, 'ENTRY') || ' · ' || s.underlying || ' · ' || s.lots || ' lot' || case when s.lots = 1 then '' else 's' end || ' · sending to the broker',
      'Signal at ' || public.live_px(new.close) || '. Order is going to the broker now; you''ll see the fill here.',
      jsonb_build_object('live', true, 'stage', 'sent', 'side', side, 'asset', s.underlying, 'name', s.name, 'lots', s.lots, 'px', new.close, 'sid', s.id));
    return new;
  end if;
  if new.mode = 'LIVE' and new.status is distinct from 'FAILED' and ev in ('EXIT', 'FLATTEN', 'STOP_LOSS', 'TRAIL_STOP', 'TARGET', 'SQUARE_OFF') then
    perform public.live_note(s.owner_id, s.id, 'lx-' || s.id, true,
      '⏳ LIVE EXIT · ' || s.underlying || ' · closing at the broker',
      initcap(replace(lower(ev), '_', ' ')) || ' at ' || public.live_px(new.close) || '. The P&L follows here once it is booked.',
      jsonb_build_object('live', true, 'stage', 'exiting', 'asset', s.underlying, 'name', s.name, 'px', new.close, 'sid', s.id, 'why', ev, 'quiet', true));
    return new;
  end if;
  if new.status = 'FAILED' then k := 'error'; elsif new.mode = 'LIVE' then k := 'live_trade'; end if;
  t := case when new.status = 'FAILED' then 'Order failed' when ev = 'ENTRY' then 'New position' when ev in ('EXIT', 'FLATTEN') then 'Position closed'
            when ev = 'INFO' then 'Entry skipped' else initcap(replace(lower(ev), '_', ' ')) end
       || case when new.mode = 'LIVE' then ' (live)' else ' (paper)' end;
  if k = 'live_trade' then
    perform public.live_note(s.owner_id, s.id, 'lo-' || new.id, true, t || ' · ' || left(s.name, 60), new.description, jsonb_build_object('live', true, 'stage', 'note', 'asset', s.underlying, 'sid', s.id));
  else
    perform public.notify_tagged(s.owner_id, k, t || ' · ' || left(s.name, 60), new.description, '/?s=' || s.id, s.id,
      case when ev in ('EXIT', 'FLATTEN') then 'exit-' || s.id else null end);
  end if;
  return new;
end $$;

-- Filled and stop placed: the strategy row is where both brokers record them (pos_broker.fill, pos_broker.stopId).
create or replace function public.trg_live_pos_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare side text; fill numeric; stop numeric; tgt numeric; risk numeric; units numeric; b text; m jsonb;
begin
  if not new.live or coalesce(new.is_master, false) or new.position = 'FLAT' then return new; end if;
  side := case when new.position = 'LONG' then 'BUY' else 'SELL' end;
  fill := coalesce((new.pos_broker->>'fill')::numeric, new.pos_entry_px);
  stop := public.eff_stop(new.pos_risk); tgt := (new.pos_risk->>'tgt')::numeric;
  units := coalesce(new.pos_lots, new.lots, 0) * coalesce(new.lot_size, 1);
  risk := case when stop is not null and fill is not null then abs(fill - stop) * units end;
  m := jsonb_build_object('live', true, 'side', side, 'asset', new.underlying, 'name', new.name, 'lots', new.pos_lots, 'fill', fill, 'stop', stop, 'tgt', tgt,
                          'risk', risk, 'margin', new.pos_margin, 'units', units, 'sid', new.id, 'dir', case when new.position = 'LONG' then 1 else -1 end);
  b := 'Stop ' || public.live_px(stop) || ' · Target ' || public.live_px(tgt) || coalesce(' · at risk ' || public.inr(risk), '') || coalesce(' · margin ' || public.inr(new.pos_margin), '');
  if (old.position is distinct from new.position) or ((new.pos_broker->>'fill') is distinct from (old.pos_broker->>'fill') and new.pos_broker->>'fill' is not null) then
    perform public.live_note(new.owner_id, new.id, 'le-' || new.id, false,
      case when side = 'BUY' then '🟢' else '🔻' end || ' LIVE ' || side || ' · ' || new.underlying || ' · ' || coalesce(new.pos_lots, new.lots) || ' lot' || case when coalesce(new.pos_lots, new.lots) = 1 then '' else 's' end || ' @ ' || public.live_px(fill),
      'Filled. ' || b, m || jsonb_build_object('stage', 'filled', 'quiet', true));
  elsif (new.pos_broker->>'stopId') is not null and (old.pos_broker->>'stopId') is distinct from (new.pos_broker->>'stopId') and (old.pos_broker->>'stopId') is null then
    perform public.live_note(new.owner_id, new.id, 'le-' || new.id, false,
      case when side = 'BUY' then '🟢' else '🔻' end || ' LIVE ' || side || ' · ' || new.underlying || ' · ' || coalesce(new.pos_lots, new.lots) || ' lot' || case when coalesce(new.pos_lots, new.lots) = 1 then '' else 's' end || ' @ ' || public.live_px(fill),
      'Filled · stop placed at the broker ✓ (trigger ' || public.live_px((new.pos_broker->>'stopTrig')::numeric) || '). ' || b,
      m || jsonb_build_object('stage', 'stop', 'stop_trig', (new.pos_broker->>'stopTrig')::numeric, 'quiet', true));
  end if;
  return new;
-- A notification must never stop the engine's write of the position.
exception when others then return new;
end $$;
create or replace trigger live_pos_notify after update of position, pos_broker on public.algo_strategies
  for each row when (new.live) execute function public.trg_live_pos_notify();

-- An entry order the broker refused: the entry notification says so (the error notification has the details).
create or replace function public.trg_live_order_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.purpose = 'entry' and new.state in ('failed', 'cancelled', 'rejected') and old.state is distinct from new.state and coalesce(new.filled_qty, 0) = 0 then
    perform public.live_note(new.user_id, new.strategy_id, 'le-' || new.strategy_id, false,
      '❌ LIVE entry not filled · ' || coalesce((select underlying from public.algo_strategies where id = new.strategy_id), ''),
      'The broker did not fill the entry' || coalesce(': ' || nullif(new.note, ''), '') || '. No position was opened.',
      jsonb_build_object('live', true, 'stage', 'failed', 'quiet', false));
  end if;
  return new;
end $$;
create or replace trigger live_order_notify after update of state on public.live_orders for each row execute function public.trg_live_order_notify();

create or replace function public.trg_trade_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare s record; u uuid; ent timestamptz; held text; pct numeric; today numeric; ttl text; bd text;
begin
  select id, name, owner_id, is_master, underlying into s from public.algo_strategies where id = new.strategy_id;
  if not found or coalesce(s.is_master, false) then return new; end if;
  u := coalesce(new.user_id, s.owner_id);
  if new.mode = 'LIVE' and not coalesce(new.hidden, false) then
    select created_at into ent from public.notifications where user_id = u and tag = 'le-' || s.id and created_at > now() - interval '30 days' order by id desc limit 1;
    held := case when ent is null then null
                 when now() - ent < interval '1 hour' then extract(minute from now() - ent)::int || ' min'
                 when now() - ent < interval '2 days' then floor(extract(epoch from now() - ent) / 3600)::int || ' h ' || (extract(minute from now() - ent))::int || ' min'
                 else floor(extract(epoch from now() - ent) / 86400)::int || ' days' end;
    pct := case when new.entry_px > 0 and new.exit_px is not null then (new.exit_px - new.entry_px) / new.entry_px * 100 * case when upper(coalesce(new.side, '')) in ('SHORT', 'SELL') then -1 else 1 end end;
    select coalesce(sum(net), 0) into today from public.algo_trades where mode = 'LIVE' and not coalesce(hidden, false) and (user_id = u or (user_id is null and strategy_id in (select id from public.algo_strategies where owner_id = u)))
      and (exit_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date;
    ttl := case when new.net >= 0 then '💰' else '🔴' end || ' LIVE EXIT · ' || s.underlying || ' · ' || case when new.net >= 0 then '+' else '' end || public.inr(new.net)
           || coalesce(' (' || case when pct >= 0 then '+' else '' end || to_char(pct, 'FM9990.0') || '%)', '');
    bd := coalesce('Held ' || held || ' · ', '') || 'today ' || case when today >= 0 then '+' else '' end || public.inr(today)
          || coalesce(' · ' || nullif(new.exit_why, ''), '') || case when coalesce(new.provisional, false) then ' · estimate until the broker''s fills arrive' else '' end;
    perform public.live_note(u, s.id, 'lx-' || s.id, false, ttl, bd,
      jsonb_build_object('live', true, 'stage', 'closed', 'asset', s.underlying, 'name', s.name, 'net', new.net, 'pct', pct, 'held', held, 'today', today,
                         'entry', new.entry_px, 'exit', new.exit_px, 'lots', new.lots, 'side', new.side, 'quiet', false));
    return new;
  end if;
  perform public.notify_tagged(u, 'trade',
    'Position closed ' || case when new.mode = 'LIVE' then '(live)' else '(paper)' end || ': ' || public.inr(new.net) || ' · ' || left(s.name, 50),
    'Net ' || public.inr(new.net) || ' after charges' || coalesce(' · ' || new.contract, '') || coalesce(' · ' || new.lots || ' lot' || case when new.lots = 1 then '' else 's' end, '')
      || coalesce(' · ' || nullif(new.exit_why, ''), ''),
    '/?s=' || s.id, s.id, 'exit-' || s.id);
  return new;
end $$;

-- A provisional live exit confirmed with the broker's fills: the same exit notification shows the confirmed P&L, quietly.
create or replace function public.trg_trade_confirm_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare s record;
begin
  if new.mode <> 'LIVE' or coalesce(new.hidden, false) or not coalesce(old.provisional, false) or coalesce(new.provisional, false) then return new; end if;
  select underlying into s from public.algo_strategies where id = new.strategy_id;
  perform public.live_note(new.user_id, new.strategy_id, 'lx-' || new.strategy_id, false,
    case when new.net >= 0 then '💰' else '🔴' end || ' LIVE EXIT · ' || coalesce(s.underlying, '') || ' · ' || case when new.net >= 0 then '+' else '' end || public.inr(new.net) || ' ✓',
    'Confirmed with the broker''s fills: net ' || public.inr(new.net) || ' after charges' || coalesce(' · exit ' || public.live_px(new.exit_px), ''),
    jsonb_build_object('stage', 'confirmed', 'net', new.net, 'exit', new.exit_px, 'quiet', true));
  return new;
end $$;
create or replace trigger trade_confirm_notify after update of provisional on public.algo_trades for each row execute function public.trg_trade_confirm_notify();

-- The test button (Connections › Phone notifications): a sample live trade in four steps, marked TEST — only a notification
-- row; no strategy, order or trade is touched. Stage 1 at most once a minute.
create or replace function public.notify_live_test(p_stage int)
returns void language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); m jsonb := jsonb_build_object('live', true, 'test', true, 'side', 'BUY', 'asset', 'GOLDM', 'name', 'TEST · Gold Mini', 'lots', 2,
  'px', 137010, 'fill', 137020, 'stop', 135650, 'tgt', 140450, 'units', 20, 'risk', 27400, 'margin', 25350, 'dir', 1, 'now', 137020);
begin
  if u is null then raise exception 'Sign in first.'; end if;
  if p_stage = 1 then
    if exists (select 1 from public.notifications where user_id = u and tag = 'lt-test' and created_at > now() - interval '1 minute') then
      raise exception 'A test was sent less than a minute ago. Try again in a minute.';
    end if;
    perform public.live_note(u, null, 'lt-test', true, 'TEST ⚡ LIVE BUY · GOLDM · 2 lots · sending to the broker',
      'TEST — signal at ₹1,37,010. Order is going to the broker now; you''ll see the fill here.', m || jsonb_build_object('stage', 'sent'));
  elsif p_stage = 2 then
    perform public.live_note(u, null, 'lt-test', false, 'TEST 🟢 LIVE BUY · GOLDM · 2 lots @ ₹1,37,020',
      'TEST — filled (₹10 slippage). Stop ₹1,35,650 · Target ₹1,40,450 · at risk ₹27,400 · margin ₹25,350', m || jsonb_build_object('stage', 'filled', 'quiet', true));
  elsif p_stage = 3 then
    perform public.live_note(u, null, 'lt-test', false, 'TEST 🟢 LIVE BUY · GOLDM · 2 lots @ ₹1,37,020',
      'TEST — filled · stop placed at the broker ✓ (trigger ₹1,35,650). Target ₹1,40,450 · at risk ₹27,400', m || jsonb_build_object('stage', 'stop', 'stop_trig', 135650, 'now', 137380, 'quiet', true));
  elsif p_stage = 4 then
    perform public.live_note(u, null, 'lx-test', true, 'TEST 💰 LIVE EXIT · GOLDM · +₹8,450 (+0.6%)',
      'TEST — held 3 h 20 min · today +₹12,300 · Target', jsonb_build_object('live', true, 'test', true, 'stage', 'closed', 'asset', 'GOLDM', 'name', 'TEST · Gold Mini',
        'net', 8450, 'pct', 0.6, 'held', '3 h 20 min', 'today', 12300, 'entry', 137020, 'exit', 137865, 'lots', 2, 'side', 'BUY'));
  end if;
end $$;
revoke all on function public.notify_live_test(int) from public, anon;
grant execute on function public.notify_live_test(int) to authenticated;
