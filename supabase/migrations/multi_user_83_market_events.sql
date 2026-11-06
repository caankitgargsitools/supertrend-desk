-- 6 Nov 2026 (strategy-research audit, step 7): market-event days for the calendar rule "event_day" (CAL): RBI policy
-- days, Fed decisions, the Union Budget and the like, entered by hand (admins). The engine reads the table once a day
-- (lab.ts loadMarketEvents → logic.ts setMarketEvents) into an engine-wide set; an empty table means no events are known
-- and the condition is simply false. Nothing is deleted from it (a past event stays a past event).
-- CREATE TABLE only; grants / policies to be decided with the pending permissions work (admins read and write; the
-- engine reads with the service role).
create table if not exists public.market_events (
  day date not null,
  name text not null,
  primary key (day, name)
);
alter table public.market_events enable row level security;
create policy market_events_admin_read on public.market_events for select using ((select public.is_admin()));
