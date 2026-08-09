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
