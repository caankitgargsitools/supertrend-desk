-- Tougher Strategy Lab pass: a walk-forward winner ("basic_passed") only counts as passed once it also works on other
-- assets and other timeframes and beats buy & hold for the risk taken. The engine runs the checks in lab_checks.
alter table public.lab_results add column if not exists basic_passed boolean, add column if not exists robust_status text, add column if not exists robust jsonb;
create table if not exists public.lab_checks (
  id bigserial primary key, lab_id bigint not null, kind text not null, asset text not null, tf integer, config jsonb not null,
  status text not null default 'pending', result jsonb, created_at timestamptz not null default now());
create index if not exists lab_checks_pending on public.lab_checks (status, lab_id desc);
create index if not exists lab_checks_lab on public.lab_checks (lab_id);
create index if not exists lab_results_robust_q on public.lab_results (robust_status) where basic_passed;
alter table public.lab_checks enable row level security;
-- No profit share any more.
update public.billing_settings set profit_share_pct = 0;
-- Earlier results: their old pass becomes the first-round pass and they are re-checked.
update public.lab_results set basic_passed = coalesce(passed, false), passed = false, robust_status = null where basic_passed is null;
