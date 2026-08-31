// netlify/functions/lib/voice.js
// What a phone says out loud.
//
// Siri is a RELAY here, exactly as ChatGPT is. Every number in these sentences
// was computed somewhere else and is being read aloud; nothing in this file
// does arithmetic and nothing in the app does either. That is the same doctrine
// the connector runs on, extended to a third mouth.
//
// The one thing that IS different is length. A verdict can be a paragraph on a
// screen, because eyes skim and can go back. Speech cannot be skimmed and
// cannot be re-read — a spoken answer past about twenty words stops being
// information and becomes noise somebody talks over. So these lines are short
// on purpose, and the long version is always one tap away on the dashboard.

// A care flag's `guidance` is written FOR A MODEL — "stop coaching intake down"
// is an instruction, not something to say to a person. Spoken aloud it would be
// baffling at best. So each flag gets a human sentence here, and the mapping is
// deliberate rather than a fallback: a flag with no spoken form must not be
// silently dropped, because silence is exactly the failure these exist to stop.
const FLAG_SPOKEN = {
  // The spoken form gets the whole flag, not just the detail, so a flag that
  // knows its own ambiguity can say it. A single-entry day cannot be told from
  // a starved day by the record — the honest sentence carries both readings
  // and the action for each, because a wrong accusation gets a care flag
  // dismissed, and a dismissed flag is as dangerous as a missing one.
  very_low_intake: (d, f) => f?.partial
    ? `${d} Log those days fully and this clears — and if they really were that small, that is under what a body runs on, and worth a doctor.`
    : `${d} That is under what a body runs on, so there is no target from me today. That one is worth a doctor.`,
  rapid_loss: d =>
    `${d} That is faster than is usually safe, and fast loss costs muscle. Worth easing the deficit.`,
  no_rest: d =>
    `${d} Take a real rest day. That is where the adaptation actually happens.`,
};

export function spokenFlag(flag) {
  if (!flag || !flag.flag) return null;
  const shape = FLAG_SPOKEN[flag.flag];
  // An unmapped flag still gets said. Losing a care flag to a missing key is
  // the one bug in this file that could genuinely hurt somebody.
  return shape ? shape(flag.detail, flag) : flag.detail || null;
}

/**
 * The day, in one breath.
 *
 * Care flags come first and come ALONE — the doctrine is that they outrank
 * everything, and in speech "outrank" has to mean the sentence stops there.
 * Appending a training nudge after a warning about under-eating would undo the
 * warning in the same breath that gave it.
 */
export function spokenBrief({ day = null, balance = null, week = null, flags = [] } = {}) {
  if (flags.length) return spokenFlag(flags[0]);

  const parts = [];

  if (balance && balance.known) {
    const net = Number(balance.net) || 0;
    parts.push(
      `Roughly ${Math.round(balance.calories_in)} in, about ${Math.round(balance.calories_out)} out` +
      (net < -150 ? `, ${Math.abs(Math.round(net))} down on the day.`
       : net > 150 ? `, ${Math.round(net)} over.`
       : `, about level.`)
    );
  } else if (day?.food?.meals) {
    // No burn to subtract from, so the intake stands alone rather than being
    // dressed up as a balance it cannot support.
    parts.push(day.food.meals_uncounted === day.food.meals
      ? `${day.food.meals} thing${day.food.meals === 1 ? '' : 's'} logged, no calories on ${day.food.meals === 1 ? 'it' : 'them'} yet.`
      : `Roughly ${Math.round(day.food.calories)} in so far.`);
  }

  const steps = day?.device?.steps;
  if (steps) parts.push(`${Math.round(steps).toLocaleString('en-US')} steps.`);

  // The expectation, kept on the table. This is the only place the phone can
  // put it in front of somebody without them opening anything.
  if (week?.say && week.target) {
    parts.push(week.met
      ? `${week.done} of ${week.target} sessions — target met.`
      : `${week.done} of ${week.target} sessions this week, ${week.days_left} day${week.days_left === 1 ? '' : 's'} left.`);
  } else if (day?.training?.sessions) {
    parts.push(`${day.training.sessions} session${day.training.sessions === 1 ? '' : 's'} logged.`);
  }

  if (!parts.length) return 'Nothing logged today yet.';
  return parts.join(' ');
}

/**
 * What Siri says back after a dictated sentence.
 *
 * The unparsed case is the ordinary one, not the error case, and it is worded
 * that way. Nothing has a model attached at this end — the connected AI reads
 * the words later — so "saved, word for word" is the honest description of what
 * just happened, and promising the calories will follow is a fact about the
 * next conversation rather than an apology for this one.
 */
export function spokenLog({ written = [], parsed = false, text = '' } = {}) {
  if (!written.length) return 'Nothing went in — try that again.';

  const names = written.map(e => e.summary).filter(Boolean);
  const list = names.length > 2
    ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
    : names.join(' and ');

  if (parsed) return `Logged: ${list}.`;

  return `Saved, word for word: ${list}. No calories on it yet — WROUGHT will fill those in next time you talk to it.`;
}

/**
 * The nightly read, written without a model.
 *
 * This file is about what a phone says out loud, and a nightly brief is not
 * speech — but it is the same job: compose an honest line out of numbers that
 * were already computed, with nothing invented. Same rule, different mouth,
 * so it lives here rather than in a file of its own.
 *
 * It exists because the nightly channel could not fire at all without it.
 * brief-nightly asked writeVerdict for a paragraph, writeVerdict needs an
 * OPENAI_API_KEY, and with no key it returned null and the whole send was
 * skipped — so the one surface that can genuinely speak first was silently
 * dead for exactly the reason the founder did not want to pay for a key.
 *
 * The written verdict is still better when a key exists. This is what goes out
 * when one does not, and it is facts rather than opinion: no coaching, no
 * praise, no instruction. A number and its direction is worth a notification.
 * An invented sentence is not.
 */
const GOAL_LABELS = {
  calories: 'calories',
  protein_g: 'protein',
  steps: 'steps',
  workout_days: 'training',
  distance_km: 'distance',
  active_minutes: 'active minutes',
  sleep_minutes: 'sleep',
  weight_kg: 'weight',
};

const compactNumber = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return (Math.round(n * 10) / 10).toLocaleString('en-US');
};

// A goal only belongs in the close of TODAY when the matching fact was
// actually recorded today. Kept in one place because the long receipt and the
// lock-screen scorecard must never disagree about whether an apparent zero is
// a measurement or simply missing data.
const dailyScoredGoals = facts => {
  const food = facts.food || {};
  const device = facts.device || {};
  const hasTodayEvidence = g => {
    switch (g.metric) {
      // COUNTED meals, not merely logged ones. A day of macros-unknown entries
      // sums to 0 kcal/0g, which is unknown rather than a perfect zero.
      case 'calories':
      case 'protein_g': return (food.meals || 0) > (food.meals_uncounted || 0);
      case 'steps': return device.steps != null;
      case 'distance_km': return device.distance_km != null;
      case 'active_minutes': return device.active_minutes != null;
      case 'sleep_minutes': return device.sleep_minutes != null;
      case 'weight_kg': return facts.body?.weight_kg != null;
      default: return false;
    }
  };

  return (facts.goals || []).filter(g =>
    g.scored && g.metric !== 'workout_days' && g.cadence !== 'weekly' && hasTodayEvidence(g));
};

// The deterministic close of the day: what actually went on the record, then
// where those facts put the goals. This leads the evening brief whether or not
// an OpenAI key exists, so the lock screen can never be an AI's impression of
// the day while the dashboard is holding exact computed numbers.
export function eveningReceipt({ facts = {}, balance = null } = {}) {
  const actions = [];
  const food = facts.food || {};
  const training = facts.training || {};
  const activity = facts.activity || {};
  const device = facts.device || {};

  if (training.sessions) {
    actions.push(`${training.sessions} workout${training.sessions === 1 ? '' : 's'}` +
      (training.minutes ? ` (${Math.round(training.minutes)} min)` : ''));
  }
  if (activity.count) {
    actions.push(`${activity.count} work/activity entr${activity.count === 1 ? 'y' : 'ies'}` +
      (activity.minutes ? ` (${Math.round(activity.minutes)} min on task)` : ''));
  }
  if (device.steps != null) actions.push(`${Math.round(device.steps).toLocaleString('en-US')} steps`);
  if (food.meals) {
    actions.push(food.meals_uncounted === food.meals
      ? `${food.meals} food entr${food.meals === 1 ? 'y' : 'ies'} with macros still unknown`
      : `roughly ${Math.round(food.calories).toLocaleString('en-US')} kcal in and ${Math.round(food.protein_g).toLocaleString('en-US')}g protein`);
  }
  if (balance?.known && (facts.logged || actions.length)) {
    actions.push(`about ${Math.round(balance.calories_out).toLocaleString('en-US')} kcal burned`);
  }

  // workout_days is read from weekSoFar below. Weekly scores in scoreGoals use
  // a range summary, so they are not evidence of what THIS day contributed.
  const goals = dailyScoredGoals(facts);
  const goalLines = goals.map(g => {
    const actual = compactNumber(g.actual);
    const target = compactNumber(g.target);
    if (actual == null || target == null) return null;
    const unit = g.unit ? ` ${g.unit}` : '';
    return `${GOAL_LABELS[g.metric] || g.goal || g.metric}: ${actual}/${target}${unit}`;
  }).filter(Boolean);

  const lines = [];
  if (actions.length) lines.push(`Today: ${actions.join('; ')}.`);
  if (goalLines.length) lines.push(`Against your goals: ${goalLines.join('; ')}.`);
  if (facts.training_week?.say) {
    lines.push(`Training week: ${facts.training_week.say}`);
  }
  return lines.join(' ') || null;
}

/**
 * The same close, cut for a lock screen rather than a paragraph.
 *
 * Push notifications cannot carry the dashboard's type, colour or layout. The
 * useful design material they do have is hierarchy and rhythm: one unmistakable
 * title, then a compact scoreboard made only from already-computed facts. No
 * prose is truncated mid-thought and tapping it opens the full Daily Close.
 */
export function eveningNotification({ facts = {}, balance = null } = {}) {
  const food = facts.food || {};
  const training = facts.training || {};
  const activity = facts.activity || {};
  const device = facts.device || {};
  const goals = dailyScoredGoals(facts);
  const goal = metric => goals.find(g => g.metric === metric);
  const clauses = [];

  if (training.sessions) {
    clauses.push(`TRAIN ${training.sessions}\u00d7${training.minutes ? `${Math.round(training.minutes)}m` : ''}`);
  }
  if (activity.count) {
    clauses.push(`WORK ${activity.count}\u00d7${activity.minutes ? `${Math.round(activity.minutes)}m` : ''}`);
  }

  const steps = goal('steps');
  if (steps) {
    const actual = compactNumber(steps.actual);
    const targetNumber = Number(steps.target);
    const target = Number.isFinite(targetNumber) && targetNumber >= 10000 && targetNumber % 1000 === 0
      ? `${targetNumber / 1000}k`
      : compactNumber(steps.target);
    if (actual != null && target != null) clauses.push(`STEPS ${actual}/${target}`);
  } else if (device.steps != null) {
    clauses.push(`STEPS ${Math.round(device.steps).toLocaleString('en-US')}`);
  }

  const partial = (food.meals_uncounted || 0) > 0;
  const rough = food.estimated ? '~' : '';
  const more = partial ? '+' : '';
  const calories = goal('calories');
  if (calories) {
    clauses.push(`FUEL ${rough}${compactNumber(calories.actual)}${more}/${compactNumber(calories.target)} kcal`);
  } else if (food.meals && food.meals_uncounted === food.meals) {
    clauses.push('FUEL MACROS PENDING');
  } else if (food.meals && food.calories != null) {
    clauses.push(`FUEL ${rough}${compactNumber(food.calories)}${more} kcal`);
  }

  const protein = goal('protein_g');
  if (protein) {
    clauses.push(`PROTEIN ${rough}${compactNumber(protein.actual)}${more}/${compactNumber(protein.target)}g`);
  } else if (food.meals && food.meals_uncounted !== food.meals && food.protein_g != null) {
    clauses.push(`PROTEIN ${rough}${compactNumber(food.protein_g)}${more}g`);
  }

  if (balance?.known && (facts.logged || clauses.length)) {
    clauses.push(`BURN ~${Math.round(balance.calories_out).toLocaleString('en-US')}`);
  }
  if (facts.training_week?.target != null) {
    clauses.push(`WEEK ${facts.training_week.done || 0}/${facts.training_week.target}`);
  }

  if (!clauses.length) return null;
  const body = clauses.join(' \u00b7 ');
  if (body.length <= 160) return body;

  // Whole clauses only. A lock screen cutting "PROTEIN" in half looks broken
  // and can change meaning; the full card remains one tap away.
  const kept = [];
  for (const clause of clauses) {
    const next = [...kept, clause].join(' \u00b7 ');
    if (next.length <= 159) kept.push(clause);
  }
  return kept.join(' \u00b7 ');
}

export function plainBrief({ facts = {}, flags = [], balance = null } = {}) {
  // Care flags outrank everything, and in a notification that has to mean the
  // message IS the flag — there is no room to bury it under a total.
  if (flags.length) return spokenFlag(flags[0]);

  const receipt = eveningReceipt({ facts, balance });

  // Nothing logged is not worth waking somebody up for. A nightly nag is how a
  // product gets muted for good, and muted is permanent.
  if (!receipt) return null;

  return `${receipt} Estimates are labelled — ask WROUGHT for the full read.`;
}

/**
 * Entries that were dictated and never read by anything.
 *
 * A sentence spoken to Siri arrives with no model behind it, so it lands
 * verbatim with an empty detail. That is deliberate — it keeps the founder's
 * objection answered ("I'm not sure why it needs an API key when you're using
 * your own GPT already") — but a verbatim entry counts for nothing in every
 * total until somebody reads it. The connected model is the somebody. This
 * picks out the ones still waiting so the next brief can hand them over.
 *
 * A 'note' is included because that is what an unparsed sentence becomes; a
 * note somebody deliberately wrote has no place here, which is why the source
 * has to be 'voice' and not merely unstructured.
 */
export function pendingVoice(rows = []) {
  return rows
    .filter(r => r.source === 'voice')
    .filter(r => {
      const d = r.detail || {};
      // Structured already: something put macros or minutes on it.
      if (d.calories != null || d.minutes != null || d.value_kg != null) return false;
      // A note that is still just its own words is still waiting.
      return r.event_type === 'note' || Object.keys(d).length === 0 || d.note != null;
    })
    .map(r => ({ id: r.id, said: r.raw_input || r.summary, date: r.local_date, at: r.occurred_at }));
}
