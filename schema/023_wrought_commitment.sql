-- 023_wrought_commitment.sql
-- The training commitment, stated in the terms notifications can be built on —
-- and the mid-week check that reads it back.
--
-- The founder, after the questionnaire blocked a mat workout over alcohol and
-- takeaway questions: "a lot of these questions should be focused more on
-- training so we can build the notifications around it — like how many muscle
-- building workouts you want to do a week, how many stamina, how many minutes
-- total that you're willing to commit — and then your notification should
-- reflect that, like a halfway-during-the-week point telling you where you're
-- at with any of this."
--
-- train_days (014) was one number: sessions a week. That cannot say whether a
-- week of three runs and no lifting is the week somebody agreed to. Three
-- columns split it the way the person thinks about it — strength sessions,
-- stamina sessions, minutes on the clock — and train_days becomes their sum so
-- every existing reader of the weekly expectation keeps working unchanged.
--
-- Columns, not goal rows, because they are siblings of train_days: the plan is
-- profile state, scored by weekSoFar against the Monday-based week, and a fake
-- goal row for each would draw three unscoreable rings on the dashboard.

alter table public.wrought_profile add column if not exists strength_per_week integer
  check (strength_per_week is null or (strength_per_week >= 0 and strength_per_week <= 14));
alter table public.wrought_profile add column if not exists cardio_per_week integer
  check (cardio_per_week is null or (cardio_per_week >= 0 and cardio_per_week <= 14));
alter table public.wrought_profile add column if not exists minutes_per_week integer
  check (minutes_per_week is null or (minutes_per_week >= 0 and minutes_per_week <= 3000));

comment on column public.wrought_profile.strength_per_week is
  'Muscle-building sessions a week they will honestly do. Their number, never an aspiration.';
comment on column public.wrought_profile.cardio_per_week is
  'Stamina (cardio) sessions a week. Sport counts as stamina; a shift never counts as either.';
comment on column public.wrought_profile.minutes_per_week is
  'Minutes of training a week, total, they will honestly commit. Hours on task, not hours in the building.';

-- The mid-week check: fires on a weekday they chose (Wednesday by default),
-- at an hour they chose, and reads the week against the commitment above.
-- Never a countdown, never guilt — an impossible week is stated, not counted
-- down to zero. The constraint is REPLACED rather than guarded, for the reason
-- 018 gives: a guarded "add if not exists" silently keeps the old list.
alter table public.wrought_alerts drop constraint if exists wrought_alerts_kind_valid;
alter table public.wrought_alerts add constraint wrought_alerts_kind_valid
  check (kind in ('intake_pace','goal_pace','goal_check','kitchen_closed','move','weigh_in','custom','week_check'));
