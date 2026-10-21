-- Applied to umryzxusbdttbcshkajt (multi_user_31_lab_list_view, multi_user_32_lab_robust_slim).
-- lab_results.robust_list: the tougher-test result without its per-check lists (kept by trigger lab_robust_slim);
-- view lab_results_list (security invoker) serves the lab list with it; the detail page still reads lab_results.
create or replace function public.lab_robust_slim(r jsonb) returns jsonb language sql immutable as $$
  select case when r is null then null else
    (r - 'assets' - 'tfs' - 'steps' - 'years' - 'quarters')
    || jsonb_build_object(
      'assets', jsonb_build_object('ok', r->'assets'->'ok', 'n', r->'assets'->'n'),
      'tfs', jsonb_build_object('ok', r->'tfs'->'ok', 'n', r->'tfs'->'n'),
      'years', case when r->'years' is null then null else jsonb_build_object('ok', r->'years'->'ok', 'n', r->'years'->'n',
        'list', (select jsonb_agg(jsonb_build_object('y', y->'y', 'net', y->'net', 'ok', y->'ok', 'n', y->'n', 'from', y->'from', 'to', y->'to'))
                 from jsonb_array_elements(coalesce(r->'years'->'list', '[]'::jsonb)) y)) end)
    || case when r ? 'quarters' then jsonb_build_object('quarters', jsonb_build_object('ok', r->'quarters'->'ok', 'n', r->'quarters'->'n')) else '{}'::jsonb end
  end $$;
alter table public.lab_results add column if not exists robust_list jsonb;
create or replace function public.trg_lab_robust_slim() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.robust is distinct from old.robust then new.robust_list := public.lab_robust_slim(new.robust); end if;
  return new;
end $$;
create trigger lab_robust_slim before insert or update of robust on public.lab_results for each row execute function public.trg_lab_robust_slim();
create or replace view public.lab_results_list with (security_invoker = on) as
select id, run_id, created_at, asset, mode, label, fingerprint, champion, config, stage, passed, basic_passed, robust_status, request_id,
  robust_list as robust, score, metrics, starred, promoted_id, twin_of, refresh, superseded_by, opt_buy, opt_sell, opt_struct, requested_by
from public.lab_results;
grant select on public.lab_results_list to authenticated;
-- backfill: update lab_results set robust_list = public.lab_robust_slim(robust) where robust is not null;
