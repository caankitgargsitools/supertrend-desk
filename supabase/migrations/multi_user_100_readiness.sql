-- Migration 100 (13 Nov 2026, Papa after the first live orders: "create checks which should actually tell us before any
-- hazard happens"). "Ready to trade?" — a pre-flight check per account, Live and Paper apart. Everything that stopped or
-- endangered an order this week is a check: Dhan refusing orders for the address (asked from Dhan itself), a token made
-- before the address was registered, funds at Dhan against the lots planned, live strategies sized far beyond the live
-- capital (paper sizing carried over), an empty Delta wallet, no stop, data plan, breaker, engine not running, paper
-- equity below zero. readiness_check() runs it now for the caller (Home card "Check now"); readiness_cron() runs it
-- hourly for accounts with live strategies and tells the owner when a check newly turns red.

create table if not exists public.readiness_runs (
  id bigserial primary key,
  user_id uuid not null,
  at timestamptz not null default now(),
  live jsonb not null default '[]'::jsonb,
  paper jsonb not null default '[]'::jsonb,
  worst_live text not null default 'ok',
  worst_paper text not null default 'ok'
);
create index if not exists readiness_runs_user_idx on public.readiness_runs (user_id, id desc);
alter table public.readiness_runs enable row level security;
create policy readiness_runs_read on public.readiness_runs for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create or replace function public.readiness_compute(u uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  a public.broker_accounts; da public.broker_accounts; rs public.risk_state;
  lv jsonb := '[]'::jsonb; pp jsonb := '[]'::jsonb;
  r json; ip jsonb; fl jsonb; hrs numeric; iat bigint; pay text; tok_day date; set_day date; free numeric;
  n_live int; n_live_dhan int; n_live_cr int; n_paper int; eq numeric; lim numeric; used numeric;
  x record; names text; today date := (now() at time zone 'Asia/Kolkata')::date; ist time := (now() at time zone 'Asia/Kolkata')::time;
  dow int := extract(dow from (now() at time zone 'Asia/Kolkata'))::int; last_run timestamptz;
  function_ok boolean;
begin
  select * into a from public.broker_accounts where user_id = u and broker = 'DHAN';
  select * into da from public.broker_accounts where user_id = u and broker = 'DELTA';
  select * into rs from public.risk_state where user_id = u;
  select count(*) filter (where live), count(*) filter (where live and data_segment <> 'DELTA'), count(*) filter (where live and data_segment = 'DELTA'), count(*) filter (where not live)
    into n_live, n_live_dhan, n_live_cr, n_paper
    from public.algo_strategies where owner_id = u and not archived and not coalesce(is_master, false) and (active or position <> 'FLAT');

  ------------------------------------------------------------------ LIVE
  if n_live = 0 then
    lv := lv || jsonb_build_object('key', 'none', 'status', 'off', 'title', 'No live strategy', 'detail', 'Nothing trades real money right now.');
  else
    -- Dhan login
    if n_live_dhan > 0 then
      if a.access_token is null or a.access_token = '' then
        lv := lv || jsonb_build_object('key', 'token', 'status', 'fail', 'title', 'No Dhan access token', 'detail', 'Live orders can''t be sent.', 'fix', 'Connections › Dhan: paste an access token.');
      else
        hrs := extract(epoch from (a.token_expires_at - now())) / 3600;
        lv := lv || jsonb_build_object('key', 'token', 'title', 'Dhan access token',
          'status', case when hrs is null then 'warn' when hrs <= 0 then 'fail' when hrs < 3 then 'warn' else 'ok' end,
          'detail', case when hrs is null then 'Its end time isn''t known.' when hrs <= 0 then 'It has expired: every Dhan request is refused.' else 'Valid for ' || round(hrs)::text || ' h more (the desk renews it each day).' end,
          'fix', case when hrs is not null and hrs < 3 then 'Connections › Dhan: paste a new access token.' end);
        -- Does Dhan accept orders from the desk's address? Asked from Dhan itself.
        begin
          r := public.dhan_send(p_client := a.client_id, p_token := a.access_token, p_method := 'GET', p_path := '/v2/ip/getIP', p_body := null);
          if (r->>'status')::int = 200 then ip := (r->>'body')::jsonb; end if;
        exception when others then ip := null; end;
        if ip is null then
          lv := lv || jsonb_build_object('key', 'ip', 'status', 'warn', 'title', 'Dhan order permission not checked', 'detail', 'Dhan didn''t answer the address check just now.', 'fix', 'Press Check now again in a minute.');
        elsif coalesce(ip->>'ordersAllowed', 'false') = 'true' then
          lv := lv || jsonb_build_object('key', 'ip', 'status', 'ok', 'title', 'Dhan accepts orders from the desk', 'detail', 'Dhan sees the desk at its registered address (' || coalesce(ip->>'ipMatchStatus', 'match') || ').');
        else
          lv := lv || jsonb_build_object('key', 'ip', 'status', 'fail', 'title', 'Dhan refuses orders from the desk''s address',
            'detail', 'Dhan sees the desk at ' || coalesce(ip->>'detectedIP', '?') || ' but has ' || coalesce(ip->>'primaryIP', 'none') || ' and ' || coalesce(ip->>'secondaryIP', 'none') || ' registered. Every live order would be refused ("Invalid IP").',
            'fix', 'web.dhan.co › My Profile › Get Trading & Data APIs › Static IP: register the address Dhan sees (the next change is allowed from ' || coalesce(ip->>'modifyDateSecondary', ip->>'modifyDatePrimary', '?') || ').');
        end if;
        -- A token made before the address was registered is refused for orders until a new one is generated (13 Nov 2026).
        if ip is not null and coalesce(ip->>'ordersAllowed', 'false') = 'true' then
          begin
            pay := translate(split_part(a.access_token, '.', 2), '-_', '+/');
            iat := (convert_from(decode(rpad(pay, (4 * ceil(length(pay) / 4.0))::int, '='), 'base64'), 'utf8')::jsonb->>'iat')::bigint;
            tok_day := (to_timestamp(iat) at time zone 'Asia/Kolkata')::date;
            set_day := (case when ip->>'ipMatchStatus' ilike 'SECONDARY%' then ip->>'modifyDateSecondary' else ip->>'modifyDatePrimary' end)::date;
          exception when others then iat := null; end;
          if iat is not null and set_day is not null and set_day > date '2000-01-01' then
            if tok_day < set_day - 7 then
              lv := lv || jsonb_build_object('key', 'token_ip', 'status', 'fail', 'title', 'Dhan token is older than the registered address',
                'detail', 'The token was generated on ' || to_char(tok_day, 'DD Mon') || ', before the address was registered. Dhan refuses orders made with it ("Invalid IP") although the address matches.',
                'fix', 'web.dhan.co › Get Trading & Data APIs: generate a new access token and paste it under Connections › Dhan.');
            elsif tok_day <= set_day - 6 and not exists (select 1 from public.live_orders o where o.user_id = u and o.broker = 'DHAN' and o.broker_order_id is not null and o.created_at > to_timestamp(iat)) then
              lv := lv || jsonb_build_object('key', 'token_ip', 'status', 'warn', 'title', 'Token and address registered about the same day',
                'detail', 'No order has been accepted with this token yet. If the first one is refused with "Invalid IP", the token is from before the address was registered.',
                'fix', 'If that happens: generate a new access token at Dhan and paste it under Connections › Dhan.');
            else
              lv := lv || jsonb_build_object('key', 'token_ip', 'status', 'ok', 'title', 'Token is newer than the registered address', 'detail', 'Generated ' || to_char(tok_day, 'DD Mon') || '.');
            end if;
          end if;
        end if;
        -- Money at Dhan against the lots planned.
        begin
          r := public.dhan_send(p_client := a.client_id, p_token := a.access_token, p_method := 'GET', p_path := '/v2/fundlimit', p_body := null);
          if (r->>'status')::int = 200 then fl := (r->>'body')::jsonb; free := coalesce((fl->>'availabelBalance')::numeric, (fl->>'availableBalance')::numeric); end if;
        exception when others then free := null; end;
        if free is null then free := (a.funds->>'available')::numeric; end if;
        select count(*) n, count(*) filter (where m1 > free * 0.95) cant, count(*) filter (where m1 <= free * 0.95 and m1 * lots > free * 0.95) cut, min(m1) smallest,
               string_agg(nm, ', ' order by m1 desc) filter (where m1 > free * 0.95) cant_names
          into x from (
            select s.underlying || case when coalesce((s.rules->>'daily')::boolean, false) or s.timeframe_min = 1440 then ' Daily' else ' ' || s.timeframe_min || 'm' end nm, greatest(1, s.lots) lots,
                   lm.price * s.lot_size * coalesce(case when s.intraday or s.product_type = 'I' then lm.fut_pct_i end, lm.fut_pct, 0.15) m1
            from public.algo_strategies s join public.lab_margins lm on lm.asset = s.underlying
            where s.owner_id = u and s.live and s.active and not s.archived and s.data_segment <> 'DELTA' and s.trade_type = 'FUTURES' and lm.price > 0) q;
        if free is null then
          lv := lv || jsonb_build_object('key', 'funds', 'status', 'warn', 'title', 'Dhan funds not known', 'detail', 'The free balance couldn''t be read.', 'fix', 'Capital › Refresh Dhan funds.');
        elsif coalesce(x.n, 0) = 0 then
          lv := lv || jsonb_build_object('key', 'funds', 'status', 'ok', 'title', 'Dhan free funds ' || public.inr(free), 'detail', 'No futures strategy to compare with.');
        elsif x.cant = x.n then
          lv := lv || jsonb_build_object('key', 'funds', 'status', 'fail', 'title', 'Dhan free funds ' || public.inr(free) || ': no live strategy can enter',
            'detail', 'Even one lot of the smallest contract needs about ' || public.inr(x.smallest) || ' of margin. Every entry would be skipped.', 'fix', 'Add funds at Dhan, or go live only with contracts that fit.');
        elsif x.cant > 0 or x.cut > 0 then
          lv := lv || jsonb_build_object('key', 'funds', 'status', 'warn', 'title', 'Dhan free funds ' || public.inr(free) || ' cover only some strategies',
            'detail', x.cant || ' of ' || x.n || ' live strategies need more than that for ONE lot (' || left(coalesce(x.cant_names, ''), 160) || '); ' || x.cut || ' more would be cut below their planned lots. Whichever signals first takes the money.',
            'fix', 'Add funds at Dhan, or pause the contracts that are too big for this account.');
        else
          lv := lv || jsonb_build_object('key', 'funds', 'status', 'ok', 'title', 'Dhan free funds ' || public.inr(free), 'detail', 'Each live strategy''s planned lots fit on their own (not all at once).');
        end if;
        -- Data plan
        lv := lv || jsonb_build_object('key', 'data', 'title', 'Dhan Data API plan',
          'status', case when a.data_plan is not null and a.data_plan not ilike 'active%' then 'fail' when a.data_valid_until is not null and a.data_valid_until - today <= 3 then 'warn' else 'ok' end,
          'detail', case when a.data_plan is not null and a.data_plan not ilike 'active%' then 'The plan is ' || a.data_plan || ': prices and candles stop.' when a.data_valid_until is not null then 'Valid until ' || to_char(a.data_valid_until, 'DD Mon') || '.' else 'Active.' end,
          'fix', case when (a.data_plan is not null and a.data_plan not ilike 'active%') or (a.data_valid_until is not null and a.data_valid_until - today <= 3) then 'Renew the Data API plan at Dhan.' end);
      end if;
    end if;
    -- Live lots against the live capital: paper sizing carried into live is the hazard this catches.
    eq := coalesce(a.capital, 0) + coalesce(public.ledger_net_user(u, 'LIVE', a.capital_since), 0);
    lim := eq * coalesce(a.deploy_pct, 100) / 100;
    if coalesce(a.capital, 0) <= 0 then
      lv := lv || jsonb_build_object('key', 'capital', 'status', 'warn', 'title', 'No live capital set', 'detail', 'Without it the "Never use more than" limit isn''t applied to live entries.', 'fix', 'Capital › Live: enter your live trading capital.');
    else
      select count(*) n, count(*) filter (where dayrs > eq * 0.25) huge, count(*) filter (where m1 > lim) never, count(*) filter (where m1 <= lim and m1 * lots > lim) cut,
             string_agg(nm || ' (' || lots || ' lots ≈ ' || public.inr(dayrs) || ' a day)', ', ' order by dayrs desc) filter (where dayrs > eq * 0.25) huge_names,
             string_agg(nm, ', ' order by m1 desc) filter (where m1 > lim) never_names
        into x from (
          select s.underlying || case when coalesce((s.rules->>'daily')::boolean, false) or s.timeframe_min = 1440 then ' Daily' else ' ' || s.timeframe_min || 'm' end nm,
                 least(greatest(1, s.lots), case when s.sizing->>'mode' = 'MOVE' and coalesce((s.sizing->>'max_lots')::int, 0) > 0 then (s.sizing->>'max_lots')::int else 1000000 end) lots,
                 lm.price * s.lot_size * coalesce(lm.fut_pct, 0.15) m1,
                 least(greatest(1, s.lots), case when s.sizing->>'mode' = 'MOVE' and coalesce((s.sizing->>'max_lots')::int, 0) > 0 then (s.sizing->>'max_lots')::int else 1000000 end) * lm.price * s.lot_size * coalesce(lm.day_move, 0.015) dayrs
          from public.algo_strategies s join public.lab_margins lm on lm.asset = s.underlying
          where s.owner_id = u and s.live and s.active and not s.archived and s.trade_type = 'FUTURES' and lm.price > 0) q;
      if coalesce(x.huge, 0) > 0 then
        lv := lv || jsonb_build_object('key', 'sizing', 'status', 'fail', 'title', x.huge || ' live strateg' || case when x.huge = 1 then 'y is' else 'ies are' end || ' sized far beyond your live capital',
          'detail', 'On a normal day their planned lots move more than a quarter of your ' || public.inr(eq) || ' live capital: ' || left(x.huge_names, 220) || '. This is usually paper sizing carried into live.',
          'fix', 'Capital › Live › Lots wizard: Autofill (or type the lots) and Apply, before these take a signal.');
      elsif coalesce(x.never, 0) > 0 or coalesce(x.cut, 0) > 0 then
        lv := lv || jsonb_build_object('key', 'sizing', 'status', 'warn', 'title', 'Some live lots don''t fit your limit of ' || public.inr(lim),
          'detail', coalesce(x.never, 0) || ' need more than the limit for one lot and can never enter (' || left(coalesce(x.never_names, '–'), 160) || '); ' || coalesce(x.cut, 0) || ' would be cut below their planned lots.',
          'fix', 'Capital › Live › Lots wizard, or pause the contracts too big for this capital.');
      else
        lv := lv || jsonb_build_object('key', 'sizing', 'status', 'ok', 'title', 'Live lots fit the live capital', 'detail', coalesce(x.n, 0) || ' futures strategies checked against ' || public.inr(eq) || ' (limit ' || public.inr(lim) || ').');
      end if;
    end if;
    -- Delta
    if n_live_cr > 0 then
      lv := lv || jsonb_build_object('key', 'delta', 'title', 'Delta Exchange (crypto)',
        'status', case when da.access_token is null or da.access_token = '' then 'fail' when da.token_note ilike '%USD 0.00%' then 'fail' else 'ok' end,
        'detail', case when da.access_token is null or da.access_token = '' then n_live_cr || ' live crypto strategies but no Delta API key.' when da.token_note ilike '%USD 0.00%' then n_live_cr || ' live crypto strategies, and the Delta wallet showed 0 at the last check (' || coalesce(to_char(da.token_checked_at at time zone 'Asia/Kolkata', 'DD Mon'), '?') || '): every order is refused for margin.' else coalesce(da.token_note, 'Key connected.') end,
        'fix', case when da.access_token is null or da.access_token = '' then 'Connections › Delta Exchange: add the API key.' when da.token_note ilike '%USD 0.00%' then 'Add funds at Delta (then Connections › Delta › Check), or switch the crypto strategies back to paper.' end);
    end if;
    -- Stops
    select count(*) n, count(*) filter (where not (coalesce(risk->'sl'->>'type', 'OFF') not in ('OFF', '') or coalesce(risk->'trail'->>'type', 'OFF') not in ('OFF', ''))) bare
      into x from public.algo_strategies where owner_id = u and live and active and not archived;
    if x.bare > 0 then
      lv := lv || jsonb_build_object('key', 'stops', 'status', 'warn', 'title', x.bare || ' of ' || x.n || ' live strategies have no stop-loss',
        'detail', 'They exit only on their rules at a candle close; nothing caps a move in between and no stop order rests at the broker.', 'fix', 'Add a stop-loss or trailing stop in each strategy''s settings if you want one.');
    else
      lv := lv || jsonb_build_object('key', 'stops', 'status', 'ok', 'title', 'Every live strategy has a stop', 'detail', x.n || ' checked.');
    end if;
    -- Stopped or stuck
    if rs.halted_at is not null then
      lv := lv || jsonb_build_object('key', 'breaker', 'status', 'fail', 'title', 'New live trades are stopped (error breaker)', 'detail', left(coalesce(rs.halt_reason, ''), 200), 'fix', 'Fix the cause, then "Allow new live trades again" at the top of the page.');
    end if;
    select count(*) n, string_agg(underlying, ', ') names into x from public.algo_strategies where owner_id = u and live and not archived and position <> 'FLAT' and exec_state = 'exit_retry';
    if x.n > 0 then
      lv := lv || jsonb_build_object('key', 'exit_retry', 'status', 'fail', 'title', x.n || ' live exit' || case when x.n = 1 then ' is' else 's are' end || ' being retried', 'detail', 'The broker refused the exit of ' || x.names || '; the desk tries again every minute. The position is still open.', 'fix', 'Check the position at the broker; close it there if the retries keep failing.');
    end if;
    select count(*) n, string_agg(underlying, ', ') names into x from public.algo_strategies where owner_id = u and live and not archived and not active and last_error is not null and last_run_at > now() - interval '3 days';
    if x.n > 0 then
      lv := lv || jsonb_build_object('key', 'paused', 'status', 'warn', 'title', x.n || ' live strateg' || case when x.n = 1 then 'y is' else 'ies are' end || ' paused with an error', 'detail', left(x.names, 200), 'fix', 'Open each one, read the error, then activate it again.');
    end if;
  end if;

  ------------------------------------------------------------------ PAPER
  if n_paper = 0 then
    pp := pp || jsonb_build_object('key', 'none', 'status', 'off', 'title', 'No paper strategy', 'detail', '');
  else
    eq := coalesce(a.paper_capital, 0) + coalesce(public.ledger_net_user(u, 'PAPER', a.paper_since), 0);
    lim := eq * coalesce(a.paper_deploy_pct, 100) / 100;
    select coalesce(sum(pos_margin), 0) into used from public.algo_strategies where owner_id = u and not live and not archived and position <> 'FLAT';
    if coalesce(a.paper_capital, 0) <= 0 then
      pp := pp || jsonb_build_object('key', 'capital', 'status', 'warn', 'title', 'No paper capital set', 'detail', 'The limit isn''t applied to paper entries.', 'fix', 'Capital › Paper: enter a paper capital.');
    elsif eq <= 0 then
      pp := pp || jsonb_build_object('key', 'capital', 'status', 'fail', 'title', 'Paper capital after losses is ' || public.inr(eq),
        'detail', 'With nothing left under the limit, every new paper entry is skipped.', 'fix', 'Capital › Paper: raise the capital, or set "Count profits & losses from" to start fresh.');
    elsif used > lim then
      pp := pp || jsonb_build_object('key', 'capital', 'status', 'warn', 'title', 'Paper margin in use is above the limit',
        'detail', public.inr(used) || ' in use against a limit of ' || public.inr(lim) || ': new paper entries wait until positions close.', 'fix', 'Capital › Paper: raise the capital or the limit, or lower the lots (Lots wizard › Autofill).');
    else
      pp := pp || jsonb_build_object('key', 'capital', 'status', 'ok', 'title', 'Paper capital has room', 'detail', public.inr(used) || ' of ' || public.inr(lim) || ' in use.');
    end if;
    if rs.paper_halted_at is not null then
      pp := pp || jsonb_build_object('key', 'breaker', 'status', 'fail', 'title', 'New paper trades are stopped (error breaker)', 'detail', left(coalesce(rs.paper_halt_reason, ''), 200), 'fix', '"Allow new paper trades again" at the top of the page.');
    end if;
    select count(*) n into x from public.algo_strategies where owner_id = u and not live and active and not archived and last_error is not null;
    if x.n > 0 then
      pp := pp || jsonb_build_object('key', 'errors', 'status', 'warn', 'title', x.n || ' paper strateg' || case when x.n = 1 then 'y shows' else 'ies show' end || ' an error', 'detail', 'Their last run failed.', 'fix', 'Open them from the Strategies list (Needs attention).');
    end if;
  end if;

  ------------------------------------------------------------------ the engine itself (both modes)
  select max(last_run_at) into last_run from public.algo_strategies where owner_id = u and active and not archived;
  function_ok := last_run is null or last_run > now() - interval '10 minutes'
    or not (exists (select 1 from public.algo_strategies where owner_id = u and active and not archived and data_segment = 'DELTA')
            or (dow between 1 and 5 and ist between time '09:20' and time '23:25'));
  if not function_ok then
    lv := lv || jsonb_build_object('key', 'engine', 'status', 'fail', 'title', 'The engine hasn''t run your strategies for ' || round(extract(epoch from (now() - last_run)) / 60) || ' minutes',
      'detail', 'Signals, stops and exits are not being worked.', 'fix', 'System health shows which part stopped; tell the admin.');
    pp := pp || jsonb_build_object('key', 'engine', 'status', 'fail', 'title', 'The engine hasn''t run your strategies for ' || round(extract(epoch from (now() - last_run)) / 60) || ' minutes', 'detail', 'Signals, stops and exits are not being worked.');
  end if;

  return jsonb_build_object('at', now(), 'live', lv, 'paper', pp,
    'worst_live', coalesce((select case when bool_or(e->>'status' = 'fail') then 'fail' when bool_or(e->>'status' = 'warn') then 'warn' when bool_and(e->>'status' = 'off') then 'off' else 'ok' end from jsonb_array_elements(lv) e), 'ok'),
    'worst_paper', coalesce((select case when bool_or(e->>'status' = 'fail') then 'fail' when bool_or(e->>'status' = 'warn') then 'warn' when bool_and(e->>'status' = 'off') then 'off' else 'ok' end from jsonb_array_elements(pp) e), 'ok'));
end $$;
revoke execute on function public.readiness_compute(uuid) from public, anon, authenticated;

-- Run it now for the signed-in user (at most every 20 seconds; otherwise the last result) and keep the result.
create or replace function public.readiness_check() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare u uuid := auth.uid(); j jsonb; last public.readiness_runs;
begin
  if u is null then raise exception 'Sign in first.'; end if;
  select * into last from public.readiness_runs where user_id = u order by id desc limit 1;
  if last.id is not null and last.at > now() - interval '20 seconds' then
    return jsonb_build_object('at', last.at, 'live', last.live, 'paper', last.paper, 'worst_live', last.worst_live, 'worst_paper', last.worst_paper);
  end if;
  j := public.readiness_compute(u);
  insert into public.readiness_runs (user_id, live, paper, worst_live, worst_paper) values (u, j->'live', j->'paper', j->>'worst_live', j->>'worst_paper');
  return j;
end $$;
revoke execute on function public.readiness_check() from public, anon;
grant execute on function public.readiness_check() to authenticated;

-- The last stored result (fast; the Home card reads this on every load).
create or replace function public.readiness_latest() returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('at', r.at, 'live', r.live, 'paper', r.paper, 'worst_live', r.worst_live, 'worst_paper', r.worst_paper)
    from public.readiness_runs r where r.user_id = auth.uid() order by r.id desc limit 1;
$$;
revoke execute on function public.readiness_latest() from public, anon;
grant execute on function public.readiness_latest() to authenticated;

-- Hourly, for every account with a live strategy: run, keep, and tell the owner about each LIVE check that is newly red.
create or replace function public.readiness_cron() returns int
language plpgsql security definer set search_path to 'public' as $$
declare u uuid; j jsonb; prev public.readiness_runs; e jsonb; n int := 0;
begin
  for u in select distinct owner_id from public.algo_strategies where live and not archived and not coalesce(is_master, false) and (active or position <> 'FLAT') and owner_id is not null loop
    begin
      select * into prev from public.readiness_runs where user_id = u order by id desc limit 1;
      j := public.readiness_compute(u);
      insert into public.readiness_runs (user_id, live, paper, worst_live, worst_paper) values (u, j->'live', j->'paper', j->>'worst_live', j->>'worst_paper');
      for e in select * from jsonb_array_elements(j->'live') loop
        if e->>'status' = 'fail' and not exists (select 1 from jsonb_array_elements(coalesce(prev.live, '[]'::jsonb)) p where p->>'key' = e->>'key' and p->>'status' = 'fail') then
          perform public.notify_tagged(u, 'error', left('Check before trading: ' || (e->>'title'), 120), left(coalesce(e->>'detail', '') || coalesce(' → ' || (e->>'fix'), ''), 400), '/?home=1', null,
            'ready-' || (e->>'key') || '-' || u || '-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYYMMDD'));
          n := n + 1;
        end if;
      end loop;
    exception when others then raise warning 'readiness % : %', u, sqlerrm; end;
  end loop;
  -- keep a fortnight of history
  return n;
end $$;
revoke execute on function public.readiness_cron() from public, anon, authenticated;

select cron.schedule('readiness-check', '23 * * * *', $c$select public.readiness_cron()$c$);
