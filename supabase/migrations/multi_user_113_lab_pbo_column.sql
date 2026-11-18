-- 18 Nov 2026 (Papa: "Are we showing this PBO score on the strategy lab list also? … that will help me in selecting the
-- strategies. Do that."): the Strategy Lab table gets a PBO column. Each lab row now carries its mode (DAILY /
-- INTRADAY), and pbo_summary() gives, per asset and mode, the median PBO of the latest 10 lab runs (as group_pbo).
do $$
declare d text := pg_get_functiondef('public.lab_feed'::regproc);
begin
  if position('l.asset, l.mode, l.stage' in d) = 0 then
    execute replace(d, 'l.asset, l.stage', 'l.asset, l.mode, l.stage');
  end if;
end $$;

create or replace function public.pbo_summary()
returns table(asset text, mode text, pbo numeric, runs integer, strategies integer, last_at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  with k as (select distinct asset, mode from public.lab_pbo where pbo is not null),
  recent as (
    select k.asset, k.mode, p.pbo, p.strategies, p.computed_at from k cross join lateral (
      select x.pbo, x.strategies, x.computed_at from public.lab_pbo x
      where x.asset = k.asset and x.mode = k.mode and x.pbo is not null order by x.computed_at desc limit 10) p)
  select asset, mode, round(percentile_cont(0.5) within group (order by pbo)::numeric, 3), count(*)::int,
         round(avg(strategies))::int, max(computed_at)
  from recent where public.lab_can_use() group by asset, mode
$$;
revoke all on function public.pbo_summary() from public, anon;
grant execute on function public.pbo_summary() to authenticated;
