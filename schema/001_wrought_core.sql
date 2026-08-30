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
--   20:00  brief: what you ate, what you moved, what the scale is doing,
--          what you got right, what you did not, and what tomorrow is for.
--
-- and not one word of it had to be re-explained the next morning.
-- ============================================================================
