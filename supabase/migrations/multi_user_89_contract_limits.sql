-- 12 Nov 2026 (go-live review): Dhan's instrument lists carry the exchange's per-order quantity limit (SM_FREEZE_QTY,
-- in the order's own unit: units on NSE / BSE F&O, lots on MCX) and the day's price band (SM_UPPER_LIMIT /
-- SM_LOWER_LIMIT). Stored with each contract by syncFno / syncMcx.
alter table public.fno_contracts add column if not exists freeze_qty numeric, add column if not exists band_hi numeric, add column if not exists band_lo numeric;
alter table public.mcx_contracts add column if not exists freeze_qty numeric, add column if not exists band_hi numeric, add column if not exists band_lo numeric;
