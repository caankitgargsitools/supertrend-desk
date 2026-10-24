-- 24 Oct 2026: lab_trial_families() reads every lab result (~9 s), over the API's 8-second limit, so the engine's call
-- timed out and the luck adjustment fell back to 10 tries instead of ~5,000-9,000. The counts are now worked out once
-- a night by pg_cron (as the database owner: no 8-second limit) and once now, stored on lab_settings;
-- the engine reads the stored numbers.
alter table public.lab_settings add column if not exists families jsonb;
alter table public.lab_settings add column if not exists families_at timestamptz;

create or replace function public.lab_families_refresh() returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  update public.lab_settings set families = public.lab_trial_families()::jsonb, families_at = now() where id = 1;
end $$;
revoke all on function public.lab_families_refresh() from public, anon, authenticated;

select public.lab_families_refresh();
select cron.schedule('lab-families', '40 21 * * *', $$select public.lab_families_refresh()$$); -- 03:10 IST
