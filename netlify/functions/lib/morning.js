// netlify/functions/lib/morning.js
// The brief that arrives BEFORE the day.
//
// The founder: "every day at 7:30 morning brief, that is the start, as a pop-up
// as well. That flags either."
//
// WHY THIS IS NOT plainBrief MOVED TO BREAKFAST. The nightly read is a verdict:
// it looks at a finished day and says what it came to. Delivered in the morning
// that becomes a worse message, because nothing in it can be acted on — the day
// it describes is over, and the only available response is to feel a way about
// it. This is a BRIEFING. Every line has to be something the next sixteen hours
// can still change, or it does not belong here.
//
// THE RULES IT INHERITS, none of which bend for being a new surface:
//
//   - A care flag is the ENTIRE message. On a lock screen "outranks everything"
//     has to mean the sentence stops there; there is no room to bury it under a
//     total, and a cheerful line above it is encouragement pointed at the exact
//     harm the flags exist to prevent.
//   - It never tells anybody to eat less. Not "you have X left", not a deficit,
//     not a ceiling. A phone at 7:30am is the worst possible place to start
//     doing arithmetic about what is allowed.
//   - Nothing is invented. Every figure comes from the same computed facts the
//     dashboard and the connector read, so three surfaces cannot disagree.
//   - One thing, never a list. A notification with three items in it is a
//     lecture and the second is never read.
//   - Silence is a real answer. A brief with nothing to say sends nothing.

import { spokenFlag } from './voice.js';

// What the morning can usefully raise, hardest first. The order is the order of
// consequence, not of cheerfulness: something that makes every other number
// meaningless outranks a number.
const MAX_LINES = 3;

/**
 * The morning message, or null to send nothing.
 *
 * @param facts        rangeFacts/dayFacts-shaped facts for TODAY
 * @param flags        careFlags output
 * @param balance      energyBalance for today, or null
 * @param week         weekSoFar output
 * @param goalsToSet   what has no target yet, from goalsToSet()
 * @param yesterday    yesterday's dayFacts, for the one backward-looking line
 * @param readiness    readiness() output, or null
 * @param planned      { name, est_minutes } — the workout most due today, or null
 */
export function morningBrief({
  facts = {}, flags = [], balance = null, week = null,
  goalsToSet = null, yesterday = null, readiness = null, planned = null,
} = {}) {
  // THE FLAG IS THE WHOLE MESSAGE. Same rule as the spoken answer and the
  // nightly read, and it is the one line in this file that must never grow a
  // clause after it.
  if (flags.length) return { text: spokenFlag(flags[0]), kind: 'care_flag', only: true };

  const lines = [];

  // 1. THE BODY'S VETO COMES FIRST, because it changes what the rest of the day
  //    should look like. It only ever softens — a good reading means train as
  //    planned and NOTHING more, so "ready" is not worth a notification and is
  //    deliberately not reported here.
  if (readiness && readiness.state && readiness.state !== 'ready' && readiness.say) {
    lines.push(readiness.say);
  }

  // 2. WHAT IS PLANNED, said before where the week stands — "what workouts do
  //    you have planned, if any, today?" is the founder's own definition of
  //    preemptive, and a named session is a plan where a count is a debt. It is
  //    the longest-rested saved workout, the same answer end_session gives,
  //    because two functions answering "what's next" differently is how the
  //    morning and the evening contradict each other. Silent when the week is
  //    already met — a met target silences the push, and being offered another
  //    session past it is nagging wearing a plan's clothes. Silent too when
  //    readiness flagged: the veto above already said train lighter, and
  //    naming a session right after reads as overriding it.
  if (planned?.name && !week?.met && !(readiness && readiness.state && readiness.state !== 'ready')) {
    lines.push(`Today's plan: ${planned.name}${planned.est_minutes ? `, about ${planned.est_minutes} min` : ''}.`);
  }

  // 3. WHERE THE WEEK STANDS, which is the number the whole plan rests on and
  //    the one thing a morning can still act on. Never a countdown to zero on
  //    an impossible week and never a scolding: sessions do not roll over, and
  //    guilt is how training logs die.
  if (week?.say && week.target && !week.met && !week.impossible) {
    lines.push(week.say);
  }

  // 3. A TARGET THAT DOES NOT EXIST outranks any figure, because without one
  //    every percentage, ring and pace alert in the product has nothing to be a
  //    fraction OF. This is the single most useful thing a morning can raise
  //    with somebody who has been using it for a fortnight and never set one.
  //    It states the gap and NEVER a number — goalsToSet computes the options,
  //    set_goal commits one, and a figure arriving unasked on a lock screen
  //    reads as a decision already taken.
  if (goalsToSet?.missing?.length) {
    // `missing` already reads as a noun phrase — "a daily calorie target" — so
    // it is dropped straight into the sentence rather than having the word
    // "target" appended to it a second time.
    const what = goalsToSet.missing.slice(0, 2).join(' and ');
    lines.push(`Nothing set for ${what} yet — ask WROUGHT and it works one out from your own numbers.`);
  }

  // 4. YESTERDAY, in one clause and only if it is genuinely informative. This
  //    is the one backward-looking line allowed, and it earns its place by
  //    being the thing that sets up today rather than a verdict on a day that
  //    is finished. A day nobody logged says nothing at all — an empty
  //    yesterday is not a fact about their eating, it is a fact about whether
  //    they told anybody, and reporting it as the former is a lie.
  if (!lines.length && yesterday?.food?.meals) {
    const f = yesterday.food;
    lines.push(f.meals_uncounted === f.meals
      ? `Yesterday went in with no macros on it yet.`
      : `Yesterday: roughly ${Math.round(f.calories)} in.`);
  }

  // 5. WHAT IS ALREADY KNOWN ABOUT TODAY, which at 7:30 is usually the resting
  //    burn and nothing else. Stated as the burn, LABELLED as a whole-day
  //    estimate, and never as a deficit — the dashboard hero's rule, needed
  //    again. At breakfast against no food a subtraction reads as an enormous
  //    deficit, which is an artifact of the day being two hours old and runs in
  //    the direction that tells somebody to eat less than they need.
  if (!lines.length && balance?.known && balance.calories_out) {
    lines.push(`About ${Math.round(balance.calories_out)} to burn today on current numbers.`);
  }

  if (!lines.length) return null;

  return {
    text: lines.slice(0, MAX_LINES).join(' '),
    kind: 'morning',
    only: false,
  };
}

/**
 * Where tapping the morning notification lands, and what it says when it gets
 * there.
 *
 * THE ONE LEGAL BRIDGE ACROSS MCP'S HARD LIMIT. The server can never make an
 * assistant speak first — request/response, permanently. But a push is allowed
 * to speak first, and a human tap on it is allowed to open anything. So the
 * notification carries a pre-written opener into the assistant, the tap
 * delivers it, and the assistant's first act of the day is calling the brief.
 * The person is in the loop by construction: nothing reaches the AI until they
 * choose to tap.
 *
 * THE OPENER IS ADDRESSED TO THE CONNECTOR BY NAME. "Gym bro" and "morning"
 * are both phrasebook triggers, so a model that reads nothing else still maps
 * the message onto `brief`; naming Wrought outright is the belt on top. It asks
 * for the day's PLAN as well as the read, because "what workouts do you have
 * planned, if any, today" is the founder's definition of preemptive.
 *
 * HONEST LIMIT, stated here because nothing can fix it server-side: the opener
 * lands in a NEW conversation, and whether the Wrought connector is switched on
 * there is a per-chat setting inside the assistant — the third of the "three
 * things called connected", the one with no server-side fix. When it is off,
 * the assistant gets the words and has no tools; the opener names Wrought so
 * the failure at least reads as "turn the connector on" rather than nonsense.
 */
const OPENERS = {
  morning:
    'Gym bro — morning. Using the Wrought connector, read me my morning brief and ' +
    "today's plan: where I stand, what workout is planned if any, and what the day needs.",
  // The midday opener ASKS, because the founder's midday is an assessment the
  // AI takes, not a report it reads out: it exists to collect the half-day —
  // what has been eaten, how the day feels — and the assistant's first act is
  // logging what comes back. Pushing toward the goals comes from the tools it
  // then calls, with real numbers, never from words pre-written here.
  midday:
    'Gym bro — midday check-in. Using the Wrought connector: I\'ll tell you what ' +
    "I've eaten so far and how the day is going — log it, then tell me where I " +
    'stand against my targets and what the afternoon needs.',
};

export function morningLink(opens, which = 'morning') {
  const q = encodeURIComponent(OPENERS[which] || OPENERS.morning);
  if (opens === 'chatgpt') return `https://chatgpt.com/?q=${q}`;
  if (opens === 'claude') return `https://claude.ai/new?q=${q}`;
  // The dashboard is the one destination every account verifiably has.
  return '/app.html';
}

/**
 * The midday line — where the day stands while an afternoon can still act on
 * it. Same silences as the morning: a care flag is the whole message (the
 * caller handles that before composing), nothing ever says "eat less" or
 * quotes what is "left", and a day with nothing to say sends nothing.
 */
export function middayBrief({ facts = {}, flags = [], scored = [] } = {}) {
  if (flags.length) return { text: spokenFlag(flags[0]), kind: 'care_flag', only: true };

  const lines = [];
  const food = facts.food || {};

  // What has landed so far — the fact that makes everything else checkable.
  // A quiet half-day is named as unlogged, never as uneaten: the difference
  // between those two is the whole product.
  if (food.meals) {
    lines.push(`Roughly ${Math.round(food.calories)} in so far.`);
  } else {
    lines.push('Nothing logged yet today — tell your AI what you\'ve had and it goes on the record.');
  }

  // Goals with numbers, scored by the same function the rings draw from. An
  // at_most goal is never cheered toward its ceiling — that is intake_pace's
  // deliberately flat wording, and a "nearly there!" on a calorie limit reads
  // as encouragement to spend the rest of it.
  const chase = scored.filter(g => g.scored && g.target != null && g.direction !== 'at_most' && !g.hit);
  if (chase.length) {
    const g = chase[0];
    lines.push(`${g.goal}: ${Math.round(g.percent || 0)}% with the afternoon to go.`);
  }

  return { text: lines.slice(0, 2).join(' '), kind: 'midday', only: false };
}

/**
 * Is it this account's morning-brief moment, in their own timezone?
 *
 * Separated from the message so the decision is testable without composing
 * anything, and so the cron's half-hour granularity lives in exactly one place.
 */
/**
 * Should a care-flag-only message be held back because the identical sentence
 * already reached the lock screen today?
 *
 * The founder's screenshot was six copies of the same flag across three
 * evenings — "always the same bullshit three times a day". The flag doctrine
 * does not bend: it outranks everything, it is the entire message, and it goes
 * out every day it stands. What this adds is only that the SAME SENTENCE is
 * delivered once per day rather than at every check-in.
 *
 * Pure, and deliberately narrow — this is the one place in the product where
 * suppressing a delivery is the dangerous direction, so both conditions must
 * hold before anything is held back:
 *   - same local day (never across days: a standing flag is said again tomorrow)
 *   - EXACT same text (a new flag, or a count that moved, always goes out)
 */
export function flagRepeat({ text, sentOn = null, sentText = null, today = null }) {
  if (!text || !today) return false;
  return sentOn === today && sentText === text;
}

export function morningDue({ hour, minute, morningHour, morningMinute = 0, sentOn = null, today = null }) {
  // Null is off, and off is the default. Nothing here starts notifying somebody
  // because the product decided it knew best.
  if (!Number.isInteger(morningHour)) return false;
  if (sentOn && today && sentOn === today) return false;      // once a day
  if (hour !== morningHour) return false;
  // The cron fires at :00 and :30. A stated :30 must not be answered at :00 —
  // that is half an hour before somebody asked to be woken, which is exactly
  // the wrong direction to be wrong in.
  return (morningMinute === 30 ? 30 : 0) === (minute >= 30 ? 30 : 0);
}
