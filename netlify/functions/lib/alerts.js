// lib/alerts.js
// Which notifications are due, and the exact words they carry.
//
// THE ONE THING AN MCP SERVER CANNOT DO IS SPEAK FIRST. The protocol is
// strictly request/response, so no amount of cleverness makes ChatGPT open a
// conversation. What CAN speak first is the phone, and the only thing standing
// between a rule somebody said out loud and a line on their lock screen is a
// scheduled function that already runs every hour.
//
// So the division is: the assistant WRITES the rule, this file DECIDES whether
// it is due and what it says, and the cron SENDS it. Nothing here composes an
// opinion and nothing here does arithmetic a screen has not already done — the
// same doctrine as every other mouth in this product.
//
// ── The rules that keep this from becoming the thing people mute ────────────
//
// 1. A CARE FLAG SILENCES THE COACHING KINDS COMPLETELY. Telling somebody who
//    has eaten under 1,200 for three days that they are "at 80% of target" is
//    encouragement pointed directly at the harm the flags exist to prevent.
//    Their own custom reminders survive, because those are theirs.
// 2. NOTHING EVER TELLS SOMEBODY TO EAT LESS. The intake line states where the
//    day stands and stops. "You have 500 left" invites doing sums about what is
//    allowed, and a notification is the worst possible place for that thought.
//    The one exception is a window the person set THEMSELVES — honouring a
//    timetable they chose is not the app deciding they have had enough.
// 3. ONE AT A TIME, ONCE A DAY, AND NEVER IN THE NIGHT. Two notifications in an
//    hour is a lecture and the second is never read.
// 4. NOTHING LOGGED MEANS NOTHING TO SAY, for anything that reads the day.

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const round = v => (v == null ? null : Math.round(v));

// Quiet hours. A rule with its own hour is explicit consent for that hour and
// is honoured exactly; everything derived from the day's numbers is held
// inside waking hours, because nobody asked to be woken up about calories.
export const QUIET_BEFORE = 8;
export const QUIET_AFTER  = 22;

export const ALERT_KINDS = {
  intake_pace: {
    label: 'Where the day stands',
    needs_hour: false,
    default_threshold: 0.8,
    describe: t => `when you reach ${Math.round((t ?? 0.8) * 100)}% of your calorie target`,
    // Deliberately a statement. See rule 2.
    why: 'States where the day stands and nothing else — never what is left, never a suggestion to stop.',
  },
  kitchen_closed: {
    label: 'Kitchen closes',
    needs_hour: true,
    describe: (_t, h) => `at ${String(h).padStart(2, '0')}:00, the time you said you stop eating`,
    why: 'A timetable they set themselves. This is the one kind that may mention stopping, because they chose the hour.',
  },
  move: {
    label: 'Training',
    needs_hour: true,
    describe: (_t, h) => `at ${String(h).padStart(2, '0')}:00 on days you have not trained and the week is behind`,
    why: 'Only when the week is genuinely behind. A met target or a care flag silences it — guilt is how training logs die.',
  },
  weigh_in: {
    label: 'Weigh-in',
    needs_hour: true,
    describe: (_t, h) => `at ${String(h).padStart(2, '0')}:00 when there has been no weigh-in for a week`,
    why: 'The weekly trend is what corrects every target. Never congratulates and never comments on the number.',
  },
  goal_pace: {
    label: 'A goal you set',
    needs_hour: false,
    default_threshold: 0.8,
    describe: (t, _h, _x, metric) => `when you reach ${Math.round((t ?? 0.8) * 100)}% of your ${metric || 'goal'}`,
    // The founder asked for "80% calorie burn of the day". Doing it as a bespoke
    // burn alert would have covered one metric; doing it against the GOALS
    // somebody actually set covers steps, active calories, distance and active
    // minutes with the same rule — and it can only ever fire for a target they
    // chose, which is what keeps it from being the app inventing a standard.
    why: 'A target they set, reported as a fact. Never a target this product picked, and never an instruction.',
  },
  goal_check: {
    label: 'Where a goal stands',
    needs_hour: true,
    describe: (_t, h, _x, metric) => `at ${String(h).padStart(2, '0')}:00, a read of your ${metric || 'goal'}`,
    // The founder: "by 4 o'clock every day there should be a notification
    // stating you're at 80% — or what percent of your steps you are."
    //
    // THAT IS A DIFFERENT RULE FROM goal_pace, and the difference is the whole
    // point. goal_pace waits for a threshold and fires when it is crossed, so
    // on a slow day it never fires at all — which is exactly the day somebody
    // wanted telling. This one fires AT AN HOUR THEY CHOSE and reports the
    // number whatever it is, so there is still time in the day to act on it.
    why: 'A scheduled read of a target they set, at an hour they picked. States the figure and stops — never what is left to do, and never an instruction.',
  },
  custom: {
    label: 'Your own words',
    needs_hour: true,
    describe: (_t, h, text) => `at ${String(h).padStart(2, '0')}:00 — "${text}"`,
    why: 'Sent verbatim. Never rewritten, never coached on top of.',
  },
};

/**
 * Which of somebody's rules are due right now.
 *
 * Pure: every input is already computed elsewhere, so a notification and the
 * dashboard can never quote two different numbers for the same day.
 *
 * @param rules        wrought_alerts rows
 * @param day          dayFacts for their local today
 * @param balance      energyBalance for the same day
 * @param calorieTarget the daily calorie goal, or null
 * @param week         weekSoFar
 * @param lastWeighDays days since the last weigh-in, or null
 * @param flags        careFlags
 * @param hour         their local hour, 0-23
 * @param weekday      their local day of week, 0 = Sunday
 * @param date         their local date, for the once-a-day guard
 */
export function dueAlerts({ rules = [], day = null, balance = null, calorieTarget = null,
                            week = null, lastWeighDays = null, flags = [], hour = 12,
                            weekday = 0, date = null, scored = [] } = {}) {
  const out = [];
  // A CARE FLAG OUTRANKS EVERYTHING, including the cheerful ones. Coaching
  // stops; their own reminders are not coaching and are left alone.
  const flagged = Array.isArray(flags) && flags.length > 0;

  for (const r of rules) {
    if (!r?.active) continue;
    if (r.last_sent_on && date && r.last_sent_on === date) continue;   // once a day
    if (Array.isArray(r.days) && r.days.length && !r.days.includes(weekday)) continue;

    const kind = ALERT_KINDS[r.kind];
    if (!kind) continue;

    // A stated hour is explicit consent for that hour. Anything without one is
    // held inside waking hours.
    if (kind.needs_hour) {
      if (!Number.isInteger(r.at_hour) || r.at_hour !== hour) continue;
    } else if (hour < QUIET_BEFORE || hour >= QUIET_AFTER) {
      continue;
    }

    const built = build(r, {
      day, balance, calorieTarget, week, lastWeighDays, flagged, hour, scored,
    });
    if (built) out.push({ id: r.id, kind: r.kind, ...built });
  }

  // ONE AT A TIME. Two notifications in the same hour is a lecture, and the
  // second one is never read. The order is the order of harm: something the
  // person explicitly asked for beats anything the server worked out.
  const rank = { custom: 0, kitchen_closed: 1, goal_check: 2, goal_pace: 3, weigh_in: 4, intake_pace: 5, move: 6 };
  out.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
  return out.slice(0, 1);
}

function build(r, { day, balance, calorieTarget, week, lastWeighDays, flagged, hour, scored = [] }) {
  switch (r.kind) {
    case 'custom': {
      const text = String(r.text || '').trim();
      // Verbatim or not at all. A reminder rewritten into house style is one
      // that no longer sounds like the person who set it.
      return text ? { title: 'Wrought', body: text, why: 'their own words' } : null;
    }

    case 'kitchen_closed': {
      if (flagged) return null;
      const eaten = round(num(day?.food?.calories));
      // The hour they chose, honoured. It says the window is closing and what
      // the day held — never what is "left", and never an instruction.
      return {
        title: 'Kitchen closes',
        body: eaten
          ? `That is the window you set. ${eaten.toLocaleString()} kcal logged today.`
          : 'That is the window you set for today.',
        why: 'a timetable they chose',
      };
    }

    case 'intake_pace': {
      if (flagged) return null;
      const target = num(calorieTarget);
      const eaten  = num(day?.food?.calories);
      // Nothing logged is nothing to report — a notification saying "you are at
      // 0%" is a nag about not having opened the app.
      if (!target || !eaten) return null;
      const at = eaten / target;
      const want = num(r.threshold) ?? ALERT_KINDS.intake_pace.default_threshold;
      if (at < want) return null;
      // STATED, NOT INSTRUCTED. No "you have N left", no "stop", no "careful" —
      // a lock screen is the worst place to start doing sums about what is
      // allowed, and this product does not tell people to eat less.
      return {
        title: 'Where the day stands',
        body: `${Math.round(eaten).toLocaleString()} of ${Math.round(target).toLocaleString()} kcal so far — about ${Math.round(at * 100)}%.`,
        why: 'they asked to be told at this point',
      };
    }

    case 'goal_pace': {
      if (flagged) return null;
      // Against a goal THEY set. A rule naming a metric they have no goal for
      // has nothing to measure and stays quiet rather than inventing a target.
      const g = (scored || []).find(x => x.scored && x.metric === r.metric);
      if (!g || !g.target) return null;
      const want = num(r.threshold) ?? ALERT_KINDS.goal_pace.default_threshold;
      if (g.percent / 100 < want) return null;
      // AN at_most GOAL IS NEVER CHASED. A calorie ceiling filling up is the
      // intake_pace case, which is already worded not to tell anybody to stop —
      // firing a second, cheerier "80% there!" at a limit would read as
      // encouragement to spend the rest of it.
      if (g.direction === 'at_most') return null;
      return {
        title: g.hit ? 'Goal met' : 'Nearly there',
        body: `${Math.round(g.actual).toLocaleString()}${g.unit} of ${Math.round(g.target).toLocaleString()}${g.unit} — ${g.percent}% of ${g.goal}.`,
        why: 'a target they set for themselves',
      };
    }

    case 'goal_check': {
      if (flagged) return null;
      const g = (scored || []).find(x => x.scored && x.metric === r.metric);
      if (!g || !g.target) return null;
      // A ceiling is not something to be walked toward on a schedule. Same
      // reason goal_pace refuses one: intake_pace already covers it, worded not
      // to tell anybody to stop.
      if (g.direction === 'at_most') return null;

      // NOTHING SENT TODAY IS NOT ZERO PROGRESS. Steps arrive from a phone, and
      // a phone that has not synced yet reads as 0 — so a scheduled 4pm report
      // would say "0% of your steps" to somebody who had walked all morning.
      // That is a false claim about their day arriving on a lock screen, which
      // is worse than saying nothing. Silence until something has actually been
      // measured; the dashboard already names the same gap as awaiting_device.
      if (!(Number(g.actual) > 0)) return null;

      return {
        title: g.hit ? 'Goal met' : 'Where you are',
        body: `${Math.round(g.actual).toLocaleString()}${g.unit} of ${Math.round(g.target).toLocaleString()}${g.unit} — ${g.percent}% of ${g.goal}.`,
        why: 'a scheduled read of a target they set',
      };
    }

    case 'move': {
      if (flagged) return null;
      // Trained today already, or the week is met: nothing worth saying. A
      // reminder to train on a day somebody trained is how a product proves it
      // is not paying attention.
      if (day?.training?.sessions > 0) return null;
      if (!week || week.done == null || week.target == null) return null;
      if (week.done >= week.target) return null;
      // AN IMPOSSIBLE WEEK IS NOT COUNTED DOWN TO ZERO. There is nothing
      // actionable left in it and repeating it is pure guilt.
      const left = num(week.days_left);
      const need = week.target - week.done;
      if (left != null && need > left) return null;
      return {
        title: 'Training',
        body: `${week.done} of ${week.target} this week` +
          (left != null ? `, ${left} day${left === 1 ? '' : 's'} left.` : '.'),
        why: 'the week is behind and there is still room in it',
      };
    }

    case 'weigh_in': {
      if (flagged) return null;
      const since = num(lastWeighDays);
      if (since == null || since < 7) return null;
      // NEVER a comment on the number, and never a congratulation — praising a
      // loss while staying silent on a gain is how a log starts being edited to
      // please the app.
      return {
        title: 'Weigh-in',
        body: `${Math.round(since)} days since the last one. The weekly trend is what corrects every target.`,
        why: 'the trend needs a point',
      };
    }

    default:
      return null;
  }
}

/**
 * What a rule reads like, for the assistant to say back and the dashboard to
 * print. One reader, so the two can never describe the same rule differently.
 */
export function describeAlert(r = {}) {
  const kind = ALERT_KINDS[r.kind];
  if (!kind) return null;
  return {
    id: r.id,
    kind: r.kind,
    label: kind.label,
    active: r.active !== false,
    at_hour: r.at_hour ?? null,
    threshold: r.threshold ?? null,
    text: r.text || null,
    metric: r.metric || null,
    say: `${kind.label} — ${kind.describe(r.threshold, r.at_hour, r.text, r.metric ? String(r.metric).replace('_', ' ') : null)}`,
  };
}

/**
 * What is worth having, and when — offered rather than switched on.
 *
 * Nothing here is enabled by default. A product that starts notifying somebody
 * because it decided it knew best is one they mute on day two, and a muted
 * product never comes back on.
 */
export function suggestAlerts({ hasCalorieTarget = false, trainDays = null, fasting = false,
                                movementGoals = [] } = {}) {
  const out = [];
  if (hasCalorieTarget) {
    out.push({ kind: 'intake_pace', threshold: 0.8,
      say: 'A line when you hit 80% of your calories for the day — where you stand, not what is left.' });
  }
  out.push({ kind: 'kitchen_closed', at_hour: 21,
    say: 'A kitchen-closes line at an hour you pick. You choose the time; it just holds you to it.' });
  if (trainDays) {
    out.push({ kind: 'move', at_hour: 17,
      say: `A training line at 5pm on days you have not trained and the week is behind ${trainDays}.` });
  }
  // Only for goals that actually exist. Offering "80% of your step goal" to
  // somebody with no step goal is offering a rule that can never fire.
  for (const m of (movementGoals || []).slice(0, 2)) {
    const name = String(m).replace('_', ' ');
    out.push({ kind: 'goal_pace', metric: m, threshold: 0.8,
      say: `A line at 80% of your ${name} goal — close enough that finishing it is still a choice you can make.` });
    // The scheduled twin. It matters most on the day the threshold one never
    // fires: at 4pm on 3,000 steps there is still an evening to do something
    // about it, and a rule that only speaks at 80% says nothing at all.
    out.push({ kind: 'goal_check', metric: m, at_hour: 16,
      say: `A read of your ${name} at 4pm whatever the number is — the slow day is the one worth hearing about, and a rule that only fires at 80% is silent on exactly that day.` });
  }
  out.push({ kind: 'weigh_in', at_hour: 8,
    say: 'A weigh-in line at 8am when it has been a week. The trend is what corrects every target.' });
  if (fasting) {
    out.push({ kind: 'custom', at_hour: 20,
      say: 'Anything in your own words at an hour you pick — "fast starts now" at 8pm, say.' });
  }
  return {
    options: out,
    note: 'OFFER these, never switch them on. Ask which they want and set only those. Nothing is enabled by default: a product that starts notifying somebody because it decided it knew best is one they mute on day two, and a muted product never comes back on.',
  };
}
