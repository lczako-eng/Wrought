-- 017_wrought_session_aim.sql
-- What this particular workout is FOR.
--
-- The founder: "for every workout you have to tell them what you're trying to
-- achieve in every workout — it's just general. Are you going for pro level?"
--
-- He is right, and the gap was precise. The PLAN has an aim (lose weight, get
-- stronger, a pace, a push level). A saved ROUTINE has a write-up. But the
-- session actually happening had nothing: preflight has always ASKED "is there
-- anything you want out of today in particular", and the answer went nowhere.
-- It was read once by a model, in one turn, and then lost.
--
-- A session without a stated aim is exercise. A session with one is training,
-- and it is the difference between "chest day" and "chest day, and today I am
-- chasing the top set on incline because it has stalled for three weeks."
-- It also makes the session ANSWERABLE afterwards: did the thing you came in
-- to do actually happen.
--
-- Nullable on purpose. Somebody who just wants to start must always be able to
-- just start — a session that arrives is worth more than one still being
-- specified, which is the same rule that keeps the warm-up from blocking.

alter table public.wrought_sessions
  add column if not exists aim text;

comment on column public.wrought_sessions.aim is
  'What this session is for, in the person''s own words — asked once at the start and never invented. '
  'Carried on the checklist so it is visible while training, and stamped on the workout event at close '
  'so the record says what was being chased, not just what was lifted. Null is a real answer: somebody '
  'who wants to just start always can.';
