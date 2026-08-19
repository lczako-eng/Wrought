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
import { sessionProgress } from './warmup.js';
import { sessionEffort, splitWork, windowedActive } from './effort.js';

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
/**
 * Planned against done, as one pure shape — used by the close AND the
 * backfill, so a session filed today and one repaired tomorrow can never
 * carry two different-looking completions.
 *
 * Per exercise, the two states are named apart: "skipped" is a plan line
 * never touched; "short" is one started and left. They are different facts —
 * one is a choice about the session, the other about the exercise — and
 * flattening them loses the founder's "half of one of them".
 *
 * An ad-hoc session has open slots (sets: null) and no real plan, so its
 * completion would be noise: null, deliberately.
 */
export function completionFrom(plan, rows) {
  const progress = sessionProgress(Array.isArray(plan) ? plan : [], rows || []);
  if (!(progress.sets_planned > 0)) return null;
  return {
    percent: progress.percent,
    sets_done: progress.sets_done,
    sets_planned: progress.sets_planned,
    exercises: progress.exercises.map(e => ({
      name: e.exercise, planned: e.sets, done: e.done,
      ...(e.done === 0 ? { skipped: true } : e.complete ? {} : { short: true }),
    })),
    skipped: progress.exercises.filter(e => e.done === 0).map(e => e.exercise),
  };
}

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

  // WHAT WAS PLANNED AGAINST WHAT WAS DONE, kept on the record forever.
  //
  // The founder: "it needs to keep, in like a database, how much I've done of
  // each exercise, or I decided to skip or whatever — so if I only do half of
  // them you'll know that, or half of one of them." The clipboard already knew
  // all of this DURING the session and then threw it away at the close: the
  // event kept only what happened, so a six-exercise plan finished at three
  // read back identically to a three-exercise plan finished in full.
  //
  // Same function the live checklist uses, so the percentage somebody watched
  // during the session and the one filed on the record can never disagree.
  // An ad-hoc session has open slots (sets: null) and no real plan, so its
  // completion would be noise — only a session with planned sets carries one.
  const completion = completionFrom(session.plan, rows);

  // WHAT IT COST, MEASURED — and the cardio counted apart from the lifting.
  //
  // The session already had a clock (started_at, ended_at), and heart rate
  // samples already arrived with timestamps; nothing was reading one against
  // the other. "Officially start the heart rate" turns out to be a query, not
  // a feature: the window was always there.
  const dayOf = localDateFor(profile.timezone, new Date(endAt));
  const [{ data: hr }, { data: activeRows }] = await Promise.all([
    supabase.from('wrought_metrics')
      .select('value, measured_at').eq('user_id', userId).eq('metric', 'heart_rate')
      .gte('measured_at', session.started_at).lte('measured_at', endedIso)
      .order('measured_at', { ascending: true }),
    // The whole DAY's rows, not just the window — the guard in windowedActive
    // needs to see whether the day has sub-daily granularity at all, because a
    // single daily total falling inside the window is the whole day wearing a
    // session's clothes.
    supabase.from('wrought_metrics')
      .select('value, measured_at').eq('user_id', userId).eq('metric', 'active_calories')
      .eq('local_date', dayOf),
  ]);

  // MEASURED BEATS ESTIMATED, when a measurement genuinely exists. The watch's
  // own energy inside the session window becomes the session's calories, so
  // trainingBurn counts it as a device figure and the hero stops saying
  // "estimated" about a session the watch actually saw.
  const watched = windowedActive(activeRows || [], session.started_at, endedIso);

  const effort = sessionEffort({
    session: { ...session, ended_at: endedIso }, sets: rows, samples: hr || [],
  });
  // A treadmill is not a bench press. Blending twenty-five minutes of incline
  // walking into "volume moved" makes the volume wrong and hides the cardio
  // entirely — two numbers, each honest.
  const split = splitWork({ sets: rows, plan: session.plan });

  const [written] = await insertEvents(userId, profile, [{
    event_type: 'workout',
    // The shortfall is IN the summary, because the summary is what every list,
    // day card and brief actually shows. "12 sets, 40 min" over a half-done
    // plan reads as a finished workout — which hides exactly the fact the
    // founder asked to keep.
    summary: `${session.name} — ${totals.sets} sets, ${minutes} min` +
      (completion && completion.percent < 100 ? ` (${completion.percent}% of plan)` : ''),
    detail: {
      kind: session.kind, minutes, muscles,
      ...(watched ? { calories: watched.kcal, calories_source: 'watch' } : {}),
      exercises: totals.top_sets.map(t => ({
        name: t.exercise, sets: rows.filter(r => r.exercise === t.exercise).length,
        reps: t.reps, weight_kg: t.weight_kg,
      })),
      volume_kg: totals.volume_kg,
      session_id: session.id,
      note: note || null,
      ...(completion ? { completion } : {}),
      ...(effort.known ? { effort: {
        avg_hr: effort.avg_hr, max_hr: effort.max_hr,
        by_exercise: effort.by_exercise, samples: effort.samples,
      } } : {}),
      ...(split.mixed ? { work_split: split } : {}),
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
    totals, rows, completion, effort, split, event_id: written?.id || null,
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

/**
 * Every workout, from wherever it came, as one list.
 *
 * "I still don't see individual workouts." The Recent sessions panel was built
 * from `wrought_sessions` alone — the sessions the ASSISTANT runs, set by set.
 * A run off the watch is a `wrought_events` row of type 'workout' and never
 * creates a session, so every workout that came from Apple Health was missing
 * from the one panel called "recent sessions" while sitting in the record the
 * whole time. Two ways in, one list, or the list is a lie about half of them.
 *
 * DEDUPED BY session_id, not by name and date. A session finalised here writes
 * a workout event carrying `detail.session_id`, so the session row and the
 * event are the same workout seen twice — counting both would double every
 * gym session in the list and, worse, make somebody think a workout logged
 * once had been logged twice.
 *
 * @param sessions  wrought_sessions rows, status done
 * @param events    wrought_events rows of type 'workout', with detail
 */
export function workoutList(sessions = [], events = [], { today = null, limit = 20 } = {}) {
  const out = [];
  const fromSession = new Set();

  for (const e of events) {
    const d = e.detail || {};
    if (d.session_id) fromSession.add(String(d.session_id));
    out.push({
      name: e.summary || d.kind || 'Workout',
      kind: d.kind || 'workout',
      date: e.local_date,
      minutes: d.minutes ?? null,
      distance_km: d.distance_km ?? null,
      calories: d.calories ?? null,
      avg_hr: d.avg_hr ?? null,
      max_hr: d.max_hr ?? null,
      session_id: d.session_id || null,
      // Where it came from, because "why is this not in my log" is answered
      // completely differently for a watch and for a dictated sentence.
      source: e.source && e.source !== 'agent' ? 'device' : 'logged',
    });
  }

  // A session with no event of its own — only possible for one still open, or
  // one from before the finaliser existed. Included so nothing is lost.
  for (const s of sessions) {
    if (fromSession.has(String(s.id))) continue;
    out.push({
      name: s.name || 'Session',
      kind: s.kind || 'strength',
      date: s.local_date,
      minutes: s.ended_at && s.started_at
        ? Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000)) : null,
      distance_km: null, calories: null, avg_hr: null, max_hr: null,
      session_id: s.id,
      source: 'logged',
    });
  }

  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return out.slice(0, limit).map(w => ({
    ...w,
    days_ago: today && w.date ? daysApart(w.date, today) : null,
  }));
}

function daysApart(from, to) {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}


// ── Repairing the record the feature predates ───────────────────────────────
//
// Completion is stamped when a session closes — so every session closed
// BEFORE the stamp existed reads as a finished workout forever, including the
// founder's own half-done session on the day he asked for this. The plan is
// still on the session row and the sets are still in the set table, so the
// answer is recoverable; leaving it unrecoverable would make "you'll know
// that" true only for workouts that happen from now on.
//
// Idempotent by inspection: an event already carrying completion is skipped,
// so the sweep costs one read per call once the backlog is done. Bounded to
// the recent past because the founder's ask is about days he can still act
// on, and a wholesale rewrite of years of summaries is a bigger decision.
export async function backfillCompletion(userId, { days = 21 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const { data: sessions } = await supabase.from('wrought_sessions')
    .select('id, plan, event_id, local_date')
    .eq('user_id', userId).eq('status', 'done')
    .not('event_id', 'is', null).gte('local_date', since);

  // Only sessions that HAD a plan — ad-hoc sessions carry no completion by
  // design, and re-deciding that here would fork the shape.
  const cands = (sessions || []).filter(s =>
    Array.isArray(s.plan) && s.plan.some(e => Number(e.sets) > 0));
  if (!cands.length) return { checked: 0, stamped: 0 };

  const { data: events } = await supabase.from('wrought_events')
    .select('id, summary, detail').in('id', cands.map(s => s.event_id));
  const byId = new Map((events || []).map(e => [String(e.id), e]));

  let stamped = 0;
  for (const s of cands) {
    const ev = byId.get(String(s.event_id));
    if (!ev || ev.detail?.completion) continue;

    const { data: sets } = await supabase.from('wrought_sets')
      .select('exercise').eq('session_id', s.id);
    const completion = completionFrom(s.plan, sets || []);
    if (!completion) continue;

    // The shortfall goes into the summary exactly as the close writes it —
    // and never twice, however many times the sweep runs.
    const summary = completion.percent < 100 && !/% of plan\)/.test(ev.summary || '')
      ? `${ev.summary} (${completion.percent}% of plan)`
      : ev.summary;

    const { error } = await supabase.from('wrought_events')
      .update({ summary, detail: { ...(ev.detail || {}), completion } })
      .eq('id', ev.id);
    if (!error) stamped++;
  }
  return { checked: cands.length, stamped };
}


// ── Re-filing the workouts the bug put on the wrong day ─────────────────────
//
// Until eventTimestamp existed, every session closed by the sweep was stamped
// with the moment the DASHBOARD LOADED rather than the moment the last set
// went down — so a Friday evening session closed on Saturday morning sat on
// Saturday, and Friday read as a rest day. The truth is still stored: the
// session row knows when it ended. This puts the event back on the day the
// training actually happened.
//
// Idempotent by arithmetic: once an event's occurred_at matches its session's
// end within the tolerance, it is never touched again. The tolerance is six
// hours because end_session legitimately stamps "now" a little after the last
// set — the target is events filed the better part of a day late, not minutes.
export async function refileMisdated(userId, profile, { days = 21 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const { data: sessions } = await supabase.from('wrought_sessions')
    .select('id, ended_at, event_id')
    .eq('user_id', userId).eq('status', 'done')
    .not('event_id', 'is', null).not('ended_at', 'is', null)
    .gte('local_date', since);
  if (!sessions?.length) return { checked: 0, refiled: 0 };

  const { data: events } = await supabase.from('wrought_events')
    .select('id, occurred_at, local_date').in('id', sessions.map(x => x.event_id));
  const byId = new Map((events || []).map(e => [String(e.id), e]));

  let refiled = 0;
  for (const sesh of sessions) {
    const ev = byId.get(String(sesh.event_id));
    if (!ev) continue;
    const endedAt = new Date(sesh.ended_at).getTime();
    const filedAt = new Date(ev.occurred_at).getTime();
    if (!Number.isFinite(endedAt) || !Number.isFinite(filedAt)) continue;
    if (Math.abs(filedAt - endedAt) <= 6 * 3600000) continue;

    const { error } = await supabase.from('wrought_events').update({
      occurred_at: sesh.ended_at,
      local_date: localDateFor(profile.timezone, new Date(endedAt)),
    }).eq('id', ev.id);
    if (!error) refiled++;
  }
  return { checked: sessions.length, refiled };
}
