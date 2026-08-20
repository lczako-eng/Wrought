-- 018_wrought_alerts.sql
-- Notifications somebody asked for, in their own words.
--
-- THE ARCHITECTURE QUESTION THE FOUNDER ASKED, ANSWERED HERE. "You can tell
-- your AI to push anything you want, like you're fasting — you just have to say
-- it. Can you not do that? How would that work?"
--
-- An MCP server can never make ChatGPT speak first; the protocol is strictly
-- request/response. But the assistant does not have to BE the notification —
-- it only has to WRITE THE RULE. A scheduled function already runs every hour
-- for the nightly brief, so a rule stored here is a rule that fires. The AI is
-- the thing you talk to; this table is the thing that remembers; the cron is
-- the thing that speaks. Nothing about that needs the conversation to be open.
--
-- WHY RULES AND NOT MESSAGES. A queued message fires once and is gone, which
-- makes "tell me at nine every night" into a chore somebody has to redo. A
-- rule is standing, editable in one sentence, and can be turned off in one
-- more. last_sent_on is what stops it repeating within a day.

create table if not exists public.wrought_alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  -- What kind of thing this watches for. Kept as text with a check rather than
  -- an enum so a new kind is one migration and not a type rewrite.
  kind          text not null,

  -- The hour, in the USER'S OWN timezone, for anything on a clock. A
  -- notification at the wrong hour is how somebody mutes an app for good, and
  -- they never come back on.
  at_hour       integer check (at_hour is null or (at_hour >= 0 and at_hour <= 23)),

  -- For the proportional kinds: 0.8 means "when you reach 80% of it".
  threshold     numeric,

  -- Their words, kept verbatim. A reminder paraphrased into house style is a
  -- reminder that does not sound like the person who set it.
  text          text,

  -- Days of the week it runs, 0 = Sunday. Null means every day.
  days          integer[],

  active        boolean not null default true,

  -- The last local date this rule actually sent on, so it cannot fire twice in
  -- one day. Checked in the same statement that sends.
  last_sent_on  date,

  created_at    timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_alerts_kind_valid') then
    alter table public.wrought_alerts add constraint wrought_alerts_kind_valid
      check (kind in ('intake_pace','kitchen_closed','move','weigh_in','custom'));
  end if;
end $$;

create index if not exists wrought_alerts_user_idx
  on public.wrought_alerts (user_id) where active;

-- One rule of each clock-less kind per person. "Remind me about my calories"
-- said twice is one intention, not two notifications.
create unique index if not exists wrought_alerts_one_per_kind
  on public.wrought_alerts (user_id, kind) where active and kind <> 'custom';

alter table public.wrought_alerts enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'wrought_alerts' and policyname = 'own alerts') then
    create policy "own alerts" on public.wrought_alerts
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

comment on table public.wrought_alerts is
  'Standing notification rules. Written by the assistant when somebody says what they want reminded of, '
  'and read by the hourly scheduled function that actually sends. The AI can never push; it can only '
  'write the rule that does.';
comment on column public.wrought_alerts.last_sent_on is
  'Guards against firing twice in one day. A notification product that repeats itself is one people mute.';
comment on column public.wrought_alerts.text is
  'Their own words. Never rewritten into house style — a reminder that does not sound like the person who '
  'set it is one they stop reading.';
