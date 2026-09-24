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

import { restingBurn, PACES, PUSH, weekSoFar, weekTargets } from './training.js';
import { STYLES, creditedName } from './design.js';

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
  // THE STANDING COACH. Optional and never in `missing`: the plain trainer is
  // a complete answer, and demanding somebody pick a tradition before their
  // first session is the setup interview the warm-up doctrine forbids.
  const coach = profile.coach_style && STYLES[profile.coach_style] ? profile.coach_style : null;
  const coachSt = coach ? STYLES[coach] : null;

  const missing = [];
  if (!intent) missing.push('what they are actually after — losing, gaining, or both at once');
  if (!pace)   missing.push('how fast they want it: gentle, steady, or aggressive');
  if (!push)   missing.push('how hard WROUGHT should chase them: light, normal, or relentless');
  if (!profile.train_days) missing.push('sessions a week they will honestly do');

  // BASAL, NEVER A LIFESTYLE MULTIPLIER — goalCall's rule, and the same
  // computation, because the plan somebody is TOLD and the target that was
  // WRITTEN must never be priced off two different bases. See goalCall for
  // the founder's instruction and what it costs.
  const rest = restingBurn(profile, weightKg);
  const maintenance = rest.kcal != null ? rest.kcal : null;

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
  if (coachSt) {
    lines.push(`Coach: ${coachSt.say}${coachSt.tradition ? `, ${coachSt.tradition}` : ''}.`);
  }
  if (target) {
    // ABOVE BASAL IS NOT A SURPLUS. A target stored under the old
    // maintenance basis sits above basal, and calling that a "surplus" tells
    // somebody who is losing weight that they are gaining. Above basal simply
    // means the deficit comes from movement rather than from the plate.
    lines.push(maintenance == null
      ? `Daily: about ${target} kcal.`
      : deficit >= 0
        ? `Daily: about ${target} kcal against a basal of about ${maintenance} — a ${deficit} deficit before you move at all, roughly ${Math.abs(rate)}kg a week on basal alone, and faster than that on a day you move.`
        : `Daily: about ${target} kcal against a basal of about ${maintenance} — ${Math.abs(deficit)} above basal, so the deficit comes from what you move rather than from the plate.`);
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
    // The standing coach — the key, its name, the tradition it is credited
    // to, and the register it talks in. Null is the plain trainer.
    coach,
    coach_say: coachSt?.say || null,
    coach_tradition: coachSt?.tradition || null,
    coach_voice: coachSt?.voice
      ? { register: coachSt.voice.register, intensity: coachSt.voice.intensity, attitude: coachSt.voice.attitude }
      : null,
    // How the coach runs the WEEK and the DAY — static words. What today IS
    // in that tradition is coachDay(), computed from the record.
    coach_habit: coachSt?.day?.habit || null,
    coach_rhythm: coachSt?.day ? { rhythm: coachSt.day.rhythm, per_week: coachSt.day.per_week } : null,
    calorie_target: target,
    // The context that turns a number into a decision. Never quoted apart.
    // This is BASAL — see the comment above the computation.
    maintenance,
    basis: 'basal',
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

// ── The standing coach runs the day ─────────────────────────────────────────
// The founder: "get these training styles into our daily plan with the GPT —
// the same aggressiveness, the same lifestyle, on a daily."
//
// planRead says WHO coaches. This says what TODAY is in that tradition —
// a training day, an easy day, a rest day the rhythm calls for, a lighter day
// the body asked for, a week already met, or a day already trained — and the
// one line the coach says about it, in its own register. Computed once, from
// the record, and relayed by every surface that speaks for the coach (the
// morning push, brief, my_plan, suggest_workout, end_session, the dashboard),
// so the lock screen and the conversation cannot disagree about the day.
//
// THE PRECEDENCE IS THE DOCTRINE, top wins:
//   care flag (null — coaching stops) > trained today > week met >
//   readiness veto > the person's commitment > the tradition's rhythm.
// A coach can only ever REMOVE an offer: it may withhold "up next" or quiet a
// week nudge on its rest day. It never adds a session, a set, a load, a
// target, a line or a notification, and it never says anything about food or
// a body. Relentless is a register, not a licence.

export const DAY_STATES = ['train', 'easy', 'rest', 'held', 'met', 'done'];

export const COACH_DAY_NOTE = 'Say `say` ONCE, in this register, after the facts they asked for and after the week and any readiness line — never instead of them. When coach_day is present its register replaces gym bro\'s for this reply; gym bro is only how they address Wrought. It changes wording and names the tradition\'s rhythm only — never a session beyond what they committed, a set, a load, a calorie, a target, or anything about food or their body. Nothing in `never` is ever offered, whatever the tradition is famous for. A rest or easy state is information, never a refusal: if they want to train, build it. Name the coach only as `name` — a tradition, never the person\'s programme or endorsement. On an evening close use the register only and do not plan tomorrow.';

const DAY_MS = 86400000;
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * Today in the standing coach's tradition, or null.
 *
 * Pure: no database, no clock, no model. The caller passes `today` (the
 * person's own local date) and the days it already holds.
 *
 * @param profile    profile row — coach_style, train_days and the commitment
 * @param flags      careFlags() output — anything here returns null
 * @param days       rangeFacts days (date, sessions), oldest first or any order
 * @param today      YYYY-MM-DD in their zone
 * @param week       weekSoFar() output the caller already prints, so the coach
 *                   and the week line can never disagree; computed if absent
 * @param readiness  readiness() output for today, or null
 */
export function coachDay({ profile = {}, flags = [], days = [], today = null, week = null, readiness = null } = {}) {
  // R0 — SILENCE. No coach, a stale key, a style with no day, or no date: the
  // plain trainer, which costs nothing. A care flag: coaching stops, and this
  // is coaching. The scheduled briefs still send their facts.
  const key = profile?.coach_style || null;
  const st = key ? STYLES[key] : null;
  if (!st || !st.day || !today) return null;
  if (flags && flags.length) return null;
  const day = st.day;

  // R1 — the week the person COMMITTED to, never the tradition's frequency.
  const wk = week ?? weekSoFar(days, { today, ...weekTargets(profile) });

  // R2 — what the record says about today and the last session before it.
  const list = Array.isArray(days) ? days : [];
  const trainedToday = (list.find(x => x.date === today)?.sessions || 0) > 0;
  const last = list.filter(x => x.date < today && (x.sessions || 0) > 0).map(x => x.date).sort().pop() || null;
  const daysSince = last ? dayDiff(last, today) : null;

  // R3 — what the commitment still needs, and the days after today to do it.
  const need = wk?.target ? Math.max(0, wk.target - (wk.done || 0)) : 0;
  const dl = wk?.days_left ?? 7;

  // R4 — the state. First match wins.
  let state = 'train', why = 'default', nextIn = null;
  if (trainedToday) { state = 'done'; why = 'trained_today'; }
  else if (wk?.met) { state = 'met'; why = 'week_met'; }
  else if (readiness && readiness.known !== false && readiness.state && readiness.state !== 'ready') {
    // The body's veto beats every intensity. It only ever softens.
    state = 'held'; why = 'readiness';
  } else if (day.gap_days > 0 && daysSince != null && daysSince <= day.gap_days) {
    if (need <= dl) {
      // The tradition wants the days off and the week still fits without today.
      state = 'rest'; why = 'rhythm_gap'; nextIn = day.gap_days + 1 - daysSince;
    } else if (need === dl + 1) {
      // Resting today would make their OWN week impossible. The commitment is
      // theirs; the tradition's spacing yields to it.
      state = 'train'; why = 'commitment_first';
    } else {
      // Already short whatever happens today: nothing is saved by training
      // through the rest, and nothing is counted down.
      state = 'rest'; why = 'rhythm_gap'; nextIn = day.gap_days + 1 - daysSince;
    }
  } else if (day.rhythm === 'hard_easy' && daysSince === 1) {
    state = 'easy'; why = 'after_hard_day';
  } else if (day.rhythm === 'base') {
    state = 'easy'; why = 'base';
  }

  // R5 — whether today is a day to offer a session at all. Every non-training
  // state may only withhold the offer, never add one.
  const offers = state === 'train' || (state === 'easy' && day.rhythm === 'base');

  // R6 — how their commitment sits against the tradition. Information only:
  // offered once when the coach is set, never written.
  const [lo, hi] = day.per_week || [];
  const td = Number(profile?.train_days) || null;
  const fit = td == null || lo == null ? null
    : td > hi ? 'more_than_tradition' : td < lo ? 'fewer_than_tradition' : 'within';

  return {
    coach: key,
    name: creditedName(st),
    title_tag: String(st.say).toUpperCase(),
    register: st.voice?.register || null,
    intensity: st.voice?.intensity || null,
    state,
    why,
    say: day.lines?.[state] || day.lines?.train || null,
    habit: day.habit || null,
    never: day.never || null,
    rhythm: day.rhythm,
    per_week: day.per_week || null,
    offers_session: offers,
    next_in_days: nextIn,
    fit,
    // R7 — the lock-screen clause, only where it changes what today is.
    tag: state === 'rest' ? 'REST DAY' : state === 'held' ? 'LIGHT DAY' : state === 'easy' && !offers ? 'EASY DAY' : null,
    note: COACH_DAY_NOTE,
  };
}

/** The register alone — for replies that carry the voice but not the day. */
export const coachRegister = cd => cd ? { name: cd.name, register: cd.register, intensity: cd.intensity } : null;

/**
 * A standing coach silenced by a care flag, said as a fact rather than left
 * as an unexplained silence. A gate nobody can see is indistinguishable from
 * a product that never asks; the coach going quiet with no reason looks like
 * the feature broke. Carries no coaching — only that it is paused and why.
 */
export function coachPaused({ profile = {}, flags = [] } = {}) {
  const key = profile?.coach_style || null;
  if (!key || !STYLES[key] || !flags?.length) return null;
  return {
    coach: key,
    name: creditedName(STYLES[key]),
    say: 'Your coach is paused while the record review stands — coaching stops under a care flag. Your briefs still arrive with their facts.',
  };
}
