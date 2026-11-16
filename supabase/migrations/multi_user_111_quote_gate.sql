-- 16 Nov 2026 (Papa: "the prices are still updating very slow"). Dhan allows one quote (last price) request a second per
-- account. Each engine run spaced only its own requests, so the per-second price loop, the minute tick, the order manager
-- and the spread watcher collided and Dhan refused about one price request in three ("rate-limited") — the price loop
-- managed 2 rounds in 10 seconds. quote_slot hands out the next free turn per account (keyed by the Dhan client id, never
-- the token) for every caller; the engine waits for its turn before asking Dhan (engine v169, Dhan.quoteGate).
create table if not exists public.quote_gate (k text primary key, next_at timestamptz not null default now());
alter table public.quote_gate enable row level security;
revoke all on table public.quote_gate from anon, authenticated;
create or replace function public.quote_slot(p_key text, p_gap_ms int default 1100) returns timestamptz
language sql security definer set search_path to 'public' as $$
  insert into public.quote_gate as g (k, next_at) values (p_key, clock_timestamp() + make_interval(secs => p_gap_ms / 1000.0))
  on conflict (k) do update set next_at = greatest(g.next_at, clock_timestamp()) + make_interval(secs => p_gap_ms / 1000.0)
  returning next_at - make_interval(secs => p_gap_ms / 1000.0);
$$;
revoke all on function public.quote_slot(text, int) from public, anon, authenticated;
