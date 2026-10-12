-- Link each strategy made from the Strategy Lab back to its lab result (applied 12 Oct 2026).
alter table public.algo_strategies add column if not exists lab_id bigint;
create index if not exists algo_strategies_lab_id on public.algo_strategies(lab_id) where lab_id is not null;
-- Backfill: lab_results.promoted_id, then names like "Lab #123 · ...".
update public.algo_strategies s set lab_id = l.id from public.lab_results l where l.promoted_id = s.id and s.lab_id is null;
update public.algo_strategies s set lab_id = (regexp_match(s.name, '^Lab #(\d+)'))[1]::bigint where s.lab_id is null and not s.is_master and s.name ~ '^Lab #\d+';
-- lab_adopt now ends its final update with ", lab_id = p_id" on the user's copy.
