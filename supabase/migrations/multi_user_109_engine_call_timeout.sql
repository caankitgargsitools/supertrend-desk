-- 16 Nov 2026 (Papa: "the desk still shows the old price and the old stop loss"). The database sends engine calls
-- (pg_net) in batches and waits for the slowest call of a batch. From the 09:00 open a market tick or an order-manager
-- run took up to the 55-second timeout, and some calls hung 55 s on the name lookup, so the every-10-second price calls
-- waited behind them: prices (and the stop line that follows them) refreshed about once a minute. The engine now
-- answers the minute dispatcher's calls at once (engine v166, BG_ACTIONS) and those calls get a 10-second timeout, so a
-- hung one holds a batch for 10 s at most; other calls keep 55 s.
create or replace function public.engine_call(p_action text, p_strategy uuid default null)
returns bigint language sql security definer set search_path to 'public', 'extensions' as $$
  select net.http_post(
    url := 'https://umryzxusbdttbcshkajt.supabase.co/functions/v1/engine',
    body := jsonb_build_object('action', p_action, 'strategy_id', p_strategy),
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-engine-secret', (select secret from public.engine_secret)),
    timeout_milliseconds := case when p_strategy is null and p_action in ('prices', 'tick', 'tick_crypto', 'orders', 'reconcile', 'pred_feed', 'spreads', 'push', 'audit', 'kill') then 10000 else 55000 end);
$$;
