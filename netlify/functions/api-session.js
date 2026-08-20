// netlify/functions/api-session.js
// The rack screen.
//
// The coaching already exists in the MCP tools — start_session, whats_next,
// log_set. What did not exist was somewhere to LOOK at it. Mid-set nobody is
// composing a sentence to an assistant; they want one glance that says what
// lift, what weight, which set, and how long is left on the rest.
//
// It reads the same session state the tools write, so the phone and the
// conversation can never disagree about where you are. Nothing here decides
// anything: the load comes from progressionCall exactly as the coach would say
// it, which is what keeps the screen and the voice telling one story.

import {
  supabase, getAuthUser, getProfile, localDateFor, kgToLb, lbToKg,
} from './lib/wrought.js';
import { lastPerformance, progressionCall, sessionTotals, exerciseKey, sessionsCanCarryAim } from './lib/training.js';
import { sessionProgress } from './lib/warmup.js';
import { recordSet, finaliseSession } from './lib/session.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return json(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  const profile = await getProfile(user.id);
  const imperial = profile.units === 'imperial';
  const w = kg => (kg == null ? null : imperial ? kgToLb(kg) : kg);
  const unit = imperial ? 'lb' : 'kg';

  // `aim` only when 017 has actually run. Naming a column PostgREST does not
  // know about makes it reject the WHOLE query, so the screen would say "no
  // workout is running" while one plainly was — a missing sentence turned into
  // a broken rack screen. The door has to be correct before the SQL runs.
  const cols = 'id, name, kind, plan, cursor_index, started_at, local_date, routine_id' +
    (await sessionsCanCarryAim() ? ', aim' : '');

  const { data: session } = await supabase.from('wrought_sessions')
    .select(cols)
    .eq('user_id', user.id).eq('status', 'active').maybeSingle();

  // ── Ticking the checklist ─────────────────────────────────────────────────
  //
  // THE HOLE THIS CLOSES. This screen could show exactly where you were in a
  // session and could not move you through it — every tick had to go via the
  // assistant. The founder asked for it plainly: "you can put a checkmark for
  // everything that you've done". The same shape as the food door: the website
  // could read the record and not write to it, so when the AI was not to hand
  // there was nowhere else to go.
  //
  // It writes through recordSet, the SAME path log_set uses, so a set ticked
  // here and a set reported out loud land identically and the cursor moves at
  // the same moment either way.
  if (event.httpMethod === 'POST') {
    if (!session) return json(409, { error: 'no_session', say: 'No workout is running. Start one and this fills in.' });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const action = String(body.action || 'set');
    const plan = Array.isArray(session.plan) ? session.plan : [];
    const at = Math.max(0, Math.min(session.cursor_index || 0, Math.max(plan.length - 1, 0)));
    const current = plan[at] || null;

    if (action === 'end') {
      // "I'm done" genuinely is the end, so the clock stops now rather than at
      // the last set — the one case where end-at-now is the truest reading.
      const done = await finaliseSession(user.id, profile, session,
        { closedBy: 'web', endedAt: new Date().toISOString() });
      return json(200, { ok: true, ended: true, ...(done || {}),
        say: done?.empty
          ? 'Session closed. Nothing was logged in it, so nothing was filed — an empty session is never turned into a workout.'
          : `Filed: ${done?.sets} sets, ${done?.minutes} min.` });
    }

    // TAPPING A ROW ON THE CHECKLIST. The founder asked to be able to tick off
    // "everything that you've done", and a person at the rack does not always
    // work top to bottom — the bench is taken, so they do the rows first. This
    // moves where they ARE; it invents nothing and records nothing.
    // A JUMP IS A MOVE, NOT A SET. It writes nothing and is checked BEFORE the
    // "nothing current" guard, because a session whose cursor has run past the
    // end is exactly when somebody needs to jump back to a row they skipped.
    if (action === 'goto') {
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i >= plan.length) {
        return json(400, { error: 'no_such_exercise', say: 'That exercise is not in this session.' });
      }
      await supabase.from('wrought_sessions').update({ cursor_index: i }).eq('id', session.id);
      session.cursor_index = i;
    } else {
      if (!current) return json(409, { error: 'nothing_current', say: 'This session has nothing left in it.' });

      const key = current.key || exerciseKey(current.name);
      const { data: hereRows } = await supabase.from('wrought_sets')
        .select('id').eq('session_id', session.id).eq('exercise_key', key);

      // A WEIGHT TYPED HERE IS THEIRS, and one that is not typed does not
      // exist. The screen shows the prescribed number so it can be confirmed
      // or changed; it is never asserted on somebody's behalf, which is the
      // same rule that keeps a working weight from being invented anywhere.
      const weightKg = body.weight == null || body.weight === ''
        ? null
        : (imperial ? lbToKg(Number(body.weight)) : Number(body.weight));

      const wrote = await recordSet(user.id, {
        session, current, plan, today: localDateFor(profile.timezone),
        reps: body.reps ?? null,
        weightKg: Number.isFinite(weightKg) ? weightKg : null,
        rpe: body.rpe ?? null,
        note: body.note ?? null,
        skip: action === 'skip',
        setsDone: (hereRows || []).length,
      });
      // A swallowed write here looks exactly like a tick that worked, on the
      // one screen somebody is using instead of talking.
      if (wrote.error) return json(500, { error: 'not_saved', say: `That did not save: ${wrote.error}` });

      // Fall through to the GET body below, so the response IS the refreshed
      // screen — read back off the record rather than patched from a guess.
      session.cursor_index = wrote.cursor;
    }
  }

  if (!session) {
    // Between sessions the question is "what am I doing next", and the answer
    // is one of their own saved workouts. Fetched here rather than cached from
    // another tab, so opening Trainer directly still answers it.
    const { data: saved } = await supabase.from('wrought_routines')
      .select('name, kind, exercises, notes, est_minutes, times_used, last_used_on')
      .eq('user_id', user.id).eq('active', true)
      .order('last_used_on', { ascending: false, nullsFirst: false });

    const today = localDateFor(profile.timezone);
    return json(200, {
      active: false,
      unit,
      routines: (saved || []).map(r => ({
        name: r.name, kind: r.kind,
        exercises: (r.exercises || []).length,
        movements: (r.exercises || []).map(e => ({ name: e.name, sets: e.sets, reps: e.reps })),
        sets: (r.exercises || []).reduce((a, e) => a + (Number(e.sets) || 0), 0),
        notes: r.notes || null,
        minutes: r.est_minutes || null,
        times_used: r.times_used,
        days_since: r.last_used_on
          ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${r.last_used_on}T00:00:00Z`)) / 86400000)
          : null,
      })),
      say: 'No session on the go. Say the name of one of these to your AI and it starts.',
    });
  }

  const { data: logged } = await supabase.from('wrought_sets')
    .select('exercise, exercise_key, set_number, reps, weight_kg, rpe, position, note, logged_at')
    .eq('user_id', user.id).eq('session_id', session.id)
    .order('logged_at', { ascending: true });

  const sets = logged || [];
  const plan = Array.isArray(session.plan) ? session.plan : [];
  const at = Math.max(0, Math.min(session.cursor_index || 0, Math.max(plan.length - 1, 0)));
  const current = plan[at] || null;
  const upcoming = plan.slice(at + 1, at + 3);

  // How far into THIS exercise, so the screen can say "set 3 of 4" rather than
  // making somebody count their own sets between efforts.
  const key = current ? (current.key || exerciseKey(current.name)) : null;
  const doneHere = key ? sets.filter(s => (s.exercise_key || exerciseKey(s.exercise)) === key) : [];

  // The prescription, from the same function the coach speaks from. A screen
  // that worked out its own number would eventually contradict the voice, and
  // then neither is worth trusting.
  let call = null;
  if (current) {
    const last = await lastPerformance(user.id, key);
    call = progressionCall({
      last,
      targetReps: current.reps,
      tier: profile.training_age === 'beginner' ? 'beginner' : 'intermediate',
      key,
    });
  }

  const lastSet = sets[sets.length - 1] || null;
  const restFor = current?.rest_s ?? 120;
  const restLeft = lastSet
    ? Math.max(0, Math.round(restFor - (Date.now() - new Date(lastSet.logged_at).getTime()) / 1000))
    : null;

  const totals = sessionTotals(sets);

  // How far through, computed by the same function the tools call. The screen
  // and the assistant quoting two different percentages at the same moment is
  // exactly the drift this whole endpoint exists to prevent.
  const progress = sessionProgress(plan, sets);

  return json(200, {
    active: true,
    unit,
    session: {
      id: session.id,
      name: session.name,
      kind: session.kind,
      started_at: session.started_at,
      minutes: Math.max(0, Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000)),
      position: at + 1,
      of: plan.length || null,
      // WHAT THIS ONE IS FOR, in their own words. In front of them while they
      // train rather than said once at the start and lost.
      aim: session.aim || null,
    },
    progress,
    current: current && {
      name: current.name,
      set_number: doneHere.length + 1,
      sets: current.sets,
      target_reps: current.reps,
      cue: current.cue || null,
      muscles: current.muscles || [],
      // Prescribed load, already in the user's own units. Null is a real answer
      // — with no history it refuses to invent a weight and gives an RPE.
      prescribed: call?.weight_kg != null ? w(call.weight_kg) : null,
      rpe: call?.rpe ?? null,
      say: call?.say || null,
      verdict: call?.verdict || null,
      done: doneHere.map(s => ({ reps: s.reps, weight: w(s.weight_kg), rpe: s.rpe })),
    },
    rest: { seconds: restFor, left: restLeft },
    upcoming: upcoming.map(e => ({ name: e.name, sets: e.sets, reps: e.reps })),
    totals: { ...totals, volume: w(totals.volume_kg) },
    today: localDateFor(profile.timezone),
  });
};
