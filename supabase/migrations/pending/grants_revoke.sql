-- NOT APPLIED — waits for Papa's answer to question 2 of the 6 Nov 2026 audit ("revoke the blanket ALL grants?").
-- Today every public table grants ALL to anon and authenticated (64 tables); RLS is the only barrier. This grants back
-- exactly what the website does: authenticated reads the tables it lists, writes only its own strategies, push
-- subscriptions, lab results / settings and coins (owner), and anon gets nothing (the sign-in page reads no table).
-- Everything else goes through SECURITY DEFINER functions (the RPC API), which keep their own EXECUTE grants.
-- Tables the engine alone uses keep service_role only. Apply in a quiet hour, then run the UI suite against production
-- (tests/ui with a real sign-in is not automated: click through Strategies, Desk, Capital, Trades, Orders, Lab, Market,
-- Wallet, Admin as admin and as a client).

begin;

-- 1. Take everything back.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke all on table public.%I from anon, authenticated', r.tablename);
  end loop;
  for r in select viewname from pg_views where schemaname = 'public' loop
    execute format('revoke all on table public.%I from anon, authenticated', r.viewname);
  end loop;
end $$;
-- Future tables: nothing to anon / authenticated by default.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- 2. What the website reads (index.html .from("…"), 6 Nov 2026).
grant select on public.algo_strategies, public.algo_trades, public.algo_signals, public.algo_backtests, public.lab_results, public.lab_results_list,
  public.lab_settings, public.lab_runs, public.lab_margins, public.lab_pbo, public.lab_combos, public.lab_combo_groups, public.idea_defs, public.idea_tries,
  public.idea_legs, public.pred_stats, public.pred_latest, public.pred_models, public.pred_settings, public.pred_worker, public.health_runs, public.desk_audit,
  public.notifications, public.market_holidays, public.live_prices, public.live_orders, public.live_marks, public.listings, public.engine_alerts,
  public.daily_pnl, public.billing_settings, public.wallet_txns, public.recharge_requests, public.shukrana_accepted, public.ticker_ref, public.risk_state,
  public.crypto_assets, public.push_subs, public.purchases, public.profiles, public.shukrana_rates, public.desk_snapshots, public.fno_contracts, public.mcx_contracts,
  public.lab_periods, public.lab_tried, public.spread_state, public.spread_ticks, public.stock_actions
  to authenticated;

-- 3. What the website writes (guarded by RLS and guard_strategy as today).
grant insert, update, delete on public.algo_strategies to authenticated;
grant insert, update, delete on public.push_subs to authenticated;
grant update on public.notifications to authenticated;
grant update, delete on public.lab_results to authenticated;   -- owner policies only
grant update on public.lab_settings to authenticated;          -- owner policy only
grant insert, update on public.crypto_assets to authenticated; -- owner policies only

-- 4. The six guarded SECURITY DEFINER functions anon could call: owner-only or signed-in only anyway.
revoke execute on function public.audit_now() from public, anon;
revoke execute on function public.lab_refresh_status() from public, anon;
revoke execute on function public.lab_run_focus() from public, anon;
revoke execute on function public.owns_strategy(uuid) from public, anon;

commit;
