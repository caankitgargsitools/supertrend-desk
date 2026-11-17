-- 17 Nov 2026 (Papa: "Yes, show the PBO Score as well"): the overfitting gauge (Probability of Backtest Overfitting,
-- lab_pbo, per lab run, asset and mode) on each Strategies group header. Per lab result of the caller's strategies:
-- its asset and mode, the median PBO of the latest 10 runs that measured that asset / mode (one run measures only ~30
-- fresh tries, so a single run is noisy), how many runs, the strategies per run and the latest run's date.
create or replace function public.group_pbo(p_ids bigint[])
returns table(id bigint, asset text, mode text, pbo numeric, runs integer, strategies integer, last_at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  with mine as (
    select r.id, r.asset, r.mode from public.lab_results r
    where r.id = any(p_ids)
      and (public.is_admin() or exists (select 1 from public.algo_strategies s where s.lab_id = r.id and s.owner_id = auth.uid()))
  ), keys as (select distinct asset, mode from mine),
  recent as (
    select k.asset, k.mode, p.pbo, p.strategies, p.computed_at
    from keys k cross join lateral (
      select x.pbo, x.strategies, x.computed_at from public.lab_pbo x
      where x.asset = k.asset and x.mode = k.mode and x.pbo is not null
      order by x.computed_at desc limit 10) p
  ), agg as (
    select asset, mode, percentile_cont(0.5) within group (order by pbo)::numeric pbo, count(*)::int runs,
           round(avg(strategies))::int strategies, max(computed_at) last_at
    from recent group by asset, mode
  )
  select m.id, m.asset, m.mode, round(a.pbo, 3), a.runs, a.strategies, a.last_at
  from mine m join agg a on a.asset = m.asset and a.mode = m.mode
$$;
revoke all on function public.group_pbo(bigint[]) from public, anon;
grant execute on function public.group_pbo(bigint[]) to authenticated;
