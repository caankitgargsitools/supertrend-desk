-- Admin › User activity, detail (6 Nov 2026, Papa: "how many minutes has he been live and scrolling … which pages, how
-- much time on which page, how many times"). The app keeps, per page, seconds on screen, seconds in use (a scroll, tap,
-- click or key in the last 30 s) and visits, and reports them about once a minute (log_activity) into 5-minute buckets.
create table if not exists public.user_page_time (user_id uuid not null references auth.users(id), bucket timestamptz not null, page text not null,
  open_s int not null default 0, active_s int not null default 0, visits int not null default 0, primary key (user_id, bucket, page));
alter table public.user_page_time enable row level security;
revoke all on public.user_page_time from anon, authenticated;
-- log_activity(p jsonb): [{page, open_s, active_s, visits}], capped per bucket (330 s, 200 visits); admin_user_pages(p_user,
-- p_hours): per page visits, open_s, active_s, last_at; admin_activity gains engaged_min and visits_24h. (Function bodies
-- as applied through the Supabase MCP on 6 Nov 2026.)
