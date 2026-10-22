-- Daily self-check: the desk's paper / live trades replayed with the backtest engine (engine action "audit").
create table if not exists public.desk_audit (
  id bigserial primary key,
  batch text not null,
  created_at timestamptz not null default now(),
  user_id uuid,
  strategy_id uuid,
  mode text,
  name text,
  from_day date,
  to_day date,
  matched int default 0,
  missed int default 0,
  extra int default 0,
  issues int default 0,
  desk_pts numeric default 0,
  bt_pts numeric default 0,
  rupee_gap numeric default 0,
  verdict text,
  note text,
  trades jsonb default '[]'::jsonb
);
create index if not exists desk_audit_user_created on public.desk_audit (user_id, created_at desc);
alter table public.desk_audit enable row level security;
create policy desk_audit_read on public.desk_audit for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_owner()));

-- "Check now" from the Trades page (owner only).
create or replace function public.audit_now() returns bigint language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  return public.engine_call('audit');
end $$;

-- Every morning at 07:40 IST, before the market opens.
select cron.schedule('desk-self-check', '10 2 * * *', $$select public.engine_call('audit')$$);
