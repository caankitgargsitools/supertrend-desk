-- Every trade of the year-by-year test (packed in columns) and the 0–100 quality score; manual tests.
alter table public.lab_results add column if not exists trades_long jsonb;
alter table public.lab_requests add column if not exists tfs integer[], add column if not exists exact boolean not null default false;
-- request_lab_variations(p_lab_id, p_strategy, p_n, p_kinds, p_assets, p_tfs, p_exact): manual tests (exact = only what was ticked).
-- lab_clean_long(jsonb): exit reasons that would describe the rules become "Strategy exit".
-- lab_public_detail adds trades_long (cleaned); lab_robust_public adds quality.
-- (applied in place with pg_get_functiondef + replace)
