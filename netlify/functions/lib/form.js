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
// Exported so log_set can mark a set's words as a report about a body at the
// moment they arrive — the doctor's question, flagged where it is said.
export const BODY_WORDS = /pain|hurt|tweak|twinge|pull|pulled|strain|sharp|shoulder|knee|back|elbow|hip|wrist/i;

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

// ── Cardio: the progression a lifting log has no shape for ──────────────────
//
// The founder: "I've been running about a month straight and today was my best
// run yet, because I pay attention to it. I need that progression. I need to
// see it. I need to see where my walls are."
//
// progressionCall answers this for a barbell and cannot answer it for a run —
// there is no top set, no double progression, no load to add. What a run has is
// PACE, and pace is the number that stalls in a way somebody can feel and not
// name. So this reads distance, duration and pace out of the workout events a
// watch already sends, and answers the two questions actually being asked:
// was today the best one, and is the line going the right way.
//
// Same rule as everything else in this file: it reports what the record holds.
// It does not know why a run was slow — heat, hills, sleep, a heavy week — and
// it does not guess between them.

const KIND_OF = name => {
  const s = String(name || '').toLowerCase();
  if (/swim/.test(s)) return 'swim';
  if (/cycl|bike|ride|spin/.test(s)) return 'ride';
  if (/walk|hik/.test(s)) return 'walk';
  if (/run|jog|treadmill/.test(s)) return 'run';
  return null;
};

const paceSay = minPerKm => {
  if (minPerKm == null) return null;
  const m = Math.floor(minPerKm);
  const sec = Math.round((minPerKm - m) * 60);
  return `${m}:${String(sec).padStart(2, '0')}/km`;
};

/**
 * Runs, rides, swims and walks read as a progression.
 *
 * `workouts` are wrought_events rows of type 'workout' with detail carrying
 * distance_km and minutes — which is exactly what the HealthKit courier sends.
 */
export function cardioProgress(workouts = [], { kind = null } = {}) {
  const rows = workouts
    .map(w => {
      const d = w.detail || {};
      const k = KIND_OF(d.source_name || w.summary || d.kind);
      const km = Number(d.distance_km);
      const mins = Number(d.minutes);
      if (!k || !(km > 0) || !(mins > 0)) return null;
      return {
        kind: k, date: w.local_date, km: Math.round(km * 100) / 100,
        minutes: Math.round(mins), pace: mins / km,
        avg_hr: d.avg_hr ?? null,
      };
    })
    .filter(Boolean)
    .filter(r => !kind || r.kind === kind)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length < 2) {
    return {
      known: false, sessions: rows.length,
      say: rows.length
        ? 'One session with distance and time on it. A second one and the progression starts to mean something.'
        : 'No runs, rides or swims with both a distance and a duration on them yet.',
    };
  }

  const byKind = new Map();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }

  const reads = [];
  for (const [k, list] of byKind) {
    if (list.length < 2) continue;
    const latest = list[list.length - 1];
    const prior = list.slice(0, -1);

    // A personal best is over COMPARABLE distance. Beating your 5k pace on a
    // 1k sprint is not a better run, and calling it one is how the number
    // stops being believed.
    const similar = prior.filter(r => Math.abs(r.km - latest.km) / latest.km <= 0.2);
    const bestPace = similar.length ? Math.min(...similar.map(r => r.pace)) : null;
    const bestEver = Math.min(...prior.map(r => r.pace));
    const longest = Math.max(...prior.map(r => r.km));

    const paceBest = bestPace != null && latest.pace < bestPace;
    const distBest = latest.km > longest;

    // The trend: first third against last third, so one good day cannot carry
    // it and one bad day cannot sink it.
    const third = Math.max(1, Math.floor(list.length / 3));
    const early = list.slice(0, third);
    const late = list.slice(-third);
    const avg = a => a.reduce((x, r) => x + r.pace, 0) / a.length;
    const shift = avg(early) - avg(late);
    const shiftPct = Math.round((shift / avg(early)) * 1000) / 10;

    reads.push({
      kind: k,
      sessions: list.length,
      latest: { date: latest.date, km: latest.km, minutes: latest.minutes,
                pace: paceSay(latest.pace), avg_hr: latest.avg_hr },
      best_pace_over_similar: bestPace != null ? paceSay(bestPace) : null,
      longest_km: Math.round(Math.max(longest, latest.km) * 100) / 100,
      personal_best: paceBest || distBest,
      trend_pct: shiftPct,
      say: (paceBest
              ? `Best ${k} yet over that distance — ${latest.km}km at ${paceSay(latest.pace)}, past your ${paceSay(bestPace)}.`
            : distBest
              ? `Longest ${k} yet — ${latest.km}km at ${paceSay(latest.pace)}.`
            : `${latest.km}km at ${paceSay(latest.pace)}.`) +
           (Math.abs(shiftPct) < 1.5
              ? ` Pace is flat across ${list.length} sessions — that is the wall.`
              : shiftPct > 0
                ? ` Pace is ${shiftPct}% quicker than when you started, across ${list.length} sessions.`
                : ` Pace is ${Math.abs(shiftPct)}% slower than when you started, across ${list.length} sessions.`),
    });
  }

  if (!reads.length) {
    return { known: false, sessions: rows.length,
             say: 'Not enough of any one kind yet — two runs, or two rides, and the line starts.' };
  }

  return {
    known: true,
    sessions: rows.length,
    reads,
    personal_best: reads.some(r => r.personal_best),
    say: reads.map(r => r.say).join(' '),
    note: 'A personal best is compared over a SIMILAR distance — beating a 5k pace on a 1km sprint is not a better run. Say a best out loud when there is one; it is the whole reason somebody keeps going out. A flat pace is information, not a failure, and must not be delivered as one — WROUGHT does not know whether it was heat, hills, sleep or a heavy week, and must not guess.',
  };
}
