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
import { STYLE_VOICES } from './voices.js';

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
// workout, or famous boxing coaches, wink wink." And then, the full list:
// "what are the top biggest trainers in the world ever — I want twenty of
// them, Freddie Roach, Louie Simmons, Schwarzenegger — as kind of our
// ambassadors, but we're gonna have to call it a style."
//
// "Ambassadors" is the problem, and he asked the right question about it:
// "if I copy their styles and put their name in it, will I get sued?"
// The method is not protectable — nobody owns one hard set to failure or a
// max-effort day. THE NAME IS. A person's name on a paid product implies their
// endorsement (right of publicity — most of these people are alive and several
// actively protect their names), and a handful of the method names are
// trademarks: Starting Strength, 5/3/1, Westside Barbell, FST-7, Heavy Duty.
//
// So the rule, settled with him: A STYLE IS NAMED FOR ITS METHOD, RECOGNISED
// FROM THE FAMOUS NAME PEOPLE ACTUALLY SAY, AND CREDITS THE PERSON AS THE
// LINEAGE — "in the tradition of" — never as the author, never as an endorser,
// never as a face. The provenance line on every one says it is published
// methodology, not their programme. That is the ordinary, allowed way to
// reference somebody's published work, and it is also the honesty doctrine
// this product already runs on: presenting textbook as insider knowledge is a
// small lie that makes the honest numbers harder to believe. A test pins it:
// no style's NAME may contain a person's surname or a trademark.
//
// A style changes structure only: emphasis, sets, reps, rest, and three
// shapes added for this list — a short-rest finisher on the last movement,
// a cap on how many movements, and a long-conditioning share. NEVER a
// weight — a famous name is exactly where a plausible-looking load would slip
// through, because it would read as pedigree rather than invention.
//
// `emphasis` says what the style actually DOES to the session it builds, in
// one honest line. Where a method is really about the WEEK (hard/easy days,
// periodised blocks, aerobic base over months) the line says so and names the
// tool that owns the week, rather than pretending one session carries it.
export const STYLES = {
  // ── Boxing ─────────────────────────────────────────────────────────────
  drilled_fundamentals: {
    say: 'Drilled fundamentals',
    lineage: "Cus D'Amato", discipline: 'Boxing',
    tradition: "in the tradition of Cus D'Amato — the same few movements drilled until they are reflex, with the head kept moving",
    provenance: "the drilled-repetition shape of a traditional boxing gym — fundamentals in high volume, core and footwork. Published fight-training structure, not his programme and not an endorsement.",
    emphasis: 'The same few movements over and over until they are reflex — repetition rather than variety.',
    match: /d'?amato|peek.?a.?boo|drilled/i,
    focus_default: 'conditioning',
    sets: { beginner: 3, other: 4 }, reps: 12, rest_s: 45,
  },
  corner_craft: {
    say: 'Corner craft',
    lineage: 'Angelo Dundee', discipline: 'Boxing',
    tradition: 'in the tradition of Angelo Dundee — fight-specific preparation, engine and core, nothing that does not serve the rounds',
    provenance: 'fight-specific conditioning — rounds, engine, core, pulling. Published fight-preparation structure, not his programme and not an endorsement.',
    emphasis: 'Built around the rounds: engine and core, and nothing in it that does not serve the fight.',
    match: /dundee|corner\s*craft/i,
    focus_default: 'conditioning',
    sets: { beginner: 3, other: 4 }, reps: 12, rest_s: 60,
  },
  sparring_volume: {
    say: 'Sparring-volume camp',
    lineage: 'Emanuel Steward', discipline: 'Boxing',
    tradition: 'in the tradition of Emanuel Steward — high technical volume, long rounds, the engine built by doing the work',
    provenance: 'high-volume fight conditioning — long rounds, short rests, technical repetition. Published camp structure, not his programme and not an endorsement.',
    emphasis: 'High volume with short rests. The engine gets built by doing the work, not by resting between it.',
    match: /steward|kronk|sparring/i,
    focus_default: 'conditioning',
    sets: { beginner: 3, other: 4 }, reps: 20, rest_s: 45,
  },
  boxing_camp: {
    say: 'Fight camp',
    lineage: 'Freddie Roach', discipline: 'Boxing',
    tradition: 'in the tradition of Freddie Roach — mitt-work volume, roadwork and core, the camp shape that builds a fighter’s engine',
    provenance: 'the conditioning shape of a traditional boxing camp — rounds, footwork, engine and core. The published structure of fight conditioning, not any named coach’s corner and not an endorsement.',
    emphasis: 'Worked in rounds, the way a camp runs — conditioning blocks with a breather between them.',
    match: /roach|box(ing|er)?|fight\s*camp|combat/i,
    focus_default: 'conditioning',
    sets: { beginner: 3, other: 4 }, reps: 15, rest_s: 60,
  },

  // ── Powerlifting and strength ──────────────────────────────────────────
  conjugate: {
    say: 'Conjugate method',
    lineage: 'Louie Simmons', discipline: 'Powerlifting',
    tradition: 'in the tradition of Louie Simmons’ conjugate method — a max-effort lift, a speed lift, and the assistance work that props them up',
    provenance: 'max-effort and dynamic-effort work with rotating variations and heavy assistance. Published conjugate methodology, not his programme and not an endorsement.',
    emphasis: 'One heavy thing first while you are fresh, then the work that props it up.',
    match: /simmons|westside|conjugate|max.?effort|dynamic.?effort/i,
    sets: { beginner: 3, other: 6 }, reps: 3, rest_s: 120,
  },
  high_frequency: {
    say: 'High-frequency technique',
    lineage: 'Boris Sheiko', discipline: 'Powerlifting',
    tradition: 'in the tradition of Boris Sheiko — the competition lifts often, at moderate loads, until the technique cannot be done wrong',
    provenance: 'high-frequency, moderate-intensity practice of the competition lifts with plenty of sets. Published Russian powerlifting methodology, not his programme and not an endorsement.',
    emphasis: 'The same lifts come back often and never near failure — technique practised until it cannot be done wrong.',
    match: /sheiko|high.?frequency|technique\s*practice/i,
    sets: { beginner: 3, other: 6 }, reps: 4, rest_s: 150,
  },
  five_by_five: {
    say: 'Five by five',
    lineage: 'Bill Starr', discipline: 'Powerlifting',
    tradition: 'in the tradition of Bill Starr — five sets of five on the big lifts, a heavy day, a light day and a medium day',
    provenance: 'five sets of five on compound lifts with a heavy / light / medium week. Standard published strength methodology, not his programme and not an endorsement.',
    emphasis: 'Fives on the big lifts with long rests. Plain, heavy, and much the same every week.',
    match: /starr|5\s*x\s*5|five\s*by\s*five|heavy.?light.?medium/i,
    sets: { beginner: 3, other: 5 }, reps: 5, rest_s: 180,
  },
  novice_linear: {
    say: 'Novice linear progression',
    lineage: 'Mark Rippetoe', discipline: 'Powerlifting',
    tradition: 'in the tradition of Mark Rippetoe — three sets of five on a handful of barbell compounds, adding a little every session while it still adds',
    provenance: 'three sets of five on barbell compounds with per-session progression. Standard published novice methodology, not his programme and not an endorsement.',
    emphasis: 'A handful of barbell lifts, nothing clever, a little more each session while that still works.',
    match: /rippetoe|starting\s*strength|novice\s*linear|3\s*x\s*5/i,
    sets: { beginner: 3, other: 3 }, reps: 5, rest_s: 180, max_movements: 4,
  },
  submax_monthly: {
    say: 'Sub-max monthly progression',
    lineage: 'Jim Wendler', discipline: 'Powerlifting',
    tradition: 'in the tradition of Jim Wendler — sub-maximal work on the main lift, small monthly jumps, assistance kept simple',
    provenance: 'sub-maximal main-lift work progressed by the month with simple assistance. Standard published intermediate methodology, not his programme and not an endorsement.',
    emphasis: 'Nothing taken to failure. The main lift moves in small steps and the assistance stays plain.',
    match: /wendler|5\s*\/\s*3\s*\/\s*1|531|sub.?max/i,
    sets: { beginner: 3, other: 3 }, reps: 5, rest_s: 150,
  },
  powerlifting: {
    say: 'Powerlifting strength',
    discipline: 'Powerlifting',
    provenance: 'competition-lift strength work — low reps, long rests, the big three first. Standard published strength methodology.',
    emphasis: 'The big three first and heavy, with long rests. Strength is the only thing being chased.',
    match: /power\s*lift|strength\s*first|heavy\s*(triples|singles)/i,
    sets: { beginner: 3, other: 5 }, reps: 5, rest_s: 210,
  },
  strongman: {
    say: 'Strongman-style',
    discipline: 'Powerlifting',
    provenance: 'carries, hinges and overhead work in the strongman shape. Published event-training structure, no named athlete’s programme.',
    emphasis: 'Carrying, lifting and pressing awkward loads — the work that makes you useful outside a gym.',
    match: /strong\s*man|carries|farmer/i,
    focus_default: 'full body',
    sets: { beginner: 3, other: 4 }, reps: 8, rest_s: 150,
  },

  // ── Strength and conditioning ──────────────────────────────────────────
  tempo_structural: {
    say: 'Tempo and structural balance',
    lineage: 'Charles Poliquin', discipline: 'Strength & conditioning',
    tradition: 'in the tradition of Charles Poliquin — every rep on a tempo, the weak links brought up so the strong ones can go further',
    provenance: 'tempo-controlled lifting with structural-balance assistance and short training phases. Published strength-coaching methodology, not his programme and not an endorsement.',
    emphasis: 'Every rep on a count: slowed down, no bouncing, and the weak links brought up so the strong ones can go further.',
    match: /poliquin|tempo|structural\s*balance/i,
    sets: { beginner: 3, other: 4 }, reps: 8, rest_s: 90,
  },
  periodised_block: {
    say: 'Periodised block',
    lineage: 'Tudor Bompa', discipline: 'Strength & conditioning',
    tradition: 'in the tradition of Tudor Bompa — training in phases with a purpose and an end, volume first, intensity later',
    provenance: 'classic periodisation — accumulation, intensification, a planned deload. Published periodisation methodology, not his programme and not an endorsement.',
    emphasis: 'Volume first, intensity later. This builds the volume half; the phases themselves run over months.',
    match: /bompa|periodi[sz]|block\s*training|phases/i,
    sets: { beginner: 3, other: 4 }, reps: 8, rest_s: 120,
  },
  athletic: {
    say: 'Athletic conditioning',
    discipline: 'Strength & conditioning',
    provenance: 'field-sport conditioning — explosive lower work, pulling, engine. Standard published athletic-prep structure.',
    emphasis: 'Fast rather than heavy — jumping, throwing, and driving the bar up with speed.',
    match: /athlet|explosive|sport\s*perform/i,
    focus_default: 'full body',
    sets: { beginner: 3, other: 4 }, reps: 6, rest_s: 120,
  },
  hard_easy: {
    say: 'Hard day, easy day',
    lineage: 'Bill Bowerman', discipline: 'Running',
    tradition: 'in the tradition of Bill Bowerman — a hard day is earned by an easy one; recovery is training',
    provenance: 'alternating hard and easy days, conditioning with strength support. Standard published running-coach structure, not his programme and not an endorsement.',
    emphasis: 'This is the hard day. Tomorrow is deliberately easy, because the easy day is what earns the hard one.',
    match: /bowerman|hard.?easy|oregon/i,
    focus_default: 'conditioning',
    sets: { beginner: 3, other: 4 }, reps: 8, rest_s: 90, long_conditioning: 0.5,
  },
  aerobic_base: {
    say: 'Aerobic base',
    lineage: 'Arthur Lydiard', discipline: 'Running',
    tradition: 'in the tradition of Arthur Lydiard — months of easy miles first, speed only once the engine is built',
    provenance: 'long steady aerobic work as the foundation, speed added later. Published endurance methodology, not his programme and not an endorsement.',
    emphasis: 'Mostly one long steady effort you could hold a conversation through, with light strength around it.',
    match: /lydiard|aerobic\s*base|base\s*build|easy\s*miles|zone\s*2/i,
    focus_default: 'conditioning',
    sets: { beginner: 2, other: 3 }, reps: 10, rest_s: 60, long_conditioning: 0.75,
  },

  // ── Kettlebell and simplicity ──────────────────────────────────────────
  never_to_failure: {
    say: 'Strength, never to failure',
    lineage: 'Pavel Tsatsouline', discipline: 'Kettlebell',
    tradition: 'in the tradition of Pavel Tsatsouline — low reps, many sets, stop while it is still crisp; practise strength, do not test it',
    provenance: 'low-rep, high-set strength practice stopped well short of failure, kettlebell and barbell alike. Published strength-practice methodology, not his programme and not an endorsement.',
    emphasis: 'Every set stops while it is still crisp. Strength gets practised here, never tested.',
    match: /pavel|tsatsouline|kettlebell|grease\s*the\s*groove|simple\s*(and|&)\s*sinister|never\s*to\s*failure/i,
    sets: { beginner: 3, other: 5 }, reps: 3, rest_s: 120,
  },
  easy_strength: {
    say: 'Easy strength',
    lineage: 'Dan John', discipline: 'Kettlebell',
    tradition: 'in the tradition of Dan John — a few fundamental movements, done well, done often, never turned into a grind',
    provenance: 'a handful of fundamental patterns at easy loads, done frequently. Published simple-strength methodology, not his programme and not an endorsement.',
    emphasis: 'A few movements, a couple of easy sets each, and out. The point is showing up again tomorrow.',
    match: /dan\s*john|easy\s*strength|simple\s*strength|fundamental/i,
    focus_default: 'full body',
    sets: { beginner: 2, other: 3 }, reps: 5, rest_s: 120, max_movements: 4,
  },

  // ── Bodybuilding ───────────────────────────────────────────────────────
  bodybuilding_principles: {
    say: 'Bodybuilding principles',
    lineage: 'Joe Weider', discipline: 'Bodybuilding',
    tradition: 'in the tradition of Joe Weider — the published principles: pyramids, supersets, instinctive training, the muscle worked from more than one angle',
    provenance: 'the classic bodybuilding training principles — pyramiding, supersets, angle variety. Published methodology, not his programme and not an endorsement.',
    emphasis: 'Each muscle worked from more than one angle, and kept under tension rather than rushed.',
    match: /weider|principles|pyramid|superset/i,
    sets: { beginner: 3, other: 4 }, reps: 10, rest_s: 60,
  },
  strict_isolation: {
    say: 'Strict isolation',
    lineage: 'Vince Gironda', discipline: 'Bodybuilding',
    tradition: 'in the tradition of Vince Gironda — strict form on isolation work, short rests, eight sets of eight',
    provenance: 'strict-form isolation work in many short-rest sets. Published old-school bodybuilding methodology, not his programme and not an endorsement.',
    emphasis: 'Strict form, almost no rest and no momentum anywhere. Isolation work done properly.',
    match: /gironda|8\s*x\s*8|eight\s*by\s*eight|strict\s*isolation/i,
    sets: { beginner: 3, other: 6 }, reps: 8, rest_s: 30,
  },
  one_hard_set: {
    say: 'One hard set',
    lineage: 'Arthur Jones', discipline: 'Bodybuilding',
    tradition: 'in the tradition of Arthur Jones — one set per movement, taken to the point where another rep is not there, then move on',
    provenance: 'high-intensity training: a single working set to momentary failure per movement, full-body. Published HIT methodology, not his programme and not an endorsement.',
    emphasis: 'One set per movement, taken to where another rep is not there, then move on. Short, and it bites.',
    match: /arthur\s*jones|nautilus|\bhit\b|one\s*hard\s*set|single\s*set/i,
    focus_default: 'full body',
    sets: { beginner: 1, other: 1 }, reps: 10, rest_s: 120,
  },
  brief_and_infrequent: {
    say: 'Brief and infrequent',
    lineage: 'Mike Mentzer', discipline: 'Bodybuilding',
    tradition: 'in the tradition of Mike Mentzer — very few sets, very hard, and more days off than most people are comfortable with',
    provenance: 'very-low-volume, high-intensity training with long recovery between sessions. Published high-intensity methodology, not his programme and not an endorsement.',
    emphasis: 'Very few sets taken very hard, then more days off than most people are comfortable with.',
    match: /mentzer|heavy\s*duty|brief\s*(and|&)\s*infrequent/i,
    sets: { beginner: 1, other: 1 }, reps: 6, rest_s: 180,
  },
  seven_set_finisher: {
    say: 'Seven-set finisher',
    lineage: 'Hany Rambod', discipline: 'Bodybuilding',
    tradition: 'in the tradition of Hany Rambod — ordinary working sets, then the last movement for the muscle done as seven short-rest sets',
    provenance: 'standard working sets with a seven-set, short-rest finisher on the final movement. Published physique-training methodology, not his programme and not an endorsement.',
    emphasis: 'Ordinary work, and then the last movement for that muscle is hammered with short rests until it is done.',
    match: /rambod|fst.?7|seven.?set|finisher/i,
    sets: { beginner: 3, other: 4 }, reps: 10, rest_s: 60, finisher: { sets: 7, rest_s: 30 },
  },
  golden_era: {
    say: 'Golden-era volume bodybuilding',
    lineage: 'Arnold Schwarzenegger', discipline: 'Bodybuilding',
    tradition: 'in the tradition of the 1970s golden era — the volume and the double-split that Arnold Schwarzenegger trained with',
    provenance: 'the high-volume style of 1970s bodybuilding — the era Arnold Schwarzenegger trained in. Published era methodology, not his programme and not an endorsement.',
    emphasis: 'More movements and more sets than most — the high-volume way the 1970s gyms trained.',
    match: /golden\s*era|arnold|\barnie\b|\bs(?:ch|h|c)?wart?ze|old.?school\s*bodybuild|venice\s*beach|bodybuild/i,
    sets: { beginner: 3, other: 5 }, reps: 10, rest_s: 90,
  },
};

// The names, in the order they are shown. Named lineages first within each
// discipline, the unnamed generic shapes after.
export const STYLE_DISCIPLINES = [...new Set(Object.values(STYLES).map(s => s.discipline))];

// How each style TALKS between the sets — attitude, intensity, the register
// the trainer standing there uses. Kept in lib/voices.js so this file stays
// about the session's shape; merged here so a style is one object.
for (const [key, voice] of Object.entries(STYLE_VOICES)) if (STYLES[key]) STYLES[key].voice = voice;

// ── The shelf, read out ────────────────────────────────────────────────────
// The founder: "I want to learn about where are they? Where can I find them?
// It should be like a quick button to push on them and I should have a brief
// description of each. What each one does."
//
// Everything needed to answer him already existed and was spread across three
// fields nobody could scan: `emphasis` is a sentence, `tradition` is a
// sentence, `provenance` is a sentence, and the panel set all three LARGER
// than the name of the style they describe. Twenty-four of those is not a
// list somebody browses; it is ten screens of uppercase prose.
//
// So one function builds the list, and BOTH the website and the connector
// read it. Two readers is how the styles somebody is SHOWN and the styles
// somebody is TOLD drift apart, and then neither is worth reading — the same
// rule that put `planRead` behind `my_plan` and the plan panel alike.
//
// `shape` is DERIVED from the same sets/reps/rest_s that designSession
// actually builds with, never written by hand. A hand-written "heavy triples"
// beside a style that builds fives is the drift this file exists to prevent,
// and it is the cheap end of the invented-number failure: a description of a
// session that is not the session.
const SHAPE_REST = s => s < 60 ? `${s}s rest` : `${Math.round(s / 60 * 10) / 10} min rest`.replace('.0 ', ' ');

export function styleShape(st, { terse = false } = {}) {
  if (!st) return null;
  const sets = typeof st.sets === 'object' ? (st.sets.other ?? st.sets.beginner) : st.sets;
  if (sets == null || st.reps == null) return null;
  const core = `${sets} × ${st.reps} · ${SHAPE_REST(Number(st.rest_s) || 60)}`;
  if (terse) return core;
  const bits = [core];
  if (st.long_conditioning) bits.push(`${Math.round(st.long_conditioning * 100)}% one long effort`);
  if (st.max_movements) bits.push(`${st.max_movements} movements`);
  if (st.finisher) bits.push(`${st.finisher.sets}-set finisher`);
  return bits.join(' · ');
}

/**
 * The short credit — the ONE place the words are put together, so the shelf,
 * the tradition workouts and the tool cannot phrase a person's name three
 * ways. Never a bare surname: "Arnold Schwarzenegger" beside a method reads as
 * authorship, and the lead-in is the whole difference between crediting a
 * tradition and claiming an endorsement.
 */
export function styleCredit(st) {
  return st?.lineage ? `in the tradition of ${st.lineage}` : null;
}

/**
 * A style said the way the card shows it: the method, then its credit in the
 * same breath. The founder wanted the credit "almost a headline", and a reply
 * is where an assistant's headline is — so the credit rides WITH the name,
 * never as a footnote after the description, and never without its lead-in:
 * "Golden-era volume bodybuilding, in the tradition of Arnold Schwarzenegger",
 * never "(Arnold Schwarzenegger)" and never "Arnold's workout". The method is
 * the product's; the person is the credit.
 */
export function creditedName(st) {
  const credit = st?.credit ?? styleCredit(st);
  return credit ? `${st.say}, ${credit}` : st.say;
}

/** The shelf read aloud, grouped by discipline, every credit said. */
export function shelfSay(groups) {
  return groups.map(g => `${g.discipline}: ${g.styles.map(creditedName).join('; ')}`).join('. ');
}

/**
 * Every style, in one shape, for every surface that lists them.
 *
 * Nothing here is a claim this file is not entitled to make: `does` is the
 * style's own emphasis, `shape` is computed from its own numbers, `tradition`
 * credits the lineage and `provenance` rides along — a style shown without its
 * provenance is the wink the doctrine forbids, so it travels with every entry
 * rather than being something a caller may choose to drop.
 *
 * NEVER A WEIGHT. Not here either: a list of styles is exactly where a
 * plausible-looking load would read as pedigree rather than invention.
 */
export function stylesList({ coach = null, recommended = null } = {}) {
  const rec = new Map((recommended?.marked || []).map(m => [m.key, m.because]));
  const items = Object.entries(STYLES).map(([key, st]) => ({
    key,
    say: st.say,
    discipline: st.discipline || 'Other',
    lineage: st.lineage || null,
    tradition: st.tradition || (st.lineage ? `in the tradition of ${st.lineage}` : null),
    credit: styleCredit(st),
    does: st.emphasis || null,
    shape: styleShape(st),
    shape_short: styleShape(st, { terse: true }),
    focus_default: st.focus_default || null,
    provenance: st.provenance || null,
    voice: st.voice
      ? { register: st.voice.register, intensity: st.voice.intensity, attitude: st.voice.attitude }
      : null,
    is_coach: coach != null && key === coach,
    recommended: rec.has(key),
    because: rec.get(key) || null,
  }));
  const by = [];
  for (const it of items) {
    const g = by.find(x => x.discipline === it.discipline);
    if (g) g.styles.push(it); else by.push({ discipline: it.discipline, styles: [it] });
  }
  return { count: items.length, disciplines: by, styles: items };
}

// ── Which of them suits you ────────────────────────────────────────────────
// The founder: "you should be able to like put a dot on there like a check
// box to see what your training style should recommend."
//
// The danger is the one this whole file is written around. A recommendation
// nobody computed is a recommendation the model INVENTED, and "this is the
// style for you" is a prescription. So every mark is produced by a rule
// reading a field the person actually filled in, it carries the fact that
// produced it, and it never claims to be the only answer.
//
// What it refuses to do, and each refusal has a precedent here:
//
// - **A thin record gets no dots**, and says what would produce them. The
//   same refusal progressionCall makes rather than inventing a working
//   weight: the honest answer to "which suits me" with nothing on file is
//   that nothing on file says.
// - **At most three.** A shelf where half the cards are ticked has said
//   nothing — the athlete read caps its recommendations for the same reason.
// - **It only ever ADDS a mark.** Nothing is drawn as a cross, a warning or a
//   colour meaning "wrong for you". A style somebody likes is theirs to pick
//   and the shelf is not a gate — `drop_goal`'s doctrine, one screen along.
//   The tier rule below therefore withholds a MARK; it never hides a style.
// - **A care flag silences it entirely**, exactly as it silences the athlete
//   read and every coaching alert. Choosing a training style is coaching.
// - **Never a load, here either.**

// What a person says their sport is, mapped onto the discipline that trains
// for it. Deliberately narrow: a sport it does not recognise produces no mark
// rather than a guess, because "you said hockey so here is a boxing camp" is
// the invented answer wearing a tick.
const SPORT_DISCIPLINE = [
  [/\bbox|fight|mma|muay|kickbox|sparring\b/i, 'Boxing'],
  [/\brun(ning|ner)?\b|\b5k\b|\b10k\b|marathon|jog|triathlon/i, 'Running'],
  [/\bpowerlift|\bmeet\b|squat.*bench.*deadlift/i, 'Powerlifting'],
  [/\bstrongman\b/i, 'Powerlifting'],
];

const setsOf = st => (typeof st.sets === 'object' ? (st.sets.other ?? st.sets.beginner) : st.sets);

// A beginner is never MARKED with a method built on going to failure, on
// max-effort singles and doubles, or on rests too short to keep form — the
// tier gate the movement library already applies, read off the style's own
// numbers rather than a hand-written tag that could drift from them.
function tooHard(st) {
  const sets = setsOf(st);
  if (sets === 1) return 'built on taking a set to failure';
  if (st.reps != null && st.reps <= 3) return 'built on max-effort singles and doubles';
  if (st.rest_s != null && st.rest_s < 45) return 'built on rests too short to hold form while learning it';
  return null;
}

/**
 * @param profile  the record: tier, train_days, equipment, track, sport
 * @param intent   'lose' | 'gain' | 'recomp' | null, off the body goal
 * @param flagged  true when a care flag stands — silences the whole read
 */
export function recommendStyles({ profile = {}, log = null, flagged = false } = {}) {

  const tier = profile.tier || null;
  const soften = flagged || tier === 'beginner';
  const days = Number(profile.train_days) || null;
  const kit = (profile.equipment || []).join(' ').toLowerCase();
  const sport = profile.sport || null;
  const hasKit = (profile.equipment || []).length > 0;

  // NOTHING ON FILE IS A REFUSAL, NOT A GUESS.
  const known = [sport, tier, days, hasKit || null, (log && log.sets >= 20) || null].filter(Boolean).length;
  if (!known) {
    return { marked: [], count: 0, thin: true,
      missing: ['your sport', 'how many days a week you train', 'how experienced you are', 'what kit you have'],
      say: 'Nothing on your record yet says which of these would suit you. Tell it your sport, how many days you train and what kit you have — or just train, and the shape of your own log starts marking them.' };
  }

  const out = [];
  const take = (key, because) => {
    if (out.length >= 3 || out.some(m => m.key === key)) return;
    const st = STYLES[key];
    if (!st) return;
    if (soften && tooHard(st)) return;           // withholds a mark, never the style
    out.push({ key, because });
  };
  const keysWhere = test => Object.keys(STYLES).filter(k => test(STYLES[k], k));

  // 1. THEIR SPORT, which is the strongest thing the record can say and the
  //    one that needs no interpretation at all.
  const disc = sport ? (SPORT_DISCIPLINE.find(([re]) => re.test(sport)) || [])[1] : null;
  if (disc) for (const k of keysWhere(st => st.discipline === disc)) {
    take(k, `${sport} is on your record, and this trains for it`);
  }

  // 2. THE KIT THEY OWN. A kettlebell method with no kettlebell is a session
  //    nobody can run — the same rule that makes the library match equipment.
  if (hasKit && /\bkettlebells?\b|\bkb\b/.test(kit)) {
    for (const k of keysWhere(st => st.discipline === 'Kettlebell')) take(k, 'you have kettlebells');
  }

  // 3. TWO DAYS A WEEK IS A CEILING, NEVER AMBITION. A method that only works
  //    on high frequency is the wrong thing to mark for somebody who told us
  //    they train twice — so the brief, capped ones are marked instead.
  if (days && days <= 2) {
    for (const k of keysWhere(st => st.max_movements != null || setsOf(st) === 1)) {
      take(k, `${days} session${days === 1 ? '' : 's'} a week — this one is built to be brief`);
    }
  }

  // 4. STARTING OUT. Simple, moderate reps, real rest — read off the numbers,
  //    and the failure/max-effort methods are already withheld above.
  if (tier === 'beginner') {
    for (const k of keysWhere(st => st.reps >= 5 && st.reps <= 10 && st.rest_s >= 90 && setsOf(st) <= 5)) {
      take(k, 'you are starting out, and this one is simple and unhurried');
    }
  }

  // 5. HOW THEY ALREADY TRAIN — the strongest thing the record itself says,
  //    because it is the only signal here made of what somebody DID rather
  //    than of what they once typed into a form. A log running at eights and
  //    twelves is a bodybuilding log whatever its owner calls it; a log of
  //    heavy triples is a powerlifting one. It needs enough sets to mean
  //    anything, and the middle of the range is deliberately SILENT — five to
  //    seven reps is everybody, and marking on it would be reading tea leaves.
  if (log && log.sets >= 20 && log.avg_reps != null) {
    const r = log.avg_reps;
    const band = r >= 8.5
      ? st => st.discipline === 'Bodybuilding' && st.reps >= 8
      : r <= 5.5
        ? st => st.discipline === 'Powerlifting' && st.reps <= 5
        : st => st.reps >= 5 && st.reps <= 8 && st.rest_s >= 90 && st.rest_s <= 180;
    for (const k of keysWhere(band)) {
      take(k, `your log runs at about ${Math.round(r)} reps a set, and this tradition is built in that band`);
    }
  }

  if (!out.length) {
    return { marked: [], count: 0,
      say: 'Nothing on your record picks between these yet — they are all a genuine choice.' };
  }
  return {
    marked: out,
    count: out.length,
    say: `${out.length} of ${Object.keys(STYLES).length} match what you have told us. They are a starting point, not a rule — any of the others is a real choice.`,
  };
}

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
  // A style may cap how many movements — "easy strength" is four and out —
  // never raise it: the clock is still the ceiling.
  const want = Math.min(movementCount(minutes), st?.max_movements ?? 7);
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
      // A running style gives most of the clock to one long steady effort;
      // otherwise a conditioning block is a fifth of the session.
      minutes: conditioning
        ? Math.max(8, Math.round((Number(minutes) || 45) * (st?.long_conditioning || 0.2)))
        : null,
      load_kg: null,
      rest_s: conditioning ? 60 : st ? st.rest_s : beginner ? 120 : 150,
      muscles: pick.muscles,
      // A beginner gets told why. An advanced lifter gets left alone.
      cue: tier === 'advanced' ? null : pick.cue,
    });
  }

  // A FINISHER changes the last lifting movement only — seven short-rest sets
  // on one movement is the method; seven sets on every movement is a different
  // and much worse session. Still capped for a beginner, like every set count.
  if (st?.finisher && !beginner) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].sets == null) continue;
      out[i].sets = st.finisher.sets;
      out[i].rest_s = st.finisher.rest_s;
      out[i].finisher = true;
      break;
    }
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
