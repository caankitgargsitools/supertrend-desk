-- 12 Nov 2026 (Papa made 30 strategies live while 13 of them held PAPER positions — 137 lots MIDCPNIFTY, 1,006 lots
-- NATGASMINI, 219 lots SOL … never placed at the broker — and the pages showed those paper positions as live). A
-- position stays in the mode it was opened in: switching Live / Paper on a strategy that holds a position now waits
-- (switch_to = 'LIVE' / 'PAPER') and takes effect the moment it is flat with no order working (trigger
-- apply_switch_when_flat). The engine closes a held position on a reversal and leaves the new entry for the next
-- signal, so an always-in-the-market strategy also reaches flat. The 13 strategies were put back to paper with
-- switch_to = 'LIVE' (nothing had been sent: live_orders empty, no trade booked since).
alter table public.algo_strategies add column if not exists switch_to text check (switch_to in ('LIVE', 'PAPER'));

create or replace function public.apply_switch_when_flat() returns trigger language plpgsql as $$
begin
  if new.switch_to is not null and new.position = 'FLAT' and new.exec_state is null then
    new.live := new.switch_to = 'LIVE';
    if new.live then new.live_since := coalesce(new.live_since, now()); end if;
    new.switch_to := null;
  end if;
  return new;
end $$;
create or replace trigger trg_switch_when_flat before update on public.algo_strategies for each row execute function public.apply_switch_when_flat();

create or replace function public.set_live(p_strategy uuid, p_live boolean)
 returns json language plpgsql security definer set search_path to 'public' as $function$
declare s public.algo_strategies; b json; fee numeric; paid date; today date := (now() at time zone 'Asia/Kolkata')::date; e json;
begin
  select * into s from public.algo_strategies where id = p_strategy;
  if not found or not (public.is_admin() or s.owner_id = auth.uid()) then raise exception 'Not allowed.'; end if;
  perform set_config('app.bypass', 'on', true);
  if not p_live then
    if s.live and s.position <> 'FLAT' then
      update public.algo_strategies set switch_to = 'PAPER' where id = p_strategy;
      return json_build_object('live', true, 'pending', 'PAPER');
    end if;
    update public.algo_strategies set live = false, switch_to = null where id = p_strategy; return json_build_object('live', false);
  end if;
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
  -- A paper position is never turned into a live one: the switch waits until the strategy is flat.
  if not s.live and s.position <> 'FLAT' then
    update public.algo_strategies set switch_to = 'LIVE' where id = p_strategy;
    return json_build_object('live', false, 'pending', 'LIVE');
  end if;
  update public.algo_strategies set live = true, switch_to = null, live_since = coalesce(live_since, now()) where id = p_strategy;
  return json_build_object('live', true);
end $function$;

-- The 13 that went live today holding paper positions: back to paper, live once flat.
update public.algo_strategies set live = false, switch_to = 'LIVE'
  where live and position <> 'FLAT' and pos_broker is null and live_since > '2026-11-12 07:25+00' and not archived;
