-- Ideas lab (step 3, 25 Oct 2026; engine ideas.ts): a short list of trading ideas, each with a small fixed set of
-- settings written into the ledger (idea_tries) before any result is seen, tested as portfolios across assets sized
-- for ₹35 lakh. idea_legs: the backtests behind each setting (one per asset, or per asset and year for 5-minute ideas);
-- their trades are cleared once the idea is decided (the setting's result keeps the months, years and totals).
alter table public.lab_settings add column if not exists ideas_enabled boolean not null default false;
alter table public.lab_settings add column if not exists ideas_capital numeric not null default 3500000;

create table if not exists public.idea_tries (
  id bigserial primary key,
  idea text not null,
  idea_order integer not null,
  setting_key text not null,
  label text not null,
  setting jsonb not null,
  status text not null default 'planned', -- planned | later | running | combined | done
  result jsonb,
  verdict jsonb,
  registered_at timestamptz not null default now(),
  started_at timestamptz,
  done_at timestamptz,
  unique (idea, setting_key)
);
alter table public.idea_tries enable row level security;
create policy idea_tries_admin on public.idea_tries for select using ((select public.is_admin()));

create table if not exists public.idea_legs (
  id bigserial primary key,
  try_id bigint not null references public.idea_tries(id),
  asset text not null,
  win_from date,
  win_to date,
  config jsonb not null,
  status text not null default 'pending', -- pending | done
  result jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists idea_legs_try on public.idea_legs (try_id, status);
alter table public.idea_legs enable row level security;
create policy idea_legs_admin on public.idea_legs for select using ((select public.is_admin()));

-- Every 2 minutes while switched on; the engine itself waits for the markets to close and for the lab to be free.
select cron.schedule('ideas-lab', '*/2 * * * *', $$select public.engine_call('ideas') where exists (select 1 from public.lab_settings where id = 1 and ideas_enabled)$$);
