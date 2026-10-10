-- Crypto perpetual futures on Delta Exchange India.
-- crypto_assets: the coins the desk offers. Four come built in (Bitcoin, Ether, Solana, XRP); the owner can add more
-- from Delta's list. The engine fills in Delta's product details (contract size, tick) the first time it sees a coin.
create table if not exists public.crypto_assets (
  key text primary key,                -- Delta symbol, e.g. BTCUSD
  name text not null,
  history_symbol text,                 -- Binance spot pair for the years before Delta India listed the coin (BTCUSDT)
  cutover date,                        -- first day of Delta's own candles (earlier days come from history_symbol)
  product_id integer,
  contract_value numeric,              -- coins per contract (0.001 BTC)
  tick_size numeric,
  slip_pct numeric not null default 0.05,  -- slippage per order, % of price
  enabled boolean not null default true,
  sort integer not null default 100,
  note text,
  synced_at timestamptz,
  added_at timestamptz not null default now()
);
alter table public.crypto_assets enable row level security;
create policy crypto_assets_read on public.crypto_assets for select to authenticated using (true);
create policy crypto_assets_owner_insert on public.crypto_assets for insert to authenticated with check (public.is_owner());
create policy crypto_assets_owner_update on public.crypto_assets for update to authenticated using (public.is_owner()) with check (public.is_owner());

insert into public.crypto_assets (key, name, history_symbol, cutover, slip_pct, sort) values
  ('BTCUSD', 'Bitcoin', 'BTCUSDT', '2024-01-15', 0.02, 1),
  ('ETHUSD', 'Ether', 'ETHUSDT', '2024-03-01', 0.03, 2),
  ('SOLUSD', 'Solana', 'SOLUSDT', '2024-05-01', 0.05, 3),
  ('XRPUSD', 'XRP', 'XRPUSDT', '2024-05-01', 0.05, 4)
on conflict (key) do nothing;

-- Delta's contracts are in US dollars; P&L, charges and margins are shown in rupees at this rate.
alter table public.lab_settings add column if not exists usd_inr numeric not null default 88;
-- A crypto contract's rupee value per $1 move is fractional (0.001 BTC × ₹88 = 0.088).
alter table public.algo_strategies alter column lot_size type numeric using lot_size::numeric;

-- Delta API key and secret (stored like the Dhan token: never shown in full again).
create or replace function public.save_delta(p_key text, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  insert into public.broker_accounts (user_id, broker) values (auth.uid(), 'DELTA') on conflict (user_id, broker) do nothing;
  update public.broker_accounts set
    client_id = coalesce(nullif(trim(p_key), ''), client_id),
    access_token = coalesce(nullif(trim(p_secret), ''), access_token),
    updated_at = now()
  where user_id = auth.uid() and broker = 'DELTA';
  perform public.engine_call_user('delta_check', auth.uid());
end $$;
revoke all on function public.save_delta(text, text) from public, anon;
grant execute on function public.save_delta(text, text) to authenticated;

create or replace function public.delta_status()
returns json language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  return coalesce((select json_build_object('has_key', coalesce(client_id,'') <> '', 'key_tail', right(coalesce(client_id,''), 4),
      'has_secret', coalesce(access_token,'') <> '', 'checked_at', token_checked_at, 'note', token_note, 'capital', capital)
    from public.broker_accounts where user_id = auth.uid() and broker = 'DELTA'), json_build_object('has_key', false, 'has_secret', false));
end $$;
revoke all on function public.delta_status() from public, anon;
grant execute on function public.delta_status() to authenticated;

-- Coins in one desk lot (orders send lots × lot_coins ÷ contract_value contracts); filled to about $5,000 of the coin.
alter table public.crypto_assets add column if not exists lot_coins numeric;
-- usd_inr() for every signed-in user (strategy form), set_live checks the Delta key for crypto strategies,
-- desk_engine runs crypto_sync (admin) and delta_check; the four coins join the lab's assets. Applied with
-- pg_get_functiondef + replace (see the session notes); the new parts:
create or replace function public.usd_inr() returns numeric language sql stable security definer set search_path = public as $$ select coalesce((select usd_inr from public.lab_settings where id = 1), 88) $$;
grant execute on function public.usd_inr() to authenticated;
-- cron: every minute, every day, while a crypto strategy is active
-- select cron.schedule('crypto-tick', '* * * * *', $$select public.engine_call('tick_crypto') where exists (select 1 from public.algo_strategies where active and data_segment = 'DELTA')$$);
