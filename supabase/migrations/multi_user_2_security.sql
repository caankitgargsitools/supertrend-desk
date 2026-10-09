-- Multi-user desk: who can see what.

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where user_id = (select auth.uid()) and role = 'admin' and status = 'active')
      or exists (select 1 from public.app_owner where user_id = (select auth.uid()));
$$;

create or replace function public.owns_strategy(p_strategy uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.algo_strategies where id = p_strategy and owner_id = (select auth.uid()));
$$;

-- Users can't move strategies between owners, attach a listing they didn't buy, or mark fees as paid.
create or replace function public.guard_strategy() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select auth.uid()) is null or public.is_admin() or current_setting('app.bypass', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    if not coalesce((select can_build from public.profiles where user_id = (select auth.uid())), false) then
      raise exception 'Building strategies is not enabled for your account.';
    end if;
    new.owner_id := (select auth.uid()); new.source_id := null; new.listing_id := null; new.locked := false;
    new.is_master := false; new.deploy_paid_until := null; new.live := false;
    return new;
  end if;
  if new.owner_id is distinct from old.owner_id or new.source_id is distinct from old.source_id or new.listing_id is distinct from old.listing_id
     or new.locked is distinct from old.locked or new.is_master is distinct from old.is_master
     or new.deploy_paid_until is distinct from old.deploy_paid_until then
    raise exception 'Not allowed.';
  end if;
  -- Going live goes through set_live() so fees and the wallet are checked.
  if new.live and not old.live then raise exception 'Use the Go live button.'; end if;
  -- A bought strategy keeps its rules with the publisher.
  if old.locked then
    new.rules := null; new.risk := old.risk; new.strategy_kind := old.strategy_kind; new.timeframe_min := old.timeframe_min;
  end if;
  return new;
end $$;
drop trigger if exists guard_strategy on public.algo_strategies;
create trigger guard_strategy before insert or update on public.algo_strategies for each row execute function public.guard_strategy();

alter table public.profiles enable row level security;
alter table public.broker_accounts enable row level security;
alter table public.billing_settings enable row level security;
alter table public.wallet_txns enable row level security;
alter table public.recharge_requests enable row level security;
alter table public.listings enable row level security;
alter table public.purchases enable row level security;

drop policy if exists "owner all strategies" on public.algo_strategies;
create policy strategies_admin on public.algo_strategies for all using ((select public.is_admin())) with check ((select public.is_admin()));
create policy strategies_user_read on public.algo_strategies for select using (owner_id = (select auth.uid()));
create policy strategies_user_insert on public.algo_strategies for insert with check (owner_id = (select auth.uid()));
create policy strategies_user_update on public.algo_strategies for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy strategies_user_delete on public.algo_strategies for delete using (owner_id = (select auth.uid()) and position = 'FLAT' and not live);

drop policy if exists "owner reads backtests" on public.algo_backtests;
create policy backtests_read on public.algo_backtests for select using ((select public.is_admin()) or user_id = (select auth.uid()));
drop policy if exists "owner reads chart" on public.algo_chart;
create policy chart_read on public.algo_chart for select using ((select public.is_admin()) or public.owns_strategy(strategy_id));
drop policy if exists "owner reads signals" on public.algo_signals;
create policy signals_read on public.algo_signals for select using ((select public.is_admin()) or public.owns_strategy(strategy_id));
drop policy if exists "owner reads trades" on public.algo_trades;
create policy trades_read on public.algo_trades for select using ((select public.is_admin()) or user_id = (select auth.uid()));

create policy profiles_read on public.profiles for select using ((select public.is_admin()) or user_id = (select auth.uid()));
create policy billing_read on public.billing_settings for select using ((select auth.uid()) is not null);
create policy wallet_read on public.wallet_txns for select using ((select public.is_admin()) or user_id = (select auth.uid()));
create policy recharge_read on public.recharge_requests for select using ((select public.is_admin()) or user_id = (select auth.uid()));
create policy listings_read on public.listings for select using ((select public.is_admin()) or status = 'published');
create policy purchases_read on public.purchases for select using ((select public.is_admin()) or user_id = (select auth.uid()));
drop policy if exists lab_margins_owner_read on public.lab_margins;
create policy lab_margins_read on public.lab_margins for select using ((select auth.uid()) is not null);
-- broker_accounts: no policies; tokens are only reached through the functions below and the engine.
