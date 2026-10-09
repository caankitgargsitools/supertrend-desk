-- Multi-user desk: roles, broker accounts, billing, wallet, marketplace.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  email text,
  full_name text,
  phone text,
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'active' check (status in ('active', 'blocked')),
  trial_until date,
  profit_share_pct numeric,          -- per-user override (null = billing default)
  deploy_fee numeric,                -- per-user override (null = billing default)
  can_build boolean not null default true,
  loss_carry numeric not null default 0, -- losses still to be earned back before profit share is charged again
  terms_accepted_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

-- One row per user per broker (Dhan today; other brokers later).
create table if not exists public.broker_accounts (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  broker text not null default 'DHAN',
  client_id text,
  access_token text,
  webhook_url text,
  webhook_secret text,
  token_expires_at timestamptz,
  token_renewed_at timestamptz,
  token_checked_at timestamptz,
  token_note text,
  capital numeric not null default 0,
  capital_since date,
  deploy_pct numeric not null default 60,
  funds jsonb,
  funds_at timestamptz,
  funds_error text,
  synced_at timestamptz,             -- last Dhan trade-book check
  sync_note text,
  updated_at timestamptz not null default now(),
  unique (user_id, broker)
);

create table if not exists public.billing_settings (
  id boolean primary key default true check (id),
  trial_days integer not null default 14,
  deploy_fee numeric not null default 0,
  deploy_fee_period text not null default 'MONTHLY' check (deploy_fee_period in ('ONE_TIME', 'MONTHLY')),
  profit_share_pct numeric not null default 20,
  min_balance numeric not null default 0,
  pay_to text,                       -- UPI ID / bank details shown to users for recharges
  pay_note text,
  updated_at timestamptz not null default now()
);
insert into public.billing_settings (id) values (true) on conflict do nothing;

-- Wallet: every credit (+) and debit (-). Balance = sum(amount).
create table if not exists public.wallet_txns (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  amount numeric not null,
  kind text not null check (kind in ('RECHARGE', 'PROFIT_SHARE', 'DEPLOY_FEE', 'PURCHASE', 'ADJUST', 'REFUND')),
  note text,
  ref text,
  strategy_id uuid,
  trade_id bigint,
  created_by uuid
);
create index if not exists wallet_txns_user on public.wallet_txns (user_id, created_at desc);

-- Recharge requests (user says "I paid ₹X, UTR ..."; admin approves and it becomes a RECHARGE).
create table if not exists public.recharge_requests (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  amount numeric not null check (amount > 0),
  ref text,
  note text,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  decided_at timestamptz,
  decided_by uuid
);

-- Marketplace listings. strategy_id is the admin-owned master copy; buyers run it without seeing its rules.
create table if not exists public.listings (
  id bigserial primary key,
  strategy_id uuid not null,
  source_strategy uuid,
  title text not null,
  summary text,
  price numeric not null default 0,
  status text not null default 'draft' check (status in ('draft', 'published', 'hidden')),
  bt_ids jsonb not null default '{}'::jsonb,   -- {"1": backtest id, ..., "5": backtest id}
  asset text,
  instrument text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id bigserial primary key,
  user_id uuid not null references auth.users on delete cascade,
  listing_id bigint not null references public.listings on delete cascade,
  price numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, listing_id)
);

-- Strategies belong to a user; deployments of a listing point at its master and keep no rules of their own.
alter table public.algo_strategies
  add column if not exists owner_id uuid,
  add column if not exists source_id uuid,
  add column if not exists listing_id bigint,
  add column if not exists locked boolean not null default false,
  add column if not exists is_master boolean not null default false,
  add column if not exists broker text not null default 'DHAN',
  add column if not exists asset_class text not null default 'IN_FNO',
  add column if not exists deploy_paid_until date,
  add column if not exists capital numeric;
alter table public.algo_trades
  add column if not exists user_id uuid,
  add column if not exists fee numeric,
  add column if not exists broker_ref text,
  add column if not exists verified boolean not null default false;
alter table public.algo_backtests
  add column if not exists user_id uuid,
  add column if not exists listing_id bigint,
  add column if not exists years integer;
