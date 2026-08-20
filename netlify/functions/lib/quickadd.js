// lib/quickadd.js
// The website's own way to log a meal.
//
// THE HOLE THIS CLOSES. "Ffs it worked a few days ago" — said about food that
// was described to ChatGPT, acknowledged conversationally, and never written.
// Every fix for that has been aimed at making the model call the tool, and
// every one of them depends on the model. Meanwhile the settled doctrine says
// the app is optional forever and "website + connector = the complete product"
// — and the website could not log a single calorie. Routines had a door.
// Movements had a door. Weight had a door. FOOD, the thing this product is
// most about, had none, so when the assistant would not write, there was
// nowhere else to go.
//
// WHY IT IS NOT A FORM. "One sentence is a complete log" is the oldest
// doctrine here, and a meal split across name / calories / protein / carbs /
// fat boxes is exactly the thing nobody keeps. One line, typed the way it
// would be said: "chicken and rice 650". What is not typed stays null.
//
// WHY IT NEVER GUESSES. The connected model can turn "a steak and a baked
// potato" into macros because it read the sentence and, when there is one, the
// photograph. This parser is not a model and never pretends to be: it extracts
// the numbers a person TYPED and refuses to invent any that they did not. A
// meal with no figure lands with calories null and says out loud that it counts
// for nothing yet — the same shape as the day card, and far better than a
// plausible 400 that quietly poisons the week. Same rule as a typed load on a
// routine: the person's own number is theirs to keep, and a generated one does
// not exist.

// A bare trailing integer is calories, because in a box labelled "what you ate"
// the last number is the only number that could be anything else. Two digits
// minimum so "2 eggs" is never read as a 2-calorie meal — the leading position
// already protects it, and the floor makes the accident impossible.
const CAL_UNIT   = /\b(\d{2,5})\s*(?:k?cals?|calories)?\s*$/i;
const CAL_NAMED  = /\b(\d{2,5})\s*(k?cals?|calories)\b/i;

// Macros, in the three forms people actually type, as ONE left-to-right pass.
//
// The single pass is the whole trick, and it is worth the comment because the
// obvious implementation is wrong. Run "number then word" and "word then
// number" as two separate sweeps and "45g protein 60g carbs" comes out with
// protein 60 — the second sweep reads across the boundary the first one should
// have consumed. Alternation in one scan cannot do that: the engine tries
// every branch at position 0 before moving on, so whichever form the line
// actually uses wins at the point it starts, and the match is consumed before
// the next number is reached. Both orderings parse correctly.
//
// The single-letter form must be ATTACHED — "40p" — because "12 c" in "12
// cookies" is a cup, a count or a typo far more often than it is twelve grams
// of carbohydrate, and a parser that silently files it as carbs is worse than
// one that ignores it.
const MACROS = new RegExp([
  /(\d{1,4})\s*g?\s*(protein|carbs?|carbohydrates?|fats?|sugars?)\b/.source,
  /\b(protein|carbs?|carbohydrates?|fats?|sugars?)\s*:?\s*(\d{1,4})\s*g?\b/.source,
  /\b(\d{1,4})(p|c|f|s)\b/.source,
].join('|'), 'gi');

const MACRO_KEY = w => {
  const t = String(w).toLowerCase();
  if (t === 'p' || t.startsWith('protein')) return 'protein_g';
  if (t === 'c' || t.startsWith('carb')) return 'carbs_g';
  if (t === 'f' || t.startsWith('fat')) return 'fat_g';
  if (t === 's' || t.startsWith('sugar')) return 'sugar_g';
  return null;
};

// A drink is its own event type in the schema and always has been. It changes
// nothing about the arithmetic and everything about reading the day back — a
// list where four coffees are indistinguishable from four meals describes a
// different day than the one that happened.
const DRINK = /\b(coffee|espresso|latte|cappuccino|americano|tea|matcha|water|juice|smoothie|shake|protein shake|beer|wine|cider|whisk(e)?y|vodka|gin|rum|cocktail|soda|pop|coke|pepsi|sprite|lemonade|kombucha|milk|cola|energy drink|monster|red bull|gatorade)\b/i;

// "at 7:30", "at 7pm". Anchored to a digit so "steak at the pub" is a steak at
// the pub. Handed on as time_hint, never as occurred_at — a client may not date
// its own events, and time_hint is resolved in the user's own zone server-side.
const AT_TIME = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

const clean = s => String(s || '').replace(/\s+/g, ' ').replace(/^[\s,;:·—–-]+|[\s,;:·—–-]+$/g, '').trim();

/**
 * One typed line into one event, or a reason it cannot be one.
 *
 * @returns { ok: true, event, read } | { ok: false, why }
 *   event  the shape insertEvents takes
 *   read   what was pulled out of the words, so the screen can show its working
 */
export function parseQuickAdd(raw) {
  const text = clean(raw);
  if (!text) return { ok: false, why: 'Nothing typed.' };
  if (text.length > 300) return { ok: false, why: 'That is longer than a line — say it to your AI instead, it will do the reading.' };

  let rest = ` ${text} `;
  const read = {};

  // Time first: "at 7" would otherwise be eaten by the calorie rule, filing a
  // 7pm coffee as a 7-calorie one.
  const tm = rest.match(AT_TIME);
  if (tm) {
    let h = parseInt(tm[1], 10);
    const mnt = tm[2] ? parseInt(tm[2], 10) : 0;
    const mer = (tm[3] || '').toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && mnt >= 0 && mnt <= 59) {
      read.time_hint = `${String(h).padStart(2, '0')}:${String(mnt).padStart(2, '0')}`;
      rest = rest.replace(tm[0], ' ');
    }
  }

  // Macros before calories, so "650 45p" does not lose the 45 to the trailing
  // number rule and does not read the 45 as the calorie figure.
  const macros = {};
  rest = rest.replace(MACROS, (m, n1, w1, w2, n2, n3, w3) => {
    const key = MACRO_KEY(w1 || w2 || w3);
    const n = parseInt(n1 ?? n2 ?? n3, 10);
    if (!key || !Number.isFinite(n)) return m;
    macros[key] = n;
    return ' ';
  });

  // Calories: an explicit unit anywhere beats a bare number at the end.
  let calories = null;
  const named = rest.match(CAL_NAMED);
  if (named) {
    calories = parseInt(named[1], 10);
    rest = rest.replace(named[0], ' ');
  } else {
    const trail = clean(rest).match(CAL_UNIT);
    if (trail) {
      calories = parseInt(trail[1], 10);
      rest = clean(rest).replace(CAL_UNIT, ' ');
    }
  }

  const summary = clean(rest);
  if (!summary) {
    // A number on its own is not a log. It cannot be corrected later, it cannot
    // be recognised in a week, and it is exactly the kind of row that makes
    // somebody stop trusting their own record.
    return { ok: false, why: 'Say what it was, not just a number — "chicken and rice 650".' };
  }

  const detail = { items: [summary] };
  if (calories != null) detail.calories = calories;
  for (const [k, v] of Object.entries(macros)) detail[k] = v;

  return {
    ok: true,
    event: {
      event_type: DRINK.test(summary) && !/\b(with|and)\b/i.test(summary) ? 'drink' : 'food',
      summary,
      detail,
      // ALWAYS LABELLED. A figure read off a packet is exact and a figure
      // remembered is not, and nothing here can tell those apart — so it takes
      // the conservative side, exactly as every other calorie in the product
      // does. The credibility dies the first time a guess is read as a fact.
      estimated: true,
      ...(read.time_hint ? { time_hint: read.time_hint } : {}),
    },
    read: {
      summary,
      calories,
      ...macros,
      ...(read.time_hint ? { time_hint: read.time_hint } : {}),
      // Said back on the screen so a mis-parse is visible immediately rather
      // than three weeks later in an average.
      note: calories == null
        ? 'No calories on it, so it counts for nothing in today\'s total. Type it again with a figure, or ask your AI — it can estimate one from the description.'
        : null,
    },
  };
}
