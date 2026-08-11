// lib/plan.js
// The plan, read out. One function, so the dashboard and the assistant can
// never state it differently.
//
// The founder asked for the plan twice and in two different ways, and both
// asks land here:
//
//   "your plans to tailor-made plan for you — aggressive, non-aggressive fat
//    burning — and how hard this thing's gonna prompt you ... it should give
//    you the ability to change it any time."
//
//   "it might say you're allowed 2,400 a day, but it should also let you know
//    that your maintenance is this while what you're trying to achieve is
//    that."
//
// A TARGET WITHOUT ITS MAINTENANCE IS AN ARBITRARY NUMBER. 2,400 on its own is
// a rule handed down; 2,400 against a maintenance of 3,400 is a
// thousand-calorie decision with a rate attached, and it is the only version
// somebody can judge rather than argue with. So the three never travel apart.
//
// It lived only inside the `my_plan` tool, which meant the plan was something
// you could be TOLD and never somewhere you could go and LOOK — and a memory
// product that cannot show you what it remembers is asking for trust it has
// not earned. Pure: it takes the profile, the goals and a weight, and does no
// database work of its own, so both callers fetch the way they already fetch.

import { restingBurn, ACTIVITY, PACES, PUSH } from './training.js';

/**
 * @param profile   the user's profile row
 * @param goals     getGoals() output
 * @param weightKg  most recent weigh-in anywhere — never the window's
 */
export function planRead({ profile = {}, goals = [], weightKg = null } = {}) {
  const bodyGoal = goals.find(g => g.metric === 'weight_kg');
  const calGoal  = goals.find(g => g.metric === 'calories' && g.cadence === 'daily');
  const proGoal  = goals.find(g => g.metric === 'protein_g' && g.cadence === 'daily');

  // Read off the goal that was actually set rather than stored twice — two
  // copies of the same fact is two things to drift apart.
  const intent = bodyGoal
    ? (bodyGoal.direction === 'at_least' ? 'gain'
       : /recomp/i.test(bodyGoal.goal || '') ? 'recomp' : 'lose')
    : calGoal ? 'lose' : null;

  const pace = profile.plan_pace || null;
  const push = profile.plan_push || null;

  const missing = [];
  if (!intent) missing.push('what they are actually after — losing, gaining, or both at once');
  if (!pace)   missing.push('how fast they want it: gentle, steady, or aggressive');
  if (!push)   missing.push('how hard WROUGHT should chase them: light, normal, or relentless');
  if (!profile.train_days) missing.push('sessions a week they will honestly do');

  const rest = restingBurn(profile, weightKg);
  const level = ACTIVITY[profile.activity_level];
  const maintenance = rest.kcal != null
    ? rest.kcal + (level ? Math.round(rest.kcal * (level.mult - 1)) : 0)
    : null;

  const target = calGoal?.target_value != null ? Math.round(calGoal.target_value) : null;
  const deficit = maintenance != null && target != null ? maintenance - target : null;
  // 7,700 kcal to a kilo. Labelled a projection everywhere it is shown, because
  // the weekly weigh-in trend corrects the target and never the other way round.
  const rate = deficit != null ? -Math.round((deficit * 7 / 7700) * 100) / 100 : null;

  const lines = [];
  if (intent) lines.push(`Aiming at: ${bodyGoal?.goal || intent}.`);
  if (pace) lines.push(`Pace: ${pace}. ${PACES[pace]?.say || ''}`);
  if (push) lines.push(`Pushing: ${push}. ${PUSH[push]?.say || ''}`);
  if (profile.train_days) {
    lines.push(`Training ${profile.train_days} a week, at ${profile.tier || 'intermediate'} level.`);
  }
  if (target) {
    lines.push(maintenance != null
      ? `Daily: about ${target} kcal against a maintenance of about ${maintenance} — a ${Math.abs(deficit)} ${deficit >= 0 ? 'deficit' : 'surplus'}, roughly ${Math.abs(rate)}kg a week.`
      : `Daily: about ${target} kcal.`);
    if (proGoal?.target_value) lines.push(`Protein about ${Math.round(proGoal.target_value)}g.`);
  }

  return {
    set: missing.length === 0,
    intent,
    goal: bodyGoal?.goal || null,
    pace, push,
    pace_say: pace ? PACES[pace]?.say || null : null,
    push_say: push ? PUSH[push]?.say || null : null,
    train_days: profile.train_days || null,
    tier: profile.tier || null,
    calorie_target: target,
    // The context that turns a number into a decision. Never quoted apart.
    maintenance,
    deficit,
    projected_kg_per_week: rate,
    resting_burn: rest.kcal ?? null,
    resting_basis: rest.basis || null,
    protein_target_g: proGoal?.target_value != null ? Math.round(proGoal.target_value) : null,
    set_on: profile.plan_set_on || null,
    missing: missing.length ? missing : null,
    lines,
    say: lines.length ? lines.join(' ') : 'No plan set yet.',
  };
}
