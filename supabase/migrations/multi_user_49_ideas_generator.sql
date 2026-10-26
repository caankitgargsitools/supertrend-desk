-- Ideas lab generator, version 1 (26 Oct 2026, Papa: up to 20 new ideas a day, the near-misses combined first).
-- idea_defs: generated ideas (the research list stays in the engine's code); each one's settings go into the ledger
-- idea_tries before any test. ideas_per_day: the daily quota (none while 20 generated ideas wait to be tested).
create table if not exists public.idea_defs (
  key text primary key,
  idea_order integer not null,
  name text not null,
  why text not null,
  kind text not null,
  daily boolean not null default true,
  universe text[] not null default '{}',
  settings jsonb not null,
  source text not null default 'generated',
  created_day date not null,
  created_at timestamptz not null default now()
);
alter table public.idea_defs enable row level security;
create policy idea_defs_admin on public.idea_defs for select using ((select public.is_admin()));
alter table public.lab_settings add column if not exists ideas_per_day integer not null default 20;
