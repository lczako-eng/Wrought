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
  supabase, getAuthUser, getProfile, localDateFor, kgToLb,
} from './lib/wrought.js';
import { lastPerformance, progressionCall, sessionTotals, exerciseKey } from './lib/training.js';
import { sessionProgress } from './lib/warmup.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

  const { data: session } = await supabase.from('wrought_sessions')
    .select('id, name, kind, plan, cursor_index, started_at, local_date, routine_id')
    .eq('user_id', user.id).eq('status', 'active').maybeSingle();

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
