-- 12 Nov 2026 (Papa: "Paper and Live do not have any linkage at all. Any strategy can be in any mode or both. Remove any
-- sort of linkage"). Replaces migration 91's wait-until-flat: switching the mode of a strategy that holds a position
-- leaves that strategy and its position alone and makes a separate copy in the other mode, flat, which trades from its
-- own next signal. Going live: the paper one keeps running (both run). Back to paper: the live one is paused (no new
-- live entries; its live position keeps its stops / exits until it closes) and a paper copy runs. A flat strategy just
-- switches, as before. The 16 waiting with switch_to = 'LIVE' got their live copies here.
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
    'name', regexp_replace(s.name, '^(.*?)( · |$)', '\1 (' || case when p_live then 'live' else 'paper' end || ')\2'));
  perform set_config('app.bypass', 'on', true);
  insert into public.algo_strategies select * from jsonb_populate_record(null::public.algo_strategies, j);
  return nid;
end $$;
revoke execute on function public.mode_copy(uuid, boolean) from public, anon, authenticated;

create or replace function public.apply_switch_when_flat() returns trigger language plpgsql as $$
begin return new; end $$;  -- migration 91's wait-until-flat is retired (copies instead)

create or replace function public.set_live(p_strategy uuid, p_live boolean)
 returns json language plpgsql security definer set search_path to 'public' as $function$
declare s public.algo_strategies; b json; fee numeric; paid date; today date := (now() at time zone 'Asia/Kolkata')::date; e json; nid uuid;
begin
  select * into s from public.algo_strategies where id = p_strategy;
  if not found or not (public.is_admin() or s.owner_id = auth.uid()) then raise exception 'Not allowed.'; end if;
  perform set_config('app.bypass', 'on', true);
  if not p_live then
    if not s.live then return json_build_object('live', false); end if;
    if s.position <> 'FLAT' then
      -- The live position stays live (its stops and exits go on); no new live entries; a paper copy trades on.
      nid := public.mode_copy(p_strategy, false);
      update public.algo_strategies set active = false, switch_to = null where id = p_strategy;
      return json_build_object('live', true, 'copy', nid, 'copy_mode', 'PAPER');
    end if;
    update public.algo_strategies set live = false, switch_to = null where id = p_strategy; return json_build_object('live', false);
  end if;
  if s.live then return json_build_object('live', true); end if;
  if s.data_segment = 'DELTA' then
    if not exists (select 1 from public.broker_accounts where user_id = s.owner_id and broker = 'DELTA' and coalesce(client_id, '') <> '' and coalesce(access_token, '') <> '')
      then raise exception 'Connect your Delta Exchange account first (API key and secret under Connections).'; end if;
  elsif not exists (select 1 from public.broker_accounts where user_id = s.owner_id and broker = 'DHAN' and coalesce(access_token, '') <> '' and coalesce(webhook_url, '') <> '')
    then raise exception 'Connect your Dhan account first (client ID, access token and webhook URL).'; end if;
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
  if s.position <> 'FLAT' then
    -- The paper position stays paper on this strategy; a separate live copy, flat, trades from its own next signal.
    nid := public.mode_copy(p_strategy, true);
    update public.algo_strategies set switch_to = null where id = p_strategy;
    return json_build_object('live', false, 'copy', nid, 'copy_mode', 'LIVE');
  end if;
  update public.algo_strategies set live = true, switch_to = null, live_since = coalesce(live_since, now()) where id = p_strategy;
  return json_build_object('live', true);
end $function$;

do $$ declare r record; begin
  for r in select id from public.algo_strategies where switch_to = 'LIVE' and not archived loop
    perform public.mode_copy(r.id, true);
    update public.algo_strategies set switch_to = null where id = r.id;
  end loop;
end $$;
