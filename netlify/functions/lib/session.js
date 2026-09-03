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
import { sessionTotals, sessionsCanCarryAim, exerciseKey, sameLift, trainingBurn } from './training.js';
import { sessionProgress } from './warmup.js';
import { sessionEffort, splitWork, windowedActive } from './effort.js';
import { sessionsCanCarryPlace } from './places.js';

// How long a gap means the session is over rather than resting. Real sets sit
// minutes apart; four hours is not a rest, it is somebody who left. Generous on
// purpose — closing a workout somebody is still doing is the worse mistake,
// because the next set would then land on a finished session.
const STALE_MS = 4 * 3600 * 1000;

// And a session that never got a single set. Nothing to file, so nothing is
// filed; it is only cleared out so it stops blocking the next one.
const EMPTY_MS = 8 * 3600 * 1000;

// How long after the last set "I'm done" is still the end of the SESSION
// rather than the end of the evening. Somebody who closes it after the
// cool-down stretches was training until then; somebody who closes it from
// the sofa ninety minutes later was not, and billing the gap as training is
// the overnight bug in a smaller hat — the founder's closed at 142 minutes for
// a session that ran under an hour, and the calorie estimate scaled with it.
export const CLOSE_GRACE_MS = 20 * 60 * 1000;

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
  // Explicit "I'm done" ends it now — within a grace of the last set. Past
  // that, the truest end available is the last set plus the grace, because
  // the minutes price the burn and an overstated burn is the number that
  // tells somebody they have room to eat.
  const endAt = endedAt
    ? Math.max(lastSetAt, Math.min(new Date(endedAt).getTime(), lastSetAt + CLOSE_GRACE_MS))
    : lastSetAt;
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

  // The aim, when the caller did not already carry it. The stale sweep selects
  // a narrow row on purpose — adding a column that may not exist yet would
  // make PostgREST reject the whole query and silently stop closing sessions,
  // which is a far worse failure than a missing sentence. So it is fetched
  // here, once, and only when 017 has actually run.
  let aim = session.aim ?? null;
  if (aim == null && await sessionsCanCarryAim()) {
    const { data: row } = await supabase.from('wrought_sessions')
      .select('aim').eq('id', session.id).maybeSingle();
    aim = row?.aim || null;
  }
  // WHERE it happened, same shape: fetched only when 024 has run.
  let place = session.place ?? null;
  if (place == null && await sessionsCanCarryPlace()) {
    const { data: row } = await supabase.from('wrought_sessions')
      .select('place').eq('id', session.id).maybeSingle();
    place = row?.place || null;
  }

  // WHAT IT COST, MEASURED — and the cardio counted apart from the lifting.
  //
  // The session already had a clock (started_at, ended_at), and heart rate
  // samples already arrived with timestamps; nothing was reading one against
  // the other. "Officially start the heart rate" turns out to be a query, not
  // a feature: the window was always there.
  const dayOf = localDateFor(profile.timezone, new Date(endAt));
  const [{ data: hr }, { data: activeRows }, { data: weighIn }] = await Promise.all([
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
    // The most recent weigh-in anywhere — a window is not a memory — so the
    // session can be priced when the watch cannot vouch for it.
    supabase.from('wrought_events')
      .select('detail').eq('user_id', userId).eq('event_type', 'weight')
      .order('occurred_at', { ascending: false }).limit(1),
  ]);

  // MEASURED BEATS ESTIMATED, when a measurement genuinely exists. The watch's
  // own energy inside the session window becomes the session's calories, so
  // trainingBurn counts it as a device figure and the hero stops saying
  // "estimated" about a session the watch actually saw.
  const watched = windowedActive(activeRows || [], session.started_at, endedIso);

  // AND WHEN IT CANNOT, THE SESSION STILL CARRIES A FIGURE — its own, labelled.
  //
  // The founder closed a workout and asked how many calories it was; the
  // answer was "I didn't add any — Wrought is treating the 764 from your
  // device as the training component." The row had minutes and no figure, so
  // the only number anywhere was the day's clamp. The same MET pricing
  // trainingBurn runs for the day is run here ONCE, from the minutes and the
  // weight on file, and stamped with its source so every reader — the day
  // panel, the log, the receipt — shows the number and calls it an estimate.
  const weightKg = Number(weighIn?.[0]?.detail?.value_kg) || null;
  const priced = watched ? null
    : trainingBurn([{ summary: session.name, detail: { kind: session.kind, minutes } }], weightKg);
  const estimate = priced?.kcal > 0 ? priced.kcal : null;
  const calories = watched
    ? { kcal: watched.kcal, source: 'watch', minutes }
    : estimate
    ? { kcal: estimate, source: 'estimate', minutes }
    : { kcal: 0, source: 'none', minutes, why: priced?.entries?.[0]?.why || 'no recent weigh-in' };

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
      ...(watched ? { calories: watched.kcal, calories_source: 'watch' }
        : estimate ? { calories: estimate, calories_source: 'estimate' } : {}),
      exercises: totals.top_sets.map(t => ({
        name: t.exercise, sets: rows.filter(r => r.exercise === t.exercise).length,
        reps: t.reps, weight_kg: t.weight_kg,
      })),
      volume_kg: totals.volume_kg,
      session_id: session.id,
      ...(place ? { place } : {}),
      // WHAT THIS SESSION WAS FOR, in their own words, kept on the record.
      // It was asked for at the start and, until now, read once by a model in
      // one turn and then lost — so the log could say what was lifted and
      // never what was being chased. Undefined rather than null when there is
      // none: a session with no stated aim is a fact, not an empty field.
      ...(aim ? { aim } : {}),
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
    // What the session was worth, on its own — the number the person asks
    // for at the close, apart from how the day then counts it.
    calories,
    local_date: localDateFor(profile.timezone, new Date(endAt)),
  };
}

// ONE WRITE PATH FOR A SET, whichever door it came through.
//
// log_set (the conversation) and the rack screen's tick both have to insert a
// set, advance the cursor at exactly the same moment, and treat an open-ended
// ad-hoc slot the same way. Two copies of that would drift, and the drift
// shows up as the screen and the voice disagreeing about which exercise you
// are on — the precise thing api-session.js exists to prevent.
//
// It records what it is GIVEN. A missing weight stays null rather than being
// filled in from the prescription: what was on the bar is the person's claim,
// and the screen's job is to show the prescribed number so they can confirm or
// change it, never to assert it on their behalf.
export async function recordSet(userId, { session, current, plan = [], today,
                                          reps = null, weightKg = null, rpe = null,
                                          note = null, exercise = null, skip = false,
                                          setsDone = 0 }) {
  let done = setsDone;
  // The row as STORED, handed back so the caller can read it out. Echoing the
  // arguments proves a write was composed, never that it landed — and the
  // words on a set are the field most often composed and least often checked.
  let row = null;

  if (skip) {
    done = current.sets ?? done;             // force the move on
  } else {
    const name = exercise || current.name;
    const key  = exercise ? exerciseKey(exercise) : current.key;
    const { data: stored, error } = await supabase.from('wrought_sets').insert([{
      user_id: userId, session_id: session.id,
      exercise: name, exercise_key: key,
      set_number: done + 1,
      // Where this lift sat in the session — the only way to later answer
      // "is my bench stalling, or is it just always third?"
      position: (session.cursor_index || 0) + 1,
      reps: reps != null ? Math.round(Number(reps)) : (parseInt(String(current.reps), 10) || null),
      weight_kg: weightKg != null ? Number(weightKg) : null,
      rpe: rpe != null ? Number(rpe) : null,
      muscles: current.muscles || [],
      note: note ? String(note).slice(0, 500) : null,
      local_date: today,
    }]).select('id, exercise, set_number, reps, weight_kg, rpe, note').single();
    if (error) return { error: error.message };
    row = stored || null;
    done += 1;
  }

  // TWO DIFFERENT NULLS, and conflating them stuck the founder's checklist at
  // exercise #1 for a whole session. An AD-HOC open slot (no sets, no minutes
  // — nobody said how many are coming) never finishes on its own: the session
  // ends when the person stops, not when a number nobody set is reached. But a
  // TIMED movement carries sets:null BECAUSE it is measured in minutes — forty
  // minutes on the treadmill logged once IS the slot done, and demanding a set
  // count from it means the cursor never moves and "what's next" answers
  // "the treadmill you just finished" forever.
  const timed = current.timed === true || current.minutes != null;
  const moreHere = timed ? false
    : current.sets == null ? true
    : done < current.sets;
  let cursor = session.cursor_index || 0;
  if (!moreHere) cursor += 1;
  if (cursor !== (session.cursor_index || 0)) {
    await supabase.from('wrought_sessions').update({ cursor_index: cursor }).eq('id', session.id);
  }

  return { sets_done: done, cursor, finished: cursor >= plan.length, more_here: moreHere, row };
}

/**
 * A workout told after the fact, while one is still RUNNING, is the same
 * workout — the pure decision.
 *
 * The founder's night: the connector dropped mid-session (a migration
 * applied live bounced PostgREST for three seconds), ChatGPT could not reach
 * log_set, and when it came back it did the honest thing and flushed the
 * rest of the session through `log` as a workout event: "pec-deck 180 × 8,
 * 180 × 8; seated row 250 × 5, 220 × 8". Correct recovery — and it left a
 * live session holding five sets beside an EVENT holding the rest, so the
 * finaliser would have filed a second workout for the same hour. Two
 * sessions on one night is the one number the whole plan rests on, wrong.
 *
 * So the exercises go INTO the session: anything already logged set by set
 * is skipped (re-telling what was recorded must not double it), anything on
 * the plan but not yet done gets its sets, anything new is appended to the
 * plan — the ad-hoc rule, a different lift in the order it happened. The
 * finaliser then writes one event with everything.
 */
export function foldPlan({ plan = [], sessionSets = [], exercises = [] }) {
  // Keyed by the NAME as well as the key, because a re-told lift matches the
  // logged one loosely (sameLift) — "seated row" beside "Seated row machine"
  // — and the loose match needs words, not keys.
  const have = new Set(sessionSets.map(r => r.exercise_key));
  const haveNames = [...new Set(sessionSets.map(r => r.exercise || r.exercise_key).filter(Boolean))];
  const planKeys = new Map(plan.map((e, i) => [e.key || exerciseKey(e.name), i]));
  const additions = [];
  const rows = [];
  const skipped = [];
  let nextIndex = plan.length;

  for (const x of exercises.slice(0, 20)) {
    const name = String(x?.name || '').trim();
    if (!name) continue;
    let key = exerciseKey(name);
    // Already on the record set by set, by key OR by the words of the name.
    // A workout re-told after the fact names lifts the short way; the strict
    // key kept them apart and the night read 14 sets for 9 done. Doubling is
    // silent, so the loose match is the safe side here — and a skip is said.
    if (have.has(key) || haveNames.some(h => sameLift(h, name))) {
      skipped.push({ name, why: 'already logged set by set in this session' }); continue;
    }
    const n = Math.min(Math.max(parseInt(x.sets, 10) || 1, 1), 10);
    const reps = x.reps != null ? Math.round(Number(x.reps)) || null : null;
    const kg = x.weight_kg != null ? Number(x.weight_kg) || null : null;
    const muscles = Array.isArray(x.muscles) ? x.muscles : [];
    let idx = planKeys.get(key);
    if (idx == null) {
      // A planned lift told the short way lands in its own slot, not a new one.
      const slot = plan.find(e => e?.name && sameLift(e.name, name));
      if (slot) { key = slot.key || exerciseKey(slot.name); idx = planKeys.get(key); }
    }
    if (idx == null) {
      idx = nextIndex++;
      additions.push({
        index: idx, name: name.slice(0, 120), key, sets: n, reps, timed: false,
        minutes: null, detail: null, rest_s: 120, load_kg: null, muscles, cue: null,
      });
      planKeys.set(key, idx);
    }
    have.add(key);
    haveNames.push(name);
    for (let s = 1; s <= n; s++) {
      rows.push({
        exercise: name.slice(0, 120), exercise_key: key, set_number: s, position: idx + 1,
        reps, weight_kg: kg, rpe: null, muscles, note: null,
      });
    }
  }
  return { additions, rows, skipped };
}

/**
 * Write the fold: the rows into the live session, the additions onto its
 * plan. Insert first, then the plan — a failure between the two leaves real
 * sets on the session and a plan one slot short, which the checklist
 * survives; the reverse would promise slots with nothing in them.
 */
export async function foldIntoSession(userId, session, exercises, { today, now = new Date().toISOString() } = {}) {
  const { data: sets, error: readErr } = await supabase.from('wrought_sets')
    .select('exercise, exercise_key').eq('session_id', session.id);
  if (readErr) return { error: readErr.message };
  const plan = Array.isArray(session.plan) ? session.plan : [];
  const { additions, rows, skipped } = foldPlan({ plan, sessionSets: sets || [], exercises });

  if (rows.length) {
    const { error } = await supabase.from('wrought_sets').insert(rows.map(r => ({
      user_id: userId, session_id: session.id, event_id: null,
      local_date: today, logged_at: now, ...r,
    })));
    if (error) return { error: error.message };
  }
  if (additions.length) {
    const { error } = await supabase.from('wrought_sessions')
      .update({ plan: [...plan, ...additions] }).eq('id', session.id);
    if (error) return { folded: rows.length, error: `plan not extended: ${error.message}` };
  }
  return {
    session_id: session.id, session_name: session.name,
    folded: rows.length, added: additions.map(a => a.name),
    skipped,
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
    // `plan` is here because completionFrom needs it: without it a session
    // closed by walking out of the gym filed no completion at all, and the
    // backfill had to come along afterwards to repair every one of them.
    .select('id, name, kind, started_at, plan')
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
      // So the list can say "estimated" beside a priced session and nothing
      // beside a watch-measured one.
      calories_source: d.calories_source ?? null,
      avg_hr: d.avg_hr ?? null,
      max_hr: d.max_hr ?? null,
      session_id: d.session_id || null,
      // Where it happened, when it was said.
      place: d.place || null,
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
      place: s.place || null,
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
// THE SHIFTS ALREADY FILED AS NOTES.
//
// insertEvents validated event_type against a set that did not contain
// 'activity', and anything missing from that set is SILENTLY REWRITTEN to
// 'note' rather than rejected. 013 added the type to the database months
// earlier; the writer was never updated. So every shift logged before that fix
// went in as a note — dayFacts filters on 'activity' and found none, so hours
// of physical work burned nothing, and the entry still appeared in the log,
// which is exactly what made it invisible.
//
// Fixing the writer only fixes the NEXT one. The record still holds weeks of
// shifts typed as notes, worth nothing, and nobody would ever find them by
// looking — the founder's own petting-zoo days are in there. A fix that leaves
// the existing data wrong has fixed half the bug.
//
// THE FINGERPRINT IS EXACT, and that is what makes this safe. log_activity is
// the only thing in this product that writes a detail carrying key, met, hours
// and kcal together. A note somebody actually dictated has none of them. It
// matches on all four rather than on the summary text, because matching prose
// would re-type a genuine note about a workday and there is no undo for that.
export async function refileMistypedActivity(userId, { days = 120 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const { data: rows, error } = await supabase.from('wrought_events')
    .select('id, detail')
    .eq('user_id', userId).eq('event_type', 'note')
    .gte('local_date', since).limit(500);
  // A swallowed error here is a repair that silently never runs, which is the
  // same class of failure as the bug it exists to undo.
  if (error) return { checked: 0, refiled: 0, error: error.message };
  if (!rows?.length) return { checked: 0, refiled: 0 };

  const isShift = d => d && typeof d === 'object' &&
    d.key != null && d.met != null &&
    Number.isFinite(Number(d.hours)) && Number.isFinite(Number(d.kcal));

  const mine = rows.filter(r => isShift(r.detail));
  if (!mine.length) return { checked: rows.length, refiled: 0 };

  // One statement rather than a loop: every row here is the same correction,
  // and a partial repair that stops halfway is worse than one that does not
  // start — the day would then be half counted.
  const { error: upErr } = await supabase.from('wrought_events')
    .update({ event_type: 'activity' })
    .eq('user_id', userId).in('id', mine.map(r => r.id));
  if (upErr) return { checked: rows.length, refiled: 0, error: upErr.message };

  return { checked: rows.length, refiled: mine.length };
}

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
