-- Simple lab rules (rev 5, 27 Oct 2026; engine lab.ts robustVerdict / consistencyScore). The full test is now the
-- strategy itself, year by year, and the held-back months; it passes when profitable in all but one year in five
-- (8 of 10, 4 of 5; minute strategies with under 3 years: 3 of the last 4 quarters), still profitable in total with
-- slippage doubled, with enough trades, and profitable in the held-back months. Ranked by the consistency score.
-- strict = true brings back the rev 4 rules (other assets, timeframes, nearby settings, luck, best trades, stage 2).
-- Stored results are re-scored in place by engine action lab_reverdict (no new backtests).
alter table public.lab_settings add column if not exists strict boolean not null default false;
