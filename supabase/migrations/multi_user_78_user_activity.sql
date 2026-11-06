-- Admin › User activity (6 Nov 2026, Papa: "how many hours he was active in the last 24 hours, live / paper capital,
-- paper / live strategies, realised / unrealised P&L on live and paper"). Presence: the app calls touch_presence() at
-- most every 5 minutes while it is on screen; one row per user per 5-minute bucket (kept; ~288 rows a user a day at most).
-- Active time = buckets in the last 24 h × 5 minutes (counted from 6 Nov 2026; Supabase's own auth audit log is empty).
create table if not exists public.user_presence (user_id uuid not null references auth.users(id), bucket timestamptz not null, primary key (user_id, bucket));
alter table public.user_presence enable row level security;
revoke all on public.user_presence from anon, authenticated;

create or replace function public.touch_presence() returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.user_presence (user_id, bucket) values (auth.uid(), date_bin(interval '5 minutes', now(), timestamptz '2026-01-01')) on conflict do nothing;
end $$;
revoke all on function public.touch_presence() from public, anon;
grant execute on function public.touch_presence() to authenticated;

create or replace function public.admin_activity() returns json language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  return coalesce((select json_agg(x order by x.active_min desc, x.email) from (
    select p.user_id, u.email, p.full_name, p.role, p.status, u.last_sign_in_at,
      (select max(bucket) from public.user_presence q where q.user_id = p.user_id) last_seen,
      (select count(*) * 5 from public.user_presence q where q.user_id = p.user_id and q.bucket > now() - interval '24 hours') active_min,
      coalesce(b.capital, 0) capital, b.access_token is not null dhan_ok,
      (select count(*) from public.algo_strategies s where s.owner_id = p.user_id and not s.archived and not s.is_master and s.live and s.active) live_n,
      (select count(*) from public.algo_strategies s where s.owner_id = p.user_id and not s.archived and not s.is_master and not s.live and s.active) paper_n,
      (select count(*) from public.algo_strategies s where s.owner_id = p.user_id and not s.archived and not s.is_master and s.live and s.position <> 'FLAT') live_open,
      (select count(*) from public.algo_strategies s where s.owner_id = p.user_id and not s.archived and not s.is_master and not s.live and s.position <> 'FLAT') paper_open,
      (select coalesce(sum(pos_margin), 0) from public.algo_strategies s where s.owner_id = p.user_id and not s.is_master and s.live and s.position <> 'FLAT') live_used,
      (select coalesce(sum(pos_margin), 0) from public.algo_strategies s where s.owner_id = p.user_id and not s.is_master and not s.live and s.position <> 'FLAT') paper_used,
      public.ledger_net_user(p.user_id, 'LIVE', null) live_real, public.ledger_net_user(p.user_id, 'PAPER', null) paper_real,
      (select coalesce(sum(pos_upnl), 0) from public.algo_strategies s where s.owner_id = p.user_id and not s.is_master and s.live and s.position <> 'FLAT') live_unreal,
      (select coalesce(sum(pos_upnl), 0) from public.algo_strategies s where s.owner_id = p.user_id and not s.is_master and not s.live and s.position <> 'FLAT') paper_unreal,
      (select count(*) from public.algo_trades t where t.user_id = p.user_id and not t.hidden and t.exit_at > now() - interval '24 hours') trades_24h,
      (select halted_at is not null from public.risk_state r where r.user_id = p.user_id) halted
    from public.profiles p join auth.users u on u.id = p.user_id left join public.broker_accounts b on b.user_id = p.user_id and b.broker = 'DHAN') x), '[]'::json);
end $$;
revoke all on function public.admin_activity() from public, anon;
grant execute on function public.admin_activity() to authenticated;
