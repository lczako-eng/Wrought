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
-- THE CODE REFUSES TO DERIVE SETS UNTIL THIS RUNS, and that is deliberate.
-- The 015 lesson says a door must be correct before anybody runs the SQL —
-- and here "correct" means not corrupting. Without event_id there is no way
-- to identify an event's own derived rows, so re-deriving could only ever ADD
-- a second copy: an amend of "that was 105, not 100" would leave both, and
-- the number the amend explicitly corrected away would keep feeding the lift
-- record, the estimated max and every progression call, forever. A feature
-- that waits for a migration is a small cost. A strength record quietly
-- holding retracted numbers is not something the person it happens to can
-- ever find or undo.

alter table public.wrought_sets
  add column if not exists event_id uuid references public.wrought_events(id) on delete cascade;

create index if not exists wrought_sets_event_idx
  on public.wrought_sets (event_id) where event_id is not null;

-- Any derived rows written before the gate existed. They are identifiable
-- exactly: a set with no session and no event came from nowhere a live
-- session could have put it. Removing them is safe — the events they came
-- from are intact, so the next log, amend or re-structure re-derives them
-- properly, with an event_id and therefore with a way to clean them up next
-- time.
delete from public.wrought_sets
 where session_id is null
   and event_id is null;
