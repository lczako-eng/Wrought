-- 016: tie derived sets to the workout event they came from.
--
-- THE GAP THIS CLOSES. A workout logged after the fact — "log my workout:
-- bench 235 for 4, rows 220 for 8" — arrives as ONE workout event whose
-- detail carries the exercises. Those exercises never reached wrought_sets,
-- which is the grain every strength read is computed from: the lift record,
-- the estimated max, last session, and the progression call for next time.
-- So the person most likely to be logging by telling their AI afterwards was
-- the person whose training counted for nothing in the one place it matters.
--
-- The server now explodes a workout event's exercises into wrought_sets.
-- event_id is what makes that IDEMPOTENT: re-structuring or amending the
-- event deletes and rewrites its derived sets instead of doubling them, and
-- deleting the event takes its derived sets with it.
--
-- Sets logged live through a session keep a NULL event_id — they are the
-- primary record, not derived from anything.
--
-- The code works before this runs (the 015 lesson: a door must be correct
-- before anybody runs the SQL) — it just loses idempotency on re-structured
-- events until it does.

alter table public.wrought_sets
  add column if not exists event_id bigint references public.wrought_events(id) on delete cascade;

create index if not exists wrought_sets_event_idx
  on public.wrought_sets (event_id) where event_id is not null;
