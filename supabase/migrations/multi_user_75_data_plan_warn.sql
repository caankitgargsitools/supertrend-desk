-- Dhan Data API plan watch (6 Nov 2026, Papa: after the plan showed "Deactive" at 09:00 and every price request was
-- refused). The hourly token check reads Dhan's /v2/profile (dataPlan, dataValidity) and warns the owner 7, 5, 3 and
-- 1 day(s) before the plan ends, and at once when Dhan reports it inactive. data_warned = "<validity>|<days>" of the
-- last warning sent, so each one goes once.
alter table public.broker_accounts add column if not exists data_plan text, add column if not exists data_valid_until date,
  add column if not exists data_checked_at timestamptz, add column if not exists data_warned text;
