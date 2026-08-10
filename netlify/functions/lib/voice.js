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
  very_low_intake: d =>
    `${d} That is under what a body runs on, so there is no target from me today. That one is worth a doctor.`,
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
  return shape ? shape(flag.detail) : flag.detail || null;
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
