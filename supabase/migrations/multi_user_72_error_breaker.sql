-- Error circuit breaker (Phase 2, 4 Nov 2026; Papa chose only this part of the account risk layer, for paper and live).
-- Per user: the engine counts minute ticks (market and crypto) in which every one of the user's strategies that ran
-- failed (Dhan / token / engine errors); a tick with any strategy run that worked resets it. After 5 such ticks in a row
-- new entries stop for the whole account (paper and live; exits, stops and square-off keep running) and the user is
-- notified. "Allow new trades again" (breaker_allow) clears it; it is never cleared by itself.
create table if not exists public.risk_state (
  user_id uuid primary key,
  err_ticks int not null default 0,
  last_error text,
  halted_at timestamptz,
  halt_reason text,
  updated_at timestamptz not null default now()
);
alter table public.risk_state enable row level security;
create policy risk_state_own on public.risk_state for select using (user_id = (select auth.uid()) or (select public.is_admin()));

create or replace function public.breaker_allow(p_user uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := coalesce(p_user, auth.uid());
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if u <> auth.uid() and not public.is_admin() then raise exception 'Not allowed.'; end if;
  update public.risk_state set halted_at = null, halt_reason = null, err_ticks = 0, updated_at = now() where user_id = u;
end $$;
revoke all on function public.breaker_allow(uuid) from public, anon;
grant execute on function public.breaker_allow(uuid) to authenticated;
