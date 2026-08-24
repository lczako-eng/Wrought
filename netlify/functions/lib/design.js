// lib/design.js
// Building a workout WITH somebody, rather than handing them one.
//
// The founder: "we could add new workouts — like, I call it whatever, and they
// can fulfil it with me. So like a questionnaire trying to get me, you know,
// what kind of workout do you want, so they can build a workout pro level."
//
// Everything needed to BUILD a session already existed — patterns, a curated
// movement library, tier gating, equipment matching. What did not exist was
// the conversation that decides what to build. `suggest_workout` answers
// "what should I train today" from what is most overdue, which is right on
// average and is not what somebody means when they say "make me a leg day and
// call it Leg Day". That is a design brief, and a brief has to be taken.
//
// THE RULES, and most of them are older than this file:
//
// - NEVER A WEIGHT. Not one, anywhere, in a designed session. Loads come from
//   progressionCall against real history or as an RPE. A workout designed to
//   somebody's specification is exactly where a plausible-looking working
//   weight would slip through, and it is the same failure as the invented
//   2,600 in the place where being wrong hurts fastest.
// - IT NEVER ASKS WHAT IT ALREADY KNOWS. Tier, equipment, days and injuries
//   are on file. Asking again is how a setup interview turns into the form
//   this product exists not to be, and it tells somebody the memory does not
//   work.
// - ONE MESSAGE, GROUPED. They asked to build something, so questions are
//   expected here in a way they are not before a warm-up — but three or four
//   at once, answered in one line, not an interview.
// - TWO ANSWERS ARE ENOUGH TO BUILD. What it is for, and how long they have.
//   Everything else has a defensible default drawn from what is on file, and
//   a session that arrives is worth more than a session that is still being
//   specified.
// - LENGTH IS A HARD CEILING, like days available. Designing seventy minutes
//   of work for somebody who said forty is how a plan gets abandoned in week
//   two, and it is the same mistake as prescribing six sessions to somebody
//   with three.
// - AVOIDING SOMETHING IS NOT TREATING IT. A sore shoulder means the session
//   is built around it and says so. It never claims to rehabilitate anything;
//   that is a doctor's question and this is not a medical device.

import { PATTERNS, movementsFor } from './library.js';

// The shapes a single session actually comes in, as people name them. Ordered
// within each: the biggest, most technical thing first while they are fresh,
// accessories after. Order is a real training decision and is why `position`
// is stored on every set.
export const FOCUSES = {
  'full body':    { patterns: ['squat', 'horizontal push', 'horizontal pull', 'hinge', 'core'],
                    say: 'a bit of everything' },
  'upper':        { patterns: ['horizontal push', 'vertical pull', 'vertical push', 'horizontal pull', 'core'],
                    say: 'upper body' },
  'lower':        { patterns: ['squat', 'hinge', 'lunge', 'core', 'carry'],
                    say: 'legs' },
  'push':         { patterns: ['horizontal push', 'vertical push', 'horizontal push', 'core'],
                    say: 'push — chest, shoulders, triceps' },
  'pull':         { patterns: ['vertical pull', 'horizontal pull', 'horizontal pull', 'core'],
                    say: 'pull — back and biceps' },
  'legs':         { patterns: ['squat', 'hinge', 'lunge', 'core'], say: 'legs' },
  'chest':        { patterns: ['horizontal push', 'horizontal push', 'vertical push', 'core'],
                    say: 'chest' },
  'back':         { patterns: ['vertical pull', 'horizontal pull', 'horizontal pull', 'carry'],
                    say: 'back' },
  'shoulders':    { patterns: ['vertical push', 'vertical push', 'horizontal pull', 'core'],
                    say: 'shoulders' },
  'conditioning': { patterns: ['conditioning', 'carry', 'core'], say: 'conditioning' },
  'core':         { patterns: ['core', 'carry', 'core'], say: 'midsection' },
};

export const FOCUS_NAMES = Object.keys(FOCUSES);

// ── Styles — the famous-name ask, done the honest way ─────────────────────
// The founder: "let's use some famous names — like a Schwarzenegger-type
// workout, or famous boxing coaches, wink wink."
//
// The wink is the problem, and the settled doctrine already names it: THE
// PROVENANCE IS STATED HONESTLY — this is established, published methodology,
// not a live survey of any particular coach, and presenting textbook as
// insider knowledge is a small lie that makes the honest numbers harder to
// believe. There is also a legal edge: a person's name used as a product
// feature implies their endorsement, which nobody here has.
//
// So a style is named for its METHOD, recognised from the famous name people
// actually say, and delivered with one honest line about where it comes from.
// "Schwarzenegger workout" builds golden-era volume bodybuilding and SAYS
// "the style he trained in, from that era's published methodology" — which is
// true — never "his workout" — which is not.
//
// A style changes structure only: emphasis, sets, reps, rest. NEVER a weight —
// a famous name is exactly where a plausible-looking load would slip through,
// because it would read as pedigree rather than invention.
export const STYLES = {
  golden_era: {
    say: 'Golden-era volume bodybuilding',
    provenance: 'the high-volume style of 1970s bodybuilding — the era Arnold Schwarzenegger trained in. Published era methodology, not his programme and not an endorsement.',
    match: /golden\s*era|arnold|schwarzen|old.?school\s*bodybuild|venice\s*beach|bodybuild/i,
    sets: { beginner: 3, other: 5 }, reps: 10, rest_s: 90,
  },
  boxing_camp: {
    say: 'Boxing-camp conditioning',
    provenance: 'the conditioning shape of a traditional boxing camp — rounds, footwork, engine and core. The published structure of fight conditioning, not any named coach\u2019s corner.',
    match: /box(ing|er)?|fight\s*camp|combat/i,
    focus_default: 'conditioning',
    sets: { beginner: 3, other: 4 }, reps: 15, rest_s: 60,
  },
  powerlifting: {
    say: 'Powerlifting strength',
    provenance: 'competition-lift strength work — low reps, long rests, the big three first. Standard published strength methodology.',
    match: /power\s*lift|strength\s*first|heavy\s*(triples|singles)/i,
    sets: { beginner: 3, other: 5 }, reps: 5, rest_s: 210,
  },
  strongman: {
    say: 'Strongman-style',
    provenance: 'carries, hinges and overhead work in the strongman shape. Published event-training structure, no named athlete\u2019s programme.',
    match: /strong\s*man|carries|farmer/i,
    focus_default: 'full body',
    sets: { beginner: 3, other: 4 }, reps: 8, rest_s: 150,
  },
  athletic: {
    say: 'Athletic conditioning',
    provenance: 'field-sport conditioning — explosive lower work, pulling, engine. Standard published athletic-prep structure.',
    match: /athlet|explosive|sport\s*perform/i,
    focus_default: 'full body',
    sets: { beginner: 3, other: 4 }, reps: 6, rest_s: 120,
  },
};

export function styleFrom(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (STYLES[t.toLowerCase().replace(/[\s-]+/g, '_')]) return t.toLowerCase().replace(/[\s-]+/g, '_');
  for (const [key, st] of Object.entries(STYLES)) if (st.match.test(t)) return key;
  return null;
}

// What somebody says, mapped onto a shape. Deliberately generous: "chest and
// tris", "arms day", "leg day", "cardio" all land somewhere sensible, because
// making somebody pick from a list is the form again.
const ALIASES = [
  [/\bfull\s*body|whole\s*body|everything\b/i, 'full body'],
  [/\bpush\b/i, 'push'],
  [/\bpull\b/i, 'pull'],
  [/\bleg|quad|hamstring|glute|lower\b/i, 'legs'],
  [/\bchest|pec|bench\b/i, 'chest'],
  [/\bback|lat|row\b/i, 'back'],
  [/\bshoulder|delt|press\b/i, 'shoulders'],
  [/\bupper\b/i, 'upper'],
  [/\bcore|abs|midsection|stomach\b/i, 'core'],
  [/\bcardio|conditioning|engine|condition\b/i, 'conditioning'],
  [/\barm|bicep|tricep\b/i, 'upper'],
];

export function focusFrom(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (FOCUSES[t.toLowerCase()]) return t.toLowerCase();
  for (const [re, name] of ALIASES) if (re.test(t)) return name;
  return null;
}

// How much work fits in the time. A session is sized by the clock, not by a
// house number — forty minutes and ninety minutes are different workouts, and
// pretending otherwise is how somebody ends up abandoning the last third of
// every session and feeling like they failed it.
//
// Roughly ten minutes a movement at three or four sets with real rest, minus
// the warm-up. Floored at three so it is a session rather than a gesture,
// capped at seven because past that nobody finishes.
export function movementCount(minutes) {
  const m = Number(minutes) || 45;
  return Math.max(3, Math.min(7, Math.round((m - 8) / 10)));
}

/**
 * The session itself. Pure, so the harness holds it and no weight can hide.
 *
 * @param focus      one of FOCUS_NAMES
 * @param minutes    what they said they have
 * @param tier       beginner | intermediate | advanced
 * @param equipment  what they own — a hard filter, never a suggestion
 * @param avoid      areas to work around, in their words
 */
export function designSession({ focus, minutes = 45, tier = 'intermediate',
                                equipment = null, avoid = [], style = null } = {}) {
  const st = style ? STYLES[style] : null;
  const shape = FOCUSES[focus || st?.focus_default];
  if (!shape) return null;

  const beginner = tier === 'beginner';
  const want = movementCount(minutes);
  const dodge = (Array.isArray(avoid) ? avoid : [avoid]).filter(Boolean)
    .map(a => String(a).toLowerCase());

  // A movement is dropped when it loads something they said to leave alone.
  // Dropped, never modified — "do it lighter" is a claim about what their body
  // can take today, and nothing here is entitled to make one.
  const clear = m => !dodge.length || !m.muscles.some(mu =>
    dodge.some(d => d.includes(mu.toLowerCase()) || mu.toLowerCase().includes(d)));

  const used = new Set();
  const out = [];
  // Round-robin the shape so a four-movement session is not four squats, and
  // a seven-movement one keeps coming back through the same order rather than
  // running out and stopping short.
  for (let i = 0; out.length < want && i < shape.patterns.length * 3; i++) {
    const pattern = shape.patterns[i % shape.patterns.length];
    const options = movementsFor(pattern, { equipment, tier }).filter(clear);
    const pick = options.find(m => !used.has(m.name));
    if (!pick) continue;
    used.add(pick.name);
    const conditioning = pattern === 'conditioning';
    out.push({
      name: pick.name,
      pattern,
      // Fewer, cleaner sets while a movement is still being learned; more once
      // it is not. Nothing here is a load.
      // A style changes the scheme, never the load. Beginner volume is capped
      // whatever the style says — golden-era set counts on a first month is
      // how somebody cannot lift their arms on day three and never comes back.
      sets: conditioning ? null
        : st ? (beginner ? st.sets.beginner : st.sets.other)
        : (beginner ? 3 : 4),
      reps: conditioning ? null
        : (pattern === 'core' || pattern === 'carry') ? 12
        : st ? st.reps
        : beginner ? 8 : 6,
      minutes: conditioning ? Math.max(8, Math.round((Number(minutes) || 45) / 5)) : null,
      load_kg: null,
      rest_s: conditioning ? 60 : st ? st.rest_s : beginner ? 120 : 150,
      muscles: pick.muscles,
      // A beginner gets told why. An advanced lifter gets left alone.
      cue: tier === 'advanced' ? null : pick.cue,
    });
  }

  return out.length ? out : null;
}

/**
 * What still has to be asked, given everything already on file.
 *
 * Returns at most a handful, in the order they matter, and NEVER anything the
 * record can already answer — the whole difference between a brief and a form.
 */
export function designQuestions({ focus = null, minutes = null, profile = {},
                                  limitations = [], gyms = [] } = {}) {
  const ask = [];

  // The one thing nothing can infer. "What is most overdue" is a good answer to
  // a different question; somebody naming a workout has something in mind.
  if (!focus) {
    ask.push({
      key: 'focus',
      ask: 'What is this one for — legs, push, pull, upper, full body, conditioning?',
      why: 'nothing on file can guess what they want this particular session to be',
    });
  }

  // A hard ceiling, so it has to be asked rather than assumed.
  if (!minutes) {
    ask.push({
      key: 'minutes',
      ask: 'How long have you actually got for it?',
      why: 'length decides how many movements fit, and overshooting it is how a plan gets abandoned',
    });
  }

  // Everything below is only asked when the record genuinely cannot answer it.
  if (!profile.equipment?.length) {
    ask.push({
      key: 'equipment',
      ask: 'What have you got to work with — full gym, dumbbells, bodyweight?',
      why: 'no equipment on file, and programming a machine they do not have is the fastest way to lose them',
    });
  }
  if (!profile.tier) {
    ask.push({
      key: 'tier',
      ask: 'How long have you been training — new to it, a while, or years?',
      why: 'tier gates the movements themselves, not just the volume',
    });
  }
  // Asked ONCE and only when nothing is on file. Somebody who has already told
  // us about a knee does not get asked about it every time they build a
  // session — that is the memory failing out loud.
  if (!limitations.length) {
    ask.push({
      key: 'avoid',
      ask: 'Anything to leave alone at the moment?',
      why: 'programming around an injury nobody mentioned is how this hurts somebody',
    });
  }
  if (gyms.length > 1) {
    ask.push({
      key: 'where',
      ask: `Which one — ${gyms.slice(0, 3).join(', ')}?`,
      why: 'they have more than one place on file and the kit is different',
    });
  }

  return ask;
}

/**
 * The note the model reads. Kept beside the questions so a changed rule and a
 * changed instruction cannot drift apart — the same pattern as nudgeNote.
 */
export function designNote(ask, built) {
  if (built) {
    return 'Read the movements back in one short line and offer to keep it — save_routine with this exact list, ' +
      'the name they gave it, and a notes write-up in their register saying what the session is for and what to ' +
      'push. NOT ONE WEIGHT, here or when it runs: loads come from the tools against their own history, or as an ' +
      'effort. If they want something swapped, swap it and rebuild rather than asking them to start over. ' +
      'Everything about the shape is a proposal — it is their workout and changing it is never a negotiation.';
  }
  return 'Ask these in ONE message, together, as a short line each — they asked for a workout to be built, so ' +
    'questions are expected here. Do NOT ask anything already answered above, do not add questions of your own, ' +
    'and do not explain that a list exists. Two answers are enough to build: what it is for and how long they ' +
    'have. If they give you those and ignore the rest, BUILD IT — a session that arrives beats one still being ' +
    'specified. Never propose a weight at any point.';
}
