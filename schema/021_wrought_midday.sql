-- 021_wrought_midday.sql
-- The midday check-in — the middle of the founder's three.
--
-- "The first one is how are you gonna do today, how are you feeling — an early
-- morning assessment. It should have a midday assessment to push you towards
-- achieving your goals, and the end of the day assessment."
--
-- The morning briefing (019) is the first and the nightly verdict has always
-- been the third. This is the second: where the day actually stands while
-- there is still an afternoon to act on it — which is the entire difference
-- between a report and a push. Same shape as the morning: off by default, the
-- person's own hour, half-hour precision, stamped only on successful delivery.

alter table public.wrought_profile
  add column if not exists midday_hour    smallint,
  add column if not exists midday_minute  smallint not null default 0,
  add column if not exists midday_sent_on date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wrought_profile_midday_valid') then
    alter table public.wrought_profile
      add constraint wrought_profile_midday_valid
      check ((midday_hour is null or (midday_hour >= 0 and midday_hour <= 23))
             and midday_minute in (0, 30));
  end if;
end $$;
