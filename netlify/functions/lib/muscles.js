// lib/muscles.js
// Which muscles a lift trained, worked out from the lift's own name.
//
// THE BUG THIS CLOSES. `log_set` and `log` accepted a `muscles` array from the
// language model and wrote it to the row verbatim. Nothing on the server ever
// checked it against the exercise, even though `lib/library.js` has held the
// correct muscles for thirty movements all along. On the founder's own record
// that produced 33 sets of which SIX were right: the bench press filed three
// times as legs and glutes, the barbell row as core, the Romanian deadlift as
// core, and eight sets carrying no muscle at all.
//
// It is the invented-number failure in the one field nobody looks at — the
// same shape as the 2,600-calorie target and the 135lb read off a photograph.
// The model reached for a plausible value because the right one was never put
// in front of it, and the fix is never more forbidding: it is removing the
// vacuum.
//
// WHAT IT WAS COSTING. `weeklyVolume` — hard sets per muscle per week, the
// first question any qualified coach asks of a programme — counts these tags,
// so the volume panel was reporting that his bench press worked his legs.
// `focusCall`, the training matrix and `neglected_muscles` read the same
// field, and the eight untagged sets counted toward nothing at all.
//
// ── THE RULE THIS TURNS ON ─────────────────────────────────────────────────
//
// `exerciseKey` is deliberately OVER-SPLIT and must stay that way: a key that
// is too broad puts another lift's weight on the bar, which is how this
// product injures somebody. This function wants the OPPOSITE bias. Hammer
// Strength row, seated row machine and barbell row are three different loads
// and one back — and getting a muscle wrong costs a set counted in the wrong
// column of a weekly dose, with nothing prescribed from it and nothing going
// on a bar.
//
// Over-splitting is safe for a LOAD. Over-merging is safe for a MUSCLE. Same
// reasoning, inverted, because what the wrong answer costs is inverted. That
// is why this is a separate function and why it must never be folded into
// `exerciseKey` — there is a test that greps for the attempt.
//
// ── WHY TWO STAGES ─────────────────────────────────────────────────────────
//
// Running all thirty curated movements through `exerciseKey` gives a lookup
// table of thirty keys. Searching the founder's twelve real keys in it hits
// THREE. The nine misses are the machines and the treadmill rows carrying
// their setup in the name — `incline treadmill level 12 at 2 5 mph` will
// never be in anybody's table. So the curated table is the reference and goes
// first, and an ordered set of word rules over the key is what actually
// catches a machine nobody curated.
//
// IT NEVER INVENTS. A key nothing recognises falls back to whatever was
// reported, and with nothing reported it returns null — counted toward
// nothing and said out loud, never an empty array pretending to be an answer.
// Same refusal as a working weight with no history.

import { MOVEMENTS } from './library.js';
import { exerciseKey } from './training.js';

// The seven groups every read in the product counts, plus `full body`, which
// is a real stored value (the erg) rather than an eighth muscle. Nothing
// outside this vocabulary may ever reach a row: a typo'd muscle draws its own
// line in the volume panel and looks like a real finding.
export const MUSCLE_GROUPS = ['chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core'];
export const MUSCLE_VOCAB = [...MUSCLE_GROUPS, 'full body'];

// Built on first use rather than at module load. `exerciseKey` lives in
// training.js and training.js calls back into here, so the two modules form a
// cycle — harmless while every crossing happens inside a function, and a
// module-level `MOVEMENTS.map(exerciseKey)` would be exactly the top-level
// evaluation that is not.
let _library = null;
function library() {
  if (_library) return _library;
  _library = new Map();
  for (const m of MOVEMENTS) {
    const muscles = clean(m.muscles);
    if (muscles) _library.set(exerciseKey(m.name), muscles);
  }
  return _library;
}

// ── The word rules, in order. First match wins. ─────────────────────────────
//
// The order is load-bearing and two entries are here rather than where they
// read most naturally:
//
//   CARRY sits above CARDIO, because a Farmer's WALK is a loaded carry and
//   not a stroll — the same word that already needed a lookaround in
//   `TIMED_MOVEMENT`.
//
//   The LOWER-BODY rules sit above ARMS, because a leg extension and a leg
//   curl are not arm exercises.
//
// Word boundaries throughout: `row` must not match `rowing machine`, the same
// lesson as "run" inside "crunch". Keys arrive lowercased with punctuation
// already flattened to spaces by `exerciseKey`, hyphens surviving — so
// `pec-deck chest fly` still has a boundary after `pec`.
//
// `hammer` NEVER appears bare. The founder trains on Hammer Strength machines,
// and a bare `hammer` would file his machine row as an arm curl.
const RULES = [
  { test: /\bleg press\b/,                                                    muscles: ['legs', 'glutes'] },
  { test: /\b(carry|carries|farmer|farmers|suitcase|yoke)\b/,                 muscles: ['core', 'back', 'arms'] },
  { test: /\b(shoulder|shoulders|overhead|military|ohp|arnold)\b/,            muscles: ['shoulders', 'arms'] },
  { test: /\b(lateral raise|side raise|rear delt|delt|shrug|upright)\b/,      muscles: ['shoulders'] },
  { test: /\b(pec|pecs|fly|flye|flies|chest|bench|incline press|decline|dip|dips|crossover)\b/,
                                                                              muscles: ['chest', 'shoulders', 'arms'] },
  { test: /\b(rowing machine|rowing|erg|ergometer|concept ?2)\b/,             muscles: ['full body'] },
  { test: /\brows?\b/,                                                        muscles: ['back', 'arms'] },
  { test: /\b(pulldown|pull down|pull-up|pull up|pullup|chin-up|chin up|chinup|lat pull|face pull)\b/,
                                                                              muscles: ['back', 'arms'] },
  { test: /\b(deadlift|deadlifts|rdl|romanian|hip thrust|swing|swings|good morning|back extension|hyperextension|pull-through)\b/,
                                                                              muscles: ['legs', 'glutes', 'back'] },
  { test: /\b(squat|squats|lunge|lunges|step-up|step up|leg extension|leg curl|hamstring curl|calf|calves|hack|bulgarian|split squat|glute|thrust|kickback)\b/,
                                                                              muscles: ['legs', 'glutes'] },
  { test: /\b(curl|curls|tricep|triceps|bicep|biceps|pushdown|push down|skull|preacher|extension|extensions|kickbacks|wrist)\b/,
                                                                              muscles: ['arms'] },
  { test: /\b(plank|planks|crunch|crunches|sit-up|sit up|situp|abs?|abdominal|knee raise|leg raise|hollow|russian twist|oblique|obliques|dead bug|wheel|hanging)\b/,
                                                                              muscles: ['core'] },
  { test: /\b(push-up|push up|pushup|press-up|press up|burpee|burpees)\b/,    muscles: ['chest', 'shoulders', 'core'] },
  { test: /\b(treadmill|walk|walking|run|running|jog|jogging|stair|stairmaster|elliptical|bike|biking|cycle|cycling|spin|sprint|sprints|skipping|jump rope|hike|hiking)\b/,
                                                                              muscles: ['legs'] },
];

/**
 * Keep only real muscle names, deduped and in the canonical order.
 *
 * Returns null rather than [] for nothing usable — an empty array reads as
 * "this lift worked no muscles", which is a claim, where null is an absence.
 */
function clean(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  for (const m of list) {
    const v = String(m || '').trim().toLowerCase();
    if (MUSCLE_VOCAB.includes(v)) seen.add(v);
  }
  if (!seen.size) return null;
  return MUSCLE_VOCAB.filter(m => seen.has(m));
}

/**
 * What a lift worked, and where the answer came from.
 *
 * @param key       the stored `exercise_key` — already normalised by
 *                  `exerciseKey`, which the callers all have in hand.
 * @param reported  whatever the model passed, used only as a last resort.
 *
 * @returns { muscles, source } where source is one of:
 *   library  — an exact match against the curated thirty. The reference.
 *   pattern  — a word rule. Right at the muscle grain, deliberately coarse.
 *   reported — nothing recognised the key, so the model's tag stands. Flagged,
 *              because it is a guess and the reader deserves to know.
 *   unknown  — nothing recognised it and nothing usable was reported. Null.
 *
 * Pure: no database, no network, no clock. The harness pins every case
 * offline, which is the only way a decision like this stays pinned.
 */
export function muscleFor(key, reported = null) {
  const k = String(key || '').toLowerCase().trim();

  const exact = library().get(k);
  if (exact) return { muscles: exact, source: 'library' };

  if (k) {
    for (const r of RULES) {
      if (r.test.test(k)) return { muscles: clean(r.muscles), source: 'pattern' };
    }
  }

  const said = clean(reported);
  if (said) return { muscles: said, source: 'reported' };

  return { muscles: null, source: 'unknown' };
}

/**
 * The muscles to WRITE on a row: the derived answer, or what was reported.
 *
 * Callers store an array, and the column has always held one, so `unknown`
 * comes back as [] here rather than null — the absence is carried by `source`
 * on the response instead. Everything that reads the column already treats an
 * empty array as "no muscle on this set" and skips it.
 */
export function musclesForRow(key, reported = null) {
  return muscleFor(key, reported).muscles || [];
}

/**
 * The rows whose stored muscles disagree with what the derivation says.
 *
 * Pure, so the harness can pin the decision with no database — the 015
 * lesson, where the first test for `degradePlan` stubbed a sealed ES module
 * namespace, silently did nothing, and passed against the bug it guarded.
 *
 * THE ONE JUDGEMENT CALL, stated rather than buried. There is a standing rule
 * here that a save never silently rewrites real data to fit a theory — it is
 * why a treadmill genuinely programmed as 4×10 keeps its 4×10. This sweep
 * overwrites, and the distinction is that THESE TAGS WERE NEVER THEIRS:
 * nobody was asked for them and nobody has ever seen them. The model wrote
 * them unprompted while it was busy getting the weight and the reps right.
 *
 * So the bounds are tight:
 *   - only a `library` or `pattern` answer overwrites. An unrecognised key
 *     never touches a stored tag.
 *   - it can only correct or fill, NEVER empty a row.
 */
export function muscleFixes(rows = []) {
  const out = [];
  for (const r of rows || []) {
    const { muscles, source } = muscleFor(r.exercise_key, r.muscles);
    if (source !== 'library' && source !== 'pattern') continue;
    if (!muscles || !muscles.length) continue;
    const before = clean(r.muscles) || [];
    if (before.length === muscles.length && before.every((m, i) => m === muscles[i])) continue;
    out.push({ id: r.id, exercise_key: r.exercise_key, from: before, muscles, source });
  }
  return out;
}
