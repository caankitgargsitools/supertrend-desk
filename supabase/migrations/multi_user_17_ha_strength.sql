-- Heikin Ashi strength: share of the lab's new strategies built on it (percent, 0–50; default 8)
alter table public.lab_settings add column if not exists ha_strength_pct numeric not null default 8 check (ha_strength_pct >= 0 and ha_strength_pct <= 50);
