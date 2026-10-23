-- Engine-wide warnings shown at the top of every page (first one: strategies running on the desk's own candles
-- because Dhan refused candle requests). A warning counts as on while the engine has reported it in the last
-- 10 minutes; "since" restarts when it comes back after a 30-minute quiet spell.
create table if not exists public.engine_alerts (
  key text primary key,
  since timestamptz not null,
  last_at timestamptz not null,
  detail jsonb
);
alter table public.engine_alerts enable row level security;
create policy engine_alerts_read on public.engine_alerts for select to authenticated using (true);

-- Returns true when the warning has just started (so the engine notifies the owner once).
create or replace function public.engine_alert(p_key text, p_detail jsonb) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare fresh boolean;
begin
  select coalesce(max(last_at) < now() - interval '30 minutes', true) into fresh from public.engine_alerts where key = p_key;
  insert into public.engine_alerts as a (key, since, last_at, detail) values (p_key, now(), now(), p_detail)
  on conflict (key) do update set last_at = now(), detail = excluded.detail,
    since = case when a.last_at < now() - interval '30 minutes' then now() else a.since end;
  return fresh;
end $$;
revoke all on function public.engine_alert(text, jsonb) from public, anon, authenticated;
