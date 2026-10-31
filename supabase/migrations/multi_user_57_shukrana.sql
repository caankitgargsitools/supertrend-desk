-- Shukrana (31 Oct 2026, Papa): a share of clients' trading profit, settled by hand outside the portal, on a running
-- basis (no monthly or quarterly periods). Two things only:
--   * Shukrana due: worked out live from the client's LIVE trades (net of charges, hidden trades left out) from the
--     time their rate was first set, on new highs only: rate × (each rise of the running total above its previous
--     best). Profit that only makes back an earlier loss earns nothing; a loss never reduces what is already due.
--     A changed rate applies to rises after it (shukrana_rates keeps every rate with its start time).
--   * Shukrana accepted: what the admin records when the client pays (amount, date, optional note; no payment mode).
--     Never deleted: a wrong entry is put right with an opposite entry.
-- Balance = accepted − due (whole rupees, truncated). Below zero = Shukrana owed; admins are reminded daily.
create table if not exists public.shukrana_rates (
  id bigserial primary key, user_id uuid not null references auth.users(id), pct numeric not null check (pct >= 0 and pct <= 100),
  from_at timestamptz not null default now(), set_by uuid, created_at timestamptz not null default now()
);
create index if not exists shukrana_rates_user on public.shukrana_rates (user_id, from_at);
create table if not exists public.shukrana_accepted (
  id bigserial primary key, user_id uuid not null references auth.users(id), amount numeric not null check (amount <> 0),
  accepted_on date not null default ((now() at time zone 'Asia/Kolkata')::date), note text, entered_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists shukrana_accepted_user on public.shukrana_accepted (user_id, id);
alter table public.shukrana_rates enable row level security;
alter table public.shukrana_accepted enable row level security;
create policy shukrana_rates_read on public.shukrana_rates for select using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy shukrana_accepted_read on public.shukrana_accepted for select using (user_id = (select auth.uid()) or (select public.is_admin()));

-- One client's Shukrana (the client themselves, or an admin for anyone).
create or replace function public.shukrana_summary(p_user uuid default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare u uuid := coalesce(p_user, auth.uid()); since timestamptz; out jsonb;
begin
  if u is null then raise exception 'sign in first'; end if;
  if u <> auth.uid() and not public.is_admin() then raise exception 'not allowed'; end if;
  select min(from_at) into since from shukrana_rates where user_id = u;
  with r as (select pct, from_at, lead(from_at) over (order by from_at, id) to_at from shukrana_rates where user_id = u),
  t as (select id, exit_at, net from algo_trades where user_id = u and mode = 'LIVE' and not hidden and since is not null and exit_at >= since),
  c as (select id, exit_at, sum(net) over (order by exit_at, id) cum from t),
  p as (select id, exit_at, cum, greatest(0, max(cum) over (order by exit_at, id rows unbounded preceding)) peak from c),
  i as (select exit_at, cum, peak, peak - coalesce(lag(peak) over (order by exit_at, id), 0) inc from p),
  d as (select coalesce(sum(i.inc * r.pct / 100), 0) due from i join r on i.exit_at >= r.from_at and (r.to_at is null or i.exit_at < r.to_at)),
  last as (select cum, peak from p order by exit_at desc, id desc limit 1)
  select jsonb_build_object(
    'since', since,
    'pct', (select pct from shukrana_rates where user_id = u order by from_at desc, id desc limit 1),
    'net', coalesce((select cum from last), 0), 'peak', coalesce((select peak from last), 0),
    'due', trunc((select due from d)),
    'accepted', trunc(coalesce((select sum(amount) from shukrana_accepted where user_id = u), 0)),
    'trades', (select count(*) from t),
    'last_accepted', (select max(accepted_on) from shukrana_accepted where user_id = u)) into out;
  return out || jsonb_build_object('balance', (out->>'accepted')::numeric - (out->>'due')::numeric,
    'to_recover', greatest(0, (out->>'peak')::numeric - (out->>'net')::numeric));
end $$;
revoke all on function public.shukrana_summary(uuid) from public, anon;
grant execute on function public.shukrana_summary(uuid) to authenticated;

-- Every client with a rate (admins): for the Admin page and the reminder.
create or replace function public.shukrana_overview() returns table (user_id uuid, email text, full_name text, s jsonb) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query select p.user_id, p.email, p.full_name, public.shukrana_summary(p.user_id)
    from profiles p where exists (select 1 from shukrana_rates r where r.user_id = p.user_id) order by p.email;
end $$;
revoke all on function public.shukrana_overview() from public, anon;
grant execute on function public.shukrana_overview() to authenticated;

-- Admins: set a client's rate (from now on) and record Shukrana accepted.
create or replace function public.shukrana_set_rate(p_user uuid, p_pct numeric) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  if p_pct is null or p_pct < 0 or p_pct > 100 then raise exception 'rate must be 0 to 100%%'; end if;
  if (select pct from shukrana_rates where user_id = p_user order by from_at desc, id desc limit 1) is distinct from p_pct then
    insert into shukrana_rates (user_id, pct, set_by) values (p_user, p_pct, auth.uid());
  end if;
end $$;
create or replace function public.shukrana_accept(p_user uuid, p_amount numeric, p_on date default null, p_note text default null) returns bigint language plpgsql security definer set search_path = public as $$
declare nid bigint;
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  if p_amount is null or trunc(p_amount) = 0 then raise exception 'enter an amount'; end if;
  insert into shukrana_accepted (user_id, amount, accepted_on, note, entered_by)
    values (p_user, trunc(p_amount), coalesce(p_on, (now() at time zone 'Asia/Kolkata')::date), nullif(trim(p_note), ''), auth.uid()) returning id into nid;
  return nid;
end $$;
revoke all on function public.shukrana_set_rate(uuid, numeric) from public, anon;
revoke all on function public.shukrana_accept(uuid, numeric, date, text) from public, anon;
grant execute on function public.shukrana_set_rate(uuid, numeric) to authenticated;
grant execute on function public.shukrana_accept(uuid, numeric, date, text) to authenticated;

-- Daily reminder to the admins: clients whose Shukrana balance is below zero (owed), largest first.
create or replace function public.shukrana_remind() returns integer language plpgsql security definer set search_path = public as $$
declare owed jsonb; n int; a record; day text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD');
begin
  select coalesce(jsonb_agg(x order by (x->>'balance')::numeric), '[]'::jsonb), count(*) into owed, n from (
    select jsonb_build_object('who', coalesce(nullif(p.full_name, ''), p.email), 'balance', (public.shukrana_summary_admin(p.user_id)->>'balance')::numeric) x
    from profiles p where exists (select 1 from shukrana_rates r where r.user_id = p.user_id)) q
  where (x->>'balance')::numeric < 0;
  if n = 0 then return 0; end if;
  for a in select user_id from profiles where role = 'admin' loop
    perform public.notify_tagged(a.user_id, 'shukrana', format('Shukrana due from %s client%s', n, case when n = 1 then '' else 's' end),
      (select string_agg(format('%s: ₹%s', e->>'who', to_char(-(e->>'balance')::numeric, 'FM99,99,99,999')), ' · ') from jsonb_array_elements(owed) e),
      '/?shukrana=1', null, 'shukrana-' || day);
  end loop;
  return n;
end $$;
-- The reminder runs without a signed-in admin: the same figures, without the caller check.
create or replace function public.shukrana_summary_admin(p_user uuid) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare since timestamptz; due numeric; acc numeric;
begin
  select min(from_at) into since from shukrana_rates where user_id = p_user;
  with r as (select pct, from_at, lead(from_at) over (order by from_at, id) to_at from shukrana_rates where user_id = p_user),
  t as (select id, exit_at, net from algo_trades where user_id = p_user and mode = 'LIVE' and not hidden and since is not null and exit_at >= since),
  c as (select id, exit_at, sum(net) over (order by exit_at, id) cum from t),
  p as (select id, exit_at, greatest(0, max(cum) over (order by exit_at, id rows unbounded preceding)) peak from c),
  i as (select exit_at, peak - coalesce(lag(peak) over (order by exit_at, id), 0) inc from p)
  select trunc(coalesce(sum(i.inc * r.pct / 100), 0)) into due from i join r on i.exit_at >= r.from_at and (r.to_at is null or i.exit_at < r.to_at);
  select trunc(coalesce(sum(amount), 0)) into acc from shukrana_accepted where user_id = p_user;
  return jsonb_build_object('due', due, 'accepted', acc, 'balance', acc - due);
end $$;
revoke all on function public.shukrana_remind() from public, anon, authenticated;
revoke all on function public.shukrana_summary_admin(uuid) from public, anon, authenticated;
select cron.schedule('shukrana-remind', '47 4 * * *', $$select public.shukrana_remind()$$); -- 10:17 IST every day
