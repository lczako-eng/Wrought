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
