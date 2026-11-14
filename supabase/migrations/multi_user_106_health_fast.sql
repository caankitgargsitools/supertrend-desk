-- 14 Nov 2026 (Papa: go ahead with the database savings). desk_health() took 6.7 s a run (0.6 s when written):
-- (1) the website-ping lookup evaluated its sub-select once per row of net._http_response (3,000 rows x 3,000);
-- (2) the "failed in the last 24 h" job check read the whole 7-day cron history (80,000 rows, 50 MB) — a day is
--     about 10,500 runs, so the newest 15,000 are enough.
-- After: the whole check 0.7 s (measured in a rolled-back run: 18 ok, 2 to watch, 0 failing).
do $mig$
declare d text; a text; b text;
begin
  select pg_get_functiondef('public.desk_health(boolean)'::regprocedure) into d;
  a := $q$from health_state s left join net._http_response r on r.id = coalesce((select r2.id from net._http_response r2 where r2.id = (s.v->>'id')::bigint), (s.v->>'prev')::bigint) where s.k = 'web_ping';$q$;
  b := $q$from health_state s left join net._http_response r on r.id = (select coalesce((select r2.id from net._http_response r2 where r2.id = (s2.v->>'id')::bigint limit 1), (s2.v->>'prev')::bigint) from health_state s2 where s2.k = 'web_ping') where s.k = 'web_ping';$q$;
  if position(a in d) = 0 then raise exception 'web ping lookup not found'; end if;
  if position('- 80000' in d) = 0 then raise exception 'cron window not found'; end if;
  d := replace(replace(d, a, b), '- 80000', '- 15000');
  execute d;
end $mig$;
