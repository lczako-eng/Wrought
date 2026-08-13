// netlify/functions/lib/training.js
// Progression, energy balance, and the arithmetic behind a live session.
//
// Same rule as the rest of the system: the server decides, the model relays.
// "Put 95 on the bar" is a calculation with a defensible rule behind it, not a
// language model's impression of what sounds encouraging. If an LLM freelances
// the loading, it will cheerfully add 20kg to someone's squat one day and the
// product will have hurt them.

import { supabase, daysBetween, kgToLb } from './wrought.js';
import { activityTotal } from './activity.js';

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
    // SHOW THE WORKING.
    //
    // "It should be about 3,000 and I don't know why it keeps reverting" is a
    // question nobody could answer from the screen, because the inputs were
    // invisible. A number a person cannot audit is a number they stop
    // believing — and they are right to, since a stale height or a wrong
    // birth year produces a confidently wrong figure that looks identical to a
    // correct one.
    //
    // Naming the equation matters as much as the inputs. Mifflin-St Jeor is
    // the standard clinical estimate and it is NOT the only one; a different
    // calculator using Harris-Benedict lands a couple of hundred higher on the
    // same person, and without the name that difference looks like a bug.
    basis: {
      formula: 'Mifflin-St Jeor',
      weight_kg: Math.round(w * 10) / 10,
      height_cm: Math.round(h),
      age,
      sex: male ? 'male' : female ? 'female' : null,
      say: `${Math.round(w * 10) / 10}kg, ${Math.round(h)}cm, age ${age}` +
           (male || female ? `, ${male ? 'male' : 'female'}` : ', sex not set so the midpoint constant is used') +
           ` — Mifflin-St Jeor gives about ${Math.round(base + offset)} kcal lying still.`,
      // The distinction the founder ran into, stated once and kept here so the
      // model and the screen say the same thing about it.
      caveat: 'That is BASAL — what a body costs doing nothing at all. Most online calculators quote maintenance instead, which is basal times an activity multiplier, and comes out several hundred higher. Mifflin-St Jeor also assumes typical body composition, so it reads low for somebody carrying a lot of muscle. The weekly weigh-in trend is what corrects it; never swap the formula to get a number you like better.',
    },
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

// What a training session cost, when nothing measured it.
//
// A watch reports a workout's calories and that figure wins. Without one, a
// logged session used to contribute NOTHING to calories out — so the person
// most likely to be logging by hand was the person whose training counted for
// zero. Net of resting, same as work: the hour is already being billed by the
// daily resting burn.
const TRAINING_MET = { strength: 5.0, cardio: 7.0, mobility: 2.8 };

export function trainingBurn(workouts = [], weightKg = null) {
  let measured = 0, estimated = 0, anyMeasured = false, anyEstimated = false;

  for (const w of workouts) {
    const kcal = Number(w.detail?.calories);
    if (Number.isFinite(kcal) && kcal > 0) { measured += kcal; anyMeasured = true; continue; }

    const mins = Number(w.detail?.minutes);
    if (!Number.isFinite(mins) || mins <= 0 || !weightKg) continue;
    const met = TRAINING_MET[w.detail?.kind] ?? TRAINING_MET.strength;
    estimated += Math.round((met - 1) * Number(weightKg) * (mins / 60) * 1.05);
    anyEstimated = true;
  }

  return {
    kcal: Math.round(measured + estimated),
    measured: Math.round(measured),
    estimated: Math.round(estimated),
    source: anyMeasured && anyEstimated ? 'mixed' : anyMeasured ? 'device' : anyEstimated ? 'estimate' : 'none',
  };
}

/**
 * The day's burn, in the three parts it actually has.
 *
 * The founder: "one is your daily metabolic rate, your workout, and other."
 * That is the right division, and it is the one people can act on — the first
 * part cannot be changed, the second is a choice, and the third is a job.
 *
 *   resting  — what a body costs lying still. Fixed.
 *   training — deliberate exercise. Measured by a watch, or estimated from
 *              logged minutes.
 *   other    — work and daily life. This is the part that was missing, and for
 *              anybody with a physical job it is the biggest of the three.
 *
 * The precedence between measurement and estimate is the whole correctness
 * problem, and it runs the same way everywhere: a device that reported the day
 * has ALREADY counted the shift and the session, because that is where the
 * steps and the heart rate came from. So a logged activity is recorded and adds
 * nothing on a measured day. Adding both is how "calories out" doubles.
 */
export function energyBalance({
  profile, weightKg, caloriesIn, activeCalories, foodEstimated,
  workouts = [], activities = [], deviceResting = null, deviceExpected = false,
}) {
  const rest = restingBurn(profile, weightKg);

  // WHEN THE WATCH REPORTS ITS OWN BASAL, THE WATCH'S PAIR WINS.
  //
  // Not because Apple's figure is better — it is another formula, not a
  // measurement — but because of FRAME COHERENCE. Apple defines "active
  // energy" as THEIR total minus THEIR basal. Splicing Apple's active onto our
  // Mifflin basal produces a total that matches neither frame, and for anybody
  // carrying a lot of mass the two basal estimates disagree by hundreds — so
  // the founder's watch said one number, this screen said another, and both
  // called themselves his resting burn. A product that argues with the watch
  // on its own wrist loses, and deserves to.
  //
  // Mifflin stays as the fallback for everybody without a device, and stays
  // visible in the basis so the two can be compared rather than one silently
  // replacing the other.
  const deviceRest = Math.round(Number(deviceResting) || 0);
  const restKcal = deviceRest > 0 ? deviceRest : rest.kcal;
  const restingSource = deviceRest > 0 ? 'device' : 'formula';

  if (restKcal == null) {
    return {
      known: false, missing: rest.missing,
      say: `Calories out needs ${rest.missing.join(' and ')} before it can be worked out. Everything else still tracks.`,
    };
  }

  const basis = deviceRest > 0
    ? {
        formula: 'Your watch',
        say: `Your watch reports about ${deviceRest} kcal basal for today — Apple's own estimate, computed on the device from your details.` +
             (rest.kcal != null ? ` Mifflin-St Jeor from your stats here gives ${rest.kcal}.` : ''),
        caveat: 'Still an estimate — Apple derives it from height, weight and age just as any formula does. The weekly weigh-in trend is what corrects the whole figure; a single day never does.',
      }
    : rest.basis || null;

  const measured = Number(activeCalories) || 0;
  const level = ACTIVITY[profile.activity_level];
  const training = trainingBurn(workouts, weightKg);
  // Capped against THIS day's resting burn, which is why it happens here rather
  // than at the call site — the ceiling is a ratio, not a constant.
  const activity = activityTotal(activities, restKcal);
  const logged = Number(activity.kcal) || 0;

  let train = 0, other = 0, activeSource;

  if (measured > 0) {
    // Apple's active energy is everything above resting, workouts included —
    // so the session comes OUT of it rather than being added to it. Floored at
    // zero: a watch that reported less than the session it recorded is a watch
    // disagreeing with itself, and a negative "other" is nonsense on a screen.
    train = Math.min(training.kcal, measured);
    const fromDevice = Math.max(0, measured - train);

    // THE LARGER OF THE TWO, not the device outright, and not the sum.
    //
    // "A measurement beats an estimate" is the right rule for a metric a watch
    // can actually see. It is the WRONG rule for manual work, and a real day
    // proved it: 5,292 steps and four and a half hours at a petting zoo came
    // back as 740 active calories. A wrist accelerometer does not see load —
    // carrying, lifting, pushing, holding, the entire thing that makes a
    // physical job physical barely registers next to walking.
    //
    // Summing them would double-count the hours the watch WAS awake for, which
    // is the trap. Taking the higher figure treats both as estimates of the
    // same quantity and keeps the better-founded one. It is deliberately the
    // conservative choice — some non-work movement the watch caught gets
    // absorbed rather than added — because overstating a burn is a credibility
    // problem and understating one tells somebody to eat less than they need.
    other = Math.max(fromDevice, logged);
    activeSource = logged > fromDevice ? 'logged_over_device' : 'device';
  } else if (logged > 0) {
    // No watch, but they told us what they did. The logged work stands on its
    // own, and the hours NOT accounted for are charged at the sedentary floor
    // rather than at their usual multiplier — the multiplier already assumes a
    // typical day, and a typical day is the thing being replaced here. Never
    // below what the multiplier alone would have said, so logging a shift can
    // never make somebody's burn go DOWN.
    train = training.kcal;
    const floor = Math.round(restKcal * (ACTIVITY.sedentary.mult - 1));
    const viaLevel = level ? Math.round(restKcal * (level.mult - 1)) : 0;
    other = Math.max(logged + floor - train, viaLevel - train, 0);
    activeSource = 'logged';
  } else if (deviceExpected) {
    // A watch normally reports for this account and simply has not sent yet
    // today. Projecting the multiplier here is exactly what a device owner
    // does not want — a whole-day forecast standing in for a watch that has
    // real numbers sitting on it. So nothing is projected: the burn shows what
    // is actually known, and the fix is named (open the app).
    train = training.kcal;
    other = 0;
    activeSource = 'awaiting_device';
  } else {
    train = training.kcal;
    const viaLevel = level ? Math.round(restKcal * (level.mult - 1)) : 0;
    other = Math.max(0, viaLevel - train);
    activeSource = level ? 'activity_level' : train > 0 ? 'training_only' : 'none';
  }

  const active = train + other;
  const out = restKcal + active;
  const inn = Number(caloriesIn) || 0;
  const net = inn - out;

  const parts = [`${restKcal} at rest`];
  if (train) parts.push(`${train} training`);
  if (other) parts.push(`${other} ${activeSource === 'logged' ? 'work and moving about' : 'moving about'}`);

  return {
    known: true,
    calories_in: inn,
    resting_burn: restKcal,
    resting_source: restingSource,
    // Kept for everything already reading it — the two halves the split bar
    // draws — with the third now named beside them.
    active_burn: active,
    training_burn: train,
    other_burn: other,
    calories_out: out,
    net,
    direction: net < -150 ? 'deficit' : net > 150 ? 'surplus' : 'maintenance',
    // ~7,700 kcal a kilo. A projection, not a promise, and worded as one.
    projected_kg_per_week: Math.round((net * 7 / 7700) * 100) / 100,
    approximate: true,
    resting_approximate: deviceRest > 0 ? false : rest.approximate,
    // The inputs, carried through so a person can audit the figure instead of
    // taking it on faith. A number nobody can check is a number they stop
    // believing, and they are right to.
    resting_basis: basis,
    // An activity multiplier is a WHOLE DAY's projection — it is the same
    // number at 8am and at 11pm, because nothing measured anything. Saying so
    // is the difference between a forecast and a claim about what has already
    // happened.
    other_projected: activeSource === 'activity_level',
    active_source: activeSource,
    training_source: training.source,
    ...(activity.count ? { logged_activity: activity } : {}),
    say: `Roughly ${inn} in, about ${out} out (${parts.join(' · ')}) — ` +
         (net < -150 ? `around ${Math.abs(net)} down on the day.`
        : net > 150  ? `around ${net} over.`
        : `about level.`) +
         (foodEstimated ? ' Food is estimated from what you described, so treat it as a direction, not a measurement.' : '') +
         // A logged shift on a day the watch also reported is NOT added, and
         // staying quiet about that reads as the log having been ignored.
         (activeSource === 'logged_over_device'
           ? ` Your watch reported ${measured} for the whole day, but the work you logged comes to about ${logged} on its own — a wrist does not see carrying, so the higher figure is the one being used. They are not added together; that would count the same hours twice.`
           : measured > 0 && logged > 0
           ? ' Your watch counted more than the work alone would come to, so its figure is the one being used — the two are not added together.'
           : '') +
         (activity.capped ? ' The logged work was held at a ceiling; the raw figure is on the entry.' : '') +
         // Silence here would be the dangerous kind: a burn counting only the
         // resting figure looks like a bigger deficit than the day really had.
         (activeSource === 'awaiting_device'
           ? ' Your watch has not sent today, so only the resting figure is counted — nothing is projected. Open the Wrought app and today\'s real movement fills in.'
           : activeSource === 'none'
           ? ' NOTE: nothing is counting your movement — this is your resting burn only, so the real figure is higher and the deficit smaller than it looks. Log the work, set an activity level, or connect a phone to fix it.'
           : activeSource === 'training_only'
           ? ' NOTE: your session is counted but nothing is counting the rest of the day, so the real figure is higher and the deficit smaller than it looks. Log the work, set an activity level, or connect a phone.'
           : ''),
    caveat: 'Every part of this is an estimate. Resting burn varies by hundreds of calories between people the same size, described meals are inferred, and work is read off a standard effort table rather than measured. Use the weekly trend on the scale to correct it, never a single day.',
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

// ── Last night ──────────────────────────────────────────────────────────────
// The founder asked for this before anything else on the dashboard: "how many
// reps you did last night, your workout that you've done, what are you
// targeting."
//
// Everything else on the Record view is arithmetic ABOUT training — averages,
// matrices, trends. This is the session itself, set by set, and it is what
// somebody actually opens the app to see the morning after. A weekly average
// cannot tell you that you got 8 on the last set when you got 6 last time, and
// that single fact is the entire reason anybody keeps a training log.
//
// Every lift is set against the last time it was done, because a number with
// nothing beside it is trivia. "92.5 for 6" means nothing; "92.5 for 6, up from
// 90 for 6" is the whole point.

export function lastSession(sessions = [], sets = [], { today = null, imperial = false } = {}) {
  const done = sessions.filter(s => s.local_date).slice();
  if (!done.length) {
    return { known: false, say: 'No finished session yet — this fills in after the first one.' };
  }

  // sessions arrive newest first from the endpoint; do not trust that.
  done.sort((a, b) => String(b.ended_at || b.local_date).localeCompare(String(a.ended_at || a.local_date)));
  const s = done[0];

  const mine = sets.filter(x => x.session_id === s.id);
  // A session with no sets attached is a cardio or sport entry, not a bug.
  const totals = sessionTotals(mine);

  const conv = kg => (kg == null ? null : imperial ? kgToLb(kg) : Math.round(kg * 10) / 10);
  const unit = imperial ? 'lb' : 'kg';

  // Group into exercises in the order they were actually performed. `position`
  // is stored on every set precisely so this is answerable.
  const order = [];
  const byKey = new Map();
  for (const x of mine) {
    const k = x.exercise_key || exerciseKey(x.exercise);
    if (!byKey.has(k)) { byKey.set(k, { key: k, name: x.exercise, sets: [], position: x.position ?? null }); order.push(k); }
    const e = byKey.get(k);
    e.sets.push(x);
    if (e.position == null) e.position = x.position ?? null;
  }
  order.sort((a, b) => (byKey.get(a).position ?? 99) - (byKey.get(b).position ?? 99));

  // The same lift, the last time before this session. This is the comparison
  // that makes the whole screen worth opening.
  const previous = new Map();
  for (const x of sets) {
    if (x.session_id === s.id) continue;
    if (x.local_date > s.local_date) continue;
    const k = x.exercise_key || exerciseKey(x.exercise);
    const cur = previous.get(k);
    if (!cur || x.local_date > cur.date) previous.set(k, { date: x.local_date, sets: [] });
    if (previous.get(k).date === x.local_date) previous.get(k).sets.push(x);
  }

  const exercises = order.map((k) => {
    const e = byKey.get(k);
    const top = e.sets.reduce((a, x) =>
      (Number(x.weight_kg) || 0) > (Number(a.weight_kg) || 0) ? x : a, e.sets[0]);
    const volume = e.sets.reduce((a, x) => a + (Number(x.reps) || 0) * (Number(x.weight_kg) || 0), 0);

    const prev = previous.get(k);
    const prevTop = prev?.sets.length
      ? prev.sets.reduce((a, x) => (Number(x.weight_kg) || 0) > (Number(a.weight_kg) || 0) ? x : a, prev.sets[0])
      : null;

    // Weight first, reps as the tiebreak. Same weight for more reps IS progress
    // and calling it "no change" is how somebody stops believing the readout.
    let verdict = null;
    if (prevTop) {
      const dw = (Number(top.weight_kg) || 0) - (Number(prevTop.weight_kg) || 0);
      const dr = (Number(top.reps) || 0) - (Number(prevTop.reps) || 0);
      if (Math.abs(dw) > 0.01) verdict = dw > 0 ? 'up' : 'down';
      else if (dr !== 0) verdict = dr > 0 ? 'up' : 'down';
      else verdict = 'same';
    }

    return {
      name: e.name, key: k,
      position: e.position,
      sets: e.sets
        .slice()
        .sort((a, b) => (a.set_number ?? 0) - (b.set_number ?? 0))
        .map(x => ({ reps: x.reps ?? null, weight: conv(x.weight_kg), rpe: x.rpe ?? null })),
      set_count: e.sets.length,
      reps: e.sets.reduce((a, x) => a + (Number(x.reps) || 0), 0),
      volume: Math.round(imperial ? kgToLb(volume) : volume),
      top_set: { weight: conv(top.weight_kg), reps: top.reps ?? null },
      // Bodyweight work has no weight and must not be reported as zero.
      loaded: top.weight_kg != null,
      last_time: prevTop
        ? { date: prev.date, weight: conv(prevTop.weight_kg), reps: prevTop.reps ?? null,
            days_ago: daysBetween(prev.date, s.local_date) }
        : null,
      verdict,
      say: prevTop
        ? (verdict === 'up'   ? 'up on last time'
        :  verdict === 'down' ? 'down on last time'
        :                       'matched last time')
        : 'first time logged',
    };
  });

  const muscles = [...new Set(mine.flatMap(x => x.muscles || []))];
  const minutes = s.ended_at && s.started_at
    ? Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000))
    : null;
  const ago = today ? daysBetween(s.local_date, today) : null;

  const when = ago === 0 ? 'Today' : ago === 1 ? 'Last night' : ago == null ? s.local_date : `${ago} days ago`;
  const up = exercises.filter(e => e.verdict === 'up').length;

  return {
    known: true,
    name: s.name, kind: s.kind, date: s.local_date, days_ago: ago, minutes,
    when,
    totals: {
      sets: totals.sets, reps: totals.reps,
      volume: Math.round(imperial ? kgToLb(totals.volume_kg) : totals.volume_kg),
      unit, exercises: exercises.length,
    },
    muscles,
    exercises,
    // Computed here so the page and the assistant read the same sentence.
    say: totals.sets
      ? `${when}: ${s.name}, ${totals.sets} set${totals.sets === 1 ? '' : 's'}, ${totals.reps} reps${minutes ? ` in ${minutes} min` : ''}.${up ? ` ${up} lift${up === 1 ? '' : 's'} up on last time.` : ''}`
      : `${when}: ${s.name}${minutes ? `, ${minutes} min` : ''}.`,
  };
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

// ── The week against the expectation ────────────────────────────────────────
// The founder's ask: "set the expectations of like three or five workouts a
// week, create that baseline and then go from there." An MCP server can never
// make the assistant speak first, so the expectation cannot be a reminder that
// arrives — it has to be a number that is ALREADY THERE every time the person
// talks. This computes it; the brief carries it.
//
// The say string is flat arithmetic on purpose. "1 of 3, four days left" is
// information somebody can act on; "you're behind" is a judgement that makes
// people stop opening the app. And a missed week is never a debt — sessions do
// not carry over, because a punishment schedule is how training dies. Same
// doctrine as blockPosition, which refuses to let the calendar delete training.
export function weekSoFar(days = [], { today, target = null } = {}) {
  if (!today) return null;
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;   // Mon = 0
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - dow);
  const weekStart = monday.toISOString().slice(0, 10);

  const done = days
    .filter(d => d.date >= weekStart && d.date <= today)
    .reduce((a, d) => a + (d.sessions || 0), 0);
  const daysLeft = 6 - dow;   // days remaining AFTER today

  const t = Number.isFinite(Number(target)) && Number(target) > 0 ? Number(target) : null;
  let say;
  if (!t) {
    say = `${done} session${done === 1 ? '' : 's'} so far this week. No weekly target is set.`;
  } else if (done >= t) {
    say = `${done} of ${t} sessions this week — the target is met.`;
  } else if (t - done > daysLeft) {
    // It cannot fit any more. Saying so beats a countdown to an impossible
    // number, and the week ends there — nothing rolls into the next one.
    say = `${done} of ${t} sessions this week with ${daysLeft} day${daysLeft === 1 ? '' : 's'} left — this week will finish short. That is information, not a debt; next week starts at zero.`;
  } else {
    say = `${done} of ${t} sessions this week, ${daysLeft} day${daysLeft === 1 ? '' : 's'} left.`;
  }

  return {
    week_start: weekStart,
    done,
    target: t,
    days_left: daysLeft,
    met: t ? done >= t : null,
    say,
  };
}

// ── What a body goal actually means, in numbers ─────────────────────────────
// "I wanna lose weight", "get more muscular" — the words are the goal; the
// server turns them into targets, because NEVER SUBSTITUTE A PLAUSIBLE NUMBER
// applies doubly here. A model asked for a cutting target will confidently say
// 1,500, to a 150kg man and a 60kg woman alike, and one of them gets hurt.
//
// The rails are the point, not the arithmetic:
//   - Loss is paced at 0.5% of bodyweight a week — the rate heavy and light
//     people can both actually sustain — with the daily deficit clamped to
//     300..750 kcal. Faster exists; it is also where careFlags() lives.
//   - The intake target NEVER lands below 1,200 kcal. That is the care-flag
//     floor, and a product must not prescribe the thing it warns about.
//   - A surplus is small (~250) because muscle is built in months and the
//     surplus beyond what training can use is just weight to lose later.
//   - "Both" (lose fat, gain muscle — what most people actually want) is a
//     modest deficit with protein high; the training does the recomposition.
// How fast, and the rails that hold whatever gets chosen.
//
// The founder: "your plans to tailor-made plan for you — aggressive,
// non-aggressive fat burning, both." He is right that one hardcoded pace is
// not a plan, it is a default. But the choice is over a BOUNDED range: every
// pace here still floors intake at 1,200 and still projects under the rate
// careFlags warns about. Aggressive means the fast end of safe, never a
// different set of rules — a product that will pace somebody into its own
// safety warning if they ask nicely has no safety warning.
export const PACES = {
  gentle:     { pct: 0.0025, min: 200, max: 400, framing: 'a gentle cut — slow, and the easiest kind to actually finish',
                say: 'Slow. Barely feels like dieting, and it is the one people finish.' },
  steady:     { pct: 0.005,  min: 300, max: 750, framing: 'a paced cut',
                say: 'The default. About half a percent of bodyweight a week — fast enough to see, slow enough to keep muscle.' },
  aggressive: { pct: 0.0075, min: 500, max: 1000, framing: 'an aggressive cut — this one is meant to be uncomfortable',
                say: 'The fast end of sensible. Hungrier, and it costs more muscle, so protein and lifting matter more, not less.' },
};

// careFlags raises rapid_loss past 1.2 kg/week. Plans stop below it, with room.
const RAPID_LOSS_CEILING = 1.0;

// How hard it pushes. This changes NOTHING about the numbers — it changes how
// often and how forcefully the assistant brings training up unprompted. Kept
// separate from bluntness, which is about how a verdict is worded: somebody can
// want the truth delivered flat and still not want chasing every evening.
export const PUSH = {
  light:      { say: 'Light. Answers when asked, brings training up only when you are well behind.' },
  normal:     { say: 'Normal. Mentions where the week stands, suggests the session when you are short.' },
  relentless: { say: 'Relentless. Names what is overdue every time you speak, and does not let a missed week pass quietly.' },
};

export function goalCall({ profile = {}, weightKg = null, intent = 'maintain', pace = 'steady' } = {}) {
  const rest = restingBurn(profile, weightKg);
  if (rest.kcal == null) {
    return { known: false, missing: rest.missing,
             say: `Setting a real target needs ${rest.missing.join(' and ')} first.` };
  }
  const level = ACTIVITY[profile.activity_level];
  const maintenance = rest.kcal + (level ? Math.round(rest.kcal * (level.mult - 1)) : 0);

  const w = Number(weightKg);
  const p = PACES[pace] || PACES.steady;

  // A percentage of bodyweight a week, in daily kcal (7,700 per kg), clamped.
  const paced = Math.round((p.pct * w * 7700) / 7);
  const deficit = Math.min(p.max, Math.max(p.min, paced));

  let target, rate, framing;
  if (intent === 'lose') {
    target = Math.max(1200, maintenance - deficit);
    rate = -Math.round(((maintenance - target) * 7 / 7700) * 100) / 100;
    framing = p.framing;
  } else if (intent === 'gain') {
    target = maintenance + (pace === 'aggressive' ? 400 : 250);
    rate = pace === 'aggressive' ? 0.4 : 0.25;
    framing = pace === 'aggressive' ? 'a faster gain, which will carry some fat with it' : 'a lean gain';
  } else if (intent === 'recomp') {
    target = Math.max(1200, maintenance - 300);
    rate = -Math.round((300 * 7 / 7700) * 100) / 100;
    framing = 'a recomposition — modest deficit, protein high, training does the rest';
  } else {
    target = maintenance;
    rate = 0;
    framing = 'maintenance';
  }

  // THE PRODUCT MUST NOT PRESCRIBE WHAT IT WARNS ABOUT.
  //
  // careFlags raises rapid_loss above 1.2 kg a week. A plan that paces
  // somebody INTO their own care flag is incoherent — it would spend a
  // fortnight telling them to eat less and then tell them they were losing too
  // fast. So the projection is held below the flag with a margin, and the
  // ceiling is stated rather than applied quietly.
  let held = null;
  if (rate < -RAPID_LOSS_CEILING) {
    const capped = Math.round((RAPID_LOSS_CEILING * 7700) / 7);
    target = Math.max(1200, maintenance - capped);
    rate = -Math.round(((maintenance - target) * 7 / 7700) * 100) / 100;
    held = `That pace would have put you past ${RAPID_LOSS_CEILING}kg a week, which is where WROUGHT starts warning rather than coaching. Held just under it.`;
  }
  if (intent !== 'maintain' && target === 1200 && maintenance - deficit < 1200) {
    held = 'The target hit the 1,200 floor — that is the least a body should be asked to run on, and no plan here goes below it however fast somebody wants to go.';
  }

  // Protein: 1.6 g/kg, capped — per-kg arithmetic overshoots at high
  // bodyweights, and 220g is already past what anybody needs.
  const protein = Math.min(220, Math.round(w * 1.6));

  return {
    known: true,
    intent,
    pace,
    maintenance,
    calorie_target: target,
    protein_target_g: protein,
    projected_kg_per_week: rate,
    resting_only: !level,
    approximate: true,
    ...(held ? { held } : {}),
    say: `Roughly ${maintenance} a day to hold steady, so the target is about ${target} — ${framing}` +
         (rate ? `, on pace for roughly ${Math.abs(rate)}kg a ${rate < 0 ? 'week down' : 'week up'}` : '') +
         `. Protein target about ${protein}g a day.` +
         (held ? ` ${held}` : '') +
         (!level ? ' NOTE: nothing is counting movement, so maintenance here is resting-only and the real figure is higher — set an activity level and this improves.' : ''),
    caveat: 'All of it is an estimate. The weekly weigh-in trend is the truth; the target gets corrected against it, never the other way round.',
  };
}

/**
 * Every target this person could defensibly be given, computed.
 *
 * THIS EXISTS BECAUSE THE NAMED FAILURE HAPPENED IN PRODUCTION. Asked "how
 * many calories am I allowed today at my weight", with no goal on file, the
 * model answered "around 2,500-2,700, I'd set your working target at 2,600".
 * Nothing set 2,600. It was a plausible number in place of a real one — the
 * exact mistake goalCall was written to make impossible — and it came out
 * several hundred BELOW what the paced arithmetic actually gives, which is the
 * direction that hurts somebody.
 *
 * Instructions alone did not stop it, and were never going to: a model invents
 * when it is asked a question and handed nothing. So the fix is to hand it
 * something. Every read that could plausibly be asked "what am I allowed"
 * carries these, already worked out, with the pace named. There is then no gap
 * to fill and no reason to reach for a round number.
 *
 * Nothing here is SET. They are options, and set_goal is still what commits
 * one — offering a number and imposing one are different acts.
 */
export function targetOptions({ profile = {}, weightKg = null } = {}) {
  const rest = restingBurn(profile, weightKg);
  if (rest.kcal == null) {
    return { known: false, missing: rest.missing,
             say: `A target needs ${rest.missing.join(' and ')} before it can be worked out. Ask for those rather than estimating one.` };
  }

  const opts = {};
  for (const pace of Object.keys(PACES)) {
    const c = goalCall({ profile, weightKg, intent: 'lose', pace });
    if (c.known) opts[pace] = { calories: c.calorie_target, kg_per_week: c.projected_kg_per_week, ...(c.held ? { held: c.held } : {}) };
  }
  const maintain = goalCall({ profile, weightKg, intent: 'maintain' });
  const gain = goalCall({ profile, weightKg, intent: 'gain' });

  return {
    known: true,
    set: false,
    maintenance: maintain.known ? maintain.calorie_target : null,
    protein_target_g: maintain.known ? maintain.protein_target_g : null,
    to_lose: opts,
    to_gain: gain.known ? gain.calorie_target : null,
    resting_basis: rest.basis || null,
    say: `Nothing is set yet. From ${rest.basis?.say || 'their own numbers'} maintenance is about ${maintain.calorie_target}. ` +
         `A steady cut is about ${opts.steady?.calories}, gentle about ${opts.gentle?.calories}, aggressive about ${opts.aggressive?.calories}.`,
    note: 'These are COMPUTED from their height, weight, age, sex and activity level — quote them exactly and never round them into a range of your own. None of them is set: offer, let them pick, then call set_goal with the intent and pace so the brief can score it. If they do not choose, leave it unset rather than assuming one.',
  };
}

// ── A number they remember is a claim, not a load ───────────────────────────
// For a lift with no history, progressionCall refuses to invent a weight — the
// right refusal, and also a dead end for somebody who has benched for years
// and knows roughly where they are. The founder's ask: "ask them what they
// think their bench press limits are and build off of that — and be careful
// about it."
//
// The care IS the feature. A remembered number is the most flattering version
// of a lift — the best day, the bounciest bar, rounded up, often years old.
// Programming it as fact is how a product hands somebody a weight that hurts
// them. So a claim is always DISCOUNTED before it touches a bar, the first
// set is named a calibration rather than a prescription, and what they then
// actually lift becomes the history everything after is computed from. The
// claim never enters the log as if it were performance.
export function baselineFromClaim({ claimed_kg, claimed_reps = null, kind = 'working', target_reps = 8, tier = 'intermediate' } = {}) {
  const w = Number(claimed_kg);
  if (!Number.isFinite(w) || w <= 0) {
    return { verdict: 'refuse', weight_kg: null,
             say: 'That claim did not include a usable weight. Ask what they usually lift for a set, or start light and let the bar decide.' };
  }

  // Epley in both directions: claimed set → estimated 1RM → working weight at
  // the target reps. A claimed max (kind 'max') is already a 1RM claim.
  const reps = Math.max(1, Math.round(Number(claimed_reps) || (kind === 'max' ? 1 : target_reps)));
  const oneRm = kind === 'max' ? w : w * (1 + reps / 30);
  const atTarget = oneRm / (1 + target_reps / 30);

  // The discount is the safety, and it is bigger for the riskier claims: a
  // stated 1RM is the least trustworthy number in any gym, and a beginner's
  // estimate of anything is a guess wearing confidence.
  const discount = (kind === 'max' ? 0.85 : 0.90) - (tier === 'beginner' ? 0.05 : 0);
  const start = Math.floor((atTarget * discount) / 2.5) * 2.5;

  if (start < 2.5) {
    return { verdict: 'refuse', weight_kg: null,
             say: 'That works out too light to load a bar with — start with the empty bar or bodyweight and log what happens.' };
  }

  return {
    verdict: 'calibration',
    weight_kg: start,
    claimed: { weight_kg: w, reps, kind },
    estimated_1rm: Math.round(oneRm),
    discount_pct: Math.round((1 - discount) * 100),
    say: `Start at ${start}kg for ${target_reps} — that is their claim with ${Math.round((1 - discount) * 100)}% held back, because a remembered number is a best day, not a Tuesday. The first set is a calibration: if it moves clean, add; if it grinds, strip it back and nothing is lost. What they ACTUALLY lift becomes the baseline.`,
    note: 'The claim never enters the log — only the performed set does. From the next session, progression runs off real history and this claim is spent.',
  };
}

// ── Readiness — what the body says before the session starts ────────────────
// The founder: "it has all my heart health data, it should show training
// spikes... recovery should know the time you're starting your workout."
//
// This is the professional half nobody has wired to an AI: resting heart rate
// and sleep, read against the person's OWN recent baseline, so the answer is
// "you, today, versus you lately" rather than a chart of strangers.
//
// TWO RULES MAKE IT SAFE TO SHIP.
//
// 1. NOT A DIAGNOSIS. An elevated resting heart rate has a hundred causes and
//    this cannot tell them apart. It is allowed to say "your body is reading
//    tired, train lighter" and is never allowed to imply a condition. When the
//    signal is genuinely extreme it stops guessing and says see a doctor.
// 2. IT ONLY EVER SOFTENS. A good reading is permission, never an instruction
//    to go harder — "you're recovered, add weight" is how a tool talks somebody
//    into an injury on a day they already felt off. The body gets a veto, never
//    a spur. Same shape as earnedRoom(): the flag adds permission or it stays
//    quiet.
export function readiness({ days = [], today = null } = {}) {
  if (!today) return null;
  const past = days.filter(d => d.date < today);
  const now  = days.find(d => d.date === today);
  if (!now) return null;

  // Baseline from the fortnight before today, so a hard week moves the bar and
  // a single rough night does not.
  const window = past.slice(-14);
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const rhrBase   = mean(window.map(d => d.resting_hr).filter(v => v != null));
  const sleepBase = mean(window.map(d => d.sleep_minutes).filter(v => v != null));

  const signals = [];
  let flags = 0;

  if (now.resting_hr != null && rhrBase != null && window.length >= 4) {
    const delta = Math.round((now.resting_hr - rhrBase) * 10) / 10;
    // 7% over a fortnight's baseline is the threshold every endurance coach
    // uses; below that it is noise, salt and what time you stood up.
    const raised = delta > 0 && delta / rhrBase >= 0.07;
    if (raised) flags++;
    signals.push({
      metric: 'resting_hr', value: now.resting_hr, baseline: Math.round(rhrBase),
      delta, notable: raised,
      say: raised
        ? `Resting heart rate ${now.resting_hr}, about ${Math.abs(delta)} above your usual ${Math.round(rhrBase)}.`
        : `Resting heart rate ${now.resting_hr}, normal for you.`,
    });
  }

  if (now.sleep_minutes != null && sleepBase != null && window.length >= 4) {
    const short = now.sleep_minutes < sleepBase - 60;
    if (short) flags++;
    signals.push({
      metric: 'sleep', value: now.sleep_minutes, baseline: Math.round(sleepBase),
      delta: Math.round(now.sleep_minutes - sleepBase), notable: short,
      say: short
        ? `Slept ${humanMinutes(now.sleep_minutes)}, about ${humanMinutes(Math.round(sleepBase - now.sleep_minutes))} short of your usual.`
        : `Slept ${humanMinutes(now.sleep_minutes)}, in line with your usual.`,
    });
  }

  if (!signals.length) {
    return { known: false, say: 'Nothing measuring recovery yet — a watch reporting sleep and resting heart rate is what fills this in.' };
  }

  const state = flags >= 2 ? 'strained' : flags === 1 ? 'watch' : 'ready';
  return {
    known: true,
    state,
    signals,
    // Only ever softer. "Ready" is permission to train as planned — never an
    // instruction to add weight, which is how a tool argues somebody into an
    // injury on a day they already felt wrong.
    say: state === 'strained'
      ? `${signals.filter(s => s.notable).map(s => s.say).join(' ')} Two signals off at once — train, but take today lighter: same movements, fewer hard sets, nothing near failure. If it stays like this for a week or you feel genuinely unwell, that is a doctor's question, not this app's.`
      : state === 'watch'
        ? `${signals.find(s => s.notable).say} One signal off. Train as planned and judge it on the first working set — if the bar feels heavy today, it is heavy today.`
        : 'Recovery signals look normal for you. Train as planned.',
    caveat: 'Not a medical reading. Resting heart rate and sleep move for a hundred reasons this cannot tell apart — it is a nudge about today, nothing more.',
  };
}

function humanMinutes(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// ── Gauging, inside the session ─────────────────────────────────────────────
// The founder, looking at a set logged and nothing coming back: "it's not
// really gauging me."
//
// He was right, and the hole was embarrassing. `log_set` returned the next
// load as a hardcoded `verdict: 'same'` for every set after the first, so
// "tell me how many you got and how hard it felt and I'll adjust" was a
// promise kept entirely by the language model — which means the adjustment
// was invented. THE ONE PLACE THE PRODUCT IS SUPPOSED TO BE A TRAINING PARTNER
// RATHER THAN A DIARY, and it was guessing.
//
// This is a different question from `progressionCall`, which decides what to
// open with NEXT TIME from the whole history. This is autoregulation within
// the hour: the set that just happened is the best information anybody will
// ever have about whether today's weight is right, and it is available three
// minutes before the next set needs it.
//
// SAFETY RULES, because this is the one function that puts a number on a bar:
//
//   1. AN UNREPORTED EFFORT NEVER ADDS WEIGHT. Without an RPE the only signals
//      are reps, and reps alone cannot tell a comfortable eight from a grinding
//      one. Silence means hold, never climb. Same shape as readiness: it only
//      ever softens.
//   2. ONE STEP AT A TIME, in real plate increments. Nothing here ever jumps.
//   3. FALLING SHORT COMES DOWN. Missing the target at a high RPE is not
//      character-building, it is a weight that is wrong today.
//   4. IT NEVER INVENTS A STARTING WEIGHT. With nothing logged for the set
//      that just happened there is nothing to adjust, and it says so.

export function nextSetLoad({ weightKg = null, reps = null, rpe = null,
                              targetReps = null, key = '', tier = 'intermediate' } = {}) {
  const w = Number(weightKg);
  const r = reps == null ? null : Number(reps);
  const e = rpe == null ? null : Number(rpe);
  const target = targetReps == null ? null : parseInt(String(targetReps), 10);

  // Rule 4. Bodyweight work and unlogged loads have nothing to move.
  if (!Number.isFinite(w) || w <= 0) {
    return {
      verdict: 'same', weight_kg: null, changed: false,
      say: r != null && target && r < target
        ? 'Same again — take a longer rest before this one.'
        : 'Same again.',
    };
  }

  const step = loadStep(key, tier);
  const round = v => Math.round(v * 4) / 4;

  // Rule 3, first: a set that fell apart is the clearest signal there is.
  const wellShort = target != null && r != null && r <= target - 3;
  const grinding  = e != null && e >= 9.5;

  if (wellShort || grinding) {
    const next = Math.max(step, round(w - step));
    return {
      verdict: 'down', weight_kg: next, changed: next !== w, step,
      say: `Take it to ${next}kg — ${grinding ? 'that was at the limit' : 'that came in short'}, and finishing the sets matters more than the number.`,
    };
  }

  // Rule 1: an easy set only counts as easy if they SAID so.
  const easy = e != null && e <= 7 && target != null && r != null && r >= target;
  if (easy) {
    const next = round(w + step);
    return {
      verdict: 'up', weight_kg: next, changed: true, step,
      say: `That was comfortable — put it to ${next}kg.`,
    };
  }

  // Everything else holds. Including "hit the target at RPE 9": they earned it,
  // and adding on top of a set that already cost that much is how a good
  // session becomes an injury.
  const shortish = target != null && r != null && r < target;
  return {
    verdict: 'same', weight_kg: w, changed: false, step,
    say: shortish
      ? `Stay at ${w}kg — one more rest, then go again.`
      : e != null && e >= 9
        ? `Stay at ${w}kg. That one cost enough.`
        : `Same ${w}kg.`,
  };
}

// ── The max, estimated and said to be ───────────────────────────────────────
// The founder: "should be recording my max for each one."
//
// A best SET is the honest record — 235 for 4 is a fact that happened. But it
// cannot be compared against 175 for 8, and that is the whole problem with
// reading a training log: every set is at a different rep range, so nothing
// lines up and progress is invisible even when it is real. Epley converts both
// onto the same scale, which is the only way "am I stronger than in March" has
// an answer.
//
// THREE RULES, and the first two are safety:
//
//   1. IT IS LABELLED AN ESTIMATE EVERYWHERE IT APPEARS. An unlabelled
//      projected max is a number people go and try to lift.
//   2. NOTHING IS EVER PROGRAMMED FROM IT, and WROUGHT never suggests going
//      and testing a real one. A max attempt is the single most dangerous
//      thing an app can talk somebody into — the estimate exists precisely so
//      that nobody needs to.
//   3. REPS ARE CAPPED AT 12. Epley diverges badly above that; a set of twenty
//      would produce a confident and absurd figure.
export function estimatedMax(weightKg, reps) {
  const w = Number(weightKg), r = parseInt(String(reps), 10);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(r) || r < 1) return null;
  return Math.round(w * (1 + Math.min(r, 12) / 30) * 10) / 10;
}

// ── Timed movements, and the artifact the old default left behind ───────────
// WORD BOUNDARIES, because the first version of this pattern lived inline in
// two files as /treadmill|bike|row(er)?|...|run|.../ and matched far more than
// it meant to: "row" is the front of "Hammer Strength Row" and every barbell
// row — strength movements, not cardio — and "run" is the middle of "crunch".
// A crunch classified as timed work gets its sets nulled, which is data loss
// by regex.
//
// And the boundaries are not quite enough on their own: a FARMER'S WALK and
// WALKING LUNGES are loaded strength movements that happen to contain the
// word "walk". The lookarounds carve those out — a carry is sets and reps,
// whatever the word inside it says.
export const TIMED_MOVEMENT =
  /\b(treadmill|bike|biking|cycling|spin|rower|rowing|erg|elliptical|(?<!farmer'?s\s)(?<!loaded\s)(?<!suitcase\s)walk(ing)?(?!\s*lunge)|run(ning)?(?!\s*lunge)|jog(ging)?|stairs?|stairmaster|cardio|swim(ming)?)\b/i;

/**
 * One movement, shaped for STORAGE. Shared by every door that writes a routine
 * so a fixed classification bug is fixed at all of them at once.
 *
 * PARTIAL IS THE MODE THAT MATTERS. Merging an update into a stored movement
 * used to spread a fully-defaulted object over it, so "change the rower to 3
 * sets of 8" overwrote the stored minutes, detail, cue, muscles and load with
 * the defaults for fields nobody mentioned. A save never silently deletes, and
 * that applies to FIELDS exactly as it applies to movements — so in partial
 * mode only the keys actually supplied come back.
 */
export function normaliseMovement(e = {}, { partial = false } = {}) {
  const has = k => e[k] !== undefined && e[k] !== '';
  const minutes = Number(e.minutes) > 0 ? Math.round(Number(e.minutes)) : null;
  const timed = minutes != null || TIMED_MOVEMENT.test(String(e.name || ''));

  if (partial) {
    const out = {};
    if (e.name != null)   out.name = String(e.name).trim().slice(0, 120);
    if (has('sets'))      out.sets = Number(e.sets) || null;
    if (has('reps'))      out.reps = e.reps;
    if (has('minutes'))   out.minutes = minutes;
    if (has('detail'))    out.detail = e.detail ? String(e.detail).slice(0, 200) : null;
    if (has('load_kg'))   out.load_kg = e.load_kg;
    if (has('rest_s'))    out.rest_s = Number(e.rest_s) || 120;
    if (Array.isArray(e.muscles)) out.muscles = e.muscles;
    if (has('cue'))       out.cue = e.cue ? String(e.cue).slice(0, 300) : null;

    // Supplying minutes for something previously counted in sets — or sets for
    // something previously timed — has to clear the other, or the movement
    // ends up claiming both and the screen shows a contradiction.
    if (has('minutes') && !has('sets')) { out.sets = null; out.reps = null; }
    if (has('sets') && !has('minutes')) out.minutes = null;
    return out;
  }

  return {
    name: String(e.name || '').trim().slice(0, 120),
    sets: has('sets') ? Number(e.sets) || null : (timed ? null : 3),
    reps: has('reps') ? e.reps : (timed ? null : 8),
    minutes,
    // How it is actually set up. Kept verbatim, because "level 10+, 2.5–3 mph"
    // is the whole instruction and no sets/reps field decomposes it well.
    detail: e.detail ? String(e.detail).slice(0, 200) : null,
    load_kg: e.load_kg ?? null,
    rest_s: Number(e.rest_s) || 120,
    muscles: Array.isArray(e.muscles) ? e.muscles : [],
    cue: e.cue ? String(e.cue).slice(0, 300) : null,
  };
}

/**
 * One movement, shaped for DISPLAY.
 *
 * READ ONLY, and that separation is the whole point. Before minutes existed
 * every movement was defaulted to sets 3, reps 8, so a timed movement stored
 * as precisely that pair with no minutes is the old default wearing a movement
 * it never described. Showing it as "3×8" is showing somebody a rep scheme
 * nobody chose — but WRITING that judgement back would rewrite the stored data
 * of anybody who genuinely programmed a treadmill as intervals, as a side
 * effect of an unrelated edit. So the retirement happens on the way out and
 * never on the way in.
 */
export function readMovement(e = {}) {
  const m = normaliseMovement(e);
  const timed = m.minutes != null || TIMED_MOVEMENT.test(m.name);
  if (timed && m.minutes == null && m.sets === 3 && Number(m.reps) === 8) {
    return { ...m, sets: null, reps: null, from_default: true };
  }
  return m;
}

// ── The bridge from a logged workout to the set record ──────────────────────
// A workout logged AFTER THE FACT — "log my workout: bench 235 for 4, rows
// 220 for 8" — arrives as one event whose detail carries the exercises, and
// until this existed those exercises never reached wrought_sets: the grain
// the lift record, the estimated max, last session and progressionCall are
// all computed from. So the person logging by telling their AI afterwards —
// the most ordinary way to log — had training that counted for nothing in
// the one place it matters.

/**
 * The set rows a workout event implies. Pure, so the harness can hold it.
 *
 * "bench, 3 sets of 8 at 100" is a claim about three sets, and expanding it
 * into three rows of 8×100 is a faithful expansion of exactly what was said —
 * nothing is invented, the top set is not smeared into a PR, and a missing
 * weight stays null rather than becoming a guess.
 *
 * LOGGED_AT IS THE WORKOUT'S OWN TIME, never now(). lastPerformance orders by
 * logged_at and reads the newest row's date as "last session", so stamping a
 * Monday workout structured on Thursday with Thursday's clock makes it
 * outrank a real Wednesday session — and progressionCall then prescribes from
 * the older, lighter day. Structuring days-old dictation is the ordinary case
 * for this feature, not an edge one.
 */
export function setRowsFromWorkout(userId, event = {}, { skipExercises = [] } = {}) {
  const d = event.detail || {};
  // A session-backed event already has REAL sets — the finaliser wrote the
  // event from them. Deriving more would double every gym session.
  if (d.session_id) return [];
  const exercises = Array.isArray(d.exercises) ? d.exercises : [];
  if (!exercises.length) return [];

  const skip = new Set(skipExercises);
  const at = event.occurred_at ? new Date(event.occurred_at) : null;
  const loggedAt = at && !Number.isNaN(at.getTime())
    ? at.toISOString()
    // No timestamp on the event: midday on its own date, which orders after
    // nothing that happened on a later day and before nothing on an earlier
    // one. Any fixed hour would do; noon is the one least likely to slip
    // across a day boundary in any zone.
    : (event.local_date ? `${event.local_date}T12:00:00.000Z` : null);

  const rows = [];
  // Caps are a backstop against a mangled parse, not a policy: twenty
  // exercises of ten sets is already beyond any real session.
  for (const [i, x] of exercises.slice(0, 20).entries()) {
    const name = String(x.name || '').trim();
    if (!name) continue;
    const key = exerciseKey(name);
    // Already covered by real sets from a live session that day — see
    // syncSetsFromWorkouts. Re-telling a workout you logged set by set must
    // not double it.
    if (skip.has(key)) continue;
    const n = Math.min(Math.max(parseInt(x.sets, 10) || 1, 1), 10);
    const reps = x.reps != null ? Math.round(Number(x.reps)) || null : null;
    const kg = x.weight_kg != null ? Number(x.weight_kg) || null : null;
    for (let s = 1; s <= n; s++) {
      rows.push({
        user_id: userId,
        session_id: null,
        event_id: event.id ?? null,
        exercise: name.slice(0, 120),
        exercise_key: key,
        set_number: s,
        position: i + 1,
        reps,
        weight_kg: kg,
        rpe: null,
        muscles: Array.isArray(d.muscles) ? d.muscles : [],
        note: null,
        local_date: event.local_date,
        ...(loggedAt ? { logged_at: loggedAt } : {}),
      });
    }
  }
  return rows;
}

// Whether wrought_sets has event_id (migration 016). Probed once per warm
// container, because the answer cannot change under a running process.
let _hasEventId = null;

export async function setsCanBeTracked() {
  if (_hasEventId !== null) return _hasEventId;
  const { error } = await supabase.from('wrought_sets').select('event_id').limit(1);
  _hasEventId = !error;
  return _hasEventId;
}

// Test seam: the harness has no database, and a stale probe would leak
// between cases.
export function _resetEventIdProbe(v = null) { _hasEventId = v; }

/**
 * Write the derived sets for workout events.
 *
 * THREE THINGS MAKE THIS SAFE, and each of them is a bug that was found by
 * review rather than by running it:
 *
 * 1. IT REFUSES TO RUN WITHOUT 016. Without event_id there is no way to
 *    identify an event's own derived rows, so a re-sync could only ever ADD a
 *    second copy — an amend of "that was 105, not 100" would leave both, and
 *    the corrected-away number would keep feeding every strength read forever.
 *    A feature that waits for a migration is a small cost; a lift record
 *    quietly holding retracted numbers is not recoverable by the person it
 *    happens to. The caller surfaces the skip rather than swallowing it.
 * 2. INSERT FIRST, THEN DELETE THE OLD. Delete-then-insert is two round trips
 *    with no transaction between them: a timeout after the delete erases a
 *    workout's entire set record and returns an error every caller ignored.
 *    Reversed, the worst case is a duplicate — visible, and cleaned up by the
 *    next successful sync — rather than a silent total loss.
 * 3. A DAY ALREADY COVERED BY A LIVE SESSION IS LEFT ALONE. Training set by
 *    set and then re-telling the same workout ("log today's workout: bench
 *    3×8") would otherwise write a second copy beside the real one, and every
 *    read that keys sessions by session_id-or-date would see two sessions.
 *
 * @param events  the workout events to (re)derive. Non-workout events are
 *                still accepted and CLEAR their derived sets — a mis-typed
 *                entry re-classified away from a workout must not leave
 *                phantom training behind.
 */
export async function syncSetsFromWorkouts(userId, events = []) {
  const touched = events.filter(e => e?.id != null);
  if (!touched.length) return { written: 0 };

  if (!(await setsCanBeTracked())) {
    return { written: 0, skipped: 'needs_migration',
             say: 'Sets from a logged workout need schema/016_wrought_set_source.sql before they can be filed safely.' };
  }

  const ids = touched.map(e => e.id);
  const dates = [...new Set(touched.map(e => e.local_date).filter(Boolean))];

  // What already has REAL sets on those days, from a live session.
  let covered = new Set();
  if (dates.length) {
    const { data: live } = await supabase.from('wrought_sets')
      .select('exercise_key, local_date, session_id')
      .eq('user_id', userId).in('local_date', dates).not('session_id', 'is', null);
    covered = new Set((live || []).map(r => `${r.local_date}::${r.exercise_key}`));
  }

  const all = [];
  for (const ev of touched) {
    if (ev.event_type !== 'workout') continue;      // a cleared type: delete only
    const skipExercises = [...covered]
      .filter(k => k.startsWith(`${ev.local_date}::`))
      .map(k => k.split('::')[1]);
    all.push(...setRowsFromWorkout(userId, ev, { skipExercises }));
  }

  // 2: insert first. A failure here leaves the previous rows exactly as they
  // were, which is the recoverable direction.
  let fresh = [];
  if (all.length) {
    const { data, error } = await supabase.from('wrought_sets').insert(all).select('id');
    if (error) return { written: 0, error: error.message };
    fresh = (data || []).map(r => r.id);
  }

  // Then retire the previous derivation of these same events. Scoped by user
  // as well as event id, so a crafted id can never reach another account.
  let q = supabase.from('wrought_sets').delete()
    .eq('user_id', userId).in('event_id', ids);
  if (fresh.length) q = q.not('id', 'in', `(${fresh.join(',')})`);
  const { error: delErr } = await q;
  if (delErr) return { written: all.length, error: `stale sets not cleared: ${delErr.message}` };

  return { written: all.length, ...(all.length < countClaimed(touched) ? { deduped: true } : {}) };
}

// How many rows the events CLAIMED, before anything was skipped for being
// already covered — so the caller can tell "nothing to write" from "all of it
// was already there".
function countClaimed(events) {
  let n = 0;
  for (const ev of events) {
    if (ev.event_type !== 'workout') continue;
    for (const x of (ev.detail?.exercises || []).slice(0, 20)) {
      if (!String(x.name || '').trim()) continue;
      n += Math.min(Math.max(parseInt(x.sets, 10) || 1, 1), 10);
    }
  }
  return n;
}

/**
 * Derive sets for workout events that predate the bridge.
 *
 * The bridge only fires when an event is WRITTEN — logged, amended or
 * structured. Every workout that went in before it existed, or before 016
 * was run, sits with its exercises on the event and nothing in the set
 * record: the founder's own bench, rows and shoulder press from the night
 * the connector was still refusing sessions. "None of the exercises landed"
 * is those events, waiting.
 *
 * Runs on the way into the dashboard, exactly like closeStaleSessions: one
 * cheap read when there is nothing to do, real work only the first time.
 * Bounded to 60 days because deriving a year of history in one page load is
 * how a dashboard times out — older events derive whenever they are next
 * touched.
 */
export async function backfillDerivedSets(userId, { sinceDate = null } = {}) {
  if (!(await setsCanBeTracked())) return { written: 0, skipped: 'needs_migration' };

  let q = supabase.from('wrought_events')
    .select('id, event_type, local_date, occurred_at, detail')
    .eq('user_id', userId).eq('event_type', 'workout')
    .order('local_date', { ascending: false }).limit(120);
  if (sinceDate) q = q.gte('local_date', sinceDate);
  const { data: events } = await q;

  // Candidates: exercises on the event, no backing session.
  const candidates = (events || []).filter(e =>
    !e.detail?.session_id && Array.isArray(e.detail?.exercises) && e.detail.exercises.length);
  if (!candidates.length) return { written: 0 };

  // Which of them already derived. One query, not one per event.
  const { data: existing } = await supabase.from('wrought_sets')
    .select('event_id').eq('user_id', userId)
    .in('event_id', candidates.map(e => e.id));
  const done = new Set((existing || []).map(r => r.event_id));

  const fresh = candidates.filter(e => !done.has(e.id));
  if (!fresh.length) return { written: 0 };

  return syncSetsFromWorkouts(userId, fresh);
}
