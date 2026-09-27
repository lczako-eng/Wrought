// netlify/functions/lib/pictures.js
// Which drawing goes with an exercise name — decided here, stamped as an id.
//
// The page and the chat card never pick a picture from a name. The server
// stamps an id on each movement and they draw from the id, checked against the
// list of drawings that exist. So there is one place a "bench dip" can become a
// bench press picture, and it is this file, with a test on the rule that stops
// it.
//
// A WRONG PICTURE TEACHES THE WRONG MOVEMENT. So the lookup is biased the
// careful way: the curated library first (an exact name), then ordered word
// rules that decide the variant before the base movement, and when nothing is
// sure it returns NO picture. A treadmill walk and a walk in the park are both
// walks; only one of them is a treadmill.
//
// NEVER MERGED INTO exerciseKey OR muscleFor. Those three answer different
// questions with different safe errors — a key must over-split because it
// carries a load, a muscle may over-merge because it carries none, and a
// picture must refuse because it teaches. A test greps for the attempt.

import { exerciseKey } from './training.js';
import { MOVEMENTS } from './library.js';
import { PICTURE_IDS } from '../../../public/exercise-pictures.js';

// The thirty curated movements, each to its drawing. Some of the drawings are
// still pending; resolvePicture says which, pictureFor withholds them.
const LIBRARY_PICTURE = {
  'Back Squat': 'squat-barbell', 'Goblet Squat': 'squat-goblet', 'Front Squat': 'squat-front', 'Leg Press': 'leg-press',
  'Romanian Deadlift': 'rdl', 'Deadlift': 'deadlift', 'Hip Thrust': 'hip-thrust', 'Kettlebell Swing': 'kb-swing',
  'Bench Press': 'bench', 'Dumbbell Bench Press': 'bench-dumbbell', 'Press-Up': 'press-up', 'Dip': 'dip',
  'Overhead Press': 'press-standing', 'Seated Dumbbell Press': 'press-seated',
  'Barbell Row': 'row-bent', 'Dumbbell Row': 'row-dumbbell', 'Seated Cable Row': 'row-seated', 'Inverted Row': 'row-inverted',
  'Pull-Up': 'pull-up', 'Lat Pulldown': 'pulldown', 'Chin-Up': 'pull-up',
  'Walking Lunge': 'lunge', 'Bulgarian Split Squat': 'split-squat', 'Step-Up': 'step-up',
  "Farmer's Carry": 'carry', 'Plank': 'plank', 'Hanging Knee Raise': 'knee-raise', 'Ab Wheel': 'ab-wheel',
  'Rowing Machine': 'rower', 'Incline Walk': 'treadmill',
};

let exact = null;
const exactMap = () => {
  if (!exact) {
    exact = new Map();
    for (const m of MOVEMENTS) if (LIBRARY_PICTURE[m.name]) exact.set(exerciseKey(m.name), LIBRARY_PICTURE[m.name]);
  }
  return exact;
};

// Things that look like a drawn movement and are not one. Checked first.
// A reverse or rear-delt fly is the chest fly run BACKWARDS, a straight-arm
// pulldown never bends the elbow, a single-leg hinge stands on one leg, and a
// chest-supported or seal row lies on a pad — the nearest drawing for each
// teaches the opposite movement, so each gets none.
const STOP = /\b(turkish|get[\s-]?ups?|curls?|extensions?|(lateral|front|rear)[\s-]raises?|shrugs?|sissy|box[\s-]squats?|hack|side[\s-]planks?|chest[\s-]press(es)?|upright[\s-]rows?|(cable|dumbbell)[\s-]fl(y|ye|yes|ies)|pistol|jump[\s-]squats?|overhead[\s-]squats?|zercher|renegade|reverse|rear[\s-]delts?|straight[\s-]arms?|(single|one)[\s-]legs?|chest[\s-]supported|seal)\b/;

const has = (k, re) => re.test(k);

// Ordered: the variant is decided before the base movement, and the first
// rule that fits wins. `hammer` never matches on its own — it is a machine
// maker's word as often as a curl's.
function byRule(k) {
  if (has(k, STOP)) return null;
  if (has(k, /\bleg[\s-]press(es)?\b/)) return 'leg-press';
  if (has(k, /\b(carry|carries|farmers?)\b/)) return 'carry';
  if (has(k, /\blunges?\b/)) return 'lunge';
  if (has(k, /\b(bulgarian|split[\s-]squats?)\b/)) return 'split-squat';
  if (has(k, /\bstep[\s-]?ups?\b/)) return 'step-up';
  // A walk is only a treadmill when it says so. A walk in the park is outdoors.
  if (has(k, /\btreadmill\b/) || (has(k, /\bincline\b/) && has(k, /\bwalk(s|ing)?\b/))) return 'treadmill';
  if (has(k, /\b(rowing[\s-]machine|rower|erg|ergometer)\b/)) return 'rower';
  if (has(k, /\bpecs?\b/) || (has(k, /\bfl(y|ye|yes|ies)\b/) && has(k, /\bmachine\b/))) return 'fly-machine';
  // A shoulder press says press; an overhead squat or carry never matches it.
  if (has(k, /\b(press|presses|ohp)\b/) && has(k, /\b(overhead|military|shoulder|ohp)\b/)) {
    if (has(k, /\b(machine|smith|hammer[\s-]strength)\b/)) return 'press-machine';
    if (has(k, /\b(seated|dumbbell)\b/)) return 'press-seated';
    return 'press-standing';
  }
  if (has(k, /\bincline\b/) && has(k, /\b(press|presses|bench)\b/)) return 'bench-incline';
  // Before bench: a bench dip is a dip done off a bench.
  if (has(k, /\bdips?\b/)) return 'dip';
  if (has(k, /\bbench\b/)) return has(k, /\bdumbbell\b/) ? 'bench-dumbbell' : 'bench';
  if (has(k, /\b(push|press)[\s-]?ups?\b/)) return 'press-up';
  if (has(k, /\brows?\b/)) {
    if (has(k, /\binverted\b/)) return 'row-inverted';
    if (has(k, /\b(seated|machine|cable|hammer[\s-]strength)\b/)) return 'row-seated';
    if (has(k, /\b(dumbbell|one[\s-]arm|single[\s-]arm)\b/)) return 'row-dumbbell';
    return 'row-bent';
  }
  if (has(k, /\b(pulldowns?|pull[\s-]downs?|lat[\s-]pulls?)\b/)) return 'pulldown';
  if (has(k, /\b(pull|chin)[\s-]?ups?\b/)) return 'pull-up';
  if (has(k, /\b(rdls?|romanian|stiff[\s-]?leg(ged)?)\b/)) return 'rdl';
  if (has(k, /\bdeadlifts?\b/)) return 'deadlift';
  if (has(k, /\bhip[\s-]thrusts?\b/)) return 'hip-thrust';
  if (has(k, /\bswings?\b/)) return 'kb-swing';
  if (has(k, /\bfront[\s-]squats?\b/)) return 'squat-front';
  if (has(k, /\bgoblet\b/)) return 'squat-goblet';
  // Only a plain back squat: every other squat is its own movement.
  if (/^(back |smith |smith machine )?squats?$/.test(k)) return 'squat-barbell';
  if (has(k, /\bplanks?\b/)) return 'plank';
  if (has(k, /\b(knee|leg)[\s-]raises?\b|\bhanging\b/)) return 'knee-raise';
  if (has(k, /\b(ab[\s-]wheel|rollouts?|roll[\s-]outs?)\b/)) return 'ab-wheel';
  return null;
}

/**
 * The drawing a name resolves to, whether or not it is drawn yet:
 * { id, grain: 'exact' | 'pattern' } or null. `exact` is a curated library
 * movement; `pattern` is the movement pattern drawn with our own generic kit,
 * which is said on the card — "not your exact equipment".
 */
export function resolvePicture(nameOrKey) {
  const k = exerciseKey(nameOrKey);
  if (!k || k === 'unnamed') return null;
  const hit = exactMap().get(k);
  if (hit) return { id: hit, grain: 'exact' };
  const id = byRule(k);
  return id ? { id, grain: 'pattern' } : null;
}

/** The drawing to show, or null — never one that is still waiting to be drawn. */
export function pictureFor(nameOrKey) {
  const r = resolvePicture(nameOrKey);
  return r && PICTURE_IDS.includes(r.id) ? r : null;
}

/** The curated library's cue for an exact movement, or null. Never invented. */
export function libraryCue(nameOrKey) {
  const k = exerciseKey(nameOrKey);
  const m = MOVEMENTS.find(x => exerciseKey(x.name) === k);
  return m?.cue || null;
}
