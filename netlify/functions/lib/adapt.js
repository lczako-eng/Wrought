// lib/adapt.js
// The scale corrects the target — computed, offered, never applied on its own.
//
// Every surface in this product says "the weekly weigh-in trend corrects the
// target, never the other way round", and until now nothing DID it. The
// projected rate and the real one were both computed and never compared, so
// the one number the whole product promises to get right was left to a
// sentence. This is the arithmetic.
//
// THE METHOD, and why it is the honest one. A target is priced off basal — a
// formula from four facts, and the founder's instruction. But a body's real
// expenditure is not a formula, it is what the scale says after a stretch of
// known eating:
//
//   expenditure ≈ average intake − (weight change × 7,700 kcal per kg) / days
//
// Somebody eating 1,900 a day who loses 0.4 kg a week is spending about
// 2,340. That figure needs no height, no age, no lifestyle multiplier — it
// comes from two things the record already holds, and it is the only number
// that can say whether the plan is doing what it claims.
//
// RULES, each of which exists because the alternative hurts somebody:
//
// - NEVER APPLIED ON ITS OWN. It is offered with its working, and the person
//   moves the target with one word or one tap. A target that changes under
//   somebody is a target they stop trusting.
// - A THIN LOG IS NOT A READ. Under ten logged days, four weigh-ins or a
//   fortnight's span it says what it is missing rather than a number; under
//   60% coverage it reports but never suggests. Unlogged days are assumed to
//   look like logged ones, and the caveat says so.
// - THE STEP IS CAPPED at 300 kcal a fortnight. A read is noisy — salt, sleep
//   and a heavy week move the scale by more than a real fortnight of fat — so
//   the target moves toward the read, never jumps to it.
// - THE FLOORS DO NOT MOVE. Never below 1,200; never past the rapid-loss
//   ceiling the care flags warn at. A trend faster than that ceiling only
//   ever moves the target UP.
// - A GAIN OR RECOMP is read the same way, in its own direction.
// - RECORDED, NOT MORALISED. Slower than projected is a fact about the
//   arithmetic, never about the person.

import { weightTrend } from './wrought.js';
import { restingBurn, PACES } from './training.js';

const KCAL_PER_KG = 7700;
const MIN_LOGGED_DAYS = 10;
const MIN_WEIGH_INS = 4;
const MIN_SPAN_DAYS = 14;
const MIN_COVERAGE = 0.6;
export const MAX_STEP = 300;
const RAPID_LOSS_CEILING = 1.0;   // kg/week — careFlags warns at 1.2; plans stop under it
const FLOOR = 1200;
const NO_CHANGE_BAND = 75;        // a move smaller than this is noise, not a correction

const round = v => Math.round(Number(v) || 0);
const money = v => round(v).toLocaleString();
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/**
 * @param days      rangeFacts() days (28–30 of them ending today)
 * @param profile   the profile row
 * @param goals     getGoals() output
 * @param weightKg  most recent weigh-in anywhere
 * @param today     the person's local date — excluded, because an open day is
 *                  never intake evidence
 */
export function calibration({ days = [], profile = {}, goals = [], weightKg = null, today = null } = {}) {
  const closed = (days || []).filter(d => d.date && d.date !== today);
  const calGoal = goals.find(g => g.metric === 'calories' && g.cadence === 'daily' && g.active !== false);
  const bodyGoal = goals.find(g => g.metric === 'weight_kg');
  const intent = bodyGoal
    ? (bodyGoal.direction === 'at_least' ? 'gain' : /recomp/i.test(bodyGoal.goal || '') ? 'recomp' : /hold where|maintain/i.test(bodyGoal.goal || '') ? 'maintain' : 'lose')
    : calGoal ? 'lose' : null;
  const target = calGoal?.target_value != null ? round(calGoal.target_value) : null;

  // A day counts as intake evidence when something with calories was logged
  // and the person has not marked the day as an incomplete diary.
  const fed = closed.filter(d => d.meals > 0 && d.calories > 0 && d.food_log_complete !== false);
  const weighed = closed.filter(d => d.weight_kg != null);
  const span = weighed.length >= 2 ? daysBetween(weighed[0].date, weighed[weighed.length - 1].date) : 0;

  const missing = [];
  if (fed.length < MIN_LOGGED_DAYS) missing.push(`${fed.length} logged day${fed.length === 1 ? '' : 's'} with calories — it needs ${MIN_LOGGED_DAYS}`);
  if (weighed.length < MIN_WEIGH_INS) missing.push(`${weighed.length} weigh-in${weighed.length === 1 ? '' : 's'} — it needs ${MIN_WEIGH_INS}`);
  else if (span < MIN_SPAN_DAYS) missing.push(`${span} days between the first and last weigh-in — it needs ${MIN_SPAN_DAYS}`);
  if (missing.length) {
    return {
      known: false, missing,
      logged_days: fed.length, weigh_ins: weighed.length, span_days: span,
      say: `The scale cannot correct the target yet: ${missing.join('; ')}. Keep logging and weighing in and it will.`,
      note: 'Say what is missing in one clause and nothing more. Never estimate an expenditure or a corrected target yourself — this read exists so that number is computed, not guessed.',
    };
  }

  // Intake over the fed days, and the trend over the weigh-ins in the same
  // window. Unlogged days are assumed to look like logged ones; the coverage
  // figure says how much of the window that assumption covers.
  const windowStart = weighed[0].date, windowEnd = weighed[weighed.length - 1].date;
  const inWindow = fed.filter(d => d.date >= windowStart && d.date <= windowEnd);
  const intakeDays = inWindow.length >= MIN_LOGGED_DAYS ? inWindow : fed;
  const avgIntake = round(intakeDays.reduce((a, d) => a + d.calories, 0) / intakeDays.length);
  const coverage = Math.round((intakeDays.length / Math.max(1, span + 1)) * 100) / 100;
  const thin = coverage < MIN_COVERAGE;

  const trend = weightTrend(weighed, profile.units);
  const perWeek = Number(trend.per_week_kg) || 0;            // negative = losing
  const dailyChange = (perWeek * KCAL_PER_KG) / 7;
  const expenditure = round(avgIntake - dailyChange);

  const rest = restingBurn(profile, weightKg);
  const basal = rest.kcal ?? null;

  // What the plan projected, priced the way the plan prices it — off basal.
  const projected = basal != null && target != null
    ? -Math.round(((basal - target) * 7 / KCAL_PER_KG) * 100) / 100 : null;

  // The verdict is about the ARITHMETIC. Slower than projected is not a
  // failing; it is the number the plan was missing.
  let verdict = 'no_plan';
  if (projected != null && intent) {
    const diff = perWeek - projected;                        // >0 = losing slower than projected (or gaining faster)
    if (Math.abs(diff) <= 0.15) verdict = 'on_track';
    else if (intent === 'gain') verdict = diff > 0 ? 'faster' : 'slower';
    else verdict = diff > 0 ? 'slower' : 'faster';
  }

  // THE CORRECTION. The deficit the plan asked for, applied to what the body
  // actually spends rather than to a formula about it.
  let suggested = null, held = null, reason = null;
  if (target != null && intent && intent !== 'maintain' && !thin) {
    const w = Number(weightKg) || Number(weighed[weighed.length - 1].weight_kg) || 0;
    const p = PACES[profile.plan_pace] || PACES.steady;
    let want;
    if (intent === 'lose') {
      const paced = Math.round((p.pct * w * KCAL_PER_KG) / 7);
      want = expenditure - Math.min(p.max, Math.max(p.min, paced));
    } else if (intent === 'recomp') {
      want = expenditure - 300;
    } else {
      want = expenditure + (profile.plan_pace === 'aggressive' ? 400 : 250);
    }
    // The rails. Never under the floor; never a projection past the ceiling.
    const ceiling = expenditure - Math.round((RAPID_LOSS_CEILING * KCAL_PER_KG) / 7);
    if (intent !== 'gain' && want < ceiling) { want = ceiling; held = `Held so the projected loss stays under ${RAPID_LOSS_CEILING}kg a week, where WROUGHT warns rather than coaches.`; }
    if (want < FLOOR) { want = FLOOR; held = 'Held at the 1,200 floor — no target here goes below it.'; }
    // The step. Toward the read, never a jump to it.
    const delta = want - target;
    const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, delta));
    if (Math.abs(delta) < NO_CHANGE_BAND) {
      reason = 'within noise of the current target — nothing worth moving';
    } else {
      suggested = round(target + step);
      reason = Math.abs(delta) > MAX_STEP
        ? `moved ${MAX_STEP} toward the read rather than all the way — a fortnight of salt and sleep moves the scale by more than a fortnight of fat, so it steps`
        : 'moved to the read';
    }
    // A trend already faster than the ceiling may only ever move the target
    // UP — the dangerous direction is the one this product refuses.
    if (intent !== 'gain' && perWeek < -RAPID_LOSS_CEILING && suggested != null && suggested < target) {
      suggested = null; reason = 'losing faster than the ceiling — the target does not come down';
    }
  }

  const trendSay = trend.direction === 'flat'
    ? 'the scale held steady'
    : `the scale moved ${perWeek < 0 ? 'down' : 'up'} about ${Math.abs(perWeek)}kg a week`;
  const projSay = projected != null ? ` against a projected ${projected < 0 ? 'loss' : projected > 0 ? 'gain' : 'hold'} of ${Math.abs(projected)}kg a week` : '';
  const verdictSay = {
    on_track: 'That is on pace.',
    slower: 'That is slower than the plan projected.',
    faster: 'That is faster than the plan projected.',
    no_plan: '',
  }[verdict];
  const say =
    `Over ${intakeDays.length} logged days you averaged about ${money(avgIntake)} kcal and ${trendSay}${projSay}. ${verdictSay} ` +
    `That reads as a real expenditure of about ${money(expenditure)} a day` +
    (basal != null ? ` (basal ${money(basal)}, so about ${money(expenditure - basal)} of it is movement)` : '') + '. ' +
    (suggested != null
      ? `To keep the ${profile.plan_pace || 'steady'} pace, the target would move from ${money(target)} to about ${money(suggested)}.`
      : target != null ? `The ${money(target)} target stands${reason ? ` — ${reason}` : ''}.` : 'No calorie target is set to correct.') +
    (held ? ` ${held}` : '') +
    (thin ? ` The log covers ${Math.round(coverage * 100)}% of the window, so this is a reading, not a correction — log more days and it becomes one.` : '');

  return {
    known: true,
    window: { from: windowStart, to: windowEnd, span_days: span },
    logged_days: intakeDays.length,
    weigh_ins: weighed.length,
    coverage,
    thin,
    avg_intake: avgIntake,
    trend_kg_per_week: perWeek,
    trend_say: trend.say,
    projected_kg_per_week: projected,
    verdict,
    expenditure,
    basal,
    movement: basal != null ? expenditure - basal : null,
    intent,
    pace: profile.plan_pace || null,
    current_target: target,
    suggested_target: suggested,
    delta: suggested != null ? suggested - target : 0,
    ...(held ? { held } : {}),
    ...(reason ? { reason } : {}),
    estimated: true,
    say,
    caveat: 'An estimate from two estimates — described meals and a noisy scale. It assumes unlogged days looked like logged ones, and it moves the target in steps for that reason. Two weeks of honest logging and weigh-ins sharpen it more than anything else.',
    note: suggested != null
      ? 'OFFER the move and its working in one line; APPLY it only if they say so (set_plan with recalibrate: true) or they tap it on the plan panel. Never move a target on your own, never round the figures, never invent a reason for the gap — salt, sleep and a heavy week are not separable from here. Slower than projected is a fact about the arithmetic, never about the person.'
      : 'State the read and leave it. Nothing to apply.',
  };
}

// How a recalibrated target is written back — the same rows setBodyGoal
// writes, so a target the scale moved and one a pace set cannot differ in shape.
export function calibratedGoalRow(userId, cal) {
  if (!cal?.known || cal.suggested_target == null) return null;
  return {
    user_id: userId,
    goal: `Calories: about ${cal.suggested_target} a day (recalibrated from the scale, ${cal.intent})`,
    metric: 'calories', direction: cal.intent === 'gain' ? 'at_least' : 'at_most',
    target_value: cal.suggested_target, target_unit: ' kcal', cadence: 'daily',
  };
}
