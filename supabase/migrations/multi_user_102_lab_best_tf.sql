-- 14 Nov 2026 (Papa: "on the bottom of the strategy tab … show if the desk has found any PASSED strategy on any asset on a
-- new time frame … I want to choose all the strategies to run on paper which are the best in that asset on each time
-- frame, so that I can test it in real time on paper, and then whatever I like I will move that to live").
-- lab_best_tf: the Strategy Lab's best current passed strategy (highest consistency score) for every asset and
-- timeframe, kept by lab_best_tf_refresh() (cron lab-best-tf, hourly at :37 — the read un-toasts ~2,300 configs, about
-- 5 s cold, so it is stored instead of being worked out at every page load). first_seen = when the lab first passed
-- anything on that asset and timeframe; best_since = since when this one is the best. A timeframe that no longer has a
-- passed strategy is kept with current = false (never deleted). After the first run, a NEW asset / timeframe notifies
-- admins once (kind "lab", link /?best=1).
-- lab_best_tf_list() (admins): those rows with the caller's own desk beside each — is the best one on paper (running
-- or paused), is it live, and how many other paper / live strategies run on that asset and timeframe. A desk strategy is
-- the same strategy when its lab result has the same fingerprint (desk strategies carry older lab ids).
-- Timeframe key as on the website (cxStratTf / labTfKey): 'D' for daily rules, else the minutes.

create table if not exists public.lab_best_tf (
  asset text not null, tf text not null,
  lab_id bigint not null, fingerprint text, label text, cons numeric,
  n_passed integer not null default 0, newest timestamptz,
  first_seen timestamptz not null default now(), best_since timestamptz not null default now(),
  updated_at timestamptz not null default now(), current boolean not null default true,
  primary key (asset, tf));
alter table public.lab_best_tf enable row level security;
revoke all on public.lab_best_tf from public, anon, authenticated;

create or replace function public.lab_best_tf_refresh() returns integer
language plpgsql security definer set search_path = public as $$
declare first_run boolean := not exists (select 1 from public.lab_best_tf);
  r record; a record; n integer := 0; seen text[] := '{}'; fresh text[] := '{}'; was_new boolean;
begin
  for r in
    select distinct on (asset, tf) asset, tf, id, fingerprint, label, cons,
      count(*) over (partition by asset, tf) as n_passed, max(created_at) over (partition by asset, tf) as newest
    from (select id, asset, fingerprint, label, created_at,
            case when config->'rules'->>'daily' = 'true' then 'D' else config->>'timeframe_min' end as tf,
            (robust_list->'consistency'->>'score')::numeric as cons
          from public.lab_results where passed and superseded_by is null and robust_status = 'done' and config is not null) x
    where tf is not null and asset is not null
    order by asset, tf, cons desc nulls last, id desc
  loop
    insert into public.lab_best_tf as b (asset, tf, lab_id, fingerprint, label, cons, n_passed, newest)
      values (r.asset, r.tf, r.id, r.fingerprint, r.label, r.cons, r.n_passed, r.newest)
    on conflict (asset, tf) do update set lab_id = excluded.lab_id, fingerprint = excluded.fingerprint, label = excluded.label, cons = excluded.cons,
      n_passed = excluded.n_passed, newest = excluded.newest, updated_at = now(), current = true,
      best_since = case when b.fingerprint is distinct from excluded.fingerprint then now() else b.best_since end,
      first_seen = case when not b.current then now() else b.first_seen end
    returning (xmax = 0) into was_new;
    seen := seen || (r.asset || '|' || r.tf); n := n + 1;
    if was_new and not first_run then fresh := fresh || (r.asset || ' ' || case when r.tf = 'D' then 'daily' else r.tf || ' min' end); end if;
  end loop;
  update public.lab_best_tf set current = false, updated_at = now() where current and not ((asset || '|' || tf) = any(seen));
  if array_length(fresh, 1) > 0 then
    for a in select user_id from public.profiles where role = 'admin' and status = 'active' loop
      perform public.notify_tagged(a.user_id, 'lab', left('The lab passed a strategy on a new timeframe: ' || fresh[1] || case when array_length(fresh, 1) > 1 then ' (+' || (array_length(fresh, 1) - 1) || ' more)' else '' end, 120),
        left(array_to_string(fresh, ', ') || '. Strategies › "Best passed strategy per asset and timeframe" lists them, with a button to put them on paper.', 400),
        '/?best=1', null, 'besttf-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYYMMDDHH24'));
    end loop;
  end if;
  return n;
end $$;
revoke all on function public.lab_best_tf_refresh() from public, anon, authenticated;

create or replace function public.lab_best_tf_list() returns json
language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid(); res json;
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  with mine as (
    select s.id, s.live, s.active, s.position, s.underlying, s.trade_type, lr.fingerprint,
      case when s.strategy_kind = 'TIMED' then s.bias_timeframe::text when s.strategy_kind = 'RULES' and s.rules->>'daily' = 'true' then 'D' else s.timeframe_min::text end as tf
    from public.algo_strategies s left join public.lab_results lr on lr.id = s.lab_id
    where s.owner_id = u and not coalesce(s.archived, false) and s.trade_type is distinct from 'OPTIONS')
  select json_build_object('at', (select max(updated_at) from public.lab_best_tf), 'rows', coalesce(json_agg(q.j order by q.asset, q.tfn), '[]'::json)) into res
  from (
    select b.asset, case when b.tf = 'D' then 1000000 else b.tf::integer end as tfn, json_build_object(
      'asset', b.asset, 'tf', b.tf, 'lab_id', b.lab_id, 'label', b.label, 'cons', b.cons, 'n_passed', b.n_passed, 'newest', b.newest,
      'first_seen', b.first_seen, 'best_since', b.best_since,
      'paper_best', (select json_build_object('id', m.id, 'active', m.active, 'position', m.position) from mine m where not m.live and m.fingerprint = b.fingerprint order by m.active desc, (m.position <> 'FLAT') desc limit 1),
      'live_best', (select json_build_object('id', m.id, 'active', m.active, 'position', m.position) from mine m where m.live and m.fingerprint = b.fingerprint order by m.active desc, (m.position <> 'FLAT') desc limit 1),
      'paper_n', (select count(*) from mine m where not m.live and m.underlying = b.asset and m.tf = b.tf),
      'paper_active_n', (select count(*) from mine m where not m.live and m.active and m.underlying = b.asset and m.tf = b.tf),
      'live_n', (select count(*) from mine m where m.live and m.underlying = b.asset and m.tf = b.tf)) as j
    from public.lab_best_tf b where b.current) q;
  return res;
end $$;
revoke all on function public.lab_best_tf_list() from public, anon;
grant execute on function public.lab_best_tf_list() to authenticated;

select public.lab_best_tf_refresh();
select cron.schedule('lab-best-tf', '37 * * * *', $c$select public.lab_best_tf_refresh()$c$);
