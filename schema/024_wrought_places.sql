-- 024_wrought_places.sql
-- Where somebody trains — a gym, the park, a hotel — as a record with a kit
-- list, not a sentence in memory.
--
-- The founder: "if there's a new gym and it recognises that you're working
-- out somewhere else, it should add a new gym. Some of that coach should be
-- ready in there, because I've added a few gyms already." He had: to ChatGPT,
-- which said it added them and wrote nothing — the memory table holds zero
-- gyms on his account. A place kept as free text in wrought_memory is a place
-- the assistant has to parse back every time, and a claimed save nobody can
-- check. This table is the fix: one row per place, its kind, its equipment,
-- when it was last used.
--
-- A place is not only a gym. "I'm going for a walk at the park" is a workout
-- with a place, and it needs no kit question. Kind decides that.

create table if not exists public.wrought_places (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  -- gym: somewhere with kit. home: the garage or the spare room. outdoor: a
  -- park, a trail, the street. travel: a hotel gym, somewhere temporary.
  kind          text not null default 'gym',
  -- What is actually there. Empty for an outdoor place; asked once for a gym.
  equipment     text[] not null default '{}',
  notes         text,
  times_used    integer not null default 0,
  last_used_on  date,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_places_kind_valid') then
    alter table public.wrought_places add constraint wrought_places_kind_valid
      check (kind in ('gym','home','outdoor','travel','other'));
  end if;
end $$;

-- One live place per name per person, matched without case — "GoodLife" and
-- "goodlife" are one gym, not two.
create unique index if not exists wrought_places_one_name
  on public.wrought_places (user_id, lower(name)) where active;

alter table public.wrought_places enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'wrought_places' and policyname = 'own places') then
    create policy "own places" on public.wrought_places
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- Where a live session is happening, so the finaliser can stamp it on the
-- workout event. Nullable; the session opens without it.
alter table public.wrought_sessions add column if not exists place text;

comment on table public.wrought_places is
  'Where somebody trains, as a record: a gym with its kit, a park, a hotel. Sessions carry the name; workouts are built to the place''s equipment.';
comment on column public.wrought_places.equipment is
  'What is actually at this place. A workout is never built around a machine that is somewhere else.';
comment on column public.wrought_sessions.place is
  'Where this session happened, by name. Stamped onto the workout event at close.';
