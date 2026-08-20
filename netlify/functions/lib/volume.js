// lib/volume.js
// Hard sets per muscle per week — the number every real programme is built on.
//
// THE GAP THIS CLOSES. `focusCall` already answers "what have I not trained
// lately", and it counts SESSIONS: a day that touched chest is a day that
// touched chest. But two sets of flyes and twelve sets of pressing are the
// same day by that measure and completely different training, so the log could
// say "chest was worked twice this week" while the chest did almost nothing.
//
// Weekly hard sets per muscle is the variable a coach actually programmes. It
// is the closest thing strength training has to a dose, and it is the first
// question anyone qualified asks of a programme — before exercise selection,
// before split, before anything about the bar.
//
// WHAT THIS IS NOT. It is not a target to chase and it never says "add
// weight". The published band is wide, the individual variation inside it is
// wider, and more volume only counts if it is recovered from — so this reports
// the dose and the direction and leaves the decision where it belongs. Same
// doctrine as everywhere else here: the server computes, the person decides.

import { daysBetween } from './wrought.js';

// The band most commonly cited for productive hypertrophy work, per muscle,
// per week. It is a POPULATION range from the training literature, not a
// prescription for one person — stated as such every single time it is shown,
// because a number this easy to read as a target is exactly the kind that
// stops being an estimate the moment it is quoted without its caveat.
export const SET_BAND = { low: 10, high: 20 };

// Two sessions a week beats one at the same total, which is about the only
// frequency finding solid enough to say out loud. Beyond two the evidence
// stops separating, so nothing here pushes for three.
const FREQ_GOOD = 2;

const GROUPS = ['chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core'];

/**
 * What each muscle actually got, in sets, per week.
 *
 * @param sets   wrought_sets rows: { muscles[], local_date, reps, rpe }
 * @param today  the day to count back from
 * @param weeks  how far back the baseline average looks
 */
export function weeklyVolume(sets = [], { today = null, weeks = 4 } = {}) {
  const rows = (sets || []).filter(s => Array.isArray(s.muscles) && s.muscles.length && s.local_date);
  if (!rows.length) {
    return {
      known: false,
      muscles: [],
      say: 'No sets with a muscle on them yet — this fills in from the first logged session.',
    };
  }

  const last = today || rows.map(r => r.local_date).sort().slice(-1)[0];
  const within = (r, d) => {
    const ago = daysBetween(r.local_date, last);
    return ago >= 0 && ago < d;
  };

  const span = Math.max(1, Number(weeks) || 4) * 7;
  const history = rows.filter(r => within(r, span));
  // The baseline is only as long as the record actually is. Dividing four
  // weeks of sets by four when only nine days exist halves every figure and
  // makes a well-trained fortnight read as neglect.
  const furthestBack = history.reduce((a, r) => Math.max(a, daysBetween(r.local_date, last)), 0);
  const coveredDays = Math.max(1, Math.min(span, furthestBack + 1));
  const coveredWeeks = coveredDays / 7;

  const seen = new Set(rows.flatMap(r => r.muscles));
  const all = [...new Set([...seen, ...GROUPS])];

  const muscles = all.map(m => {
    const mine = history.filter(r => r.muscles.includes(m));
    const week  = mine.filter(r => within(r, 7));
    const prior = mine.filter(r => { const a = daysBetween(r.local_date, last); return a >= 7 && a < 14; });

    const days = new Set(week.map(r => r.local_date));
    const perWeek = Math.round((mine.length / coveredWeeks) * 10) / 10;

    // "None" is a real state and a different one from "low": a muscle nothing
    // has touched is a hole in the programme, not a light week.
    const state = !week.length ? (mine.length ? 'none_this_week' : 'never')
                : week.length < SET_BAND.low ? 'low'
                : week.length <= SET_BAND.high ? 'productive'
                : 'high';

    return {
      muscle: m,
      sets_7d: week.length,
      sets_prior_7d: prior.length,
      // Their own average, which is the only benchmark that means anything
      // about this person. The band is context, not the standard.
      sets_per_week_avg: perWeek,
      // Sessions, not sets — two days at eight sets beats one at sixteen, and
      // that is about the only frequency finding worth stating plainly.
      days_hit_7d: days.size,
      frequency_ok: days.size >= FREQ_GOOD,
      state,
      // Against themselves last week, which is the comparison that survives
      // individual variation. Ignores swings under 3 sets — below that it is
      // exercise selection and what somebody felt like, not a trend.
      direction: !prior.length && !week.length ? null
               : Math.abs(week.length - prior.length) < 3 ? 'holding'
               : week.length > prior.length ? 'up' : 'down',
    };
  }).filter(m => m.sets_per_week_avg > 0 || m.state === 'never');

  const trained = muscles.filter(m => m.state !== 'never');
  const low  = trained.filter(m => m.state === 'low' || m.state === 'none_this_week')
    .sort((a, b) => a.sets_7d - b.sets_7d);
  const high = trained.filter(m => m.state === 'high').sort((a, b) => b.sets_7d - a.sets_7d);
  const thin = trained.filter(m => m.sets_7d > 0 && m.days_hit_7d < FREQ_GOOD && m.sets_7d >= SET_BAND.low);

  const totalWeek = history.filter(r => within(r, 7)).length;

  return {
    known: true,
    days_counted: coveredDays,
    band: SET_BAND,
    total_sets_7d: totalWeek,
    muscles: muscles.sort((a, b) => b.sets_7d - a.sets_7d),
    lowest: low.slice(0, 3).map(m => m.muscle),
    highest: high.slice(0, 3).map(m => m.muscle),
    // High volume crammed into one day is a different problem from high
    // volume, and it is the one somebody can fix without training less.
    one_day_wonders: thin.map(m => m.muscle),
    say: totalWeek
      ? `${totalWeek} hard set${totalWeek === 1 ? '' : 's'} in the last 7 days` +
        (low.length ? `. Lightest: ${low.slice(0, 3).map(m => `${m.muscle} ${m.sets_7d}`).join(', ')}.` :
         high.length ? `. Heaviest: ${high.slice(0, 2).map(m => `${m.muscle} ${m.sets_7d}`).join(', ')}.` : '.')
      : 'No sets logged in the last 7 days.',
    // SAID EVERY TIME. This number is the easiest thing here to read as a
    // target, and read that way it stops being an estimate.
    caveat: `Counted from sets logged with a muscle on them, so anything logged without one is missing from it. ` +
      `${SET_BAND.low}–${SET_BAND.high} sets a week per muscle is a rough band from the training literature, not a target for you — ` +
      `individual variation inside it is large, and volume only counts if it is being recovered from.`,
    note: 'Report the counts and the direction. Do NOT turn a low count into "add weight" — the number here is SETS, and the honest response to a light week is more sets or better frequency, never a heavier bar. If readiness is flagged or a care flag is up, say nothing about adding anything at all.',
  };
}
