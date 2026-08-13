-- schema/ALL.sql
-- GENERATED — do not edit. Run: node scripts/build-all-sql.mjs
--
-- Every WROUGHT migration, in order, in one file. Paste the whole thing into
-- the Supabase SQL editor and run it once.
--
-- Safe to run again. Every statement in here is idempotent, so re-running after
-- a partial failure picks up where it stopped rather than doubling anything.
--
-- Files included, in order:
--    1. 001_wrought_core.sql
--    2. 002_wrought_oauth.sql
--    3. 003_wrought_training.sql
--    4. 004_wrought_fasting.sql
--    5. 005_wrought_activity.sql
--    6. 006_wrought_identity.sql
--    7. 007_wrought_push.sql
--    8. 008_wrought_blocks.sql
--    9. 009_wrought_photos.sql
--   10. 010_wrought_profile_web.sql
--   11. 011_wrought_membership.sql
--   12. 012_wrought_link_codes.sql
--   13. 013_wrought_work.sql
--   14. 014_wrought_plan.sql
--   15. 015_wrought_ingest_dedupe_fix.sql
--   16. 016_wrought_set_source.sql


-- ──────────────────────────────────────────────── 001_wrought_core.sql ────

-- ============================================================================
-- WROUGHT — schema 001: the core
--
-- The problem, stated plainly: every morning you open a brand new chat and
-- re-explain your entire life. What you ate. What you lifted. What the scale
-- said. The model is brilliant for ninety seconds and then forgets you exist.
-- Meanwhile the watch on your wrist knows your resting heart rate to the beat
-- and has never once volunteered an opinion about it.
--
-- WROUGHT is the memory that survives the tab closing, plus an honest read on
-- what it means. The AI is only the interface. This schema is the product.
--
-- Design decisions worth defending later:
--
--   * ONE log table (wrought_events) for everything a human says, and ONE
--     time-series table (wrought_metrics) for everything a device pushes.
--     A person emits a sentence a day; a watch emits a row a minute. Putting
--     them in one table makes both queries bad forever.
--
--   * local_date is STORED, not derived. A day is a day in the user's own
--     timezone, and "yesterday" at 1am means something different in Halifax
--     than in Victoria. Deriving it from UTC at read time is a bug factory,
--     and every single number in the brief is grouped by it.
--
--   * source_ref makes ingest idempotent. A watch WILL re-send the same
--     night's sleep four times. The unique index is the only thing standing
--     between that and four nights of sleep.
--
--   * estimated is a first-class column. "Two eggs and toast" becomes a
--     calorie number by inference, not measurement. The product's entire
--     credibility rests on never once presenting a guess as a fact.
--
-- Nothing here is a medical record and nothing here diagnoses anything.
-- It is a diary that can do arithmetic and will not flatter you.
--
-- Safe to run more than once. Paste into the Supabase SQL editor.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ── Profile ─────────────────────────────────────────────────────────────────
-- The handful of facts that make the numbers mean anything, asked once, ever.
-- Everything except timezone is nullable on purpose: WROUGHT works knowing
-- nothing but what clock you're on, and must never hold a brief hostage
-- waiting for a birth year.

create table if not exists public.wrought_profile (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  timezone      text not null default 'America/Toronto',
  units         text not null default 'metric',   -- display only; storage is metric
  height_cm     numeric,
  birth_year    integer,
  sex           text,                             -- free text, the user's own words
  training_age  text,                             -- 'beginner' | '3 years lifting' | whatever they say
  equipment     text[],                           -- 'full gym', 'dumbbells', 'bodyweight', 'barbell'
  train_days    integer,                          -- realistic sessions per week
  dietary       text[],                           -- 'vegetarian', 'no dairy', 'halal', 'hates fish'
  bluntness     text not null default 'honest',   -- gentle | honest | brutal
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.wrought_profile is
  'One row per user. Asked once, remembered forever — this table is the reason you never re-explain yourself.';
comment on column public.wrought_profile.units is
  'Display preference only. Storage is always metric (kg, cm). Conversion happens at the edge, never in the database.';
comment on column public.wrought_profile.bluntness is
  'How hard the verdict hits. The user sets this and it is honoured exactly — nobody gets brutality they did not ask for, and nobody who asked for honesty gets a cheerleader.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_units_valid') then
    alter table public.wrought_profile add constraint wrought_profile_units_valid
      check (units in ('metric', 'imperial'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_bluntness_valid') then
    alter table public.wrought_profile add constraint wrought_profile_bluntness_valid
      check (bluntness in ('gentle', 'honest', 'brutal'));
  end if;
end $$;

-- ── Events — the human log ──────────────────────────────────────────────────
-- "eggs and black coffee, 40 minutes upper body, 182 on the scale" becomes
-- three rows. summary is the sentence a person would actually say out loud;
-- detail is the structure a query needs. Both, always — the summary is what
-- gets read back, the detail is what gets counted.

create table if not exists public.wrought_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  event_type   text not null,
  occurred_at  timestamptz not null default now(),
  local_date   date not null,
  summary      text not null,
  detail       jsonb not null default '{}'::jsonb,
  source       text not null default 'agent',
  source_ref   text,
  estimated    boolean not null default false,
  raw_input    text,                              -- what they actually said, kept verbatim
  created_at   timestamptz not null default now()
);

comment on table public.wrought_events is
  'Everything the user tells WROUGHT, one row per thing. The diary.';
comment on column public.wrought_events.event_type is
  'food | drink | workout | weight | measurement | sleep | symptom | mood | supplement | note';
comment on column public.wrought_events.local_date is
  'The calendar day in the user''s own timezone. Every brief groups on this and never on UTC.';
comment on column public.wrought_events.detail is
  'Typed payload. food: {items[], calories, protein_g, carbs_g, fat_g}. workout: {kind, minutes, exercises[{name,sets,reps,weight_kg}], muscles[]}. measurement: {metric, value_cm}. weight: {value_kg}.';
comment on column public.wrought_events.raw_input is
  'The user''s literal words before any parsing. If the parser mangles "burrito" into "burrata", this is how it gets fixed instead of lost.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_events_type_valid') then
    alter table public.wrought_events add constraint wrought_events_type_valid
      check (event_type in ('food','drink','workout','weight','measurement',
                            'sleep','symptom','mood','supplement','note'));
  end if;
end $$;

create index if not exists wrought_events_user_day_idx
  on public.wrought_events (user_id, local_date desc);
create index if not exists wrought_events_user_type_day_idx
  on public.wrought_events (user_id, event_type, local_date desc);
create index if not exists wrought_events_detail_idx
  on public.wrought_events using gin (detail);

-- Idempotent ingest. Partial index so hand-logged rows (no ref) are unconstrained.
create unique index if not exists wrought_events_source_ref_idx
  on public.wrought_events (user_id, source, source_ref)
  where source_ref is not null;

-- ── Metrics — the device time series ────────────────────────────────────────
-- Steps, heart rate, HRV, sleep minutes, weight off a smart scale. Narrow and
-- tall, because a wearable will happily write forever and never ask permission.

create table if not exists public.wrought_metrics (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  metric       text not null,
  value        numeric not null,
  unit         text not null,
  measured_at  timestamptz not null,
  local_date   date not null,
  source       text not null,
  source_ref   text,
  created_at   timestamptz not null default now()
);

comment on table public.wrought_metrics is
  'Numeric time series pushed by devices: steps, heart_rate, resting_hr, hrv, sleep_minutes, weight_kg, active_calories, spo2, vo2max, body_fat_pct.';
comment on column public.wrought_metrics.source is
  'apple_health | oura | whoop | fitbit | garmin | withings | manual';

create index if not exists wrought_metrics_user_metric_idx
  on public.wrought_metrics (user_id, metric, measured_at desc);
create index if not exists wrought_metrics_user_day_idx
  on public.wrought_metrics (user_id, local_date desc);

-- The same night's sleep, sent four times, stays one row.
create unique index if not exists wrought_metrics_dedupe_idx
  on public.wrought_metrics (user_id, source, metric, measured_at);

-- ── Goals ───────────────────────────────────────────────────────────────────
-- What the verdict is measured against. Without one the brief still works —
-- it just reports instead of scoring, which is a weaker product but never a
-- broken one.

create table if not exists public.wrought_goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  goal         text not null,                     -- their words: "get to 180 by Christmas"
  metric       text,                              -- 'protein_g' | 'weight_kg' | 'workout_days' | 'steps'
  target_value numeric,
  target_unit  text,
  direction    text not null default 'at_least',  -- at_least | at_most | reach
  cadence      text not null default 'daily',     -- daily | weekly | once
  target_date  date,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

comment on table public.wrought_goals is
  'What the user is actually trying to do, in their own words, plus an optional number the brief can score against.';
comment on column public.wrought_goals.direction is
  'at_least (protein, steps, sessions), at_most (alcohol, calories), reach (a target weight by a date).';

create index if not exists wrought_goals_user_idx on public.wrought_goals (user_id) where active;

-- ── Eating window ───────────────────────────────────────────────────────────
-- Snacking is a time problem before it is a food problem. Nobody eats 900
-- calories of crisps at 2pm; they do it at 11pm standing at the counter.
-- The window is stored so the brief can say "you closed at 8, it's 10:40"
-- without ever having to be asked what the plan was.

create table if not exists public.wrought_eating_window (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  opens_at     time not null default '11:00',
  closes_at    time not null default '19:00',
  active       boolean not null default true,
  strictness   text not null default 'soft',      -- soft (a note) | firm (called out in the verdict)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.wrought_eating_window is
  'The hours the user has decided they eat between. WROUGHT never invents one and never imposes one — it only holds the line the user drew.';

-- ── Connections — watches, rings, scales ────────────────────────────────────
-- Apple is the awkward one, and it is worth writing down why in the schema so
-- nobody rediscovers it painfully in six months:
--
--   HealthKit has NO cloud API. There is no server-to-server way to read an
--   Apple Watch, at any price, with any entitlement. Apple Health data lives on
--   the device and leaves only if the device pushes it.
--
-- So Apple connects by PUSH — an iOS Shortcut (or an export app) POSTing to
-- /ingest with a key from wrought_ingest_keys. Oura, Whoop, Fitbit, Garmin and
-- Withings all have real cloud OAuth APIs and connect by PULL, with tokens
-- stored here. Two modes, one table, because to the rest of the system they
-- are all just sources.

create table if not exists public.wrought_connections (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  provider         text not null,
  mode             text not null default 'push',   -- push | pull
  external_user_id text,
  access_token     text,
  refresh_token    text,
  expires_at       timestamptz,
  scopes           text,
  status           text not null default 'active', -- active | expired | revoked
  last_sync_at     timestamptz,
  last_error       text,
  created_at       timestamptz not null default now()
);

comment on table public.wrought_connections is
  'Linked devices and services. Tokens are reachable only by the service role — no browser client ever selects from this table.';
comment on column public.wrought_connections.mode is
  'push = the device sends to us (Apple Health, via Shortcut — the only way Apple data can ever leave the phone). pull = we fetch with OAuth (Oura, Whoop, Fitbit, Garmin, Withings).';

create unique index if not exists wrought_connections_user_provider_idx
  on public.wrought_connections (user_id, provider);

-- ── Ingest keys — how a phone authenticates without OAuth ───────────────────
-- An iOS Shortcut cannot run a PKCE dance. It gets one long random bearer,
-- stored only as a SHA-256 hash, scoped to writing health data for exactly one
-- user and nothing else. Revocable and rotatable without touching the login.

create table if not exists public.wrought_ingest_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  token_hash   text not null unique,
  label        text not null default 'Apple Health',
  last_used_at timestamptz,
  revoked      boolean not null default false,
  created_at   timestamptz not null default now()
);

comment on table public.wrought_ingest_keys is
  'Write-only bearer tokens for device push. Stored hashed; the plaintext is shown to the user exactly once, at creation, and is never recoverable.';

create index if not exists wrought_ingest_keys_user_idx
  on public.wrought_ingest_keys (user_id) where not revoked;

-- ── Briefs — the verdict, kept ──────────────────────────────────────────────
-- One per user per day. Cached so re-reading costs nothing, and so "what did
-- you tell me last Tuesday" has an actual answer instead of a fresh opinion.
-- Keeping them is also what makes the product improve: a month of verdicts is
-- a record of whether the advice was any good.

create table if not exists public.wrought_briefs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  local_date   date not null,
  kind         text not null default 'evening',   -- morning | evening
  facts        jsonb not null default '{}'::jsonb, -- everything computed server-side
  verdict      text,                               -- the honest paragraph
  created_at   timestamptz not null default now()
);

comment on table public.wrought_briefs is
  'The daily read, kept. facts is arithmetic and is always trustworthy; verdict is written prose and is the only part of WROUGHT that is an opinion.';

create unique index if not exists wrought_briefs_user_day_kind_idx
  on public.wrought_briefs (user_id, local_date, kind);

-- ── Memory — the things that do not fit a column ────────────────────────────
-- "My left knee goes if I squat below parallel." "I travel every third week."
-- "Do not suggest running, I hate it." None of this is a metric and all of it
-- changes every recommendation forever. This is the table that means you never
-- have to say it twice.

create table if not exists public.wrought_memory (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  fact         text not null,
  category     text not null default 'general',   -- injury | preference | schedule | context | general
  confidence   numeric not null default 0.85,
  source       text not null default 'agent',
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

comment on table public.wrought_memory is
  'Durable free-text facts about the person that no column can hold. Injuries, hatreds, schedules. Read before every recommendation.';

create index if not exists wrought_memory_user_idx
  on public.wrought_memory (user_id, category) where active;

-- ── Row level security ──────────────────────────────────────────────────────
-- This is the most personal data anybody will ever hand this system. Default
-- deny everywhere. A signed-in user reaches their own rows and nobody else's.
-- The two token tables get NO policy at all, so a leaked anon key cannot read
-- a wearable credential or forge an ingest bearer.

alter table public.wrought_profile       enable row level security;
alter table public.wrought_events        enable row level security;
alter table public.wrought_metrics       enable row level security;
alter table public.wrought_goals         enable row level security;
alter table public.wrought_eating_window enable row level security;
alter table public.wrought_briefs        enable row level security;
alter table public.wrought_memory        enable row level security;
alter table public.wrought_connections   enable row level security;
alter table public.wrought_ingest_keys   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['wrought_profile','wrought_events','wrought_metrics','wrought_goals',
                           'wrought_eating_window','wrought_briefs','wrought_memory']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_own', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_own', t);
  end loop;
end $$;

-- wrought_connections and wrought_ingest_keys are deliberately policy-free.
-- RLS is on and nothing is permitted, so only the service role touches them.

-- ============================================================================
-- After this runs, a Tuesday looks like:
--
--   07:10  the watch has already filed 6h42m of sleep and a resting HR of 54
--   08:30  "eggs and black coffee"                    → 1 food event
--   12:45  "chicken burrito bowl, no rice"            → 1 food event
--   18:20  "pushed 40 minutes, bench 3x8 at 80"       → 1 workout event
--   22:00  brief: what you ate, what you moved, what the scale is doing,
--          what you got right, what you did not, and what tomorrow is for.
--
-- and not one word of it had to be re-explained the next morning.
-- ============================================================================


-- ─────────────────────────────────────────────── 002_wrought_oauth.sql ────

-- ============================================================================
-- WROUGHT — schema 002: OAuth 2.1
--
-- This is what makes "Sign in with Wrought" appear inside ChatGPT and Claude
-- instead of asking a human being to copy a JWT out of a web page and paste it
-- into a connector settings box. Nobody does that twice.
--
-- OAuth 2.1 with PKCE and dynamic client registration, because MCP clients
-- register themselves — there is no console where someone adds ChatGPT by hand.
--
-- Everything secret is stored hashed. A dump of these tables yields no usable
-- credential: codes and tokens are SHA-256, and the plaintext exists only in
-- the response that created it.
--
-- Safe to run more than once. Run after 001.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ── Clients ─────────────────────────────────────────────────────────────────
-- Registered by the MCP client itself at first connect (RFC 7591). ChatGPT and
-- Claude each land here on their own, unattended.

create table if not exists public.wrought_oauth_clients (
  client_id     text primary key,
  client_name   text,
  redirect_uris text[] not null,
  grant_types   text[] not null default array['authorization_code','refresh_token'],
  scope         text not null default 'wrought',
  created_at    timestamptz not null default now()
);

comment on table public.wrought_oauth_clients is
  'Self-registered MCP clients. Public clients only — PKCE replaces the client secret, which a desktop app could never keep anyway.';

-- ── Authorization codes ─────────────────────────────────────────────────────
-- Single use, short lived, bound to a PKCE challenge. Stored hashed so a
-- database read cannot replay one.

create table if not exists public.wrought_oauth_codes (
  code_hash       text primary key,
  client_id       text not null,
  user_id         uuid not null references auth.users(id) on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  challenge_method text not null default 'S256',
  expires_at      timestamptz not null,
  used            boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists wrought_oauth_codes_expiry_idx on public.wrought_oauth_codes (expires_at);

-- ── Access and refresh tokens ───────────────────────────────────────────────
-- Access tokens are what getAuthUser() checks on every MCP call. Refresh
-- tokens are why signing in once actually means once — the connector renews
-- silently and the user never sees a login again.

create table if not exists public.wrought_oauth_tokens (
  token_hash  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  client_id   text,
  scope       text not null default 'wrought',
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists wrought_oauth_tokens_user_idx   on public.wrought_oauth_tokens (user_id);
create index if not exists wrought_oauth_tokens_expiry_idx on public.wrought_oauth_tokens (expires_at);

create table if not exists public.wrought_oauth_refresh (
  token_hash  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  client_id   text,
  scope       text not null default 'wrought',
  revoked     boolean not null default false,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists wrought_oauth_refresh_user_idx on public.wrought_oauth_refresh (user_id);

-- ── Lock it all down ────────────────────────────────────────────────────────
-- RLS on, no policies at all. These tables are service-role only: a browser
-- holding the anon key must never be able to read a token row, hashed or not.

alter table public.wrought_oauth_clients enable row level security;
alter table public.wrought_oauth_codes   enable row level security;
alter table public.wrought_oauth_tokens  enable row level security;
alter table public.wrought_oauth_refresh enable row level security;

-- ── Housekeeping ────────────────────────────────────────────────────────────
-- Expired codes and tokens are litter. Call this from a scheduled function, or
-- run it by hand now and then — nothing breaks if it never runs, the tables
-- just grow.

create or replace function public.wrought_oauth_gc()
returns void language sql security definer set search_path = public as $$
  delete from public.wrought_oauth_codes  where expires_at < now() - interval '1 day';
  delete from public.wrought_oauth_tokens where expires_at < now() - interval '7 days';
  delete from public.wrought_oauth_refresh where expires_at < now() - interval '30 days';
$$;


-- ──────────────────────────────────────────── 003_wrought_training.sql ────

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
  position     integer,
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
comment on column public.wrought_sets.position is
  'Where this exercise sat in the session — 1st, 2nd, 5th. Almost nobody stores this, which is why almost nobody can answer the question it unlocks: your bench is not stalling, it is just always going third. The lift that goes first gets the freshest nervous system, and over enough sessions the cost of going late is measurable per exercise rather than guessed at.';
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


-- ───────────────────────────────────────────── 004_wrought_fasting.sql ────

-- ============================================================================
-- WROUGHT — schema 004: fasting
--
-- The eating window in 001 is a PLAN — the hours somebody has decided they eat
-- between. This is the RECORD: what actually happened last night. The two are
-- different in the way a timetable is different from a train, and conflating
-- them is how a product ends up congratulating you for a fast you did not do.
--
-- It is a trust system and that is deliberate. "Stopped eating at eight, ate
-- again at eight" is a complete entry. There is no button to press at the start
-- and no timer to forget to stop — a fasting tracker that depends on remembering
-- to open it at 8pm measures the days you remembered, exactly like every food
-- log that died on the same problem.
--
-- Safe to run more than once. Run after 001.
-- ============================================================================

-- 'fast' joins the event types. Doing it as a real type rather than a note with
-- a flag on it is what makes "how long have I been averaging" a query instead of
-- a scan through free text.
alter table public.wrought_events drop constraint if exists wrought_events_type_valid;

alter table public.wrought_events add constraint wrought_events_type_valid
  check (event_type in ('food','drink','workout','weight','measurement',
                        'sleep','symptom','mood','supplement','note','fast'));

comment on column public.wrought_events.event_type is
  'food | drink | workout | weight | measurement | sleep | symptom | mood | supplement | note | fast';


-- ──────────────────────────────────────────── 005_wrought_activity.sql ────

-- ============================================================================
-- WROUGHT — schema 005: how much you actually move
--
-- restingBurn() answers "what would you burn lying still all day". Without a
-- watch, that was the ONLY number available, so calories out came back as the
-- resting figure and everything a person did between waking and sleeping
-- counted as nothing. Four hours on your feet at work registered as zero, and
-- the deficit that came out the other end was wrong in the direction that
-- matters — it makes people eat less than they should.
--
-- One column fixes it. A standard activity multiplier over the resting burn is
-- how every dietitian estimates this, and it is a far better answer than
-- pretending the day did not happen.
--
-- The device is still better and always wins when it is there: measured beats
-- multiplied. This is what the ninety per cent of people with no wearable get,
-- and what everybody gets on the day they leave the watch on the charger.
--
-- Safe to run more than once. Run after 001.
-- ============================================================================

alter table public.wrought_profile
  add column if not exists activity_level text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_activity_valid') then
    alter table public.wrought_profile add constraint wrought_profile_activity_valid
      check (activity_level is null or activity_level in
        ('sedentary', 'light', 'moderate', 'active', 'very_active'));
  end if;
end $$;

comment on column public.wrought_profile.activity_level is
  'How much they move outside deliberate training: sedentary (desk, little walking) | light | moderate | active (on their feet all day) | very_active (physical job). Used as a multiplier over resting burn ONLY when no device is reporting active calories — a measurement always beats an estimate.';


-- ──────────────────────────────────────────── 006_wrought_identity.sql ────

-- 006_wrought_identity.sql
-- Many doors, one account.
--
-- The founder's problem, in his words: "even though your GTP might have a
-- different email. You're gonna have to link it to." He signs in at wrought.fit
-- with Google. ChatGPT knows him by some other address. Without something here,
-- those are two strangers who happen to be the same person, and his training
-- history quietly splits down the middle.
--
-- Most of the fix is Supabase's own identity linking, which happens in the
-- browser and needs no schema. This file is for the case linking came too late:
-- two accounts already exist, both with data in them, and one has to absorb the
-- other WITHOUT losing a row and WITHOUT tripping a unique index on the way.
--
-- It is one function rather than a dozen round trips from a Netlify handler
-- because a half-finished merge is the worst possible state for this product to
-- be in — some of your history under one id, the rest under another, and the
-- brief confidently averaging whichever half it can see. A transaction is the
-- only honest way to move somebody's life between two rows.

-- ── The merge ───────────────────────────────────────────────────────────────
-- keep   = the account that survives, and the one the person is signed into
-- absorb = the account being emptied into it
--
-- Every table is handled the same way: delete from `absorb` only what would
-- collide with a row `keep` already has, then move the rest. Deleting the
-- duplicate is right — a collision on these indexes means both accounts were
-- told about the same night's sleep or the same Shortcut push, so the row is
-- not lost, it is already there.

create or replace function public.wrought_merge_accounts(keep uuid, absorb uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  moved jsonb := '{}'::jsonb;
  n integer;
begin
  if keep is null or absorb is null then
    raise exception 'both accounts are required';
  end if;
  if keep = absorb then
    raise exception 'an account cannot absorb itself';
  end if;

  -- ── Events ──
  -- The idempotency index is (user_id, source, source_ref) where source_ref is
  -- not null. Hand-logged rows carry no ref and can never collide, which is
  -- correct: two accounts each holding a sentence about lunch is two lunches
  -- until proven otherwise, and inventing a duplicate to delete would lose one.
  delete from wrought_events b
   where b.user_id = absorb and b.source_ref is not null
     and exists (select 1 from wrought_events a
                  where a.user_id = keep and a.source = b.source
                    and a.source_ref = b.source_ref);
  update wrought_events set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('events', n);

  -- ── Device metrics ──
  -- The likeliest collision in the whole merge: one watch, pushing the same
  -- night to both accounts because the Shortcut was set up twice.
  delete from wrought_metrics b
   where b.user_id = absorb
     and exists (select 1 from wrought_metrics a
                  where a.user_id = keep and a.source = b.source
                    and a.metric = b.metric and a.measured_at = b.measured_at);
  update wrought_metrics set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('metrics', n);

  -- ── Sessions ──
  -- At most one workout may be active per account. If both have one on the go,
  -- the absorbed account's is marked abandoned rather than deleted — it still
  -- has sets hanging off it, and those are the finest grain in the system.
  update wrought_sessions set status = 'abandoned', ended_at = coalesce(ended_at, now())
   where user_id = absorb and status = 'active'
     and exists (select 1 from wrought_sessions a where a.user_id = keep and a.status = 'active');
  update wrought_sessions set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('sessions', n);

  -- ── Sets ── nothing unique to trip over, and nothing here may ever be lost.
  update wrought_sets set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('sets', n);

  -- ── Routines ── one "leg day" per person, matched case-insensitively.
  delete from wrought_routines b
   where b.user_id = absorb and b.active
     and exists (select 1 from wrought_routines a
                  where a.user_id = keep and a.active and lower(a.name) = lower(b.name));
  update wrought_routines set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('routines', n);

  -- ── Briefs ── one per day per kind. The kept account's verdict wins; it is
  -- the one the person has actually been reading.
  delete from wrought_briefs b
   where b.user_id = absorb
     and exists (select 1 from wrought_briefs a
                  where a.user_id = keep and a.local_date = b.local_date and a.kind = b.kind);
  update wrought_briefs set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('briefs', n);

  -- ── Connections ── one row per provider per account.
  delete from wrought_connections b
   where b.user_id = absorb
     and exists (select 1 from wrought_connections a
                  where a.user_id = keep and a.provider = b.provider);
  update wrought_connections set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('connections', n);

  -- ── Goals, memory, ingest keys ── no per-user uniqueness to collide with.
  update wrought_goals       set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('goals', n);
  update wrought_memory      set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('memory', n);
  -- Keys are hashed and globally unique, so a phone that was pushing to the
  -- absorbed account keeps working and now writes to the right one.
  update wrought_ingest_keys set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('ingest_keys', n);

  -- ── Live OAuth grants ──
  -- This is the line that actually solves the founder's complaint. ChatGPT holds
  -- a token minted for the absorbed account; moving it means the connector he
  -- already set up keeps working and starts writing to the surviving account,
  -- with nothing to reconnect and nothing to explain.
  update wrought_oauth_tokens  set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('oauth_tokens', n);
  update wrought_oauth_refresh set user_id = keep where user_id = absorb;
  update wrought_oauth_codes   set user_id = keep where user_id = absorb;

  -- ── Profile ──
  -- Five facts asked once, ever. If the absorbed account is the one that was
  -- asked, throwing them away would mean asking again — so the surviving
  -- profile keeps everything it already knows and fills its blanks from the
  -- other. Bluntness and timezone are settings the person chose on the account
  -- they are still using, so those are never overwritten.
  if exists (select 1 from wrought_profile where user_id = keep) then
    update wrought_profile a set
      height_cm      = coalesce(a.height_cm,     b.height_cm),
      birth_year     = coalesce(a.birth_year,    b.birth_year),
      sex            = coalesce(a.sex,           b.sex),
      training_age   = coalesce(a.training_age,  b.training_age),
      equipment      = coalesce(a.equipment,     b.equipment),
      train_days     = coalesce(a.train_days,    b.train_days),
      dietary        = coalesce(a.dietary,       b.dietary),
      activity_level = coalesce(a.activity_level, b.activity_level),
      notes          = coalesce(a.notes,         b.notes),
      updated_at     = now()
      from wrought_profile b
     where a.user_id = keep and b.user_id = absorb;
    delete from wrought_profile where user_id = absorb;
  else
    update wrought_profile set user_id = keep where user_id = absorb;
  end if;

  -- ── Eating window ── a timetable, and the surviving one is the current one.
  if exists (select 1 from wrought_eating_window where user_id = keep) then
    delete from wrought_eating_window where user_id = absorb;
  else
    update wrought_eating_window set user_id = keep where user_id = absorb;
  end if;

  return moved || jsonb_build_object('kept', keep, 'absorbed', absorb);
end $$;

comment on function public.wrought_merge_accounts(uuid, uuid) is
  'Moves every row belonging to `absorb` onto `keep`, in one transaction, dropping only rows that would duplicate something `keep` already holds. Callable by the service role only — the API in front of it proves the caller controls BOTH accounts before it runs.';

-- The function is SECURITY DEFINER, so it runs past row level security by
-- design — a merge is exactly the operation RLS is built to stop. That makes
-- who may call it the entire safety story: nobody signed in through the browser
-- can, ever. Only the service role, from api-merge.js, which first verifies a
-- live token for each of the two accounts.
revoke all on function public.wrought_merge_accounts(uuid, uuid) from public;
revoke all on function public.wrought_merge_accounts(uuid, uuid) from anon;
revoke all on function public.wrought_merge_accounts(uuid, uuid) from authenticated;
grant execute on function public.wrought_merge_accounts(uuid, uuid) to service_role;


-- ──────────────────────────────────────────────── 007_wrought_push.sql ────

-- 007_wrought_push.sql
-- Where a notification is allowed to go.
--
-- An MCP server can never make ChatGPT speak first — the protocol is strictly
-- request/response and no amount of cleverness changes it. So the phone has to
-- carry the nightly read, and this is the address book for that.
--
-- A subscription is not a secret in the usual sense, but it is very close to
-- one: anybody holding the endpoint plus the two keys can put words on the
-- lock screen of a named person's phone. RLS keeps it to its owner, and nothing
-- in the browser ever selects another user's row.

create table if not exists public.wrought_push_subs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null,
  p256dh       text not null,          -- the browser's public key, base64url
  auth         text not null,          -- the 16-byte auth secret, base64url
  label        text,                   -- "iPhone", "Pixel" — whatever the user called it
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz,
  failures     integer not null default 0
);

comment on table public.wrought_push_subs is
  'Browser push subscriptions. The payload is encrypted to p256dh/auth before it leaves us, so the push service routes the notification without ever being able to read it — which matters when the message is a line about somebody''s eating.';

-- One row per endpoint. Re-subscribing on the same device must update rather
-- than accumulate, or a fortnight of reinstalls turns one verdict into six
-- notifications for the same night.
create unique index if not exists wrought_push_subs_endpoint_idx
  on public.wrought_push_subs (endpoint);

create index if not exists wrought_push_subs_user_idx
  on public.wrought_push_subs (user_id);

alter table public.wrought_push_subs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'wrought_push_subs' and policyname = 'own push subs') then
    create policy "own push subs" on public.wrought_push_subs
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- ── When to send ────────────────────────────────────────────────────────────
-- brief-nightly runs hourly, not nightly, because 22:00 is a different instant
-- for every user. This is the hour each person wants it, in their own timezone,
-- and null means the default. A notification that arrives at the wrong hour is
-- how somebody turns notifications off for good, and they never come back on.

alter table public.wrought_profile
  add column if not exists brief_hour integer;

alter table public.wrought_profile
  add column if not exists push_enabled boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_brief_hour_valid') then
    alter table public.wrought_profile add constraint wrought_profile_brief_hour_valid
      check (brief_hour is null or (brief_hour >= 0 and brief_hour <= 23));
  end if;
end $$;

comment on column public.wrought_profile.brief_hour is
  'Local hour to send the nightly read, 0-23. Null means 22:00.';
comment on column public.wrought_profile.push_enabled is
  'Off means no push, ever, whatever subscriptions exist. A per-device unsubscribe is a device decision; this is the person''s decision.';


-- ────────────────────────────────────────────── 008_wrought_blocks.sql ────

-- 008_wrought_blocks.sql
-- Multi-week training blocks — the last structural piece of the training side.
--
-- Routines already exist and per-exercise progression already works against
-- real history, so a block is an ordered schedule over them plus a rule for how
-- the volume moves. What it adds is the two things a person cannot do for
-- themselves week to week:
--
--   A DELOAD THAT WAS SCHEDULED BEFORE IT WAS NEEDED. Anybody who waits until
--   they feel like they need one takes it a fortnight late, in the form of an
--   injury or a month off. It is the most skipped thing in training and the
--   only fix is that something else already put it in the calendar.
--
--   AN END. "Week 4 of 8" is a reason to show up on the days nobody wants to.
--   A plan that finishes is finishable; an endless one is quit.
--
-- The plan is frozen at the moment it starts, exactly as sessions freeze their
-- routine. Editing the library must never rewrite a block somebody is halfway
-- through — that would change what they already did.

create table if not exists public.wrought_blocks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  programme_id  text,                                  -- which library programme it came from
  goal          text not null default 'general',
  tier          text not null default 'intermediate',
  weeks         integer not null,
  days_per_week integer not null,
  plan          jsonb not null default '{}'::jsonb,    -- the whole frozen block
  started_on    date not null,
  status        text not null default 'active',        -- active | done | abandoned
  ended_at      timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.wrought_blocks is
  'A multi-week training block. plan is a frozen copy of the schedule at the moment it started — editing the library must never rewrite a block somebody is halfway through.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_blocks_status_valid') then
    alter table public.wrought_blocks add constraint wrought_blocks_status_valid
      check (status in ('active','done','abandoned'));
  end if;
end $$;

-- One block at a time. Running two is not a plan, it is two plans, and the
-- deload in each falls in a different week.
create unique index if not exists wrought_blocks_one_active_idx
  on public.wrought_blocks (user_id) where status = 'active';

create index if not exists wrought_blocks_user_idx
  on public.wrought_blocks (user_id, started_on desc);

alter table public.wrought_blocks enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'wrought_blocks' and policyname = 'own blocks') then
    create policy "own blocks" on public.wrought_blocks
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- Which block a session belonged to. Counted rather than dated, because
-- MISSING A WEEK MUST NOT SKIP A WEEK — advancing the block by the calendar
-- would punish a chest infection by deleting the training, and the block would
-- read as finished having never happened.
alter table public.wrought_sessions
  add column if not exists block_id uuid references public.wrought_blocks(id) on delete set null;

create index if not exists wrought_sessions_block_idx
  on public.wrought_sessions (block_id) where block_id is not null;

comment on column public.wrought_sessions.block_id is
  'The block this session counted towards. Position in a block is the count of completed sessions carrying its id, never the date — a missed week is a missed week, not a skipped one.';


-- ────────────────────────────────────────────── 009_wrought_photos.sql ────

-- 009_wrought_photos.sql
-- Progress photos, which are the most sensitive thing this product will ever
-- hold and are treated accordingly.
--
-- WHY THEY EARN THEIR PLACE. The scale is a bad instrument over months: it
-- moves with salt, sleep, hydration and the time of day, and it cannot tell
-- three kilos of muscle from three kilos of anything else. Two photographs
-- eight weeks apart answer the question the number keeps getting wrong. This is
-- also the one place where somebody who has been doing everything right and
-- seeing a flat line finally gets to see that it worked.
--
-- WHY THEY ARE DANGEROUS. A photograph of somebody's body, dated, in a series,
-- next to their weight, is the single most exposing row in this database. So:
--
--   - The bucket is PRIVATE. Nothing is ever publicly readable, and no URL
--     exists that works without a signed token that expires.
--   - The path is namespaced by user id and RLS is enforced on the object, not
--     just on this table. A leaked row id must not be enough to fetch a file.
--   - NOTHING EVER READS THE IMAGE. No body-fat estimate, no pose scoring, no
--     "AI analysis". A number invented from a photograph of somebody's torso
--     would break the estimates-are-labelled doctrine in the place it would do
--     the most harm, and there is no version of it that is honest.
--   - No sharing feature. Not now, not later. Export gives them their own files
--     and what they do with them is their business.

create table if not exists public.wrought_photos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  path        text not null,                       -- object path inside the private bucket
  local_date  date not null,
  pose        text not null default 'front',       -- front | side | back | other
  weight_kg   numeric,                             -- what the scale said that day, if known
  note        text,
  created_at  timestamptz not null default now()
);

comment on table public.wrought_photos is
  'Progress photos. The files live in a private Storage bucket; this table holds only the path and the date. Nothing in this system ever reads the image itself — no body composition estimate is derived from a photograph, ever.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_photos_pose_valid') then
    alter table public.wrought_photos add constraint wrought_photos_pose_valid
      check (pose in ('front','side','back','other'));
  end if;
end $$;

create index if not exists wrought_photos_user_idx
  on public.wrought_photos (user_id, local_date desc);

-- One photo per pose per day. Twelve near-identical shots from one morning make
-- the comparison worse, not better.
create unique index if not exists wrought_photos_user_day_pose_idx
  on public.wrought_photos (user_id, local_date, pose);

alter table public.wrought_photos enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'wrought_photos' and policyname = 'own photos') then
    create policy "own photos" on public.wrought_photos
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- ── Storage ─────────────────────────────────────────────────────────────────
-- Private bucket. `public = false` is the load-bearing argument here: a public
-- bucket means every object is one guessed path away from the open internet.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wrought-photos', 'wrought-photos', false, 12582912,
        array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update
  set public = false,
      file_size_limit = 12582912,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic'];

-- Objects are namespaced by user id — wrought-photos/<uid>/<uuid>.jpg — and the
-- policy compares that first path segment to the caller. A leaked row id is
-- then not enough to fetch anything, because the object itself refuses.
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'objects' and policyname = 'wrought photos are private to their owner') then
    create policy "wrought photos are private to their owner" on storage.objects
      for all
      using (bucket_id = 'wrought-photos' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'wrought-photos' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;


-- ───────────────────────────────────────── 010_wrought_profile_web.sql ────

-- 010_wrought_profile_web.sql
-- A profile somebody can actually look at and edit.
--
-- Everything in wrought_profile was reachable only through the assistant, via
-- set_profile. That is the right way to CAPTURE it — five facts asked once, in
-- passing, never as an interrogation — but it is the wrong and only way to
-- CHECK it. "What does it think my height is" had no answer you could go and
-- read, and a memory product that cannot show you what it remembers is asking
-- for trust it has not earned.
--
-- A settings screen is not a form somebody has to fill in. It is a place to
-- look. Nothing here is required and nothing is asked for at signup.

alter table public.wrought_profile
  add column if not exists display_name text;

alter table public.wrought_profile
  add column if not exists avatar_path text;

comment on column public.wrought_profile.display_name is
  'What they want to be called. Used in the greeting and nowhere else — there is no social surface in this product for a name to leak onto.';
comment on column public.wrought_profile.avatar_path is
  'Object path in the private wrought-avatars bucket. Nothing ever reads this image, exactly as with progress photos.';

-- ── Avatars ─────────────────────────────────────────────────────────────────
-- A separate bucket from progress photos, and not because of tidiness: the two
-- have genuinely different lifetimes. Somebody deleting every progress photo
-- should not lose their profile picture, and a bulk operation on one bucket
-- must never be able to reach the other.
--
-- Private, like everything else here. A profile picture on a health product has
-- no reason to be publicly addressable — there is nowhere in WROUGHT it is
-- shown to another person, so a public URL would exist purely as a liability.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wrought-avatars', 'wrought-avatars', false, 4194304,
        array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update
  set public = false,
      file_size_limit = 4194304,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic'];

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'objects' and policyname = 'wrought avatars are private to their owner') then
    create policy "wrought avatars are private to their owner" on storage.objects
      for all
      using (bucket_id = 'wrought-avatars' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'wrought-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;


-- ────────────────────────────────────────── 011_wrought_membership.sql ────

-- 011_wrought_membership.sql
-- Memberships, trials and the codes that grant them.
--
-- Two things this has to get right, and they pull in opposite directions.
--
-- RUNNING A BUSINESS needs an operator who can see who signed up, who is still
-- here, who is on a trial and when it ends, and who has been cut off. None of
-- that is health data — it is the same metadata any service keeps about its own
-- customers, and refusing to keep it does not make anybody safer, it just makes
-- the thing unrunnable.
--
-- BEING TRUSTED WITH A HEALTH RECORD means the operator still cannot read one.
-- Not the food, not the weight, not the training, not a symptom. The admin
-- endpoint enforces that, and it is the reason this table holds counts and
-- dates and nothing else.
--
-- The other line that must not move: A REVOKED MEMBERSHIP NEVER TAKES SOMEBODY'S
-- DATA. They can still sign in and they can still export every row. A hub you
-- cannot leave is a trap, and that stays true whether or not somebody is paying.

create table if not exists public.wrought_memberships (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  plan        text not null default 'free',      -- free | trial | pro | comp
  status      text not null default 'active',    -- active | revoked
  started_on  date not null default current_date,
  expires_on  date,                              -- null = does not expire
  source      text,                              -- code | manual | signup
  code_used   text,
  note        text,                              -- operator's note, never shown to the user
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

comment on table public.wrought_memberships is
  'What plan somebody is on. NO row means free and active — the default is permissive on purpose, so a missing row can never lock anybody out of their own health record.';
comment on column public.wrought_memberships.status is
  'active | revoked. Only an explicit revoke blocks anything, and even then the export endpoint keeps working — see lib/membership.js.';
comment on column public.wrought_memberships.note is
  'For the operator. Never returned to the member it is about.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_memberships_plan_valid') then
    alter table public.wrought_memberships add constraint wrought_memberships_plan_valid
      check (plan in ('free','trial','pro','comp'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wrought_memberships_status_valid') then
    alter table public.wrought_memberships add constraint wrought_memberships_status_valid
      check (status in ('active','revoked'));
  end if;
end $$;

create index if not exists wrought_memberships_status_idx
  on public.wrought_memberships (status, plan);
create index if not exists wrought_memberships_expiry_idx
  on public.wrought_memberships (expires_on) where expires_on is not null;

alter table public.wrought_memberships enable row level security;

-- A member may READ their own plan and nothing else. Writing is service-role
-- only: an account that could set its own plan is not a plan.
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'wrought_memberships' and policyname = 'read own membership') then
    create policy "read own membership" on public.wrought_memberships
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- ── Codes ───────────────────────────────────────────────────────────────────
-- A trial code is a coupon, not a credential: it is meant to be written on a
-- card and handed to somebody, so it is stored as it reads. That is the
-- opposite of wrought_ingest_keys, which are secrets and are stored hashed.
-- The protection here is not secrecy, it is a use count and an expiry.

create table if not exists public.wrought_codes (
  code        text primary key,
  plan        text not null default 'trial',
  days        integer not null default 30,
  max_uses    integer not null default 1,
  used_count  integer not null default 0,
  expires_on  date,
  active      boolean not null default true,
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.wrought_codes is
  'Trial and comp codes. Stored in the clear because they are meant to be handed out; the limit is max_uses and expires_on, not secrecy.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_codes_plan_valid') then
    alter table public.wrought_codes add constraint wrought_codes_plan_valid
      check (plan in ('trial','pro','comp'));
  end if;
end $$;

create index if not exists wrought_codes_active_idx
  on public.wrought_codes (active) where active;

alter table public.wrought_codes enable row level security;
-- No policy at all: nobody reaches this table from a browser. Redemption goes
-- through the server, which is also the only thing that can increment a count
-- without a race.

-- One row per redemption, so "who used that code" is answerable and a single
-- code cannot be spent twice by the same person.
create table if not exists public.wrought_code_uses (
  code       text not null references public.wrought_codes(code) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  used_at    timestamptz not null default now(),
  primary key (code, user_id)
);

alter table public.wrought_code_uses enable row level security;

-- Redeeming safely. Doing this in the browser or across two round trips means
-- a code with one use left can be spent twice by two people pressing at once.
create or replace function public.wrought_redeem_code(p_code text, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.wrought_codes;
  ends date;
begin
  -- Locked for the duration of the transaction, which is the whole point of
  -- doing this in one function.
  select * into c from wrought_codes
   where lower(code) = lower(p_code) for update;

  if c.code is null then return jsonb_build_object('ok', false, 'error', 'no_such_code'); end if;
  if not c.active then return jsonb_build_object('ok', false, 'error', 'code_inactive'); end if;
  if c.expires_on is not null and c.expires_on < current_date then
    return jsonb_build_object('ok', false, 'error', 'code_expired');
  end if;
  if c.used_count >= c.max_uses then
    return jsonb_build_object('ok', false, 'error', 'code_used_up');
  end if;
  if exists (select 1 from wrought_code_uses where code = c.code and user_id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'already_redeemed');
  end if;

  ends := current_date + (c.days || ' days')::interval;

  insert into wrought_code_uses (code, user_id) values (c.code, p_user);
  update wrought_codes set used_count = used_count + 1 where code = c.code;

  insert into wrought_memberships (user_id, plan, status, started_on, expires_on, source, code_used)
  values (p_user, c.plan, 'active', current_date, ends, 'code', c.code)
  on conflict (user_id) do update set
    plan = excluded.plan,
    -- Redeeming a code un-revokes. If an operator hands somebody a code, that
    -- is the operator letting them back in.
    status = 'active',
    -- Never shorten what somebody already has. Stacking two trials extends.
    expires_on = greatest(coalesce(wrought_memberships.expires_on, current_date), excluded.expires_on),
    source = 'code',
    code_used = excluded.code_used,
    updated_at = now();

  return jsonb_build_object('ok', true, 'plan', c.plan, 'expires_on', ends, 'days', c.days);
end $$;

revoke all on function public.wrought_redeem_code(text, uuid) from public;
revoke all on function public.wrought_redeem_code(text, uuid) from anon;
revoke all on function public.wrought_redeem_code(text, uuid) from authenticated;
grant execute on function public.wrought_redeem_code(text, uuid) to service_role;


-- ────────────────────────────────────────── 012_wrought_link_codes.sql ────

-- 012_wrought_link_codes.sql
-- Joining two accounts without an email or a password.
--
-- The founder's problem, said plainly and repeatedly: "you can merge multiple
-- emails. If the website is your Gmail and your GTP is iCloud, it should still
-- recognise the same person."
--
-- Merging already does exactly that, and it moves the live connector grant so
-- nothing has to be reconnected. The thing that kept blocking it was PROOF: the
-- merge demands control of both accounts, and the only proofs on offer were a
-- password nobody remembered and a reset email that never arrived.
--
-- But there is a third proof sitting right there. The assistant is already
-- holding a live token for the other account — that IS control of it, more
-- current than any password. So the assistant mints a short code, the person
-- reads it across to the dashboard, and the two halves are joined.
--
-- WHY A CODE IS SAFE HERE. It is minted only by an authenticated tool call, so
-- it cannot be requested for an account somebody does not already hold. It
-- lasts ten minutes, is single use, and is worthless on its own — redeeming it
-- also requires being signed in on the surviving account. Two proofs, same as
-- before; one of them is just no longer a password.

create table if not exists public.wrought_link_codes (
  code        text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

comment on table public.wrought_link_codes is
  'Short-lived codes proving control of an account, minted by the assistant so two accounts can be joined without a password or an email round trip.';

create index if not exists wrought_link_codes_user_idx
  on public.wrought_link_codes (user_id);
create index if not exists wrought_link_codes_expiry_idx
  on public.wrought_link_codes (expires_at) where used_at is null;

alter table public.wrought_link_codes enable row level security;
-- No policy: nothing in a browser ever reads or writes this. Minting happens
-- through the MCP tool and redemption through the merge endpoint, both of which
-- run as the service role after verifying who is asking.

-- Redeeming, in one locked step, so a code cannot be spent twice by two
-- requests arriving together.
create or replace function public.wrought_claim_link_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.wrought_link_codes;
begin
  select * into row from wrought_link_codes
   where upper(code) = upper(p_code) for update;

  if row.code is null then return null; end if;
  if row.used_at is not null then return null; end if;
  if row.expires_at < now() then return null; end if;

  update wrought_link_codes set used_at = now() where code = row.code;
  return row.user_id;
end $$;

revoke all on function public.wrought_claim_link_code(text) from public;
revoke all on function public.wrought_claim_link_code(text) from anon;
revoke all on function public.wrought_claim_link_code(text) from authenticated;
grant execute on function public.wrought_claim_link_code(text) to service_role;


-- ──────────────────────────────────────────────── 013_wrought_work.sql ────

-- ============================================================================
-- WROUGHT — schema 013: the day that is not training and not lying down
--
-- The founder, after a shift: "today I worked at the Petting Zoo. It's very
-- hard work so I wanna make sure that captures it and then add it to the total
-- as well — like one is your daily metabolic rate, your workout, and other."
--
-- He is right that there are three, and until now there were two. Resting burn
-- answers what a body costs lying still. A watch's active energy answers what
-- moving cost, when there is a watch. Between them sits the biggest number in
-- most people's week and the one nothing was counting: eight hours of actual
-- physical work.
--
-- Why its own event type rather than a 'workout' with a flag on it. A shift at
-- a petting zoo is not a training session, and filing it as one would count it
-- toward the weekly session target, put it in the training matrix, feed it to
-- progression, and let somebody hit "four workouts this week" by going to work.
-- The whole point of the expectation is that it is training. Separating them
-- also makes "how much do I burn at work" a query rather than a scan through
-- summaries with a flag nobody remembers to set.
--
-- Safe to run more than once. Run after 001 and 004.
-- ============================================================================

alter table public.wrought_events drop constraint if exists wrought_events_type_valid;

alter table public.wrought_events add constraint wrought_events_type_valid
  check (event_type in ('food','drink','workout','weight','measurement',
                        'sleep','symptom','mood','supplement','note','fast',
                        'activity'));

comment on column public.wrought_events.event_type is
  'food | drink | workout | weight | measurement | sleep | symptom | mood | supplement | note | fast | activity. '
  '''activity'' is work and daily life — a shift, a garden, a house move. Real '
  'expenditure that is not training, and must never be counted as a session.';


-- ──────────────────────────────────────────────── 014_wrought_plan.sql ────

-- ============================================================================
-- WROUGHT — schema 014: the plan, named and changeable
--
-- The founder: "your plans to tailor-made plan for you — aggressive,
-- non-aggressive fat burning, both — and how hard this thing's gonna prompt
-- you. This should be explained right when you try your first workout: what
-- plan are you on? Let's build this thing before diving right into it. And it
-- should give you the ability to change it any time."
--
-- Everything needed to ANSWER "what am I doing" already existed in pieces —
-- an intent on a goal, a bluntness setting, days a week, a tier. What did not
-- exist was the thing itself: one named plan a person can ask about, be told
-- about before their first session, and change in one sentence. A plan
-- scattered across four columns is not a plan somebody can hold in their head,
-- and one nobody can state is one nobody is following.
--
-- Two columns, because the two questions are genuinely different:
--
--   plan_pace — HOW FAST. gentle | steady | aggressive. Bounded: every pace
--     still floors intake at 1,200 and still projects under the rate careFlags
--     warns about. Aggressive is the fast end of safe, never a different set of
--     rules — a product that will pace somebody into its own safety warning if
--     they ask nicely does not really have one.
--
--   plan_push — HOW HARD IT CHASES YOU. light | normal | relentless. This
--     changes nothing about any number; it changes how often training gets
--     brought up unprompted. Deliberately separate from bluntness, which is
--     about how a verdict is WORDED: somebody can want the truth delivered flat
--     and still not want chasing every evening. Conflating them means turning
--     down the nagging also turns down the honesty, which is the one thing the
--     product exists to provide.
--
-- Both nullable. No plan is a valid state — it means WROUGHT has not been told
-- and will ask once, at the first workout, rather than assuming.
--
-- Safe to run more than once. Run after 001.
-- ============================================================================

alter table public.wrought_profile
  add column if not exists plan_pace text,
  add column if not exists plan_push text,
  add column if not exists plan_set_on date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_plan_pace_valid') then
    alter table public.wrought_profile add constraint wrought_profile_plan_pace_valid
      check (plan_pace is null or plan_pace in ('gentle', 'steady', 'aggressive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_plan_push_valid') then
    alter table public.wrought_profile add constraint wrought_profile_plan_push_valid
      check (plan_push is null or plan_push in ('light', 'normal', 'relentless'));
  end if;
end $$;

comment on column public.wrought_profile.plan_pace is
  'gentle | steady | aggressive. How fast the body goal is paced. Bounded — every '
  'pace floors intake at 1,200 kcal and stays under the loss rate careFlags warns '
  'about. Null means never chosen; ask once at the first session.';

comment on column public.wrought_profile.plan_push is
  'light | normal | relentless. How hard the assistant brings training up '
  'unprompted. Changes no number. Never overrides a care flag, which silences '
  'the pushing entirely whatever this says.';

comment on column public.wrought_profile.plan_set_on is
  'When the plan was last chosen. Read so a plan that has gone stale can be '
  'offered back for review rather than run forever unexamined.';


-- ─────────────────────────────────── 015_wrought_ingest_dedupe_fix.sql ────

-- ============================================================================
-- WROUGHT — schema 015: the index that was silently eating every workout
--
-- THE BUG. 001 created the ingest dedupe index as a PARTIAL index:
--
--     create unique index wrought_events_source_ref_idx
--       on public.wrought_events (user_id, source, source_ref)
--       where source_ref is not null;
--
-- The reasoning was sound — hand-logged rows carry no source_ref and should
-- not be constrained by one. The consequence was not.
--
-- Postgres cannot INFER a partial unique index from a bare column list. An
-- `ON CONFLICT (user_id, source, source_ref)` has to repeat the index
-- predicate before Postgres will match it, and PostgREST has no way to send a
-- predicate — so every upsert against this table failed outright with 42P10,
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification".
--
-- That is the entire reason workouts never appeared. Metrics arrived fine
-- because their index (wrought_metrics_dedupe_idx) is not partial, which is
-- exactly what made the failure so hard to see: steps, distance and calories
-- all landed, so the phone was obviously talking to the server, and only the
-- workouts vanished. The endpoint reported success either way because the
-- write result was checked with `if (!error)` and never surfaced.
--
-- THE FIX. Drop the predicate. Nothing is lost by doing so, because a unique
-- index already treats NULLs as distinct from each other — a thousand
-- hand-logged rows with source_ref NULL still coexist happily. The partial
-- clause was never buying the protection it looked like it was buying; it was
-- only making the index unusable for conflict inference.
--
-- Safe to run more than once. Run after 001.
-- ============================================================================

drop index if exists public.wrought_events_source_ref_idx;

-- No WHERE clause. NULL <> NULL in a unique index, so rows with no source_ref
-- remain completely unconstrained — same behaviour, now inferrable.
create unique index if not exists wrought_events_source_ref_idx
  on public.wrought_events (user_id, source, source_ref);

comment on index public.wrought_events_source_ref_idx is
  'Idempotent ingest: one row per (user, source, source_ref). Deliberately NOT '
  'partial — a partial index cannot be inferred by ON CONFLICT without its '
  'predicate, which PostgREST cannot send, and that failure silently discarded '
  'every device-sent workout. NULL source_ref rows stay unconstrained anyway '
  'because unique indexes treat NULLs as distinct.';


-- ────────────────────────────────────────── 016_wrought_set_source.sql ────

-- 016: tie derived sets to the workout event they came from.
--
-- THE GAP THIS CLOSES. A workout logged after the fact — "log my workout:
-- bench 235 for 4, rows 220 for 8" — arrives as ONE workout event whose
-- detail carries the exercises. Those exercises never reached wrought_sets,
-- which is the grain every strength read is computed from: the lift record,
-- the estimated max, last session, and the progression call for next time.
-- So the person most likely to be logging by telling their AI afterwards was
-- the person whose training counted for nothing in the one place it matters.
--
-- The server now explodes a workout event's exercises into wrought_sets.
-- event_id is what makes that IDEMPOTENT: re-structuring or amending the
-- event deletes and rewrites its derived sets instead of doubling them, and
-- deleting the event takes its derived sets with it.
--
-- Sets logged live through a session keep a NULL event_id — they are the
-- primary record, not derived from anything.
--
-- The code works before this runs (the 015 lesson: a door must be correct
-- before anybody runs the SQL) — it just loses idempotency on re-structured
-- events until it does.

alter table public.wrought_sets
  add column if not exists event_id bigint references public.wrought_events(id) on delete cascade;

create index if not exists wrought_sets_event_idx
  on public.wrought_sets (event_id) where event_id is not null;

