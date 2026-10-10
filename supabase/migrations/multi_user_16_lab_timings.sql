-- Lab: per-step timings and engine-memory candle cache (cache is code-only)
alter table public.lab_runs add column if not exists timings jsonb;
create or replace function public.lab_add_time(p_run bigint, p_phase text, p_ms int) returns void language sql security definer set search_path = public as $$
  update public.lab_runs set timings = coalesce(timings, '{}'::jsonb) || jsonb_build_object(p_phase, coalesce((timings->>p_phase)::bigint, 0) + p_ms, 'steps', coalesce((timings->>'steps')::int, 0) + 1) where id = p_run $$;
revoke all on function public.lab_add_time(bigint, text, int) from public, anon, authenticated;
grant execute on function public.lab_add_time(bigint, text, int) to service_role;
