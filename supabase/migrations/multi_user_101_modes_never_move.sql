-- 13 Nov 2026 (Papa: "paper and live are different. So even if I make any strategy live, that doesn't mean that you pick
-- it out from paper and put it to live. If I specifically remove it from paper, then only remove it from paper.")
-- Until now a FLAT paper strategy that went live was switched (it left Paper); only one holding a position got a
-- separate live copy (migration 92). Now going live NEVER touches the paper strategy: a separate live copy is made
-- (flat, trades from its own next signal), or, when the strategy already has a live copy, nothing is made and that copy
-- is named. "Switch to paper" on a live strategy never makes a second paper twin: with a paper copy already there the
-- live one is only paused (its position, if any, keeps its stops and exits); without one, a flat live strategy becomes
-- the paper one and one holding a position gets a paper copy, as before.
-- A copy is recognised by the name without its "(live)" / "(paper)" tag, for the same owner, asset, kind of trade and lab result
-- (no link column: the two stay independent rows).

create or replace function public.mode_key(p_name text) returns text language sql immutable as
$$ select btrim(regexp_replace(coalesce(p_name, ''), '\s*\((live|paper)\)', '', 'gi')) $$;

/** The strategy's separate copy in the other mode (not archived): a running one first, then the newest. */
create or replace function public.mode_twin(p_strategy uuid, p_live boolean) returns uuid
language sql stable security definer set search_path = public as $$
  select t.id from public.algo_strategies s
  join public.algo_strategies t on t.owner_id = s.owner_id and t.id <> s.id and t.live = p_live and not coalesce(t.archived, false)
    and public.mode_key(t.name) = public.mode_key(s.name) and t.underlying is not distinct from s.underlying and t.trade_type is not distinct from s.trade_type
    and t.lab_id is not distinct from s.lab_id
  where s.id = p_strategy
  order by t.active desc, t.created_at desc limit 1
$$;
revoke execute on function public.mode_twin(uuid, boolean) from public, anon, authenticated;

-- The copy's name carries one tag only ("Lab #5 (paper) · …" going live becomes "Lab #5 (live) · …").
create or replace function public.mode_copy(p_strategy uuid, p_live boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.algo_strategies; j jsonb; k text; nid uuid := gen_random_uuid();
begin
  select * into s from public.algo_strategies where id = p_strategy;
  j := to_jsonb(s);
  for k in select jsonb_object_keys(j) loop
    if k like 'pos\_%' or k like 'pending\_%' or k in ('day_pnl', 'day_pnl_date', 'exec_state', 'exec_at', 'last_error', 'kill_at', 'kill_note',
      'kill_override_trades', 'ca_day', 'switch_to', 'catch_up', 'catch_note', 'last_entry_day', 'deploy_paid_until', 'archived_at') then j := j || jsonb_build_object(k, null); end if;
  end loop;
  j := j || jsonb_build_object('id', nid, 'created_at', now(), 'updated_at', now(), 'position', 'FLAT', 'live', p_live, 'archived', false, 'pos_catchup', false,
    'live_since', case when p_live then now() else null end,
    'name', regexp_replace(public.mode_key(s.name), '^(.*?)( · |$)', '\1 (' || case when p_live then 'live' else 'paper' end || ')\2'));
  perform set_config('app.bypass', 'on', true);
  insert into public.algo_strategies select * from jsonb_populate_record(null::public.algo_strategies, j);
  return nid;
end $$;
revoke execute on function public.mode_copy(uuid, boolean) from public, anon, authenticated;

create or replace function public.set_live(p_strategy uuid, p_live boolean)
 returns json language plpgsql security definer set search_path to 'public' as $function$
declare s public.algo_strategies; b json; fee numeric; paid date; today date := (now() at time zone 'Asia/Kolkata')::date; e json; nid uuid; twin uuid; t public.algo_strategies;
begin
  select * into s from public.algo_strategies where id = p_strategy;
  if not found or not (public.is_admin() or s.owner_id = auth.uid()) then raise exception 'Not allowed.'; end if;
  perform set_config('app.bypass', 'on', true);
  twin := public.mode_twin(p_strategy, p_live);
  if not p_live then
    if not s.live then return json_build_object('live', false); end if;
    if twin is not null then
      -- A paper copy already runs on its own: the live one only stops taking new live entries (an open live position
      -- keeps its stops and exits until it closes). Nothing is added to Paper.
      update public.algo_strategies set active = false, switch_to = null where id = p_strategy;
      return json_build_object('live', true, 'paused', true, 'copy', twin, 'copy_mode', 'PAPER', 'existing', true, 'holding', s.position <> 'FLAT');
    end if;
    if s.position <> 'FLAT' then
      -- The live position stays live (its stops and exits go on); no new live entries; a paper copy trades on.
      nid := public.mode_copy(p_strategy, false);
      update public.algo_strategies set active = false, switch_to = null where id = p_strategy;
      return json_build_object('live', true, 'paused', true, 'copy', nid, 'copy_mode', 'PAPER', 'holding', true);
    end if;
    -- Flat and no paper copy: this one becomes the paper strategy.
    update public.algo_strategies set live = false, switch_to = null, name = public.mode_key(name) where id = p_strategy;
    return json_build_object('live', false);
  end if;
  if s.live then return json_build_object('live', true); end if;
  if s.data_segment = 'DELTA' then
    if not exists (select 1 from public.broker_accounts where user_id = s.owner_id and broker = 'DELTA' and coalesce(client_id, '') <> '' and coalesce(access_token, '') <> '')
      then raise exception 'Connect your Delta Exchange account first (API key and secret under Connections).'; end if;
  elsif not exists (select 1 from public.broker_accounts where user_id = s.owner_id and broker = 'DHAN' and coalesce(access_token, '') <> '' and coalesce(webhook_url, '') <> '')
    then raise exception 'Connect your Dhan account first (client ID, access token and webhook URL).'; end if;
  if twin is not null then
    -- It already has a live copy: nothing is made (no second live strategy on the same rules), nothing is charged.
    select * into t from public.algo_strategies where id = twin;
    return json_build_object('live', false, 'copy', twin, 'copy_mode', 'LIVE', 'existing', true, 'copy_active', t.active, 'copy_name', t.name);
  end if;
  b := public.billing_for(s.owner_id);
  if b is not null and b->>'role' <> 'admin' then
    e := public.entries_allowed(s.owner_id);
    if not (e->>'ok')::boolean then raise exception '%', e->>'why'; end if;
    fee := coalesce((b->>'deploy_fee')::numeric, 0);
    if fee > 0 and not (b->>'trial_active')::boolean and (s.deploy_paid_until is null or s.deploy_paid_until < today) then
      if (b->>'balance')::numeric < fee then raise exception 'Going live needs a deployment fee of ₹%. Your wallet has ₹%. Recharge first.', fee, (b->>'balance'); end if;
      paid := case when b->>'deploy_fee_period' = 'ONE_TIME' then date '9999-12-31' else (today + interval '1 month')::date - 1 end;
      insert into public.wallet_txns (user_id, amount, kind, note, strategy_id) values (s.owner_id, -fee, 'DEPLOY_FEE',
        case when paid = date '9999-12-31' then 'Deployment fee: ' || s.name else format('Deployment fee: %s (till %s)', s.name, paid) end, s.id);
      update public.algo_strategies set deploy_paid_until = paid where id = p_strategy;
    end if;
  end if;
  -- The paper strategy stays exactly as it is (running, position and all); a separate live copy, flat, trades from its
  -- own next signal.
  nid := public.mode_copy(p_strategy, true);
  update public.algo_strategies set deploy_paid_until = coalesce(paid, s.deploy_paid_until) where id = nid;
  return json_build_object('live', false, 'copy', nid, 'copy_mode', 'LIVE');
end $function$;

-- Papa's 14 live strategies that had no paper copy (they were switched to live while flat, before this change) get one:
-- flat, running, trading on paper from their own next signal. Run once, for the owner's account:
--   select s.name, public.mode_copy(s.id, false) from public.algo_strategies s
--   where s.owner_id = '<owner>' and s.live and not coalesce(s.archived, false) and public.mode_twin(s.id, false) is null;
--   (then: active = true on the copies)
