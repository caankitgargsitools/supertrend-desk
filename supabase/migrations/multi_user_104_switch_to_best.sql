-- 14 Nov 2026 (Papa: "when the best strategy is chosen to be implemented, let the old strategy do its exit at its own, and
-- the new entry after that exit has to be as per the new strategy").
-- switch_to_best(p_from, p_to): the running strategy p_from hands over to p_to in p_from's mode.
--   * p_from is paused at once: no new entries; an open position keeps its stops / exit rules and closes on its own.
--   * the strategy that takes over is p_to itself when it is in the same mode, else its copy in that mode (the existing
--     one, or a new copy — going to Live never takes anything out of Paper, migration 101).
--   * it takes over p_from's lots and lot sizing (p_from was sized for its mode's capital; a paper strategy's sizing would
--     otherwise go live with it).
--   * p_from flat → the new one starts now; p_from holding → the new one waits (algo_strategies.wait_for = p_from) and the
--     trigger handover_on_exit starts it the moment p_from's position closes, and tells the owner.
-- Live needs the broker connected (as set_live). Returns { to, started, waiting, copied, mode }.

alter table public.algo_strategies add column if not exists wait_for uuid;

create or replace function public.switch_to_best(p_from uuid, p_to uuid) returns json
language plpgsql security definer set search_path = public as $$
declare f public.algo_strategies; t public.algo_strategies; tid uuid; copied boolean := false;
begin
  select * into f from public.algo_strategies where id = p_from;
  select * into t from public.algo_strategies where id = p_to;
  if f.id is null or t.id is null or not (public.is_admin() or (f.owner_id = auth.uid() and t.owner_id = auth.uid())) then raise exception 'Not allowed.'; end if;
  if f.owner_id <> t.owner_id then raise exception 'Both strategies must be on the same account.'; end if;
  if coalesce(f.archived, false) or coalesce(t.archived, false) then raise exception 'Restore the archived strategy first.'; end if;
  if f.id = t.id then raise exception 'That is the same strategy.'; end if;
  perform set_config('app.bypass', 'on', true);
  if t.live = f.live then tid := t.id;
  else
    tid := public.mode_twin(t.id, f.live);
    if tid is null then
      if f.live then
        if t.data_segment = 'DELTA' then
          if not exists (select 1 from public.broker_accounts where user_id = t.owner_id and broker = 'DELTA' and coalesce(client_id, '') <> '' and coalesce(access_token, '') <> '')
            then raise exception 'Connect your Delta Exchange account first (API key and secret under Connections).'; end if;
        elsif not exists (select 1 from public.broker_accounts where user_id = t.owner_id and broker = 'DHAN' and coalesce(access_token, '') <> '' and coalesce(webhook_url, '') <> '')
          then raise exception 'Connect your Dhan account first (client ID, access token and webhook URL).'; end if;
      end if;
      tid := public.mode_copy(t.id, f.live); copied := true;
    end if;
  end if;
  if tid = f.id then raise exception 'The best one is this same strategy (its copy in the other mode); nothing to switch.'; end if;
  update public.algo_strategies set active = false where id = f.id;
  update public.algo_strategies set lots = f.lots, sizing = f.sizing, wait_for = case when f.position = 'FLAT' then null else f.id end,
    active = (f.position = 'FLAT') or active and position <> 'FLAT' where id = tid;
  return json_build_object('to', tid, 'started', f.position = 'FLAT', 'waiting', f.position <> 'FLAT', 'copied', copied, 'mode', case when f.live then 'LIVE' else 'PAPER' end);
end $$;
revoke all on function public.switch_to_best(uuid, uuid) from public, anon;
grant execute on function public.switch_to_best(uuid, uuid) to authenticated;

create or replace function public.trg_handover_on_exit() returns trigger
language plpgsql security definer set search_path = public as $$
declare w record;
begin
  begin
    if old.position <> 'FLAT' and new.position = 'FLAT' then
      for w in update public.algo_strategies set active = true, wait_for = null where wait_for = new.id and not coalesce(archived, false) returning id, owner_id, name loop
        perform public.notify_tagged(w.owner_id, 'trade', left('Switched to the best: ' || w.name, 120),
          left(new.name || ' closed its position on its own, so ' || w.name || ' now runs and takes its next entry by its own rules.', 400),
          '/?s=' || w.id, w.id, 'handover-' || w.id);
      end loop;
    end if;
  exception when others then null;
  end;
  return new;
end $$;
create or replace trigger handover_on_exit after update of position on public.algo_strategies
  for each row execute function public.trg_handover_on_exit();
