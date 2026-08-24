// netlify/functions/api-goals.js
// The website's door for setting a target — one tap on a computed option.
//
// The Targets panel computed every defensible number and then said "say which
// you want to your assistant": a screen that could show the answer and not
// accept it. Same hole the food log had before api-log grew its POST, same
// doctrine closing it — website + connector are each a complete door.
//
// WHAT A TAP MAY CARRY. For a body goal, an INTENT and a PACE — never a
// calorie figure. The numbers come out of the same goalCall the assistant
// uses, floored and held under the care-flag rate, so a tap on "steady cut"
// is a choice between computed options rather than a number the page typed.
// For steps, THEIR number, bounded: a step target is a choice about their own
// day, not an estimate.
//
// ONE WRITE PATH. Everything here goes through lib/goals.js, which set_goal
// also calls — the recordSet lesson, so the tap and the conversation cannot
// write two different shapes of the same intention.

import { getAuthUser } from './lib/wrought.js';
import { setBodyGoal, setMetricGoal } from './lib/goals.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const INTENTS = new Set(['lose', 'maintain', 'gain', 'recomp']);
const PACE_NAMES = new Set(['gentle', 'steady', 'aggressive']);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only.' });

  const user = await getAuthUser(event);
  if (!user) return json(401, { error: 'sign_in_required' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON.' }); }

  // A body goal: intent + optional pace. The page's buttons send exactly this.
  if (body.intent) {
    if (!INTENTS.has(body.intent)) return json(400, { error: `intent is one of: ${[...INTENTS].join(', ')}.` });
    if (body.pace != null && !PACE_NAMES.has(body.pace)) {
      return json(400, { error: `pace is one of: ${[...PACE_NAMES].join(', ')}.` });
    }
    const done = await setBodyGoal(user.id, { intent: body.intent, pace: body.pace || null });
    if (done.error === 'setup_needed') {
      // The five facts are missing — the form for those already lives on the
      // hero panel, so the answer points there rather than dead-ending.
      return json(409, { error: 'setup_needed', missing: done.missing, say: done.say });
    }
    if (done.error) return json(500, { error: done.error });
    return json(200, {
      set: true, goal: done.goal, pace: done.pace,
      calories_per_day: done.call.calorie_target,
      protein_g_per_day: done.call.protein_target_g,
      maintenance: done.call.maintenance,
      projected_kg_per_week: done.call.projected_kg_per_week,
      ...(done.call.held ? { held: done.call.held } : {}),
    });
  }

  // A metric goal — steps today, the rest as the panels grow buttons.
  if (body.metric) {
    const done = await setMetricGoal(user.id, {
      metric: body.metric, target: body.target,
      direction: body.metric === 'calories' ? 'at_most' : 'at_least',
    });
    if (done.error) return json(400, { error: done.error });
    return json(200, { set: true, goal: done.row.goal, replaced: done.replaced || null });
  }

  return json(400, { error: 'Send an intent (lose / maintain / gain / recomp) or a metric with a target.' });
};
