-- Capital, position sizing, trade ledger and automatic Dhan token renewal (applied 2026-10-08).
alter table public.portal_settings
  add column if not exists token_expires_at timestamptz, add column if not exists token_renewed_at timestamptz,
  add column if not exists token_checked_at timestamptz, add column if not exists token_note text,
  add column if not exists capital numeric not null default 500000, add column if not exists capital_since date,
  add column if not exists deploy_pct numeric not null default 60,
  add column if not exists funds jsonb, add column if not exists funds_at timestamptz, add column if not exists funds_error text;
alter table public.algo_strategies
  add column if not exists sizing jsonb, add column if not exists pos_entry_px numeric, add column if not exists pos_entry_prem numeric,
  add column if not exists pos_lots integer, add column if not exists pos_margin numeric;

create table if not exists public.algo_trades (
  id bigserial primary key,
  strategy_id uuid not null references public.algo_strategies(id) on delete cascade,
  mode text not null check (mode in ('LIVE','PAPER')),
  entry_day date, exit_at timestamptz not null default now(),
  side text, contract text, lots integer, units integer,
  entry_px numeric, exit_px numeric, gross numeric, costs numeric, net numeric not null, exit_why text
);
create index if not exists algo_trades_mode_exit on public.algo_trades (mode, exit_at);
create index if not exists algo_trades_strategy on public.algo_trades (strategy_id, exit_at desc);
alter table public.algo_trades enable row level security;
create policy "owner reads trades" on public.algo_trades for select to authenticated using ((select public.is_owner()));

create or replace function public.ledger_net(p_mode text, p_since date)
returns numeric language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(net), 0) from public.algo_trades
  where mode = p_mode and (p_since is null or exit_at >= (p_since::timestamp at time zone 'Asia/Kolkata'));
$$;
revoke all on function public.ledger_net(text, date) from public, anon, authenticated;
grant execute on function public.ledger_net(text, date) to service_role;

create or replace function public.capital_status()
returns json language plpgsql stable security definer set search_path to 'public' as $$
declare s public.portal_settings;
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  select * into s from public.portal_settings limit 1;
  return json_build_object(
    'capital', s.capital, 'since', s.capital_since, 'deploy_pct', s.deploy_pct,
    'live_net', public.ledger_net('LIVE', s.capital_since), 'paper_net', public.ledger_net('PAPER', s.capital_since),
    'live_used', (select coalesce(sum(pos_margin), 0) from public.algo_strategies where live and position <> 'FLAT'),
    'paper_used', (select coalesce(sum(pos_margin), 0) from public.algo_strategies where not live and position <> 'FLAT'),
    'funds', s.funds, 'funds_at', s.funds_at, 'funds_error', s.funds_error);
end $$;
revoke all on function public.capital_status() from public, anon;
grant execute on function public.capital_status() to authenticated;

create or replace function public.save_capital(p_capital numeric, p_since date, p_deploy_pct numeric)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  if p_capital is null or p_capital < 0 then raise exception 'Capital must be 0 or more.'; end if;
  if p_deploy_pct is null or p_deploy_pct <= 0 or p_deploy_pct > 100 then raise exception 'Deployment cap must be between 1 and 100%%.'; end if;
  update public.portal_settings set capital = p_capital, capital_since = p_since, deploy_pct = p_deploy_pct, updated_at = now() where id;
end $$;
revoke all on function public.save_capital(numeric, date, numeric) from public, anon;
grant execute on function public.save_capital(numeric, date, numeric) to authenticated;

-- portal_status: adds token expiry / renewal note and deploy_pct (token itself still never returned).
create or replace function public.portal_status()
returns json language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  return (select json_build_object('client_id', dhan_client_id,
      'has_token', coalesce(dhan_access_token,'') <> '', 'token_tail', right(coalesce(dhan_access_token,''), 4),
      'token_expires_at', token_expires_at, 'token_renewed_at', token_renewed_at, 'token_checked_at', token_checked_at, 'token_note', token_note,
      'has_url', coalesce(webhook_url,'') <> '', 'url_host', substring(coalesce(webhook_url,'') from '^https?://([^/]+)'),
      'has_secret', coalesce(webhook_secret,'') <> '', 'deploy_pct', deploy_pct) from public.portal_settings);
end $$;

create or replace function public.portal_engine(p_action text, p_strategy uuid)
returns bigint language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.is_owner() then raise exception 'Not allowed'; end if;
  if p_action not in ('refresh', 'flatten', 'token', 'token_renew', 'funds') then raise exception 'Unknown action'; end if;
  return public.engine_call(p_action, p_strategy);
end $$;

-- Hourly token check; renews when under 4 hours are left (or at 08:xx IST).
select cron.schedule('dhan-token-check', '7 * * * *', $$select public.engine_call('token')$$);

-- Margin rates from Dhan's margin calculator, per Strategy Lab asset (refreshed at the start of each lab run).
create table if not exists public.lab_margins (
  asset text primary key, price numeric, fut_pct numeric, fut_pct_i numeric, sell_pct numeric, sell_pct_i numeric,
  detail jsonb, error text, checked_at timestamptz default now()
);
alter table public.lab_margins enable row level security;
create policy lab_margins_owner_read on public.lab_margins for select using (is_owner());
