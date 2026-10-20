-- Applied to umryzxusbdttbcshkajt. Exchange holidays the engine and the portal follow.
create table if not exists public.market_holidays (
  day date not null, exch text not null check (exch in ('NSE', 'MCX')), opens_at time, note text,
  primary key (day, exch));
alter table public.market_holidays enable row level security;
create policy market_holidays_read on public.market_holidays for select to authenticated using (true);
insert into public.market_holidays (day, exch, opens_at, note) values
  ('2026-10-20','NSE',null,'Dussehra'), ('2026-10-20','MCX','17:00','Dussehra (evening session only)'),
  ('2026-11-10','NSE',null,'Diwali Balipratipada'), ('2026-11-10','MCX','17:00','Diwali Balipratipada (evening session only)'),
  ('2026-11-24','NSE',null,'Guru Nanak Jayanti'), ('2026-11-24','MCX','17:00','Guru Nanak Jayanti (evening session only)'),
  ('2026-12-25','NSE',null,'Christmas'), ('2026-12-25','MCX',null,'Christmas')
on conflict do nothing;
