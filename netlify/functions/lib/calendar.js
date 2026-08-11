// lib/calendar.js
// The month, day by day, with both halves of the sum on every square.
//
// The founder's ask, and the original annoyance restated: "I want a calendar
// with everything I ate, and I wanna know calories in versus calories out —
// you add up the math. Then weekly, then yearly."
//
// Everything else on the dashboard is arithmetic ABOUT the record — averages,
// matrices, trends. A calendar is the record laid out the way a person already
// thinks about time: squares, in rows of seven. It is the only view where "I
// was good all week except Thursday" is a thing you can SEE rather than derive.
//
// THE RULE THAT MAKES IT HONEST, and the reason this is not thirty lines in the
// page: a day nobody logged is not a zero-calorie day. Summing raw calendar
// days would count every unlogged day as a perfect fast, manufacture an
// enormous deficit out of forgetfulness, and then tell somebody they are losing
// two kilos a week. That error runs in the dangerous direction — it invites
// eating less on the back of a number that only measures how often the app was
// opened. So totals and averages count LOGGED days only, and say how many.
//
// Same reasoning on the other side: calories out needs height, birth year and a
// weight. Without them the figure is null on every square rather than a resting
// burn standing in for a day of work, which is the error that overstates a
// deficit. Nothing is guessed to fill a cell.

import { restingBurn, ACTIVITY } from './training.js';

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Bodyweight moves slowly and is weighed irregularly, so the resting burn for a
// Tuesday with no weigh-in uses the nearest real one. Forward first — the most
// recent reading BEFORE the day is the truest thing available — then backwards,
// so days before somebody ever stepped on a scale still get a figure rather
// than a hole at the start of every history.
function weightByDay(days) {
  const out = new Map();
  let carried = null;
  for (const d of days) {
    if (d.weight_kg != null) carried = d.weight_kg;
    out.set(d.date, carried);
  }
  let back = null;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.weight_kg != null) back = d.weight_kg;
    if (out.get(d.date) == null) out.set(d.date, back);
  }
  return out;
}

// What a day burned. A measurement always beats a multiplier, and with neither
// the day is flagged rather than quietly counted as time spent lying down.
function burnFor(profile, weightKg, activeCalories) {
  const rest = restingBurn(profile, weightKg);
  if (rest.kcal == null) return { out: null, missing: rest.missing };

  const measured = n(activeCalories);
  const level = ACTIVITY[profile.activity_level];
  const active = measured > 0 ? Math.round(measured)
    : level ? Math.round(rest.kcal * (level.mult - 1))
    : 0;

  return {
    out: rest.kcal + active,
    resting: rest.kcal,
    active,
    source: measured > 0 ? 'device' : level ? 'activity_level' : 'none',
    missing: [],
  };
}

/**
 * One entry per calendar day in the range, newest last.
 *
 * @param days      rangeFacts().days
 * @param foodRows  food and drink events, with summary and detail
 * @param profile   the user's profile
 */
export function calendarDays({ days = [], foodRows = [], profile = {} } = {}) {
  const weights = weightByDay(days);

  // Meals belong to the day they were eaten, in the order they went in.
  const mealsByDay = new Map();
  for (const r of foodRows) {
    if (!mealsByDay.has(r.local_date)) mealsByDay.set(r.local_date, []);
    mealsByDay.get(r.local_date).push({
      summary: r.summary || 'logged',
      calories: r.detail?.calories != null ? Math.round(n(r.detail.calories)) : null,
      protein_g: r.detail?.protein_g != null ? Math.round(n(r.detail.protein_g)) : null,
      estimated: !!r.estimated,
    });
  }

  return days.map(d => {
    const burn = burnFor(profile, weights.get(d.date), d.active_calories);
    const meals = mealsByDay.get(d.date) || [];
    const inn = d.calories != null ? d.calories : null;

    return {
      date: d.date,
      logged: !!d.logged,
      in: inn,
      out: burn.out,
      // Only a real subtraction. One side missing means no net, never a net
      // computed against a zero that nobody measured.
      net: inn != null && burn.out != null ? inn - burn.out : null,
      resting: burn.resting ?? null,
      active: burn.active ?? null,
      active_source: burn.source || null,
      meals,
      meal_count: meals.length,
      sessions: d.sessions || 0,
      minutes: d.minutes || 0,
      protein_g: d.protein_g,
      weight_kg: d.weight_kg,
      steps: d.steps,
      estimated: meals.some(m => m.estimated),
    };
  });
}

// A window over those days. Counts only days that were actually logged, and
// says so — see the note at the top of the file for why that is the whole
// point rather than a detail.
function roll(entries, label) {
  const withIn  = entries.filter(e => e.in != null);
  const withNet = entries.filter(e => e.net != null);

  const sum = (arr, k) => arr.reduce((a, e) => a + e[k], 0);
  const dayWord = k => `${k} day${k === 1 ? '' : 's'}`;

  // THE THREE NUMBERS HAVE TO SUBTRACT. Averaging "in" over every logged day
  // while averaging "out" over the days that also have a burn puts three
  // figures side by side that visibly do not add up — and a screen whose own
  // arithmetic is wrong is worse than one that says it does not know.
  //
  // So when any day has both halves, all three come from those days. When none
  // does, "in" alone is still worth reporting and stands on its own.
  const base = withNet.length ? withNet : withIn;
  const inTotal  = sum(base, 'in');
  const outTotal = withNet.length ? sum(withNet, 'out') : null;
  const netTotal = withNet.length ? sum(withNet, 'net') : null;

  return {
    label,
    from: entries.length ? entries[0].date : null,
    to: entries.length ? entries[entries.length - 1].date : null,
    span_days: entries.length,
    days_logged: entries.filter(e => e.logged).length,
    // The denominator, named. An average over "the last 30 days" and an average
    // over "the 9 days you logged" are different claims and only one is true.
    days_counted: base.length,
    days_logged_food: withIn.length,
    days_with_both: withNet.length,
    in_total: base.length ? Math.round(inTotal) : null,
    in_avg: base.length ? Math.round(inTotal / base.length) : null,
    out_total: outTotal == null ? null : Math.round(outTotal),
    out_avg: outTotal == null ? null : Math.round(outTotal / withNet.length),
    net_total: netTotal == null ? null : Math.round(netTotal),
    net_avg: netTotal == null ? null : Math.round(netTotal / withNet.length),
    sessions: sum(entries, 'sessions'),
    estimated: withIn.some(e => e.estimated),
    say: !base.length
      ? `Nothing logged in ${label}.`
      : withNet.length
        ? `${label}: roughly ${Math.round(inTotal / base.length)} in and ${Math.round(outTotal / withNet.length)} out on an average logged day, ` +
          `about ${Math.abs(Math.round(netTotal / withNet.length))} ${netTotal < 0 ? 'under' : 'over'}. Counted across ${dayWord(base.length)}, not the whole ${label.replace(/^the /, '')}.`
        : `${label}: roughly ${Math.round(inTotal / base.length)} a day across ${dayWord(base.length)}. Calories out is not worked out yet.`,
  };
}

/**
 * Week, month and year over the same days. A window is only reported when the
 * loaded range actually covers it — a "this year" figure computed from seven
 * days of data is a fabrication wearing a long label.
 */
/**
 * The loaded window as ONE running total, whatever length it happens to be.
 *
 * The founder, looking at the dashboard after tapping 7d: "look at the seven
 * day — should be yesterday, today to this point. The same with the month.
 * It's not running total." He is right, and the gap was real: every window
 * figure on the page was an AVERAGE per logged day, and the range buttons
 * changed nothing above the fold at all. An average answers "what is a normal
 * day"; a running total answers "where am I, right now, in this stretch" —
 * and that second question is the one somebody has at four in the afternoon
 * on day five of a week they are trying to hold.
 *
 * Same arithmetic as every other window here, which is the point of reusing
 * `roll` rather than summing in the page: logged days only, all three figures
 * off the same days so they visibly subtract, and the denominator said out
 * loud. Today counts as it stands — partial, because it IS partial.
 */
export function rangeRollup(entries = [], label = 'this window') {
  if (!entries.length) return null;
  return roll(entries, label);
}

export function calendarRollups(entries = []) {
  const out = {};
  // The window has to be FULLY covered, not nearly. Reporting "the last 30
  // days" off 28 of them, or "the last year" off 300, is the same fabrication
  // the label is supposed to prevent — just small enough to feel harmless.
  if (entries.length >= 7)   out.week  = roll(entries.slice(-7),   'the last 7 days');
  if (entries.length >= 30)  out.month = roll(entries.slice(-30),  'the last 30 days');
  if (entries.length >= 365) out.year  = roll(entries.slice(-365), 'the last year');
  return out;
}

/**
 * What is stopping the right-hand column from existing. Named once, at the top,
 * rather than repeated on thirty empty squares.
 */
export function calendarMissing(profile = {}, entries = []) {
  if (entries.some(e => e.out != null)) {
    // The figure exists. Say if nothing is measuring movement, because a burn
    // counting only the resting figure reads as a bigger deficit than the day
    // really had.
    return entries.some(e => e.active_source === 'none')
      ? { blocking: [], note: 'Nothing is counting your movement, so calories out is your resting burn alone — the real figure is higher and the gap smaller than it looks. Set an activity level or connect your phone.' }
      : { blocking: [], note: null };
  }
  const rest = restingBurn(profile, null);
  return {
    blocking: rest.missing,
    note: `Calories out needs ${rest.missing.join(' and ')} before any of these squares can show it.`,
  };
}
