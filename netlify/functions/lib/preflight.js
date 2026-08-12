// lib/preflight.js
// The five minutes before the first set, answered from the record.
//
// The founder: "should I ask you before work how you feel, what you wanna
// accomplish — it should look at your [intake] for the day and see where
// you're at."
//
// Three separate things, and only one of them existed.
//
//   1. HOW THEY FEEL. `readiness()` reads resting heart rate and sleep against
//      their own fortnight, which is the objective half and genuinely useful.
//      It is also blind to the half that matters most on the day: a watch
//      cannot tell a bad night from a bad week at work, and it has never once
//      known that somebody's back is tight. Nobody has ever asked them.
//   2. WHAT THEY WANT OUT OF IT. A session prescribed by "what is most
//      overdue" is right on average and wrong on the day somebody came in to
//      do one thing. Asking costs a clause and changes the whole hour.
//   3. WHERE THEY ARE FOR THE DAY. Six hundred calories by six in the evening
//      is a fact about the session that is about to happen, and until now the
//      training half of this product and the eating half never spoke to each
//      other at the one moment they obviously should.
//
// THE RULES THAT KEEP IT FROM BECOMING A FORM:
//
// - IT NEVER BLOCKS THE SESSION. Same lesson the warm-up taught: a question
//   standing between somebody and the bar is one they resent, and then a
//   session they stop starting. The questions ride ON the handover, in one
//   line, answered in the same turn or not at all.
// - ONE LINE, BOTH QUESTIONS. Two turns of interview before a workout is an
//   interrogation. The person answering knows what they mean.
// - FUEL ADVICE ONLY EVER POINTS AT EATING MORE. Telling somebody about to
//   train that they should eat less is the dangerous direction, and this is
//   not the moment for a deficit conversation under any framing.
// - MEDICATION AND SUPPLEMENTS ARE STATED, NEVER ADVISED ON. That they took
//   something is a fact about the day. Whether they should have, whether it
//   interacts, whether to take more — a doctor's question, every time.
// - THE BODY STILL ONLY EVER SOFTENS. Nothing here turns a good reading, a
//   good mood or a full stomach into "add weight". Same rule as readiness,
//   for the same reason: that is how a tool argues somebody into an injury.

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param day        dayFacts() for today
 * @param balance    energyBalance() for today, or null
 * @param ready      readiness() output, or null
 * @param calorieTarget  the daily calorie goal, or null
 * @param sessionName    what is being proposed, for the question's wording
 */
export function preflight({ day = null, balance = null, ready = null,
                            calorieTarget = null, sessionName = null } = {}) {
  const eaten = num(day?.food?.calories);
  const meals = num(day?.food?.meals);

  // ── Fuel ──────────────────────────────────────────────────────────────────
  // A fact and, at most, a suggestion to eat something. Never a number to stay
  // under, never a comparison framed as being over.
  let fuel = null;
  if (meals === 0) {
    fuel = {
      state: 'empty',
      eaten: 0,
      say: 'Nothing logged today yet — if you have genuinely not eaten, something small before you start will make the whole session better.',
    };
  } else if (calorieTarget && eaten > 0 && eaten < calorieTarget * 0.25) {
    fuel = {
      state: 'light',
      eaten,
      say: `About ${eaten.toLocaleString()} in so far — a light tank for this. Worth something before you start.`,
    };
  } else if (eaten > 0) {
    // Deliberately flat. "You are at 2,100 of 2,500" invites doing maths about
    // what is left, before a workout, which is the one place that thought is
    // least useful and most likely to end in eating too little.
    fuel = {
      state: 'fed',
      eaten,
      say: `About ${eaten.toLocaleString()} in so far today.`,
    };
  }

  // ── What they have taken ──────────────────────────────────────────────────
  // Recorded, listed, and not interpreted. It is here because the founder
  // asked what he has had today to be part of the picture, and it is
  // deliberately inert.
  const takenRows = (day?.log || []).filter(e => e.type === 'supplement');
  const taken = takenRows.length
    ? { count: takenRows.length, items: takenRows.map(e => e.summary),
        say: `Logged today: ${takenRows.map(e => e.summary).join('; ')}.` }
    : null;

  // ── The two questions ─────────────────────────────────────────────────────
  // One line. The first is the half no sensor can reach; the second is the one
  // that makes the hour theirs rather than the algorithm's.
  const ask =
    'How are you feeling, and is there anything you want out of today in particular? ' +
    'One line is plenty — and if you would rather just start, say so and we start.';

  const bits = [];
  // The body's veto comes FIRST when it is not "ready", before anything about
  // food and before the plan. Same order as everywhere else.
  if (ready?.known && ready.state !== 'ready') bits.push(ready.say);
  if (fuel && fuel.state !== 'fed') bits.push(fuel.say);
  if (taken) bits.push(taken.say);

  return {
    ask,
    readiness_first: !!(ready?.known && ready.state !== 'ready'),
    fuel,
    taken,
    say: bits.length ? bits.join(' ') : null,
    note:
      'Ask BOTH questions in ONE short line, in the same message as the session — never as a separate turn, ' +
      'never as a form, and NEVER wait for an answer before handing over the plan. If they answer, pass their ' +
      'own words to start_session as intent and log_set as the note; if they ignore it, carry on and do not ask ' +
      'again. ' +
      (ready?.known && ready.state !== 'ready'
        ? 'Say the recovery line FIRST — the body gets a veto and it belongs before the plan. It only ever means train lighter, never train harder. '
        : '') +
      (fuel?.state === 'empty' || fuel?.state === 'light'
        ? 'Mention food ONCE and only as "eat something" — never a figure to stay under, never anything that reads as a deficit conversation before a workout. '
        : '') +
      (taken
        ? 'What they have taken is recorded and NOT to be commented on: no advice, no interaction warnings, no suggestion to take more or less. If they ask, that is a doctor\'s question. '
        : '') +
      'Nothing here ever becomes a reason to add weight — a good reading, a good mood and a full stomach all mean train as planned and nothing more.',
    ...(sessionName ? { proposed: sessionName } : {}),
  };
}
