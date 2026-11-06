-- NOT APPLIED — waits for Papa's answer to question 4 of the 6 Nov 2026 audit (DROP needs his approval by the standing
-- rule). Three parts, each can go alone.

-- Part A · dead tables (no code, function, cron, trigger or policy reaches them; sizes from the audit).
-- strategies, signals, settings, strategy_chart: the single-user v1 tables, empty. lab_robust_bak_1013: a 10 MB one-off
-- backup from 13 Oct, no primary key. owner_invite: 1 row, unreferenced. portal_settings: the pre-multi-user owner
-- settings (its token was blanked on 6 Nov); reached only by the dead functions below.
drop table if exists public.strategies, public.signals, public.settings, public.strategy_chart, public.lab_robust_bak_1013, public.owner_invite, public.portal_settings;

-- Part B · dead functions (no code, cron, trigger, policy or caller).
drop function if exists public.capital_status();
drop function if exists public.portal_status();
drop function if exists public.save_portal_settings(text, text, text, text);
drop function if exists public.save_capital(numeric, date, numeric);
drop function if exists public.portal_engine(text, uuid);
drop function if exists public.ledger_net(date);
drop function if exists public.start_backtest(uuid, date, date, numeric);
drop function if exists public.rerun_backtest(bigint);
drop function if exists public.delta_private(uuid, text, text, text);
drop function if exists public.delta_result(bigint);
drop function if exists public.lab_public(text, text, int);
drop function if exists public.desk_prewarm();
drop function if exists public.price_bars_tick();
drop function if exists public.notify(uuid, text, text, text, text, uuid);
drop function if exists public.request_lab_variations(bigint, uuid, int, text[], text[]); -- the 5-arg overload; the 7-arg one stays
drop function if exists public.renew_deploy_fees();  -- cron job 7 is already off
drop trigger if exists on_auth_user_created on auth.users;  -- fires claim_owner(), a no-op
drop function if exists public.claim_owner();
-- NOTE: check each signature with `select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname = '…'`
-- before running; the argument lists above are from the audit and must match exactly or the statement is skipped.

-- Part C · the 13 duplicate permissive policy pairs ("owner reads" + "user reads own" on algo_strategies ×4,
-- algo_backtests, algo_chart, algo_signals, algo_trades, lab_margins): one policy each. Example for algo_trades:
--   drop policy "owner reads trades" on public.algo_trades;
--   alter policy trades_read on public.algo_trades using (user_id = (select auth.uid()) or (select public.is_admin()));
-- The exact names are in pg_policies; written out when Papa says go.

-- Part D · archival (UPDATE, not DROP, but it removes data from the database): move trades / trades_long / robust of the
-- 11,600 superseded lab_results rows to storage files, then null the columns (~250 MB back; VACUUM FULL in a quiet hour).
-- Done by an engine action (not written yet) so files land in the lab's bucket with the row id as the name.
