-- Multi-leg option structures: spreads, straddles / strangles, iron condor / butterfly, calendars, futures + option hedges.
alter table public.algo_strategies add column if not exists structure jsonb, add column if not exists pos_legs jsonb;
alter table public.lab_results add column if not exists opt_struct jsonb;
-- Applied in place (pg_get_functiondef + replace):
--  * guard_strategy: a locked copy keeps structure null (it runs on the master's).
--  * lab_adopt / buy_listing: the buyer's copy gets structure null; lab_adopt and lab_master accept p_side 'SPREAD'
--    (variant from opt_struct, trade_type OPTIONS, structure from the variant).
--  * lab_feed: view 'SPREAD' (rows with opt_struct) and osp (its summary metrics).
--  * lab_public_detail: spread versions (key 'SPREAD', named by structure only).
