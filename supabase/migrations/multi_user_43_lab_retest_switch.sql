-- 24 Oct 2026: lab_settings.retest_until_done — set by a re-test run (engine action lab_start_retest); while true and
-- saved strategies are still queued in lab_refresh, the lab runs only re-test batches (100 each, 10 minutes' rest
-- between them, only while no Dhan market a running strategy trades is open). Cleared when the queue is empty.
alter table public.lab_settings add column if not exists retest_until_done boolean not null default false;
