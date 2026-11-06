-- Desk capital deployed vs profit, minute by minute (6 Nov 2026, Papa: "make it per minute view … the default"):
-- desk_snapshot every minute (cron job 36 `desk-snapshot`, was every 5 minutes) and desk_series buckets down to 1 minute.
create or replace function public.desk_series(p_mode text, p_from timestamp with time zone, p_to timestamp with time zone, p_points integer default 600)
 returns json language plpgsql stable security definer set search_path to 'public' as $function$
declare u uuid := auth.uid(); step interval;
begin
  if u is null then raise exception 'Sign in first.'; end if;
  step := greatest(interval '1 minute', (p_to - p_from) / greatest(50, least(p_points, 2000)));
  return json_build_object(
    'first', (select min(at) from public.desk_snapshots where user_id = u and mode = p_mode),
    'step_s', extract(epoch from step)::int,
    'rows', (select coalesce(json_agg(json_build_object('t', b.t, 'm', b.margin, 'u', b.upnl, 'r', b.realized, 'n', b.n_open) order by b.t), '[]'::json) from (
      select distinct on (date_bin(step, at, p_from)) date_bin(step, at, p_from) t, margin, upnl, realized, n_open
      from public.desk_snapshots where user_id = u and mode = p_mode and at between p_from and p_to
      order by date_bin(step, at, p_from), at desc) b));
end $function$;
select cron.alter_job(36, schedule := '* * * * *');
