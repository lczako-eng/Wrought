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
