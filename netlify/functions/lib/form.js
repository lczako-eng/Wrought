// netlify/functions/lib/form.js
// Where the set went wrong, read from the record rather than guessed from thin air.
//
// The founder: "sometimes I do skip and the form goes out the window, and I
// think form is more important." He is right, and this is the one place in the
// product where being useful and being honest pull hardest against each other.
//
// THE RULE THAT SHAPES EVERY LINE BELOW: THIS CANNOT SEE YOU.
//
// There is no camera, no bar-speed sensor, no accelerometer on the bar. Any
// sentence of the form "your form is breaking down" is an assertion about
// something that was never observed — the same offence as reading a body-fat
// percentage off a photograph, and it would poison the credibility that every
// other number in this product depends on. So nothing here describes technique.
//
// What the record CAN carry is the shadow technique leaves behind: reps
// collapsing on the last set, effort climbing at a weight that used to be
// easy, a target missed the same way three weeks running, and — the most
// valuable of the four — the person's own words, said mid-set and kept.
//
// Every finding therefore ships with its EVIDENCE, and the evidence is always
// something the log actually contains. The verdict is a change to the training,
// never a claim about the lifter.

const MIN_SESSIONS = 3;

// Words people use about their own execution. Matched only to hand back what
// they said — never to conclude anything from it, and never medically.
const FORM_WORDS = /form|sloppy|rush|rushed|ugly|grind|grinding|bounce|bounced|cheat|swing|swung|arch|round|rounded|lost tightness|no control|technique/i;
const BODY_WORDS = /pain|hurt|tweak|twinge|pull|pulled|strain|sharp|shoulder|knee|back|elbow|hip|wrist/i;

/** One entry per exercise per session: the sets as they were performed, in order. */
function bySession(sets = []) {
  const out = new Map();
  for (const s of sets) {
    if (!s.exercise_key) continue;
    const id = `${s.exercise_key}::${s.session_id || s.local_date}`;
    if (!out.has(id)) out.set(id, {
      key: s.exercise_key, name: s.exercise, date: s.local_date,
      position: s.position ?? null, sets: [],
    });
    out.get(id).sets.push({
      n: Number(s.set_number) || 0,
      reps: s.reps == null ? null : Number(s.reps),
      weight: s.weight_kg == null ? null : Number(s.weight_kg),
      rpe: s.rpe == null ? null : Number(s.rpe),
      note: s.note || null,
    });
  }
  for (const v of out.values()) v.sets.sort((a, b) => a.n - b.n);
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The last set falling off a cliff, repeatedly.
 *
 * 8, 8, 8, 4 is not a bad day — it is a weight that only holds for three sets.
 * The honest reading is that the load is above where the person can keep the
 * pattern together to the end, and the fix is load, not exhortation. Requires
 * it to have happened repeatedly, because one collapsed set is a phone call, a
 * bad night, or someone taking the rack.
 */
function lastSetCollapse(sessions) {
  const usable = sessions.filter(s => s.sets.length >= 3 && s.sets.every(x => x.reps != null));
  if (usable.length < MIN_SESSIONS) return null;

  const recent = usable.slice(-4);
  const bad = recent.filter(s => {
    const first = s.sets[0].reps;
    const last = s.sets[s.sets.length - 1].reps;
    return first > 0 && (first - last) / first >= 0.3;
  });
  if (bad.length < 2) return null;

  const worst = bad[bad.length - 1];
  const first = worst.sets[0].reps;
  const last = worst.sets[worst.sets.length - 1].reps;
  const load = worst.sets[worst.sets.length - 1].weight;

  return {
    finding: 'last_set_collapse',
    exercise: worst.name,
    // The evidence, always. A verdict without the rows behind it is an opinion.
    evidence: `${bad.length} of the last ${recent.length} sessions ended well below where they started — most recently ${first} reps down to ${last}.`,
    verdict: load != null
      ? `Take about 10% off — ${Math.round(load * 0.9 * 4) / 4}kg — and finish all the sets at the same quality.`
      : 'Drop the load enough that the last set looks like the first one.',
    say: `${worst.name}: the last set is where it goes. ${bad.length} of your last ${recent.length} sessions dropped from ${first} to ${last}. ` +
         (load != null ? `Try ${Math.round(load * 0.9 * 4) / 4}kg and own every set.` : 'Take some weight off and own every set.'),
  };
}

/**
 * Same weight, harder every time.
 *
 * RPE climbing while the load stands still is the clearest thing in this file:
 * whatever is happening, that weight is costing more than it used to. It does
 * NOT say why — under-recovered, under-eating, technique drifting, a bad
 * fortnight at work — and it must not guess between them.
 */
function effortCreep(sessions) {
  const tops = sessions
    .map(s => {
      const rated = s.sets.filter(x => x.rpe != null && x.weight != null);
      if (!rated.length) return null;
      const heaviest = rated.reduce((a, b) => (b.weight > a.weight ? b : a), rated[0]);
      return { date: s.date, name: s.name, weight: heaviest.weight, rpe: heaviest.rpe };
    })
    .filter(Boolean);

  if (tops.length < MIN_SESSIONS) return null;

  const recent = tops.slice(-3);
  const sameLoad = recent.every(r => Math.abs(r.weight - recent[0].weight) < 0.01);
  if (!sameLoad) return null;

  const rise = recent[recent.length - 1].rpe - recent[0].rpe;
  if (rise < 1) return null;

  return {
    finding: 'effort_creep',
    exercise: recent[0].name,
    evidence: `${recent[0].weight}kg has gone from RPE ${recent[0].rpe} to RPE ${recent[recent.length - 1].rpe} across ${recent.length} sessions.`,
    verdict: 'Hold the weight and cut a set, or take a light week on it. Adding load on top of this is how a stall becomes a strain.',
    say: `${recent[0].name} at ${recent[0].weight}kg has gone from RPE ${recent[0].rpe} to ${recent[recent.length - 1].rpe} without the weight changing. Same load, more cost — hold it or back off, do not add.`,
  };
}

/**
 * Grinding: at or above RPE 9 and still short of the target.
 *
 * The combination is what matters. Missing reps at RPE 7 means the weight is
 * wrong; missing them at RPE 9.5 means it is well past where anything is being
 * practised except failure.
 */
function grinding(sessions, targetReps = null) {
  const recent = sessions.slice(-3);
  if (recent.length < 2) return null;

  const hard = recent.filter(s => s.sets.some(x => (x.rpe ?? 0) >= 9 &&
    targetReps != null && x.reps != null && x.reps < targetReps));
  if (hard.length < 2) return null;

  return {
    finding: 'grinding',
    exercise: recent[recent.length - 1].name,
    evidence: `${hard.length} of the last ${recent.length} sessions had sets at RPE 9 or above that still came in under ${targetReps} reps.`,
    verdict: `Back the load off until ${targetReps} is reachable with one left in the tank, then build again from there.`,
    say: `${recent[recent.length - 1].name}: you are grinding — RPE 9 and still short of ${targetReps}, ${hard.length} sessions running. Come down to a weight you can finish, then climb.`,
  };
}

/**
 * What they said at the time, handed straight back.
 *
 * The most valuable thing in here and the least clever. A notebook has a column
 * for weight and a column for reps and nowhere at all for "third set I rushed
 * it" — so the one fact that explains the number is the one paper cannot hold.
 * It is quoted, never interpreted: WROUGHT does not know what their form looked
 * like and does not get to decide what the words meant.
 */
function ownWords(sets = []) {
  const said = sets
    .filter(s => s.note && (FORM_WORDS.test(s.note) || BODY_WORDS.test(s.note)))
    .slice(-6)
    .map(s => ({
      exercise: s.exercise,
      date: s.local_date,
      note: s.note,
      // Body words are flagged so the model treats them as a person's report of
      // their own body rather than a coaching cue. Not a diagnosis either way.
      about_body: BODY_WORDS.test(s.note) && !FORM_WORDS.test(s.note),
    }));
  return said.length ? said : null;
}

/**
 * The whole read for a lift, or for everything.
 *
 * Deliberately quiet. With nothing to say it says nothing, because a coach who
 * finds a fault every session is one people stop listening to — and because
 * inventing a finding is exactly the failure this file is built to avoid.
 */
export function formWatch({ sets = [], targetReps = null, exerciseKey = null } = {}) {
  const rows = exerciseKey ? sets.filter(s => s.exercise_key === exerciseKey) : sets;
  if (!rows.length) {
    return {
      known: false,
      say: 'No sets logged yet, so there is nothing to read. Log a few sessions and the pattern shows up on its own.',
    };
  }

  const byKey = new Map();
  for (const s of rows) {
    if (!byKey.has(s.exercise_key)) byKey.set(s.exercise_key, []);
    byKey.get(s.exercise_key).push(s);
  }

  const findings = [];
  for (const [, lift] of byKey) {
    const sessions = bySession(lift);
    for (const f of [lastSetCollapse(sessions), effortCreep(sessions), grinding(sessions, targetReps)]) {
      if (f) findings.push(f);
    }
  }

  const words = ownWords(rows);

  return {
    known: true,
    sessions_read: bySession(rows).length,
    findings,
    your_words: words,
    // The line that has to survive every future edit of this file.
    limits: 'WROUGHT cannot see you lift. Nothing here is an assessment of your technique — it is what your own log shows, and what to change about the training because of it.',
    say: findings.length
      ? findings.map(f => f.say).join(' ')
      : 'Nothing in the log is coming apart. Sets are finishing where they should.',
    note: findings.length
      ? 'Deliver the findings with their evidence — the rows are what makes this credible rather than a guess. NEVER say their form is breaking down or that they are doing a lift wrong: nothing here watched them. Say what the record shows and what to change about the load.'
      : 'Say it in one line and move on. Do not hunt for something to correct.',
  };
}
