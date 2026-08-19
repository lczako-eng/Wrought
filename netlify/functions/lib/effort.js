// lib/effort.js
// What the session cost, measured — and the cardio inside it counted apart.
//
// The founder: "when you start your workout you should officially start the
// heart rate during that period, during each exercise... and yesterday my
// treadmill stuff should be calculated, used as a statistic, a separate
// statistic."
//
// Three things, and all three are answerable from data ALREADY ARRIVING. No
// new sensor is needed for any of it:
//
//   1. THE SESSION HAS A CLOCK. wrought_sessions stores started_at and
//      ended_at, so "officially start" already happened — the window exists
//      and nothing was reading heart rate against it.
//   2. EVERY SET HAS A TIMESTAMP. wrought_sets.logged_at means the samples
//      between one set and the next belong to the exercise being done then.
//      That is per-exercise heart rate, from the grain the log already keeps.
//   3. A TREADMILL IS NOT A BENCH PRESS. Cardio inside a strength session is
//      real work and it is a different KIND of work — blending it into
//      "volume moved" makes both numbers meaningless. Same doctrine as a
//      shift not being a session, one level down.
//
// WHAT THIS NEVER DOES. Heart rate during training is a training statistic and
// is reported as one. Blood oxygen, respiratory rate and the rest of the
// clinical group are NOT interpreted here and never will be — a spo2 reading
// beside a workout invites "is that bad", and the honest answer to that is a
// doctor, never a fitness app. They are stored, shown as readings, and left
// alone. Nothing here diagnoses, and a heart rate is never read as a sign of
// anything except how hard that set was.

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const avg = xs => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Heart rate through a session, and through each exercise in it.
 *
 * @param session  { started_at, ended_at }
 * @param sets     rows with { exercise, logged_at }, oldest first
 * @param samples  wrought_metrics rows for heart_rate: { value, measured_at }
 */
export function sessionEffort({ session = null, sets = [], samples = [] } = {}) {
  const start = session?.started_at ? new Date(session.started_at).getTime() : null;
  if (!start) return { known: false, why: 'no session clock' };

  const end = session?.ended_at ? new Date(session.ended_at).getTime()
            : sets.length ? new Date(sets[sets.length - 1].logged_at).getTime()
            : Date.now();

  const inWindow = (samples || [])
    .map(s => ({ v: num(s.value), t: new Date(s.measured_at).getTime() }))
    .filter(s => s.v != null && s.t >= start && s.t <= end)
    .sort((a, b) => a.t - b.t);

  if (!inWindow.length) {
    return {
      known: false,
      window: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
      // Named rather than silent: "no heart rate" and "no watch on" look
      // identical on a screen, and only one of them is worth doing anything
      // about.
      why: 'nothing sent a heart rate inside this session — the window is right, the samples are missing',
    };
  }

  const vals = inWindow.map(s => s.v);
  const peak = Math.max(...vals);

  // PER EXERCISE, from the set clock. The samples between the first set of a
  // lift and the first set of the next one were taken while that lift was
  // being done — including its rest gaps, which is correct: the cost of a
  // heavy triple is partly what it does to you for the two minutes after.
  const marks = [];
  for (const s of sets) {
    const t = new Date(s.logged_at).getTime();
    if (!Number.isFinite(t)) continue;
    const last = marks[marks.length - 1];
    if (!last || last.exercise !== s.exercise) marks.push({ exercise: s.exercise, from: t, to: t });
    else last.to = t;
  }

  const byExercise = marks.map((m, i) => {
    // Up to the next exercise's first set, or the end of the session for the
    // last one. The first mark reaches back to the session start, because the
    // walk to the rack and the warm-up sets are part of what it cost.
    const from = i === 0 ? start : m.from;
    const to = i + 1 < marks.length ? marks[i + 1].from : end;
    const mine = inWindow.filter(s => s.t >= from && s.t <= to).map(s => s.v);
    if (!mine.length) return null;
    return {
      exercise: m.exercise,
      avg_hr: avg(mine),
      max_hr: Math.max(...mine),
      minutes: Math.max(1, Math.round((to - from) / 60000)),
      samples: mine.length,
    };
  }).filter(Boolean);

  const hardest = byExercise.length
    ? byExercise.reduce((a, e) => (e.max_hr > a.max_hr ? e : a), byExercise[0]) : null;

  return {
    known: true,
    avg_hr: avg(vals),
    max_hr: peak,
    samples: vals.length,
    minutes: Math.max(1, Math.round((end - start) / 60000)),
    window: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
    by_exercise: byExercise,
    ...(hardest ? { hardest: { exercise: hardest.exercise, max_hr: hardest.max_hr } } : {}),
    say: `Heart rate through the session: ${avg(vals)} average, ${peak} peak` +
         (hardest && byExercise.length > 1 ? ` — highest on ${hardest.exercise}.` : '.'),
    // Said every time, because a wrist reading during a set is a noisy
    // instrument and a number people over-read.
    caveat: 'From your watch, sampled during the session. A wrist reading moves with grip and cold hands as well as effort — read it as a trend across sessions, not as a score for one set.',
  };
}

// Movements measured in minutes rather than sets — the same test the routine
// editor uses, kept in one place so a treadmill is a treadmill on every screen.
const CARDIO_HINT = /\b(treadmill|walk(ing)?|run(ning)?|jog|bike|cycl|row(ing)? machine|erg|elliptical|stair|climber|ski\s?erg|swim|sled\s+(push|drag)|conditioning|cardio|incline)\b/i;

/**
 * A session split into the two kinds of work it actually contained.
 *
 * "Yesterday my treadmill stuff should be calculated as a separate statistic."
 * Exactly right, and for the same reason a shift is not a session: blending
 * twenty-five minutes of incline walking into "volume moved" makes the volume
 * number wrong and hides the cardio entirely. Two numbers, each honest.
 *
 * The split is by MOVEMENT, not by session — a session is very often both, and
 * calling the whole thing "a leg day" loses the treadmill that was half of it.
 */
export function splitWork({ sets = [], plan = [] } = {}) {
  const timed = new Set();
  for (const p of plan || []) {
    const isTimed = p?.minutes != null || (p?.sets == null && p?.reps == null) || CARDIO_HINT.test(String(p?.name || ''));
    if (isTimed) timed.add(String(p.name || '').toLowerCase());
  }

  const isCardio = name => timed.has(String(name || '').toLowerCase()) || CARDIO_HINT.test(String(name || ''));

  const strengthSets = [], cardioSets = [];
  for (const s of sets || []) (isCardio(s.exercise) ? cardioSets : strengthSets).push(s);

  const volume = rows => Math.round(rows.reduce((a, s) =>
    a + (num(s.weight_kg) || 0) * (num(s.reps) || 0), 0));

  const names = rows => [...new Set(rows.map(s => s.exercise))];

  // Minutes for the cardio come from the PLAN, because a treadmill walk's
  // length is the thing that defines it and a set row does not carry it.
  const cardioMinutes = (plan || [])
    .filter(p => isCardio(p?.name))
    .reduce((a, p) => a + (num(p.minutes) || 0), 0);

  return {
    strength: {
      sets: strengthSets.length,
      exercises: names(strengthSets),
      volume_kg: volume(strengthSets),
    },
    cardio: {
      entries: cardioSets.length,
      exercises: names(cardioSets).concat(
        (plan || []).filter(p => isCardio(p?.name) && !names(cardioSets)
          .some(n => n.toLowerCase() === String(p.name).toLowerCase())).map(p => p.name)),
      minutes: cardioMinutes || null,
    },
    mixed: strengthSets.length > 0 && (cardioSets.length > 0 || cardioMinutes > 0),
    say: (() => {
      const bits = [];
      if (strengthSets.length) bits.push(`${strengthSets.length} lifting sets${volume(strengthSets) ? `, ${volume(strengthSets).toLocaleString()}kg moved` : ''}`);
      if (cardioMinutes) bits.push(`${cardioMinutes} min cardio`);
      else if (cardioSets.length) bits.push(`${cardioSets.length} cardio ${cardioSets.length === 1 ? 'piece' : 'pieces'}`);
      return bits.join(' · ') || null;
    })(),
    note: 'Report these as TWO statistics, never one. Volume moved is a lifting number and minutes is a cardio number; a session total that blends them describes neither, and the treadmill disappears into it.',
  };
}
