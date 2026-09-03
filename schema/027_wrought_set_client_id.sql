-- 027_wrought_set_client_id.sql
-- A set ticked with no signal is sent when the signal returns — once.
--
-- Gyms are basements. The rack screen and log_set both need the network, and
-- a tick that fails is a set that has to be remembered by a person mid-workout.
-- So the page keeps a queue and sends it when it can. The danger of a queue is
-- the retry: a request whose response was lost after the server wrote the row
-- is sent again and the set is doubled — silently, into the lift record, the
-- max and the progression. A client-minted id on each tick makes the second
-- send find the first row instead of writing another.
--
-- Unique per user rather than per session so the guarantee is a database
-- fact, not a code path. NULLs are distinct in a unique index, so every set
-- logged by voice — which carries no client id — is untouched.

alter table public.wrought_sets add column if not exists client_id text;

create unique index if not exists wrought_sets_client_id_idx
  on public.wrought_sets (user_id, client_id);

comment on column public.wrought_sets.client_id is
  'Minted by the rack screen for each tick, so a set queued offline and sent twice lands once. Null for every other door.';
