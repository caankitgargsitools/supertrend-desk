-- Stricter lab (23 Oct 2026): vault of held-back months, luck adjustment, neighbouring settings, best-trades cut,
-- trade minimum, doubled slippage for daily strategies too; breeding from winners off (lab_settings.evolve).
-- lab_trial_families(): rule families tried per asset and mode ("ASSET|DAILY" → n) and lab-wide ("*|DAILY", used by the
-- luck adjustment, as ideas move between assets), from the tried list and the saved results: a family is the rule text
-- with its numbers taken out (same indicators and conditions, any settings). 23 Oct: 5,219 daily, 8,874 intraday.
create or replace function public.lab_trial_families() returns json
language sql stable security definer set search_path to 'public' as $$
  with f as (
    select asset, coalesce(mode, 'INTRADAY') mode, regexp_replace(split_part(label, ' · ', 2), '[0-9.,]+', '', 'g') fam from public.lab_tried
    union all
    select asset, coalesce(mode, 'INTRADAY'), regexp_replace(split_part(label, ' · ', 2), '[0-9.,]+', '', 'g') from public.lab_results
  )
  select coalesce(json_object_agg(k, n), '{}'::json) from (
    select asset || '|' || mode k, count(distinct fam) n from f group by 1
    union all
    select '*|' || mode, count(distinct fam) from f group by 1
  ) y;
$$;
revoke all on function public.lab_trial_families() from public, anon, authenticated;

alter table public.lab_settings add column if not exists evolve boolean not null default false;
