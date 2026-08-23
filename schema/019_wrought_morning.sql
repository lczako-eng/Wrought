-- 019_wrought_morning.sql
-- The brief that arrives before the day, not after it.
--
-- The founder: "every day at 7:30 morning brief, that is the start, as a
-- pop-up as well. That flags either."
--
-- WHY THIS IS NOT JUST brief_hour MOVED. The nightly read is a VERDICT — it
-- looks back at a day that is finished and says what it came to. Moving it to
-- the morning would report yesterday at breakfast, which is a worse version of
-- the same message: nothing in it can be acted on, because the day it describes
-- is over.
--
-- A morning brief is the opposite shape. It is a BRIEFING: where you stand
-- right now, what the week still needs, what is missing that would make every
-- other number mean something. Every line of it is something the next sixteen
-- hours can change. That is why it gets its own hour rather than borrowing one,
-- and why "as well" in his sentence is load-bearing — he wants both ends of the
-- day, and they are different messages.
--
-- THE HALF HOUR IS THE POINT, and it cost a cron change. 7:30 is when somebody
-- is actually awake and has not yet decided what to eat; 7:00 is an alarm going
-- off. brief-nightly moves to :00 and :30 so a stated half hour is honoured
-- exactly, for the same reason brief_hour is per-user in the first place — a
-- notification at the wrong moment is how somebody mutes an app permanently,
-- and they never turn it back on.
--
-- NULL MEANS OFF, and off is the default. Nothing in this product starts
-- notifying somebody because it decided it knew best; suggestAlerts offers and
-- the person chooses. An account that never asks for a morning brief never gets
-- one, and that is not a feature waiting to be discovered — it is the setting
-- working correctly.

alter table public.wrought_profile
  add column if not exists morning_hour   smallint,
  add column if not exists morning_minute smallint not null default 0,
  -- The evening read gets the same precision, so the two are set the same way
  -- and neither is the odd one out. Existing rows keep :00, which is what they
  -- have always effectively meant.
  add column if not exists brief_minute   smallint not null default 0;

-- Range, not presence. A bad hour must come back as a sentence from set_profile
-- rather than a constraint violation the person cannot read — but a value that
-- got past every check and into the column would fire at an hour nobody chose,
-- and a notification at 3am is precisely the failure this whole file is written
-- around. So the database refuses it too.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_morning_hour_valid') then
    alter table public.wrought_profile
      add constraint wrought_profile_morning_hour_valid
      check (morning_hour is null or (morning_hour >= 0 and morning_hour <= 23));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_minutes_valid') then
    alter table public.wrought_profile
      add constraint wrought_profile_minutes_valid
      check (morning_minute in (0, 30) and brief_minute in (0, 30));
  end if;
end $$;

-- The once-a-day guard for the morning send. Kept OFF the alerts table on
-- purpose: wrought_alerts holds rules a person wrote, and one of the settled
-- doctrines is that a care flag silences every coaching rule while leaving
-- their own reminders alone. A brief is neither — it is the product speaking,
-- not a rule they set, and folding it in would make that distinction impossible
-- to keep straight.
--
-- Stamped only when delivery actually SUCCEEDED, exactly like last_sent_on on
-- an alert. Marking it sent on a failure means the one morning a phone was off
-- is the morning the brief silently skips.
alter table public.wrought_profile
  add column if not exists morning_sent_on date;
