-- ============================================================================
-- WROUGHT — schema 015: the index that was silently eating every workout
--
-- THE BUG. 001 created the ingest dedupe index as a PARTIAL index:
--
--     create unique index wrought_events_source_ref_idx
--       on public.wrought_events (user_id, source, source_ref)
--       where source_ref is not null;
--
-- The reasoning was sound — hand-logged rows carry no source_ref and should
-- not be constrained by one. The consequence was not.
--
-- Postgres cannot INFER a partial unique index from a bare column list. An
-- `ON CONFLICT (user_id, source, source_ref)` has to repeat the index
-- predicate before Postgres will match it, and PostgREST has no way to send a
-- predicate — so every upsert against this table failed outright with 42P10,
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification".
--
-- That is the entire reason workouts never appeared. Metrics arrived fine
-- because their index (wrought_metrics_dedupe_idx) is not partial, which is
-- exactly what made the failure so hard to see: steps, distance and calories
-- all landed, so the phone was obviously talking to the server, and only the
-- workouts vanished. The endpoint reported success either way because the
-- write result was checked with `if (!error)` and never surfaced.
--
-- THE FIX. Drop the predicate. Nothing is lost by doing so, because a unique
-- index already treats NULLs as distinct from each other — a thousand
-- hand-logged rows with source_ref NULL still coexist happily. The partial
-- clause was never buying the protection it looked like it was buying; it was
-- only making the index unusable for conflict inference.
--
-- Safe to run more than once. Run after 001.
-- ============================================================================

drop index if exists public.wrought_events_source_ref_idx;

-- No WHERE clause. NULL <> NULL in a unique index, so rows with no source_ref
-- remain completely unconstrained — same behaviour, now inferrable.
create unique index if not exists wrought_events_source_ref_idx
  on public.wrought_events (user_id, source, source_ref);

comment on index public.wrought_events_source_ref_idx is
  'Idempotent ingest: one row per (user, source, source_ref). Deliberately NOT '
  'partial — a partial index cannot be inferred by ON CONFLICT without its '
  'predicate, which PostgREST cannot send, and that failure silently discarded '
  'every device-sent workout. NULL source_ref rows stay unconstrained anyway '
  'because unique indexes treat NULLs as distinct.';
