-- Lighter lab: candles in file storage, rest between runs, give way when the database is slow, background option queue.
alter table public.lab_candles alter column bars drop not null;
alter table public.lab_candles add column if not exists stored boolean not null default false;
alter table public.lab_settings add column if not exists pause_reason text;      -- 'rest' | 'slow' | 'manual'
alter table public.lab_settings add column if not exists opt_status jsonb;       -- what the option queue is pricing now
alter table public.lab_settings add column if not exists opt_lease_until timestamptz;
insert into storage.buckets (id, name, public, file_size_limit) values ('lab-candles', 'lab-candles', false, 52428800) on conflict (id) do nothing;
create index if not exists lab_results_waiting on public.lab_results (stage, id) where stage in ('pending', 'opt_queue', 'pricing');
-- lab_stop(): also sets pause_reason = 'manual'.
-- Watchdog every 2 minutes; option queue every 4 minutes while no run is going:
-- select cron.schedule('strategy-lab-options', '*/4 * * * *', $$select public.engine_call('lab_opt') where not exists (select 1 from public.lab_runs where status = 'running') and exists (select 1 from public.lab_results where stage in ('opt_queue', 'pricing'))$$);
