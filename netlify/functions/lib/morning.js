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
//   - A care flag stops automated coaching, never the scheduled briefing
//     itself. The founder was explicit after seeing a lock screen full of the
//     same warning: the morning, midday and evening pushes are appointments,
//     and replacing their facts with a warning means the product did not send
//     the brief. The push keeps its facts and carries REVIEW secondarily.
//   - It never tells anybody to eat less. Not "you have X left", not a deficit,
//     not a ceiling. A phone at 7:30am is the worst possible place to start
//     doing arithmetic about what is allowed.
//   - Nothing is invented. Every figure comes from the same computed facts the
//     dashboard and the connector read, so three surfaces cannot disagree.
//   - A briefing is short, but it is a briefing: yesterday's completed burn,
//     today's goals, the week's training position, then a tap that opens the
//     decision. Those belong together because the interaction is the action
//     the facts set up. Anything beyond that is a lecture and will not be read.
//   - Silence is a real answer. A brief with nothing to say sends nothing.

// What the morning can usefully raise, hardest first. The order is the order of
// consequence, not of cheerfulness: something that makes every other number
// meaningless outranks a number.
const MAX_LINES = 6;
const GOAL_NAMES = {
  calories: 'calories', protein_g: 'protein', steps: 'steps',
  distance_km: 'distance', active_minutes: 'active minutes',
  sleep_minutes: 'sleep', weight_kg: 'goal weight',
};

function goalExpectations(goals = []) {
  return goals
    // The live week line below owns training. scoreGoals' general summary can
    // span a month; the morning must never label that count as this week.
    .filter(g => g.metric !== 'workout_days' && g.target_value != null)
    .map(g => {
      const n = Number(g.target_value);
      if (!Number.isFinite(n)) return null;
      const value = (Math.round(n * 10) / 10).toLocaleString('en-US');
      const unit = g.target_unit ? ` ${g.target_unit}` : '';
      const cadence = g.cadence === 'weekly' ? ' weekly' : '';
      return `${GOAL_NAMES[g.metric] || g.goal || g.metric}: ${value}${unit}${cadence}`;
    })
    .filter(Boolean);
}

function careNote(flag) {
  if (!flag) return null;
  if (flag.flag === 'very_low_intake') {
    const count = flag.evidence_dates?.length;
    return count
      ? `Record check: ${count} low-intake day${count === 1 ? '' : 's'} need review.`
      : 'Record check: the low-intake history needs review.';
  }
  if (flag.flag === 'rapid_loss') return 'Care note: the recorded weight trend is moving unusually fast.';
  if (flag.flag === 'no_rest') return 'Care note: the record shows no rest day in the last two weeks.';
  return 'Care note: there is a health record item to review.';
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return Math.round(n).toLocaleString('en-US');
}

function compactGoal(goal) {
  const value = compactNumber(goal?.target_value);
  if (!value) return null;
  if (goal.metric === 'calories') return `FUEL ${value} kcal`;
  if (goal.metric === 'protein_g') return `PROTEIN ${value}g`;
  if (goal.metric === 'steps') return `STEPS ${value}`;
  return null;
}

/**
 * The actual lock-screen shape for the morning appointment.
 *
 * The long `morningBrief` remains useful in email and a conversation. The
 * phone needs the same four answers in a form that survives iOS truncation:
 * yesterday's burn, today's deal, the live week, and the tap back into today's
 * training choice. A care flag changes the title to REVIEW; it never replaces
 * those answers again.
 */
export function morningNotification({ yesterdayBalance = null, goals = [], week = null, planned = null, flags = [] } = {}) {
  const parts = [];
  if (yesterdayBalance?.known && yesterdayBalance.calories_out) {
    parts.push(`YDAY BURN ~${compactNumber(yesterdayBalance.calories_out)}`);
  }
  const deal = goals.map(compactGoal).filter(Boolean).slice(0, 3);
  if (deal.length) parts.push(deal.join(' / '));
  if (week?.target) parts.push(`WEEK ${week.done || 0}/${week.target}`);
  else if (week) parts.push(`WEEK ${week.done || 0}`);
  if (planned?.name && !week?.met) {
    parts.push(`NEXT ${planned.name}${planned.est_minutes ? ` ${planned.est_minutes}m` : ''}`);
  }
  const action = 'TAP: WHAT ARE WE TRAINING?';
  const detail = parts.join(' · ');
  let body = detail ? `${detail} · ${action}` : action;
  if (body.length > 160) {
    const room = 160 - action.length - 4; // ellipsis plus the separator
    body = `${detail.slice(0, room)}… · ${action}`;
  }
  return {
    title: flags.length ? 'WROUGHT · MORNING BRIEF · REVIEW' : 'WROUGHT · MORNING BRIEF',
    body,
  };
}

/**
 * The morning message, or null to send nothing.
 *
 * @param facts        rangeFacts/dayFacts-shaped facts for TODAY
 * @param flags        careFlags output
 * @param yesterdayBalance energyBalance for the completed day, or null
 * @param week         weekSoFar output
 * @param goals        active goal rows — expectations, not today's score
 * @param goalsToSet   what has no target yet, from goalsToSet()
 * @param yesterday    yesterday's dayFacts, for the one backward-looking line
 * @param readiness    readiness() output, or null
 * @param planned      { name, est_minutes } — the workout most due today, or null
 */
export function morningBrief({
  facts = {}, flags = [], yesterdayBalance = null, week = null,
  goals = [], goalsToSet = null, yesterday = null, readiness = null, planned = null,
} = {}) {
  const lines = [];

  // 1. YESTERDAY'S COMPLETED BURN, not a projection of today at breakfast.
  //    The old implementation passed TODAY into energyBalance and then said
  //    "to burn today" — the opposite of the founder's morning brief. A past
  //    day is only stated when something was actually recorded on it, and the
  //    figure stays labelled as an estimate because every calories-out figure
  //    is one, watch included.
  if (yesterday?.logged && yesterdayBalance?.known && yesterdayBalance.calories_out) {
    lines.push(`Yesterday: about ${Math.round(yesterdayBalance.calories_out).toLocaleString()} kcal burned.`);
  }

  // 2. TODAY'S EXPECTATIONS, read from goals the person actually set. These
  //    are targets, never an allowance and never a number invented on the lock
  //    screen. Tapping the notification opens the assistant to keep or change
  //    them; the push itself never negotiates with a closed conversation.
  const expectations = goalExpectations(goals);
  if (expectations.length) {
    lines.push(`Today's goals: ${expectations.join('; ')}.`);
  } else if (goalsToSet?.missing?.length) {
    const what = goalsToSet.missing.slice(0, 2).join(' and ');
    lines.push(`Nothing set for ${what} yet — tap to set it with WROUGHT.`);
  }

  // 3. WHERE THE WEEK STANDS — always. "2 of 4" is the game state the founder
  //    asked for; hiding it when the target is met turns the most useful fact
  //    into a nag that only appears while somebody is behind.
  if (week?.say) {
    lines.push(week.say);
  }

  // 4. THE BODY'S VETO, when there is one. It only ever softens; it never turns
  //    a good reading into permission to go harder.
  const heldBack = readiness && readiness.state && readiness.state !== 'ready';
  if (heldBack && readiness.say) {
    lines.push(readiness.say);
  }

  // 5. YESTERDAY'S INTAKE, in one clause and only if it is genuinely informative. This
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

  // 6. THE INTERACTION. The whole notification is the hyperlink; a tap opens
  //    the selected assistant with the goals and training question already in
  //    its prompt. A saved workout is an option, not a command, and rest stays
  //    a first-class answer even when the weekly target is already met.
  if (lines.length || planned?.name) {
    lines.push(planned?.name && !week?.met && !heldBack
      ? `Up next: ${planned.name}${planned.est_minutes ? `, about ${planned.est_minutes} min` : ''}. Tap to keep or change the plan.`
      : 'Tap to keep or change the goals, then choose today\'s training — or a rest day.');
  }

  // The record review stays visible, but it does not take the appointment
  // hostage. It is last and deliberately factual: the notification title also
  // says REVIEW, while every number above remains the briefing the person set.
  const review = careNote(flags[0]);
  if (review) lines.push(review);

  if (!lines.length) return null;

  return {
    text: lines.slice(0, MAX_LINES).join(' '),
    kind: 'morning',
    only: false,
    care: !!flags.length,
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
    'Gym bro — morning. Using the Wrought connector, give me my morning brief: yesterday\'s computed ' +
    'calories burned, my current goals and expectations, and where I stand in this week\'s training target. ' +
    'Ask whether I want to keep or change any of it, then ask what I want to train today. Wait for my ' +
    'answer before changing a goal or choosing or building today\'s training plan. If Wrought has a care ' +
    'note, mention it after the briefing; never replace the briefing with it.',
  // The midday opener ASKS, because the founder's midday is an assessment the
  // AI takes, not a report it reads out: it exists to collect the half-day —
  // what has been eaten, how the day feels — and the assistant's first act is
  // logging what comes back. Pushing toward the goals comes from the tools it
  // then calls, with real numbers, never from words pre-written here.
  midday:
    'Gym bro — midday check-in. Using the Wrought connector: I\'ll tell you what ' +
    "I've eaten so far and how the day is going — log it, then tell me where I " +
    'stand against my targets and what the afternoon needs. If Wrought has a care note, mention it after ' +
    'the check-in; never replace the check-in with it.',
};

function careOpener(flag = {}) {
  const dates = (flag.evidence_dates || []).join(', ');
  return 'Gym bro — Wrought paused coaching because the food record shows a sustained low-intake pattern' +
    (dates ? ` on these dates: ${dates}` : '') + '. Ask me first whether each flagged date was fully logged or had meals missing. ' +
    'For exactly the dates I confirm were incomplete, call review_intake_days with complete=false; do not invent meals or calories. ' +
    'For dates I confirm were complete, call it with complete=true. Then read the care flag again. Only if it clears, give me the normal morning brief; ' +
    'otherwise explain the safety hold plainly and stop there.';
}

/**
 * The notification cannot open the assistant's APP with the day's opener
 * already typed — the ChatGPT app takes no prefilled prompt (an open OpenAI
 * request), and a service worker's openWindow lands a raw chatgpt.com URL in a
 * logged-out browser tab, which is the dead end the founder hit. So the tap
 * goes to OUR launcher instead: same-origin, so it opens inside the installed
 * Wrought app with no login wall, and there it hands the person a real
 * button — the one gesture iOS will actually hand off to the assistant's app —
 * plus the opener to read or paste. The launcher builds the chatgpt.com /
 * claude.ai URL itself.
 */
function bridge(opens, prompt) {
  if (opens === 'chatgpt' || opens === 'claude') {
    return `/go.html?to=${opens}&q=${encodeURIComponent(prompt)}`;
  }
  // The dashboard is the one destination every account verifiably has.
  return '/app.html';
}

export function morningLink(opens, which = 'morning') {
  return bridge(opens, OPENERS[which] || OPENERS.morning);
}

/**
 * A care notification must still be the whole message, but it must not be a
 * dead end. The person's tap opens the same assistant they chose for their
 * morning briefing with the exact dates and the one permitted resolution:
 * record whether the diary was incomplete, without fabricating what was eaten.
 */
export function careReviewLink(opens, flag) {
  if (opens === 'chatgpt' || opens === 'claude') return bridge(opens, careOpener(flag));
  return '/app.html#care-review';
}

/**
 * The midday line — where the day stands while an afternoon can still act on
 * it. A care flag remains a secondary record note rather than replacing the
 * appointment; nothing ever says "eat less" or quotes what is "left".
 */
export function middayBrief({ facts = {}, flags = [], scored = [] } = {}) {
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

  const notificationText = lines.slice(0, 2).join(' ');
  const review = careNote(flags[0]);
  if (review) lines.push(review);

  return {
    text: lines.slice(0, 3).join(' '),
    // The lock screen is the appointment, not the review. The title can mark
    // REVIEW; the repeated low-intake count stays out of the pop-up body.
    notification_text: notificationText,
    kind: 'midday',
    only: false,
    care: !!flags.length,
  };
}

/**
 * Is it this account's morning-brief moment, in their own timezone?
 *
 * Separated from the message so the decision is testable without composing
 * anything, and so the cron's half-hour granularity lives in exactly one place.
 */
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
