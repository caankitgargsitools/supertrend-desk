-- Variation runs: test a strategy many more ways (other assets, timeframes, stop / target / trailing tweaks, other
-- indicator combinations, setting tweaks), on request for one strategy.

create table if not exists public.lab_requests (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  source_lab_id bigint,
  source_strategy uuid,
  title text,                          -- shown to the user (no parameters)
  config jsonb not null,               -- the strategy's rules; never returned to users
  n integer not null default 100,
  kinds text[] not null default array['assets', 'timeframes', 'stops', 'trailing', 'indicators', 'tweaks'],
  assets text[],
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  run_id bigint,
  progress text,
  error text,
  finished_at timestamptz
);
create index if not exists lab_requests_status on public.lab_requests (status, id);
alter table public.lab_requests enable row level security;
-- No direct access; users go through the functions below.

alter table public.lab_results add column if not exists requested_by uuid, add column if not exists request_id bigint;
create index if not exists lab_results_request on public.lab_results (request_id) where request_id is not null;
alter table public.lab_settings add column if not exists nightly_due boolean not null default false;

-- Queue a variation run. Source: a lab result, or one of my strategies (a bought or lab-picked one uses its private master).
create or replace function public.request_lab_variations(p_lab_id bigint, p_strategy uuid, p_n int, p_kinds text[], p_assets text[]) returns bigint language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); c jsonb; s public.algo_strategies; t text; v bigint; n int;
begin
  if u is null then raise exception 'Sign in first.'; end if;
  if not public.lab_can_use() then raise exception 'The Strategy Lab is not enabled for your account.'; end if;
  if not public.is_admin() and exists (select 1 from public.lab_requests where user_id = u and status in ('pending', 'running')) then
    raise exception 'You already have a variation run waiting or running. Let it finish first.';
  end if;
  if p_lab_id is not null then
    select config into c from public.lab_results where id = p_lab_id;
    if c is null then raise exception 'Lab strategy not found.'; end if;
    t := format('Lab #%s', p_lab_id);
  else
    select * into s from public.algo_strategies where id = p_strategy;
    if not found or not (public.is_admin() or s.owner_id = u) then raise exception 'Not allowed.'; end if;
    t := s.name;
    if s.source_id is not null then select * into s from public.algo_strategies where id = s.source_id; end if;
    if s.strategy_kind <> 'RULES' or s.rules is null then raise exception 'Variation runs work for condition-based strategies (built from conditions or picked from the Strategy Lab).'; end if;
    c := to_jsonb(s);
  end if;
  n := greatest(10, least(case when public.is_admin() then 400 else 150 end, coalesce(p_n, 100)));
  insert into public.lab_requests (user_id, source_lab_id, source_strategy, title, config, n, kinds, assets, progress)
  values (u, p_lab_id, p_strategy, t, c, n, coalesce(p_kinds, array['assets', 'timeframes', 'stops', 'trailing', 'indicators', 'tweaks']), p_assets, 'Waiting for the lab')
  returning id into v;
  perform public.engine_call('lab_next');
  return v;
end $$;

create or replace function public.my_lab_requests() returns json language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  return coalesce((select json_agg(x order by x.id desc) from (
    select r.id, r.created_at, r.title, r.n, r.kinds, r.assets, r.status, r.progress, r.error, r.finished_at, r.user_id,
      (select count(*) from public.lab_results l where l.request_id = r.id and l.stage <> 'pending') as tested,
      (select count(*) from public.lab_results l where l.request_id = r.id and l.passed) as passed,
      (select max(score) from public.lab_results l where l.request_id = r.id and l.passed) as best_score
    from public.lab_requests r where r.user_id = auth.uid() or public.is_admin() order by r.id desc limit 30) x), '[]'::json);
end $$;

create or replace function public.cancel_lab_request(p_id bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.lab_requests set status = 'cancelled', finished_at = now(), progress = 'Cancelled'
  where id = p_id and status = 'pending' and (user_id = auth.uid() or public.is_admin());
end $$;

-- Lab results for users: their own variation runs as well as the shared nightly runs.
create or replace function public.lab_feed(p_view text, p_asset text, p_period text, p_only boolean, p_request bigint) returns json language plpgsql stable security definer set search_path = public as $$
declare r public.lab_runs; since timestamptz; adm boolean := public.is_admin();
begin
  if not public.lab_can_use() then raise exception 'The Strategy Lab is not enabled for your account.'; end if;
  select * into r from public.lab_runs order by id desc limit 1;
  since := case when p_period = 'run' then null else now() - make_interval(days => greatest(1, least(60, coalesce(nullif(p_period, '')::int, 30)))) end;
  return json_build_object(
    'run', case when r.id is null then null else json_build_object('id', r.id, 'created_at', r.created_at, 'status', r.status, 'phase', r.phase, 'progress', r.progress,
      'counts', r.counts, 'from_day', r.from_day, 'split_day', r.split_day, 'to_day', r.to_day, 'request', (r.settings->>'request_id') is not null) end,
    'rows', coalesce((select json_agg(x order by x.score desc) from (
      select l.id, l.run_id, l.created_at, l.asset, l.stage, l.passed, l.score, l.champion, l.metrics, l.request_id,
        md5(coalesce(l.fingerprint, l.id::text)) as fingerprint, public.lab_family(l.asset, l.config) as family, (l.config->'risk') is not null and l.config->'risk' <> 'null'::jsonb as has_risk,
        case when l.opt_buy is null then null else jsonb_build_object('metrics', l.opt_buy->'summary'->'metrics') end as ob,
        case when l.opt_sell is null then null else jsonb_build_object('metrics', l.opt_sell->'summary'->'metrics') end as os
      from public.lab_results l
      where l.stage in ('screened', 'opt_queue', 'pricing', 'priced')
        and (case when p_request is not null then l.request_id = p_request and (adm or l.requested_by = auth.uid())
                  else (l.requested_by is null or l.requested_by = auth.uid() or adm)
                       and (case when p_period = 'run' then l.run_id = r.id else l.created_at >= since end) end)
        and (p_view <> 'FUT' or not coalesce(p_only, true) or l.passed)
        and (p_view = 'FUT' or (p_view = 'BUY' and l.opt_buy is not null) or (p_view = 'SELL' and l.opt_sell is not null))
        and (p_asset = 'ALL' or l.asset = p_asset)
      order by l.score desc limit 2000) x), '[]'::json));
end $$;

revoke all on function public.request_lab_variations(bigint, uuid, int, text[], text[]) from public, anon;
revoke all on function public.my_lab_requests() from public, anon;
revoke all on function public.cancel_lab_request(bigint) from public, anon;
revoke all on function public.lab_feed(text, text, text, boolean, bigint) from public, anon;
grant execute on function public.request_lab_variations(bigint, uuid, int, text[], text[]) to authenticated;
grant execute on function public.my_lab_requests() to authenticated;
grant execute on function public.cancel_lab_request(bigint) to authenticated;
grant execute on function public.lab_feed(text, text, text, boolean, bigint) to authenticated;

-- Starts the nightly run that was held back, or the next variation run, whenever the lab is free.
select cron.schedule('strategy-lab-next', '*/2 * * * *', $$select public.engine_call('lab_next') where not exists (select 1 from public.lab_runs where status = 'running')
  and (exists (select 1 from public.lab_requests where status = 'pending') or exists (select 1 from public.lab_settings where nightly_due))$$);
