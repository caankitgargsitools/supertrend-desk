-- Desk: capital deployed vs realised / running / total profit over time (3 Nov 2026, Papa: "a perpetual graph … for
-- any time in the past"). Every 5 minutes, for every user and mode with a strategy: margin in use by open positions,
-- their running P&L, realised P&L so far (closed trades after charges, hidden ones out) and how many positions are open.
-- Rows are kept for good (about 600 a day for the whole desk). Before the first snapshot the page estimates the capital
-- deployed from the closed trades (entry price × units × today's margin rate) and shows running P&L only from here on.

create table if not exists public.desk_snapshots (
  user_id uuid not null,
  mode text not null check (mode in ('LIVE', 'PAPER')),
  at timestamptz not null default date_trunc('minute', now()),
  margin numeric not null default 0,
  upnl numeric not null default 0,
  realized numeric not null default 0,
  n_open int not null default 0,
  primary key (user_id, mode, at)
);
alter table public.desk_snapshots enable row level security;
create policy desk_snapshots_own on public.desk_snapshots for select using (user_id = (select auth.uid()) or (select public.is_admin()));

create or replace function public.desk_snapshot() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.desk_snapshots (user_id, mode, at, margin, upnl, realized, n_open)
  select s.owner_id, m.mode, date_trunc('minute', now()),
    coalesce(sum(s.pos_margin) filter (where s.position <> 'FLAT' and (s.live = (m.mode = 'LIVE'))), 0),
    coalesce(sum(s.pos_upnl) filter (where s.position <> 'FLAT' and (s.live = (m.mode = 'LIVE'))), 0),
    public.ledger_net_user(s.owner_id, m.mode, null),
    count(*) filter (where s.position <> 'FLAT' and (s.live = (m.mode = 'LIVE')))
  from public.algo_strategies s cross join (values ('LIVE'), ('PAPER')) m(mode)
  where not coalesce(s.is_master, false) and s.owner_id is not null
  group by s.owner_id, m.mode
  having count(*) filter (where s.live = (m.mode = 'LIVE') and not s.archived) > 0
      or public.ledger_net_user(s.owner_id, m.mode, null) <> 0
  on conflict (user_id, mode, at) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.desk_snapshot() from public, anon, authenticated;

select cron.schedule('desk-snapshot', '*/5 * * * *', $$select public.desk_snapshot()$$);
select public.desk_snapshot();

-- The page's series: the caller's snapshots between p_from and p_to in about p_points buckets (last row of each bucket),
-- plus the time of their first snapshot (before it the page estimates from closed trades).
create or replace function public.desk_series(p_mode text, p_from timestamptz, p_to timestamptz, p_points int default 600) returns json
language plpgsql stable security definer set search_path = public as $$
declare u uuid := auth.uid(); step interval;
begin
  if u is null then raise exception 'Sign in first.'; end if;
  step := greatest(interval '5 minutes', (p_to - p_from) / greatest(50, least(p_points, 2000)));
  return json_build_object(
    'first', (select min(at) from public.desk_snapshots where user_id = u and mode = p_mode),
    'step_s', extract(epoch from step)::int,
    'rows', (select coalesce(json_agg(json_build_object('t', b.t, 'm', b.margin, 'u', b.upnl, 'r', b.realized, 'n', b.n_open) order by b.t), '[]'::json) from (
      select distinct on (date_bin(step, at, p_from)) date_bin(step, at, p_from) t, margin, upnl, realized, n_open
      from public.desk_snapshots where user_id = u and mode = p_mode and at between p_from and p_to
      order by date_bin(step, at, p_from), at desc) b));
end $$;
revoke all on function public.desk_series(text, timestamptz, timestamptz, int) from public, anon;
grant execute on function public.desk_series(text, timestamptz, timestamptz, int) to authenticated;
