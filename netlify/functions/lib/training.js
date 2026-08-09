// netlify/functions/lib/training.js
// Progression, energy balance, and the arithmetic behind a live session.
//
// Same rule as the rest of the system: the server decides, the model relays.
// "Put 95 on the bar" is a calculation with a defensible rule behind it, not a
// language model's impression of what sounds encouraging. If an LLM freelances
// the loading, it will cheerfully add 20kg to someone's squat one day and the
// product will have hurt them.

import { supabase, daysBetween } from './wrought.js';

// ── Matching an exercise across time ────────────────────────────────────────
// "Barbell Bench Press", "bench press", "Bench (BB)" and "benching" are one
// exercise. If they don't collapse to the same key, last week's number is
// invisible, progression silently stops, and nobody notices for a month
// because the app still looks like it's working.

const NOISE = /\b(barbell|bb|dumbbell|db|machine|cable|smith|seated|standing|incline|decline|flat|close[- ]?grip|wide[- ]?grip|reverse|single[- ]?arm|one[- ]?arm|alternating|weighted|assisted)\b/g;

const SYNONYM = {
  'bench': 'bench press', 'benching': 'bench press', 'chest press': 'bench press',
  'squat': 'squat', 'squatting': 'squat', 'back squat': 'squat', 'front squat': 'squat',
  'dead': 'deadlift', 'deads': 'deadlift', 'deadlifting': 'deadlift',
  'ohp': 'overhead press', 'shoulder press': 'overhead press', 'military press': 'overhead press',
  'press': 'overhead press',
  'pull up': 'pull-up', 'pullup': 'pull-up', 'chin up': 'pull-up', 'chinup': 'pull-up',
  'row': 'row', 'bent over row': 'row',
  'rdl': 'romanian deadlift', 'romanian': 'romanian deadlift',
  'curl': 'curl', 'bicep curl': 'curl', 'biceps curl': 'curl',
  'lat pulldown': 'pulldown', 'pulldown': 'pulldown', 'pull down': 'pulldown',
  'leg press': 'leg press', 'lunge': 'lunge',
  'dip': 'dip', 'tricep extension': 'tricep extension',
};

export function exerciseKey(name) {
  let s = String(name || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (SYNONYM[s]) return SYNONYM[s];
  // Singularise a trailing plural so "curls" finds "curl".
  const singular = s.replace(/s$/, '');
  if (SYNONYM[singular]) return SYNONYM[singular];
  return s || 'unnamed';
}

// Lower-body lifts take bigger jumps than upper — 2.5kg on a bench is a real
// step, 2.5kg on a squat is rounding error.
const LOWER = /squat|deadlift|leg press|lunge|hip thrust|romanian|calf|hack/;
export const loadStep = (key, tier) => {
  const big = LOWER.test(key);
  if (tier === 'beginner')  return big ? 5   : 2.5;
  if (tier === 'advanced')  return big ? 2.5 : 1.25;
  return big ? 5 : 2.5;
};

// ── What happened last time ─────────────────────────────────────────────────

export async function lastPerformance(userId, key) {
  const { data } = await supabase.from('wrought_sets')
    .select('exercise, reps, weight_kg, rpe, local_date, session_id')
    .eq('user_id', userId).eq('exercise_key', key)
    .order('logged_at', { ascending: false }).limit(24);

  if (!data?.length) return null;

  // Only the most recent session's sets — comparing today against a mixture of
  // the last four weeks is how you end up chasing a number from a good day you
  // will not repeat.
  const lastDate = data[0].local_date;
  const sets = data.filter(s => s.local_date === lastDate);

  const best = sets.reduce((a, s) =>
    (Number(s.weight_kg) || 0) > (Number(a.weight_kg) || 0) ? s : a, sets[0]);

  return {
    date: lastDate,
    sets: sets.length,
    top_weight_kg: best.weight_kg != null ? Number(best.weight_kg) : null,
    top_reps: best.reps != null ? Number(best.reps) : null,
    rpe: best.rpe != null ? Number(best.rpe) : null,
    all: sets.map(s => ({ reps: s.reps, weight_kg: s.weight_kg, rpe: s.rpe })),
  };
}

// ── What to put on the bar ──────────────────────────────────────────────────
// Double progression: hit the top of the rep range with something left in the
// tank, then and only then add load. It is unglamorous, it is what actually
// works, and it is the rule that keeps a machine from writing cheques a body
// cannot cash.

export function progressionCall({ last, targetReps, tier = 'intermediate', key = '' }) {
  if (!last || last.top_weight_kg == null) {
    return {
      verdict: 'find_working_weight',
      weight_kg: null,
      say: tier === 'beginner'
        ? `First time on this one — start light enough that the last rep of ${targetReps} still looks clean, and tell me what you used. That becomes the baseline.`
        : `No history for this yet. Pick your usual working weight for ${targetReps} and log it — everything after this compares against it.`,
    };
  }

  const step = loadStep(key, tier);
  const hitTarget = (last.top_reps ?? 0) >= targetReps;
  const hard = (last.rpe ?? 0) >= 9;

  if (hitTarget && !hard) {
    const next = Math.round((last.top_weight_kg + step) * 4) / 4;
    return {
      verdict: 'add_load', weight_kg: next, previous_kg: last.top_weight_kg, step,
      say: `${next}kg. You had ${last.top_weight_kg} for ${last.top_reps} on ${last.date}${last.rpe ? ` at RPE ${last.rpe}` : ''}, so there's room.`,
    };
  }
  if (hitTarget && hard) {
    return {
      verdict: 'hold', weight_kg: last.top_weight_kg, previous_kg: last.top_weight_kg,
      say: `Same ${last.top_weight_kg}kg. You got the reps last time but it was close to failure — own the weight before adding to it.`,
    };
  }
  const missedBy = targetReps - (last.top_reps ?? 0);
  if (missedBy >= 3) {
    const back = Math.round((last.top_weight_kg * 0.9) * 4) / 4;
    return {
      verdict: 'deload', weight_kg: back, previous_kg: last.top_weight_kg,
      say: `Drop to ${back}kg. You were ${missedBy} reps short at ${last.top_weight_kg} — that weight isn't ready yet, and grinding it again just buys another bad session.`,
    };
  }
  return {
    verdict: 'repeat', weight_kg: last.top_weight_kg, previous_kg: last.top_weight_kg,
    say: `${last.top_weight_kg}kg again. You were ${missedBy} rep${missedBy === 1 ? '' : 's'} short last time — finish the job before moving up.`,
  };
}

// ── Tiers ───────────────────────────────────────────────────────────────────
// The difference between a beginner and an advanced lifter is not how hard the
// session is. It is how much gets explained, and how little gets assumed.

export const TIERS = {
  beginner: {
    sets: '2-3', reps: '8-12', rest_s: 90,
    doctrine: 'Compound lifts only, machines and dumbbells welcome. Explain every movement in one plain line — what it works and what it should feel like. Prescribe RPE, never a number off the internet: "the last rep should be hard but clean". Three exercises is a complete session. Do not use jargon without unpacking it once.',
  },
  intermediate: {
    sets: '3-4', reps: '6-10', rest_s: 120,
    doctrine: 'Assume they know the lifts. Name the exercise, sets, reps and load, and get out of the way. Cue only what their own history says they struggle with.',
  },
  advanced: {
    sets: '4-6', reps: '3-8', rest_s: 180,
    doctrine: 'Talk in their language. Smaller load jumps, tighter RPE targets, accessory work chosen against the specific lagging lift the log shows. No explanation unless asked.',
  },
};

// ── Calories out ────────────────────────────────────────────────────────────
// Mifflin-St Jeor, which is the standard clinical estimate and still an
// estimate — real resting metabolism varies by hundreds of calories between
// two people of identical size. It is reported as approximate every single
// time, because a number this soft presented as fact is how someone ends up
// eating 400 calories a day less than they should.

export function restingBurn(profile, weightKg) {
  const w = Number(weightKg), h = Number(profile.height_cm);
  const year = profile.birth_year ? Number(profile.birth_year) : null;
  if (!w || !h || !year) {
    return { kcal: null, missing: [
      !w ? 'a recent weigh-in' : null,
      !h ? 'height' : null,
      !year ? 'birth year' : null,
    ].filter(Boolean) };
  }

  const age = 2026 - year;
  const base = 10 * w + 6.25 * h - 5 * age;
  const sex = String(profile.sex || '').toLowerCase();

  // Sex is optional and free text. When it is absent, the midpoint of the two
  // constants is used and flagged — better than silently assuming, and better
  // than refusing to answer at all.
  const male = /^m|man|male/.test(sex);
  const female = /^f|woman|female/.test(sex);
  const offset = male ? 5 : female ? -161 : -78;

  return {
    kcal: Math.round(base + offset),
    approximate: !male && !female,
    missing: [],
  };
}

// Standard activity multipliers over resting burn. Not invented here — this is
// the arithmetic every dietitian uses, and it is only ever a fallback for when
// nothing is measuring the day.
export const ACTIVITY = {
  sedentary:   { mult: 1.2,   say: 'desk job, little walking' },
  light:       { mult: 1.375, say: 'on your feet some of the day' },
  moderate:    { mult: 1.55,  say: 'moving most of the day' },
  active:      { mult: 1.725, say: 'on your feet all day' },
  very_active: { mult: 1.9,   say: 'physical job, heavy work' },
};

export function energyBalance({ profile, weightKg, caloriesIn, activeCalories, foodEstimated }) {
  const rest = restingBurn(profile, weightKg);

  if (rest.kcal == null) {
    return {
      known: false, missing: rest.missing,
      say: `Calories out needs ${rest.missing.join(' and ')} before it can be worked out. Everything else still tracks.`,
    };
  }

  const measured = Number(activeCalories) || 0;
  const level = ACTIVITY[profile.activity_level];

  // A measurement always beats a multiplier. But with neither, "calories out"
  // was the resting figure alone — which counts a day of work as nothing and
  // produces a deficit that is wrong in the dangerous direction, because it
  // tells somebody to eat less than they need.
  const active = measured > 0
    ? measured
    : level ? Math.round(rest.kcal * (level.mult - 1)) : 0;
  const activeSource = measured > 0 ? 'device' : level ? 'activity_level' : 'none';

  const out = rest.kcal + active;
  const inn = Number(caloriesIn) || 0;
  const net = inn - out;

  return {
    known: true,
    calories_in: inn,
    resting_burn: rest.kcal,
    active_burn: active,
    calories_out: out,
    net,
    direction: net < -150 ? 'deficit' : net > 150 ? 'surplus' : 'maintenance',
    // ~7,700 kcal a kilo. A projection, not a promise, and worded as one.
    projected_kg_per_week: Math.round((net * 7 / 7700) * 100) / 100,
    approximate: true,
    resting_approximate: rest.approximate,
    active_source: activeSource,
    say: `Roughly ${inn} in, about ${out} out (${rest.kcal} at rest${
      activeSource === 'device' ? ` plus ${active} your watch measured`
      : activeSource === 'activity_level' ? ` plus about ${active} for ${ACTIVITY[profile.activity_level].say}`
      : ''}) — ` +
         (net < -150 ? `around ${Math.abs(net)} down on the day.`
        : net > 150  ? `around ${net} over.`
        : `about level.`) +
         (foodEstimated ? ' Food is estimated from what you described, so treat it as a direction, not a measurement.' : '') +
         // Silence here would be the dangerous kind: a burn counting only the
         // resting figure looks like a bigger deficit than the day really had.
         (activeSource === 'none'
           ? ' NOTE: nothing is counting your movement — this is your resting burn only, so the real figure is higher and the deficit smaller than it looks. Set an activity level or connect a phone to fix it.'
           : ''),
    caveat: 'Both halves are estimates. Resting burn varies by hundreds of calories between people the same size, and described meals are inferred. Use the weekly trend on the scale to correct it, never a single day.',
  };
}

// ── Device matrices ─────────────────────────────────────────────────────────
// The training matrix works because a muscle group either got worked or it did
// not, and the eye reads a gap instantly. Everything the watch collects wants
// the same treatment — but it needs a second scale, because the two halves of
// training mean opposite things.
//
//   EFFORT RUNS HOT.  Steps, active calories, volume. More is more work, so it
//                     climbs the forge scale. Hotter = harder.
//   RECOVERY RUNS COOL. Sleep, HRV, resting heart rate. These are temper blue —
//                     the colour steel turns when it is drawn back from
//                     hardness so it bends instead of snapping. Deeper = better
//                     recovered.
//
// Using one scale for both would be a lie: a red-hot resting heart rate row
// would read as a good week when it means the opposite. Two vocabularies,
// because there are genuinely two things being said.
//
// Bands are computed against the person's own range, not a population. Nobody
// needs to know how their HRV compares to a stranger's; they need to know
// whether last night was good *for them*.

const RECOVERY_METRICS = {
  sleep_minutes: { label: 'Sleep',      better: 'high' },
  hrv:           { label: 'HRV',        better: 'high' },
  resting_hr:    { label: 'Resting HR', better: 'low'  },
};

const EFFORT_METRICS = {
  steps:           { label: 'Steps',     better: 'high' },
  active_calories: { label: 'Move',      better: 'high' },
  volume_kg:       { label: 'Volume',    better: 'high' },
};

// Five bands, 0-4, against this person's own spread. A flat metric returns the
// middle band throughout rather than inventing contrast that is not there.
function band(value, min, max, better) {
  if (value == null) return null;
  if (max - min < 1e-9) return 2;
  const t = (value - min) / (max - min);
  const scaled = better === 'low' ? 1 - t : t;
  return Math.max(0, Math.min(4, Math.round(scaled * 4)));
}

export function deviceMatrix(days, { metrics = null } = {}) {
  const want = metrics || { ...RECOVERY_METRICS, ...EFFORT_METRICS };
  const rows = [];

  for (const [key, meta] of Object.entries(want)) {
    const values = days.map(d => (d[key] == null ? null : Number(d[key])));
    const present = values.filter(v => v != null);
    if (present.length < 3) continue;                 // too sparse to read

    const min = Math.min(...present), max = Math.max(...present);
    const avg = present.reduce((a, b) => a + b, 0) / present.length;

    rows.push({
      metric: key,
      label: meta.label,
      scale: key in RECOVERY_METRICS ? 'recovery' : 'effort',
      better: meta.better,
      min: Math.round(min), max: Math.round(max), avg: Math.round(avg),
      coverage: Math.round((present.length / days.length) * 100),
      cells: days.map((d, i) => ({
        date: d.date,
        value: values[i],
        band: band(values[i], min, max, meta.better),
      })),
    });
  }

  return {
    days: days.map(d => d.date),
    rows,
    say: rows.length
      ? `${rows.length} metric${rows.length === 1 ? '' : 's'} tracked across ${days.length} days.`
      : 'No device data in this stretch — connect a watch and this fills in on its own.',
  };
}

// ── The week you actually live ──────────────────────────────────────────────
// Averages hide the shape of a life. "You sleep 6h48m" is useless; "you sleep
// five and a half hours on Sunday nights and it wrecks every Monday" is a thing
// somebody can act on. Only visible once there are enough weeks to average.

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayPattern(days, { minWeeks = 2 } = {}) {
  const buckets = DOW.map(() => ({ sleep: [], steps: [], calories: [], sessions: 0, count: 0 }));

  for (const d of days) {
    const idx = (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7;   // Monday = 0
    const b = buckets[idx];
    b.count++;
    if (d.sleep_minutes) b.sleep.push(d.sleep_minutes);
    if (d.steps) b.steps.push(d.steps);
    if (d.calories) b.calories.push(d.calories);
    if (d.sessions) b.sessions++;
  }

  const enough = buckets.every(b => b.count >= minWeeks);
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  const rows = buckets.map((b, i) => ({
    day: DOW[i],
    sleep_minutes: b.sleep.length ? Math.round(mean(b.sleep)) : null,
    steps: b.steps.length ? Math.round(mean(b.steps)) : null,
    calories: b.calories.length ? Math.round(mean(b.calories)) : null,
    trained_pct: b.count ? Math.round((b.sessions / b.count) * 100) : 0,
    weeks: b.count,
  }));

  if (!enough) {
    return { rows, enough: false, findings: [],
      say: 'A few more weeks and the shape of your week starts showing.' };
  }

  const findings = [];

  const slept = rows.filter(r => r.sleep_minutes != null);
  if (slept.length >= 5) {
    const worst = slept.reduce((a, r) => (r.sleep_minutes < a.sleep_minutes ? r : a));
    const best  = slept.reduce((a, r) => (r.sleep_minutes > a.sleep_minutes ? r : a));
    const gap = best.sleep_minutes - worst.sleep_minutes;
    if (gap >= 45) {
      findings.push({
        kind: 'sleep',
        say: `${worst.day} is your worst night — about ${Math.round(worst.sleep_minutes / 60 * 10) / 10}h against ${Math.round(best.sleep_minutes / 60 * 10) / 10}h on ${best.day}.`,
      });
    }
  }

  const never = rows.filter(r => r.trained_pct === 0);
  if (never.length && never.length < 5) {
    findings.push({
      kind: 'training',
      say: `You have never trained on ${never.map(r => r.day).join(' or ')} in this stretch.`,
    });
  }

  const fed = rows.filter(r => r.calories != null);
  if (fed.length >= 5) {
    const heaviest = fed.reduce((a, r) => (r.calories > a.calories ? r : a));
    const avg = fed.reduce((a, r) => a + r.calories, 0) / fed.length;
    if (heaviest.calories - avg > 350) {
      findings.push({
        kind: 'food',
        say: `${heaviest.day} runs about ${Math.round(heaviest.calories - avg)} calories above your other days.`,
      });
    }
  }

  return {
    rows, enough: true, findings,
    say: findings.length ? findings[0].say : 'Your week is fairly even, which is rarer than you would think.',
  };
}

// ── Order ───────────────────────────────────────────────────────────────────
// Whatever goes first gets the freshest nervous system. Everybody in a gym
// knows this vaguely; almost nobody can tell you what it costs them, because
// no app stores where in the session a lift happened.
//
// This one does, so the question becomes answerable with arithmetic: your bench
// is not stalling, it is just always going third, and it costs you 5kg when it
// does. That is a fix worth more than any programme change.

const COMPOUND = /squat|deadlift|bench press|overhead press|row|pull-up|dip|lunge|leg press|hip thrust|clean|snatch|romanian/;
const ISOLATION = /curl|extension|raise|fly|pushdown|pulldown|calf|shrug|abduction|kickback/;

// A safety net over whatever assembled the session. Big compounds first, then
// everything else, then isolation — the ordering that is correct often enough
// that violating it should be deliberate rather than accidental.
export function orderPlan(plan) {
  const rank = e => {
    const k = e.key || exerciseKey(e.name);
    if (COMPOUND.test(k)) return 0;
    if (ISOLATION.test(k)) return 2;
    return 1;
  };
  // Stable within a rank, so a deliberate order inside the compounds survives.
  return [...plan]
    .map((e, i) => ({ e, i, r: rank(e) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ e }, i) => ({ ...e, index: i }));
}

// Two sessions at a position before anything is claimed. One heavy Monday
// proves nothing, and a confident claim off a single data point is worse than
// silence — it sends somebody rebuilding a programme around noise.
const MIN_SESSIONS = 2;

// What to train next, decided from the record rather than from a plan.
//
// The matrix already shows what has gone cold; nobody wants to read a grid and
// work out the answer themselves. This turns it into the one sentence somebody
// actually wants at the door of the gym: train these, they are the ones you
// have left alone longest.
//
// Every muscle group the person has EVER trained is considered, not just the
// ones in the last fortnight — a group that vanished five weeks ago is exactly
// the one to surface, and filtering to recent days would hide it completely.
const GROUPS = ['chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core'];

export function focusCall(days = [], { today = null } = {}) {
  const trained = days.filter(d => d.muscles?.length);
  if (!trained.length) {
    return {
      known: false,
      target: [], strong: [], groups: [],
      say: 'No sessions logged yet — this fills in from the first one.',
    };
  }

  const last = today || trained[trained.length - 1].date;
  const seen = new Set(trained.flatMap(d => d.muscles));
  // Their own vocabulary first, then the standard groups they have not used —
  // a group never trained at all is the strongest possible recommendation.
  const all = [...new Set([...seen, ...GROUPS])];

  const groups = all.map(m => {
    const hits = trained.filter(d => d.muscles.includes(m));
    const lastOn = hits.length ? hits[hits.length - 1].date : null;
    const ago = lastOn ? daysBetween(lastOn, last) : null;
    const fortnight = hits.filter(d => daysBetween(d.date, last) <= 13).length;
    return {
      muscle: m,
      sessions_14d: fortnight,
      days_since: ago,
      last_on: lastOn,
      // Four days is roughly when a group is ready again; a fortnight without
      // it is a hole rather than a rest.
      state: ago == null ? 'never' : ago >= 14 ? 'cold' : ago >= 7 ? 'stale' : fortnight >= 3 ? 'hammered' : 'worked',
    };
  }).sort((a, b) => {
    // A group they used to train and stopped outranks one they have never
    // mentioned. Both are gaps, but "five weeks since legs saw a barbell" is
    // the one that lands — they can plainly do it and have quietly stopped,
    // whereas a group with no history may simply be described differently.
    const abandoned = g => g.days_since != null && g.days_since >= 7;
    if (abandoned(a) !== abandoned(b)) return abandoned(a) ? -1 : 1;
    return (b.days_since ?? 999) - (a.days_since ?? 999);
  });

  const target = groups.filter(g => g.state === 'never' || g.state === 'cold' || g.state === 'stale').slice(0, 3);
  const strong = groups.filter(g => g.state === 'hammered');

  const name = g => g.muscle;
  const phrase = target.length
    ? `${target.map(name).join(', ')} — ${target[0].days_since == null
        ? 'never trained'
        : `${target[0].days_since} days since ${target[0].muscle}`}.`
    : 'Nothing is behind. Everything has been trained inside the last week.';

  return {
    known: true,
    groups,
    target: target.map(name),
    strong: strong.map(name),
    say: target.length
      ? `Train ${phrase}`
      : phrase,
    note: 'This is computed from what they actually did, not from a plan they said they would follow.',
  };
}

export function orderInsight(sets) {
  const byExercise = new Map();

  for (const s of sets) {
    if (s.position == null || s.weight_kg == null) continue;
    const key = s.exercise_key;
    if (!byExercise.has(key)) byExercise.set(key, new Map());
    const sessions = byExercise.get(key);
    // One entry per session: the top set, since that is what "how strong was I
    // on this lift today" actually means.
    const id = s.session_id || s.local_date;
    const prev = sessions.get(id);
    if (!prev || Number(s.weight_kg) > Number(prev.weight_kg)) {
      sessions.set(id, { weight_kg: Number(s.weight_kg), position: s.position, name: s.exercise });
    }
  }

  const findings = [];

  for (const [key, sessions] of byExercise) {
    const rows = [...sessions.values()];
    if (rows.length < MIN_SESSIONS * 2) continue;

    const early = rows.filter(r => r.position <= 2);
    const late  = rows.filter(r => r.position >= 3);
    if (early.length < MIN_SESSIONS || late.length < MIN_SESSIONS) continue;

    const avg = a => a.reduce((x, r) => x + r.weight_kg, 0) / a.length;
    const e = avg(early), l = avg(late);
    const diff = Math.round((e - l) * 10) / 10;
    const pct  = Math.round(((e - l) / e) * 1000) / 10;

    // Under 3% is inside the noise of sleep, food and the day itself.
    if (pct < 3) continue;

    findings.push({
      exercise: rows[0].name,
      key,
      early_avg_kg: Math.round(e * 10) / 10,
      late_avg_kg: Math.round(l * 10) / 10,
      cost_kg: diff,
      cost_pct: pct,
      sessions_early: early.length,
      sessions_late: late.length,
      say: `${rows[0].name} averages ${Math.round(e * 10) / 10}kg when it goes first or second, and ${Math.round(l * 10) / 10}kg when it goes third or later — ${diff}kg, about ${pct}%. If it matters to you, move it up.`,
    });
  }

  findings.sort((a, b) => b.cost_pct - a.cost_pct);

  return {
    findings,
    say: findings.length
      ? findings[0].say
      : 'Not enough sessions at different positions yet to say whether order is costing you anything.',
  };
}

// ── Earned room ─────────────────────────────────────────────────────────────
// Every eating app is one of two things: punitive, or permissive. Punitive ones
// get deleted in February. Permissive ones get ignored by March.
//
// This is the third thing. Track the week rather than the day, and when someone
// has genuinely been under, say so and tell them to spend it. Not "you may have
// a small treat" — actual arithmetic: you are 1,400 under for the week, that is
// a proper dinner out, go and have it.
//
// The reason it works is not motivational, it is structural: the room only
// exists if the log is honest, so the reward reinforces the exact behaviour the
// whole product depends on. Nobody games it, because gaming it means writing
// down food you did not eat in order to be told you may not eat more.
//
// TWO RULES THAT DO NOT BEND:
//
//   1. This function only ever ADDS permission. It never tells anybody to eat
//      less, skip a meal, or make up for yesterday. Being over is reported as
//      a fact about the trend and nothing else — the moment "earned" has an
//      opposite, it becomes a punishment schedule, and that is the pattern
//      that turns a food log into a disorder.
//
//   2. A care flag switches the whole framing off. Dangling food as a reward
//      for eating little is textbook, and a person in that pattern is the last
//      person who should be handed a scoreboard.

export function earnedRoom({ days, dailyTarget, flags = [], honestyDays = null }) {
  const fed = days.filter(d => d.calories);

  if (flags.some(f => f.flag === 'very_low_intake' || f.flag === 'rapid_loss')) {
    return {
      available: false, blocked: 'care',
      // `say` is read aloud, so it cannot explain why the frame is off — doing
      // that tells somebody who is already under-eating that they have not
      // qualified for a treat, which is the precise harm this branch exists to
      // prevent. The answer is unconditional permission and no scoreboard.
      say: 'Yes — have it. Food is not something you need to earn.',
      guidance: 'Grant it plainly and stop. Do not quote a calorie number, do not mention a weekly total, do not frame food as a reward or as something owed, and do not explain why. Follow the care flag guidance for anything further.',
    };
  }

  if (!dailyTarget) {
    return {
      available: false, blocked: 'no_target',
      say: 'No daily calorie target set, so there is nothing to measure room against.',
      guidance: 'Offer set_goal with a daily calorie number once. If they decline, drop it.',
    };
  }

  if (fed.length < 3) {
    return {
      available: false, blocked: 'not_enough_data',
      logged_days: fed.length,
      say: `Only ${fed.length} day${fed.length === 1 ? '' : 's'} of food logged this week — a few more and the weekly picture starts to mean something.`,
      guidance: 'Say it once, plainly. Do not nag about logging.',
    };
  }

  const target   = dailyTarget * fed.length;
  const consumed = fed.reduce((a, d) => a + d.calories, 0);
  const room     = Math.round(target - consumed);
  const streak   = honestyDays ?? fed.length;

  // Over for the week: state it and stop. No instruction, no making up for it.
  if (room <= 0) {
    return {
      available: false, over_by: Math.abs(room), logged_days: fed.length, honesty_streak: streak,
      say: `About ${Math.abs(room)} over target across ${fed.length} logged days — roughly ${Math.round(Math.abs(room) / fed.length)} a day.`,
      guidance: 'Report it and move on. Do NOT prescribe eating less, skipping anything, or making up for it. One factual line, no correction plan unless they explicitly ask for one.',
    };
  }

  const spend =
      room >= 900 ? 'a proper meal out, whatever you actually want'
    : room >= 600 ? 'a takeaway, or dessert and a couple of drinks'
    : room >= 350 ? 'pudding, or a decent-sized snack'
    : room >= 150 ? 'a bit of slack — a beer, a bag of crisps'
    : 'not much, but you are on the right side of it';

  return {
    available: true,
    room_kcal: room,
    logged_days: fed.length,
    honesty_streak: streak,
    daily_target: dailyTarget,
    avg_intake: Math.round(consumed / fed.length),
    worth: spend,
    say: `You are about ${room} calories under for the week across ${fed.length} logged days. That is ${spend}. You have earned it — spend it and do not log it as a failure.`,
    guidance: 'Say this warmly and without conditions. No "but", no "just be careful", no suggestion they bank it instead. A reward hedged is not a reward, and the honesty this depends on is worth more than the calories.',
  };
}

// ── Building a session ──────────────────────────────────────────────────────

export function planFromRoutine(routine) {
  const list = Array.isArray(routine.exercises) ? routine.exercises : [];
  return list.map((e, i) => ({
    index: i,
    name: e.name,
    key: exerciseKey(e.name),
    sets: Number(e.sets) || 3,
    reps: e.reps ?? 8,
    load_kg: e.load_kg ?? null,
    rest_s: Number(e.rest_s) || TIERS[routine.tier]?.rest_s || 120,
    muscles: e.muscles || [],
    cue: e.cue || null,
  }));
}

export function sessionTotals(sets) {
  const volume = sets.reduce((a, s) =>
    a + (Number(s.reps) || 0) * (Number(s.weight_kg) || 0), 0);
  return {
    sets: sets.length,
    reps: sets.reduce((a, s) => a + (Number(s.reps) || 0), 0),
    volume_kg: Math.round(volume),
    exercises: [...new Set(sets.map(s => s.exercise))],
    top_sets: Object.values(sets.reduce((acc, s) => {
      const k = s.exercise;
      if (!acc[k] || (Number(s.weight_kg) || 0) > (Number(acc[k].weight_kg) || 0)) acc[k] = s;
      return acc;
    }, {})).map(s => ({ exercise: s.exercise, weight_kg: s.weight_kg, reps: s.reps })),
  };
}
