// netlify/functions/lib/goals.js
// The ONE write path for setting a target, shared by the two doors.
//
// The founder: "we should have our targets as well — let's make this an app
// that you have to set target goals, so it will bring you to your app through
// GPT like a pop-up hyperlink."
//
// The website had NO way to set a goal. The Targets panel computed every
// defensible option and then said "say which you want to your assistant" — the
// same hole the food log had before api-log grew its POST, on the same settled
// doctrine: website + connector are each a complete door. A link from the
// assistant that lands on a screen which can only point back at the assistant
// is a corridor, not a door.
//
// EXTRACTED, NOT COPIED, and that is the point of this file. `set_goal` in
// mcp.js and the dashboard's tap both call these functions, so the two doors
// cannot drift — the recordSet lesson: two copies of a write path show up as
// two surfaces disagreeing about the same account, which is the precise thing
// a memory product cannot afford. mcp.js keeps its phrasing; the writes live
// here.
//
// THE NUMBERS ARE STILL NEVER THE CLIENT'S. A body goal takes an INTENT and a
// PACE; goalCall computes the calories and protein from their own facts,
// floored at 1,200 and held under the care-flag rate. A tap on "steady cut" is
// a choice between computed options, never a figure the page typed — the
// invented-2,600 incident is the whole reason this shape exists.

import { supabase, getProfile, SET_TARGETS_URL } from './wrought.js';
import { goalCall, PACES } from './training.js';

/**
 * Retire every active goal aiming at the same metric+cadence. Returns a human
 * summary of what was replaced, or null. Retired, never deleted — what
 * somebody used to aim at is part of the record.
 */
export async function retireGoalsFor(userId, metric, cadence) {
  if (!metric) return null;
  const { data } = await supabase.from('wrought_goals')
    .select('id, goal, target_value, target_unit')
    .eq('user_id', userId).eq('active', true).eq('metric', metric).eq('cadence', cadence || 'daily');
  if (!data?.length) return null;
  await supabase.from('wrought_goals').update({ active: false })
    .in('id', data.map(g => g.id));
  return data.map(g => `${g.goal}${g.target_value != null ? ` (${g.target_value}${g.target_unit || ''})` : ''}`).join('; ');
}

/**
 * A body goal, computed and written: the goal row, the calorie target and the
 * protein target in one transaction-shaped call, plus the pace onto the plan —
 * so a new pace can never stand beside an old target (the stacked-rings bug).
 *
 * Returns { ok, call } or { error, missing?, say? }.
 */
export async function setBodyGoal(userId, { intent, pace = null, goalText = null, target = null, targetDate = null }) {
  const profile = await getProfile(userId);
  const { data: recent } = await supabase.from('wrought_events')
    .select('detail').eq('user_id', userId).eq('event_type', 'weight')
    .order('occurred_at', { ascending: false }).limit(1);
  const weightKg = recent?.[0]?.detail?.value_kg ?? null;

  const usePace = PACES[pace] ? pace : (profile.plan_pace || 'steady');
  const call = goalCall({ profile, weightKg, intent, pace: usePace });
  if (!call.known) return { error: 'setup_needed', missing: call.missing, say: call.say };

  for (const m of ['weight_kg', 'calories', 'protein_g']) {
    await retireGoalsFor(userId, m, m === 'weight_kg' ? 'once' : 'daily');
  }

  const goal = goalText || {
    lose: 'Lose weight', maintain: 'Hold where I am',
    gain: 'Gain', recomp: 'Lose fat and build muscle',
  }[intent] || String(intent);

  const rows = [
    { user_id: userId, goal, metric: 'weight_kg', direction: intent === 'gain' ? 'at_least' : 'reach',
      target_value: target != null ? Number(target) : null,
      target_unit: 'kg', cadence: 'once', target_date: targetDate || null },
    { user_id: userId, goal: `Calories: about ${call.calorie_target} a day (computed, ${intent})`,
      metric: 'calories', direction: intent === 'gain' ? 'at_least' : 'at_most',
      target_value: call.calorie_target, target_unit: ' kcal', cadence: 'daily' },
    { user_id: userId, goal: `Protein: about ${call.protein_target_g}g a day (computed)`,
      metric: 'protein_g', direction: 'at_least',
      target_value: call.protein_target_g, target_unit: 'g', cadence: 'daily' },
  ];
  const { error } = await supabase.from('wrought_goals').insert(rows);
  if (error) return { error: error.message };

  // The pace lives on the plan, so "what am I actually doing" has one answer.
  const planRow = { user_id: userId, plan_pace: usePace, plan_set_on: new Date().toISOString().slice(0, 10) };
  const { error: planErr } = await supabase.from('wrought_profile').upsert(planRow, { onConflict: 'user_id' });
  // A missing 014 loses the pace note, never the goal — the goal rows are
  // already written and are the thing being asked for.
  if (planErr && !/column .* does not exist/i.test(planErr.message)) return { error: planErr.message };

  return { ok: true, goal, pace: usePace, call };
}

/**
 * A plain metric goal — steps, distance, active minutes. THEIR number: a step
 * target is a choice about their own day, not an estimate, so it is accepted
 * as typed — bounded, because 0 and 900,000 are typos, not ambitions.
 */
export async function setMetricGoal(userId, { metric, target, direction = 'at_least', cadence = 'daily', goalText = null }) {
  const BOUNDS = {
    steps: [500, 100000], distance_km: [0.5, 200], active_minutes: [5, 600],
    calories: [1200, 10000], protein_g: [20, 400],
  };
  const b = BOUNDS[metric];
  if (!b) return { error: `Not a settable metric: ${metric}.` };
  const t = Number(target);
  if (!Number.isFinite(t) || t < b[0] || t > b[1]) {
    return { error: `A ${metric} target between ${b[0]} and ${b[1]} — ${target} looks like a typo.` };
  }

  const replaced = await retireGoalsFor(userId, metric, cadence);
  const row = {
    user_id: userId,
    goal: goalText || `${metric === 'steps' ? `${t.toLocaleString('en-US')} steps` : `${t} ${metric.replace(/_/g, ' ')}`} a day`,
    metric, target_value: t,
    target_unit: metric === 'distance_km' ? 'km' : metric === 'active_minutes' ? 'min' : metric === 'protein_g' ? 'g' : metric === 'calories' ? ' kcal' : null,
    direction, cadence,
  };
  const { error } = await supabase.from('wrought_goals').insert([row]);
  if (error) return { error: error.message };
  return { ok: true, row, replaced };
}

// Re-exported from wrought.js so every consumer names the same door.
export { SET_TARGETS_URL };
