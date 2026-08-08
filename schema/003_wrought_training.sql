-- ============================================================================
-- WROUGHT — schema 003: routines, live sessions, and every set
--
-- 001 and 002 made a diary. This makes a training partner.
--
-- The difference is tense. A diary is written afterwards, in the past tense,
-- and it is always slightly a lie — you round the reps up and forget the set
-- you bailed on. A partner is present tense: it stands next to you, tells you
-- what is next, and writes down what actually happened while it is happening.
--
-- Three tables, and the third one is the important one:
--
--   routines  — "leg day", "chest and arms", "Tuesday soccer". Named, saved,
--               reused. The user says the name and the whole session is there.
--   sessions  — one live workout, holding its own place in the routine so the
--               conversation can be interrupted and picked back up. Phones die
--               mid-set. Somebody talks to you between exercises. The session
--               has to survive that or it is useless in a real gym.
--   sets      — every single set, individually. This is what makes honest
--               progressive overload possible: to say "you did 80 for 8 last
--               Tuesday, go for 82.5" you need the set, not a session summary.
--               Summaries are where progress goes to die.
--
-- Safe to run more than once. Run after 001 and 002.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ── Routines ────────────────────────────────────────────────────────────────
-- "Remember this as my leg day" has to work, or the user rebuilds the same
-- session from scratch every week and stops after three weeks.

create table if not exists public.wrought_routines (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  kind         text not null default 'strength',
  tier         text not null default 'intermediate',
  exercises    jsonb not null default '[]'::jsonb,
  equipment    text[],
  est_minutes  integer,
  notes        text,
  times_used   integer not null default 0,
  last_used_on date,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.wrought_routines is
  'Saved, named sessions. The user says "leg day" and the whole thing is there — that is the difference between a tool used twice and one used for years.';
comment on column public.wrought_routines.kind is
  'strength | cardio | sport | mobility | hybrid. Sport covers the days that are not gym days at all — five-a-side, hockey, climbing — because a training log that cannot hold Tuesday football is not a training log.';
comment on column public.wrought_routines.tier is
  'beginner | intermediate | advanced. Governs volume, exercise selection and how much the coaching explains rather than assumes.';
comment on column public.wrought_routines.exercises is
  'Ordered array: [{name, sets, reps, load_kg, rest_s, muscles[], cue, substitutions[]}]. load_kg may be null — a beginner gets a rep target and an RPE, not a number pulled out of nowhere.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_routines_kind_valid') then
    alter table public.wrought_routines add constraint wrought_routines_kind_valid
      check (kind in ('strength','cardio','sport','mobility','hybrid'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wrought_routines_tier_valid') then
    alter table public.wrought_routines add constraint wrought_routines_tier_valid
      check (tier in ('beginner','intermediate','advanced'));
  end if;
end $$;

create index if not exists wrought_routines_user_idx
  on public.wrought_routines (user_id) where active;

-- One "leg day" per person. Saving it again updates it rather than quietly
-- creating a second one nobody can tell apart.
create unique index if not exists wrought_routines_user_name_idx
  on public.wrought_routines (user_id, lower(name)) where active;

-- ── Live sessions ───────────────────────────────────────────────────────────
-- The state lives on the server, not in the conversation. A chat context can
-- be cleared, a phone can die between sets, and somebody will always talk to
-- you at the squat rack. Any of those must not lose the workout.

create table if not exists public.wrought_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  routine_id    uuid references public.wrought_routines(id) on delete set null,
  name          text not null,
  kind          text not null default 'strength',
  plan          jsonb not null default '[]'::jsonb,
  cursor_index  integer not null default 0,
  status        text not null default 'active',
  local_date    date not null,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  event_id      uuid references public.wrought_events(id) on delete set null
);

comment on table public.wrought_sessions is
  'One workout, in progress. cursor_index is where the user actually is, so "what is next" survives a dead phone, a cleared chat, or a conversation at the rack.';
comment on column public.wrought_sessions.plan is
  'A frozen copy of the routine at the moment it started. Editing a routine must never rewrite the history of a session already done under the old version.';
comment on column public.wrought_sessions.event_id is
  'The wrought_events workout row this session produced on completion, so the brief and the training matrix see it like any other session.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_sessions_status_valid') then
    alter table public.wrought_sessions add constraint wrought_sessions_status_valid
      check (status in ('active','done','abandoned'));
  end if;
end $$;

create index if not exists wrought_sessions_user_idx
  on public.wrought_sessions (user_id, local_date desc);

-- At most one workout on the go. Starting a second means the first was
-- abandoned, and the tool says so rather than leaving two half-sessions
-- fighting over which one "next set" belongs to.
create unique index if not exists wrought_sessions_one_active_idx
  on public.wrought_sessions (user_id) where status = 'active';

-- ── Sets ────────────────────────────────────────────────────────────────────
-- The finest grain in the whole system, and the reason honest progression is
-- possible at all. "You had 80 for 8 last Tuesday and left one in the tank —
-- put 82.5 on" cannot be said from a session summary. It needs the set.

create table if not exists public.wrought_sets (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  session_id   uuid references public.wrought_sessions(id) on delete cascade,
  exercise     text not null,
  exercise_key text not null,
  set_number   integer not null,
  reps         integer,
  weight_kg    numeric,
  rpe          numeric,
  distance_km  numeric,
  seconds      integer,
  muscles      text[],
  note         text,
  local_date   date not null,
  logged_at    timestamptz not null default now()
);

comment on table public.wrought_sets is
  'Every set, individually. The record progressive overload is computed from.';
comment on column public.wrought_sets.exercise_key is
  'Normalised name for matching across time — "Barbell Bench Press", "bench press" and "bench" must all find last week''s number, or progression silently stops working and nobody notices for a month.';
comment on column public.wrought_sets.rpe is
  'Rate of perceived exertion, 1-10. How close to failure. For a beginner with no idea what a working weight is, this is the only honest way to prescribe load.';
comment on column public.wrought_sets.note is
  'Whatever was said at the rack — "left shoulder pinched", "grip went before the legs", "felt light today". Attached to the set, not the session, because "the third set felt wrong" is information and "somewhere in that hour something felt wrong" is not. This is where the reason behind a number lives, and six weeks later it is the only thing that explains the plateau.';

create index if not exists wrought_sets_user_exercise_idx
  on public.wrought_sets (user_id, exercise_key, logged_at desc);
create index if not exists wrought_sets_session_idx
  on public.wrought_sets (session_id);
create index if not exists wrought_sets_user_day_idx
  on public.wrought_sets (user_id, local_date desc);

-- ── Row level security ──────────────────────────────────────────────────────

alter table public.wrought_routines enable row level security;
alter table public.wrought_sessions enable row level security;
alter table public.wrought_sets     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['wrought_routines','wrought_sessions','wrought_sets']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_own', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_own', t);
  end loop;
end $$;

-- ============================================================================
-- A Tuesday, with this in place:
--
--   you    "leg day"
--   wrought "Back squat, 4 sets of 6. You had 92.5 for 6 last Tuesday at RPE 8,
--            so start at 95. Say done when the first set is up."
--   you    "done, got 6"
--   wrought "That's the PR. 3 min rest. Same weight next set."
--   ...
--   wrought "Session done. 51 minutes, 7,340 kg moved, squat up 2.5 on last week.
--            You're 1,190 calories short on the day and 40g down on protein."
--
-- and none of it was typed into a form.
-- ============================================================================
