-- Find Love · migration 001 (DRAFT — not applied; apply only after Papa decides the project / data questions in README)
-- Schema `findlove`: reporters, cases (lost / found), photos, sightings, matches, events. Nothing is ever deleted.

create schema if not exists findlove;

-- Who reports / verifies. One row per auth user who touches Find Love.
create table if not exists findlove.reporters (
  user_id      uuid primary key references auth.users(id),
  name         text not null default '',
  phone        text,                      -- verified by OTP before a report goes live
  phone_ok     boolean not null default false,
  role         text not null default 'reporter' check (role in ('reporter','volunteer','admin')),
  approved_by  uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

create table if not exists findlove.cases (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('lost','found')),
  status        text not null default 'draft'
                check (status in ('draft','open','matched','reunited','handed_over','withdrawn','duplicate')),
  hidden        boolean not null default false,          -- the only "delete"
  reporter      uuid not null references auth.users(id),
  -- the child
  child_name    text,                                     -- unknown for a found child
  sex           text check (sex in ('M','F','U')),
  age_years     numeric(4,1),                             -- best estimate
  age_tol       numeric(4,1) not null default 1,          -- ± years
  height_cm     int,
  marks         text,                                     -- scars, birthmarks, disability, speech
  clothes       text,
  languages     text,
  -- where and when
  place         text not null,                            -- free text as reported
  lat           double precision,
  lon           double precision,
  at            timestamptz not null,                     -- last seen (lost) / found at (found)
  now_at        text,                                     -- found: where the child is now (shelter, police post)
  -- official channels
  fir_no        text, fir_station text,
  childline_ref text, trackchild_ref text, cwc_ref text,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists cases_open_ix on findlove.cases (kind, status) where not hidden;

-- Photos live in a PRIVATE storage bucket `findlove`; this table holds the paths only.
create table if not exists findlove.case_photos (
  id         bigint generated always as identity primary key,
  case_id    bigint not null references findlove.cases(id),
  path       text not null,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists findlove.sightings (
  id         bigint generated always as identity primary key,
  case_id    bigint not null references findlove.cases(id),
  reporter   uuid not null references auth.users(id),
  place      text not null, lat double precision, lon double precision,
  at         timestamptz not null,
  note       text,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);

-- A lost case paired with a found case. The code suggests; a volunteer / admin confirms.
create table if not exists findlove.matches (
  id          bigint generated always as identity primary key,
  lost_id     bigint not null references findlove.cases(id),
  found_id    bigint not null references findlove.cases(id),
  score       numeric(5,2) not null,                       -- 0..100 from find_candidates / match.ts
  reasons     jsonb not null default '[]',
  status      text not null default 'suggested'
              check (status in ('suggested','checking','confirmed','rejected')),
  decided_by  uuid references auth.users(id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (lost_id, found_id)
);

-- Audit: every change, who and when.
create table if not exists findlove.case_events (
  id       bigint generated always as identity primary key,
  case_id  bigint not null references findlove.cases(id),
  actor    uuid references auth.users(id),
  kind     text not null,                                   -- created / edited / status / match / note
  detail   jsonb not null default '{}',
  at       timestamptz not null default now()
);

-- Row-level security: reporters see their own; volunteers and admins see all open cases; anon sees nothing.
alter table findlove.reporters   enable row level security;
alter table findlove.cases       enable row level security;
alter table findlove.case_photos enable row level security;
alter table findlove.sightings   enable row level security;
alter table findlove.matches     enable row level security;
alter table findlove.case_events enable row level security;

create or replace function findlove.my_role() returns text language sql stable security definer as $$
  select coalesce((select role from findlove.reporters where user_id = auth.uid()), 'none')
$$;

create policy reporters_self   on findlove.reporters for select using (user_id = auth.uid() or findlove.my_role() = 'admin');
create policy cases_read       on findlove.cases for select using (not hidden and (reporter = auth.uid() or findlove.my_role() in ('volunteer','admin')));
create policy cases_insert     on findlove.cases for insert with check (reporter = auth.uid());
create policy cases_edit_own   on findlove.cases for update using (reporter = auth.uid() or findlove.my_role() = 'admin');
create policy photos_read      on findlove.case_photos for select using (not hidden and exists (select 1 from findlove.cases c where c.id = case_id));
create policy sightings_read   on findlove.sightings for select using (not hidden and exists (select 1 from findlove.cases c where c.id = case_id));
create policy sightings_insert on findlove.sightings for insert with check (reporter = auth.uid());
create policy matches_read     on findlove.matches for select using (exists (select 1 from findlove.cases c where c.id in (lost_id, found_id)));
create policy events_read      on findlove.case_events for select using (exists (select 1 from findlove.cases c where c.id = case_id));

-- Candidates for a case: the other kind, open, scored by age, sex, distance and time (same rules as match.ts).
create or replace function findlove.find_candidates(p_case bigint, p_limit int default 20)
returns table (case_id bigint, score numeric, km numeric, days numeric)
language sql stable security invoker as $$
  with me as (select * from findlove.cases where id = p_case)
  select o.id,
         round((
           case when me.sex is null or o.sex is null or me.sex = 'U' or o.sex = 'U' then 15 when me.sex = o.sex then 30 else 0 end
         + case when me.age_years is null or o.age_years is null then 10
                else greatest(0, 25 - 10 * abs(me.age_years - o.age_years) / greatest(me.age_tol, o.age_tol, 0.5)) end
         + case when me.lat is null or o.lat is null then 10
                else greatest(0, 25 - 25 * (6371 * acos(least(1, cos(radians(me.lat)) * cos(radians(o.lat)) * cos(radians(o.lon) - radians(me.lon)) + sin(radians(me.lat)) * sin(radians(o.lat))))) / 200) end
         + case when me.kind = 'lost' and o.at < me.at then 0                       -- found before it was lost: no
                else greatest(0, 20 - 20 * abs(extract(epoch from (o.at - me.at))) / 86400 / 90) end
         )::numeric, 2) as score,
         case when me.lat is null or o.lat is null then null
              else round((6371 * acos(least(1, cos(radians(me.lat)) * cos(radians(o.lat)) * cos(radians(o.lon) - radians(me.lon)) + sin(radians(me.lat)) * sin(radians(o.lat)))))::numeric, 1) end as km,
         round((extract(epoch from (o.at - me.at)) / 86400)::numeric, 1) as days
  from me join findlove.cases o on o.kind <> me.kind and not o.hidden and o.status in ('open','matched')
  order by 2 desc limit p_limit
$$;
