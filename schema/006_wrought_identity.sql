-- 006_wrought_identity.sql
-- Many doors, one account.
--
-- The founder's problem, in his words: "even though your GTP might have a
-- different email. You're gonna have to link it to." He signs in at wrought.fit
-- with Google. ChatGPT knows him by some other address. Without something here,
-- those are two strangers who happen to be the same person, and his training
-- history quietly splits down the middle.
--
-- Most of the fix is Supabase's own identity linking, which happens in the
-- browser and needs no schema. This file is for the case linking came too late:
-- two accounts already exist, both with data in them, and one has to absorb the
-- other WITHOUT losing a row and WITHOUT tripping a unique index on the way.
--
-- It is one function rather than a dozen round trips from a Netlify handler
-- because a half-finished merge is the worst possible state for this product to
-- be in — some of your history under one id, the rest under another, and the
-- brief confidently averaging whichever half it can see. A transaction is the
-- only honest way to move somebody's life between two rows.

-- ── The merge ───────────────────────────────────────────────────────────────
-- keep   = the account that survives, and the one the person is signed into
-- absorb = the account being emptied into it
--
-- Every table is handled the same way: delete from `absorb` only what would
-- collide with a row `keep` already has, then move the rest. Deleting the
-- duplicate is right — a collision on these indexes means both accounts were
-- told about the same night's sleep or the same Shortcut push, so the row is
-- not lost, it is already there.

create or replace function public.wrought_merge_accounts(keep uuid, absorb uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  moved jsonb := '{}'::jsonb;
  n integer;
begin
  if keep is null or absorb is null then
    raise exception 'both accounts are required';
  end if;
  if keep = absorb then
    raise exception 'an account cannot absorb itself';
  end if;

  -- ── Events ──
  -- The idempotency index is (user_id, source, source_ref) where source_ref is
  -- not null. Hand-logged rows carry no ref and can never collide, which is
  -- correct: two accounts each holding a sentence about lunch is two lunches
  -- until proven otherwise, and inventing a duplicate to delete would lose one.
  delete from wrought_events b
   where b.user_id = absorb and b.source_ref is not null
     and exists (select 1 from wrought_events a
                  where a.user_id = keep and a.source = b.source
                    and a.source_ref = b.source_ref);
  update wrought_events set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('events', n);

  -- ── Device metrics ──
  -- The likeliest collision in the whole merge: one watch, pushing the same
  -- night to both accounts because the Shortcut was set up twice.
  delete from wrought_metrics b
   where b.user_id = absorb
     and exists (select 1 from wrought_metrics a
                  where a.user_id = keep and a.source = b.source
                    and a.metric = b.metric and a.measured_at = b.measured_at);
  update wrought_metrics set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('metrics', n);

  -- ── Sessions ──
  -- At most one workout may be active per account. If both have one on the go,
  -- the absorbed account's is marked abandoned rather than deleted — it still
  -- has sets hanging off it, and those are the finest grain in the system.
  update wrought_sessions set status = 'abandoned', ended_at = coalesce(ended_at, now())
   where user_id = absorb and status = 'active'
     and exists (select 1 from wrought_sessions a where a.user_id = keep and a.status = 'active');
  update wrought_sessions set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('sessions', n);

  -- ── Sets ── nothing unique to trip over, and nothing here may ever be lost.
  update wrought_sets set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('sets', n);

  -- ── Routines ── one "leg day" per person, matched case-insensitively.
  delete from wrought_routines b
   where b.user_id = absorb and b.active
     and exists (select 1 from wrought_routines a
                  where a.user_id = keep and a.active and lower(a.name) = lower(b.name));
  update wrought_routines set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('routines', n);

  -- ── Briefs ── one per day per kind. The kept account's verdict wins; it is
  -- the one the person has actually been reading.
  delete from wrought_briefs b
   where b.user_id = absorb
     and exists (select 1 from wrought_briefs a
                  where a.user_id = keep and a.local_date = b.local_date and a.kind = b.kind);
  update wrought_briefs set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('briefs', n);

  -- ── Connections ── one row per provider per account.
  delete from wrought_connections b
   where b.user_id = absorb
     and exists (select 1 from wrought_connections a
                  where a.user_id = keep and a.provider = b.provider);
  update wrought_connections set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('connections', n);

  -- ── Goals, memory, ingest keys ── no per-user uniqueness to collide with.
  update wrought_goals       set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('goals', n);
  update wrought_memory      set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('memory', n);
  -- Keys are hashed and globally unique, so a phone that was pushing to the
  -- absorbed account keeps working and now writes to the right one.
  update wrought_ingest_keys set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('ingest_keys', n);

  -- ── Live OAuth grants ──
  -- This is the line that actually solves the founder's complaint. ChatGPT holds
  -- a token minted for the absorbed account; moving it means the connector he
  -- already set up keeps working and starts writing to the surviving account,
  -- with nothing to reconnect and nothing to explain.
  update wrought_oauth_tokens  set user_id = keep where user_id = absorb;
  get diagnostics n = row_count;  moved := moved || jsonb_build_object('oauth_tokens', n);
  update wrought_oauth_refresh set user_id = keep where user_id = absorb;
  update wrought_oauth_codes   set user_id = keep where user_id = absorb;

  -- ── Profile ──
  -- Five facts asked once, ever. If the absorbed account is the one that was
  -- asked, throwing them away would mean asking again — so the surviving
  -- profile keeps everything it already knows and fills its blanks from the
  -- other. Bluntness and timezone are settings the person chose on the account
  -- they are still using, so those are never overwritten.
  if exists (select 1 from wrought_profile where user_id = keep) then
    update wrought_profile a set
      height_cm      = coalesce(a.height_cm,     b.height_cm),
      birth_year     = coalesce(a.birth_year,    b.birth_year),
      sex            = coalesce(a.sex,           b.sex),
      training_age   = coalesce(a.training_age,  b.training_age),
      equipment      = coalesce(a.equipment,     b.equipment),
      train_days     = coalesce(a.train_days,    b.train_days),
      dietary        = coalesce(a.dietary,       b.dietary),
      activity_level = coalesce(a.activity_level, b.activity_level),
      notes          = coalesce(a.notes,         b.notes),
      updated_at     = now()
      from wrought_profile b
     where a.user_id = keep and b.user_id = absorb;
    delete from wrought_profile where user_id = absorb;
  else
    update wrought_profile set user_id = keep where user_id = absorb;
  end if;

  -- ── Eating window ── a timetable, and the surviving one is the current one.
  if exists (select 1 from wrought_eating_window where user_id = keep) then
    delete from wrought_eating_window where user_id = absorb;
  else
    update wrought_eating_window set user_id = keep where user_id = absorb;
  end if;

  return moved || jsonb_build_object('kept', keep, 'absorbed', absorb);
end $$;

comment on function public.wrought_merge_accounts(uuid, uuid) is
  'Moves every row belonging to `absorb` onto `keep`, in one transaction, dropping only rows that would duplicate something `keep` already holds. Callable by the service role only — the API in front of it proves the caller controls BOTH accounts before it runs.';

-- The function is SECURITY DEFINER, so it runs past row level security by
-- design — a merge is exactly the operation RLS is built to stop. That makes
-- who may call it the entire safety story: nobody signed in through the browser
-- can, ever. Only the service role, from api-merge.js, which first verifies a
-- live token for each of the two accounts.
revoke all on function public.wrought_merge_accounts(uuid, uuid) from public;
revoke all on function public.wrought_merge_accounts(uuid, uuid) from anon;
revoke all on function public.wrought_merge_accounts(uuid, uuid) from authenticated;
grant execute on function public.wrought_merge_accounts(uuid, uuid) to service_role;
