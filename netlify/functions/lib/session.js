// lib/session.js
// Closing a workout that nobody remembered to close.
//
// THE FAILURE THIS EXISTS TO FIX, because it is the worst kind: the data was
// there the whole time and every screen said the day was a rest day.
//
// A live session lives in `wrought_sessions` with status 'active', and every
// set goes straight into `wrought_sets`. But the WORKOUT EVENT — the row the
// brief, the day card, the matrix, the weekly count, the calendar square and
// the training burn all actually read — was only written by `end_session`. So
// somebody who logged a full session set by set and then walked out of the gym
// without saying "I'm done" had:
//
//   - every set stored, correctly, in the set table
//   - no workout event, so the day read "Rest day (nothing logged)"
//   - a session stuck on 'active', which api-progress filters out entirely
//   - and, the next time they started a workout, that session marked
//     ABANDONED — the training deleted from every view for good
//
// Nobody says "end session". They finish the last set and leave. The founder
// trains with headphones in, dictating between sets; the one sentence least
// likely to get said is the administrative one at the end. A log that only
// counts the sessions somebody remembered to close is the same failure as a
// food log that only counts the days somebody remembered to open the app.
//
// So: A SESSION WITH SETS IN IT IS TRAINING, whether or not it was closed.
// Nothing here is a judgement about effort or completeness — it files what
// happened, using the same finalisation `end_session` performs, so a session
// closed by hand and one closed by the server produce identical rows.
//
// THE MINUTES ARE START → LAST SET, NEVER START → NOW. A session left open
// overnight would otherwise bill fourteen hours of training, which invents
// hundreds of calories of burn and runs in the dangerous direction — an
// overstated burn is the number that tells somebody they have room to eat.

import { supabase, insertEvents, localDateFor } from './wrought.js';
import { sessionTotals } from './training.js';

// How long a gap means the session is over rather than resting. Real sets sit
// minutes apart; four hours is not a rest, it is somebody who left. Generous on
// purpose — closing a workout somebody is still doing is the worse mistake,
// because the next set would then land on a finished session.
const STALE_MS = 4 * 3600 * 1000;

// And a session that never got a single set. Nothing to file, so nothing is
// filed; it is only cleared out so it stops blocking the next one.
const EMPTY_MS = 8 * 3600 * 1000;

/**
 * Is this session still being trained, or did somebody walk out of the gym?
 *
 * Pure, and separate, because it is the only judgement call in the file and
 * getting it wrong in either direction is a real cost: close a live session
 * and the next set has nowhere to go; never close one and the workout is
 * invisible. Times are epoch milliseconds; a null lastSetAt means no set has
 * been logged at all.
 */
export function stillRunning({ lastSetAt = null, startedAt, now = Date.now() } = {}) {
  if (lastSetAt != null) return now - lastSetAt < STALE_MS;
  return now - startedAt < EMPTY_MS;
}

/**
 * File a running session as a finished workout, exactly as end_session does.
 *
 * @param session   the wrought_sessions row (needs id, name, kind, started_at)
 * @param note      the user's own words, when there are any
 * @returns { closed, empty, minutes, sets } — or null if nothing was done
 */
export async function finaliseSession(userId, profile, session,
                                      { note = null, closedBy = 'server', endedAt = null } = {}) {
  if (!session?.id) return null;

  const { data: sets } = await supabase.from('wrought_sets')
    .select('exercise, exercise_key, reps, weight_kg, rpe, muscles, logged_at')
    .eq('session_id', session.id).order('logged_at', { ascending: true });

  const rows = sets || [];

  // No sets at all is not a workout and must never become one. A phantom
  // session in the record is worse than a missing one — it counts toward the
  // weekly target, and an expectation met by a workout that never happened
  // makes the one number the whole plan rests on meaningless.
  if (!rows.length) {
    await supabase.from('wrought_sessions')
      .update({ status: 'abandoned', ended_at: new Date().toISOString() })
      .eq('id', session.id);
    return { closed: false, empty: true, minutes: 0, sets: 0 };
  }

  const started = new Date(session.started_at).getTime();
  // Somebody saying "I'm done" ends the session NOW, and that is the truest
  // reading available. Nobody saying anything ends it at the last set — never
  // at now, because a session left open overnight would otherwise bill
  // fourteen hours. See the note at the top of the file.
  const lastSetAt = new Date(rows[rows.length - 1].logged_at).getTime();
  const endAt = endedAt ? new Date(endedAt).getTime() : lastSetAt;
  // Floor at one minute so a single-set session is not zero.
  const minutes = Math.max(1, Math.round((endAt - started) / 60000));
  const endedIso = new Date(endAt).toISOString();

  const totals = sessionTotals(rows);
  const muscles = [...new Set(rows.flatMap(s => s.muscles || []))];

  const [written] = await insertEvents(userId, profile, [{
    event_type: 'workout',
    summary: `${session.name} — ${totals.sets} sets, ${minutes} min`,
    detail: {
      kind: session.kind, minutes, muscles,
      exercises: totals.top_sets.map(t => ({
        name: t.exercise, sets: rows.filter(r => r.exercise === t.exercise).length,
        reps: t.reps, weight_kg: t.weight_kg,
      })),
      volume_kg: totals.volume_kg,
      session_id: session.id,
      note: note || null,
      // Said out loud on the row itself, so anybody reading the record later
      // can tell a session somebody closed from one the server closed for them.
      closed_by: closedBy,
    },
    // The workout happened when it happened. Filing it under today would move
    // a Tuesday session onto Wednesday for anybody who trains late, which is
    // the same class of error as deriving local_date from UTC.
    occurred_at: endedIso,
    estimated: false,
  }], { rawInput: note || null });

  await supabase.from('wrought_sessions').update({
    status: 'done', ended_at: endedIso, event_id: written?.id || null,
  }).eq('id', session.id);

  return {
    closed: true, empty: false, minutes, sets: totals.sets,
    // Handed back so the caller does not re-read what was just written — and
    // so a hand-closed session and a server-closed one go through identical
    // code and can never produce two different-looking rows.
    totals, rows, event_id: written?.id || null,
    local_date: localDateFor(profile.timezone, new Date(endAt)),
  };
}

/**
 * Close anything left running that plainly is not running any more.
 *
 * Called on the way into a read — the dashboard, the brief — so a session
 * finished by walking out of the gym turns up without needing another workout
 * to be started first. Idempotent: a session genuinely in progress is left
 * completely alone, and one already closed is not seen at all.
 */
export async function closeStaleSessions(userId, profile, { now = Date.now() } = {}) {
  const { data: open } = await supabase.from('wrought_sessions')
    .select('id, name, kind, started_at')
    .eq('user_id', userId).eq('status', 'active');

  const rows = open || [];
  if (!rows.length) return [];

  const closed = [];
  for (const s of rows) {
    const { data: last } = await supabase.from('wrought_sets')
      .select('logged_at').eq('session_id', s.id)
      .order('logged_at', { ascending: false }).limit(1);

    const lastAt = last?.[0]?.logged_at ? new Date(last[0].logged_at).getTime() : null;
    const startedAt = new Date(s.started_at).getTime();

    // Still going: a set within the window, or an empty session started
    // recently enough that somebody is plausibly still warming up.
    if (stillRunning({ lastSetAt: lastAt, startedAt, now })) continue;

    const done = await finaliseSession(userId, profile, s);
    if (done?.closed) closed.push({ id: s.id, name: s.name, ...done });
  }
  return closed;
}
