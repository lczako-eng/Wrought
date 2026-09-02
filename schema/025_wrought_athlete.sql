-- 025_wrought_athlete.sql
-- The athlete track: a person training FOR something, read against the
-- performance sensors and told what to work on.
--
-- The founder: "as a trainer for competitive sports, that should have a
-- version where we take more sensors — VO2 max, sprint time and stuff like
-- that. This should have a plan to build you like a super athlete, and your
-- reminders should reflect all this: you should be working out five times a
-- week, these are the ones I recommend you work on. It should analyse."
--
-- Two columns. `track` decides whether the athlete read runs at all — it costs
-- a metrics query and it would be noise for somebody losing weight. `sport`
-- is their word for what they train for, kept verbatim.

alter table public.wrought_profile add column if not exists track text not null default 'general';
alter table public.wrought_profile add column if not exists sport text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_track_valid') then
    alter table public.wrought_profile add constraint wrought_profile_track_valid
      check (track in ('general','athlete'));
  end if;
end $$;

comment on column public.wrought_profile.track is
  'general | athlete. Athlete turns on the performance read — VO2 max, HR recovery, HRV, resting HR, logged tests — and the what-to-work-on line in the briefs and the mid-week check.';
comment on column public.wrought_profile.sport is
  'What they train for, in their own words. Never used to invent a number.';
