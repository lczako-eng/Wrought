// netlify/functions/lib/library.js
// The movement library and the programmes built from it.
//
// The founder's actual complaint: "I have an S tier workout list of exercises
// that are rated really highly, but I'm turning pages all the time, can't find
// half this shit." A list you have to scroll is not a library — it is a filing
// problem. This turns it into something you ask a question of.
//
// Two rules govern everything in this file, and both come straight from the
// doctrines:
//
//   NO LOADS. Not one movement here carries a weight, and no programme
//   prescribes one. Loads come from progressionCall() against the person's own
//   history, or they come as an RPE. Guessing a stranger's working weight is
//   the fastest way this product injures somebody, and a library is exactly
//   where that mistake would look most reasonable.
//
//   TIER CHANGES WHAT IS OFFERED, NOT JUST THE VOLUME. A beginner gets
//   compounds they can learn and every movement explained. An advanced lifter
//   gets named movements and is left alone. Handing a novice an advanced split
//   is not ambition, it is six weeks of junk volume and a tweaked back.
//
// "Rated highly" here means the movement earns its place by pattern coverage
// and how well it loads — not by being fashionable. Anything included is
// something a competent coach would program without needing to justify it.

export const PATTERNS = [
  'squat', 'hinge', 'horizontal push', 'vertical push',
  'horizontal pull', 'vertical pull', 'lunge', 'carry', 'core', 'conditioning',
];

// tier is the FLOOR — the least experience at which this is sensible to
// program. An advanced lifter still squats; a beginner has no business under a
// heavy snatch-grip anything.
export const MOVEMENTS = [
  // ── Squat ────────────────────────────────────────────────────────────────
  { name: 'Back Squat',        pattern: 'squat',  tier: 'intermediate', equipment: ['barbell', 'rack'], muscles: ['legs', 'glutes', 'core'], cue: 'Brace before you unrack, not after. Knees track over the middle toes.' },
  { name: 'Goblet Squat',      pattern: 'squat',  tier: 'beginner',     equipment: ['dumbbell'],        muscles: ['legs', 'glutes'],         cue: 'Hold the bell at your chest and let it counterweight you. The easiest squat to learn depth with.' },
  { name: 'Front Squat',       pattern: 'squat',  tier: 'advanced',     equipment: ['barbell', 'rack'], muscles: ['legs', 'core'],           cue: 'Elbows up the whole way. The moment they drop, the bar follows.' },
  { name: 'Leg Press',         pattern: 'squat',  tier: 'beginner',     equipment: ['machine'],         muscles: ['legs', 'glutes'],         cue: 'Do not let your lower back round off the pad at the bottom.' },

  // ── Hinge ────────────────────────────────────────────────────────────────
  { name: 'Romanian Deadlift', pattern: 'hinge',  tier: 'intermediate', equipment: ['barbell'],         muscles: ['legs', 'glutes', 'back'], cue: 'Push your hips back, do not bend down. Stop where your hamstrings stop you.' },
  { name: 'Deadlift',          pattern: 'hinge',  tier: 'intermediate', equipment: ['barbell'],         muscles: ['back', 'legs', 'glutes'], cue: 'Take the slack out of the bar before you pull. It should click, not clang.' },
  { name: 'Hip Thrust',        pattern: 'hinge',  tier: 'beginner',     equipment: ['barbell', 'bench'], muscles: ['glutes'],                cue: 'Chin tucked, ribs down, squeeze at the top rather than arching your back over.' },
  { name: 'Kettlebell Swing',  pattern: 'hinge',  tier: 'beginner',     equipment: ['kettlebell'],      muscles: ['glutes', 'back', 'core'], cue: 'It is a hinge, not a squat, and the arms are rope. Snap the hips.' },

  // ── Horizontal push ──────────────────────────────────────────────────────
  { name: 'Bench Press',       pattern: 'horizontal push', tier: 'intermediate', equipment: ['barbell', 'bench'],  muscles: ['chest', 'shoulders', 'arms'], cue: 'Shoulder blades pinned back and down. Bar to the lower chest, not the throat.' },
  { name: 'Dumbbell Bench Press', pattern: 'horizontal push', tier: 'beginner',  equipment: ['dumbbell', 'bench'], muscles: ['chest', 'shoulders', 'arms'], cue: 'Kinder to the shoulders than a barbell and easier to bail out of alone.' },
  { name: 'Press-Up',          pattern: 'horizontal push', tier: 'beginner',     equipment: ['bodyweight'],        muscles: ['chest', 'shoulders', 'core'], cue: 'Ribs down, glutes on. A press-up is a moving plank.' },
  { name: 'Dip',               pattern: 'horizontal push', tier: 'advanced',     equipment: ['bars'],              muscles: ['chest', 'arms', 'shoulders'], cue: 'Lean forward for chest, stay upright for triceps. Stop at shoulder height.' },

  // ── Vertical push ────────────────────────────────────────────────────────
  { name: 'Overhead Press',    pattern: 'vertical push',   tier: 'intermediate', equipment: ['barbell'],   muscles: ['shoulders', 'arms', 'core'], cue: 'Squeeze your glutes so the press does not become a standing bench.' },
  { name: 'Seated Dumbbell Press', pattern: 'vertical push', tier: 'beginner',   equipment: ['dumbbell', 'bench'], muscles: ['shoulders', 'arms'], cue: 'Back supported. Press slightly in front of your ears, not behind.' },

  // ── Horizontal pull ──────────────────────────────────────────────────────
  { name: 'Barbell Row',       pattern: 'horizontal pull', tier: 'intermediate', equipment: ['barbell'],   muscles: ['back', 'arms'],  cue: 'Torso stays where it started. If it rises to move the bar, the weight is wrong.' },
  { name: 'Dumbbell Row',      pattern: 'horizontal pull', tier: 'beginner',     equipment: ['dumbbell', 'bench'], muscles: ['back', 'arms'], cue: 'Pull to the hip, not the armpit. Do not rotate to get another inch.' },
  { name: 'Seated Cable Row',  pattern: 'horizontal pull', tier: 'beginner',     equipment: ['machine'],   muscles: ['back', 'arms'],  cue: 'Chest tall. Let the shoulder blades travel — do not lock them still.' },
  { name: 'Inverted Row',      pattern: 'horizontal pull', tier: 'beginner',     equipment: ['bodyweight', 'bars'], muscles: ['back', 'arms'], cue: 'The lower the bar, the harder it is. A whole pull-up progression on its own.' },

  // ── Vertical pull ────────────────────────────────────────────────────────
  { name: 'Pull-Up',           pattern: 'vertical pull',   tier: 'intermediate', equipment: ['bars'],      muscles: ['back', 'arms'],  cue: 'Start from a dead hang every rep. Half a rep is not a rep.' },
  { name: 'Lat Pulldown',      pattern: 'vertical pull',   tier: 'beginner',     equipment: ['machine'],   muscles: ['back', 'arms'],  cue: 'Pull to your collarbone with your elbows, not with your hands.' },
  { name: 'Chin-Up',           pattern: 'vertical pull',   tier: 'intermediate', equipment: ['bars'],      muscles: ['back', 'arms'],  cue: 'Underhand grip. More biceps, and most people can do more of them.' },

  // ── Lunge / single leg ───────────────────────────────────────────────────
  { name: 'Walking Lunge',     pattern: 'lunge',  tier: 'beginner',     equipment: ['dumbbell', 'bodyweight'], muscles: ['legs', 'glutes'], cue: 'Step out far enough that the front shin stays near vertical.' },
  { name: 'Bulgarian Split Squat', pattern: 'lunge', tier: 'intermediate', equipment: ['dumbbell', 'bench'],  muscles: ['legs', 'glutes'], cue: 'Brutal and worth it. Front foot far enough out that the back knee drops straight down.' },
  { name: 'Step-Up',           pattern: 'lunge',  tier: 'beginner',     equipment: ['dumbbell', 'bench'],      muscles: ['legs', 'glutes'], cue: 'Drive through the top foot. Do not push off the floor with the trailing leg.' },

  // ── Carry / core ─────────────────────────────────────────────────────────
  { name: 'Farmer\'s Carry',   pattern: 'carry',  tier: 'beginner',     equipment: ['dumbbell', 'kettlebell'], muscles: ['core', 'back', 'arms'], cue: 'Tall, quiet steps. Grip usually fails first, which is the point.' },
  { name: 'Plank',             pattern: 'core',   tier: 'beginner',     equipment: ['bodyweight'],             muscles: ['core'],                 cue: 'Squeeze everything. Thirty hard seconds beats three soft minutes.' },
  { name: 'Hanging Knee Raise', pattern: 'core',  tier: 'intermediate', equipment: ['bars'],                   muscles: ['core'],                 cue: 'Curl the pelvis up. Swinging the legs is a hip flexor exercise.' },
  { name: 'Ab Wheel',          pattern: 'core',   tier: 'advanced',     equipment: ['wheel'],                  muscles: ['core'],                 cue: 'Ribs down the whole way out. If your back arches, you went too far.' },

  // ── Conditioning ─────────────────────────────────────────────────────────
  { name: 'Rowing Machine',    pattern: 'conditioning', tier: 'beginner', equipment: ['machine'], muscles: ['full body'], cue: 'Legs, then back, then arms. Reverse it coming back.' },
  { name: 'Incline Walk',      pattern: 'conditioning', tier: 'beginner', equipment: ['machine', 'bodyweight'], muscles: ['legs'], cue: 'The most under-rated conditioning there is. You can hold a conversation and still recover from it.' },
];

const TIER_RANK = { beginner: 0, intermediate: 1, advanced: 2 };

// A programme is an ordered schedule over patterns, not over named lifts. The
// names get chosen at the last moment against what the person actually owns,
// which is why "I only have dumbbells" does not need its own separate library.
export const PROGRAMMES = [
  {
    id: 'full-body-3',
    name: 'Full Body, 3 days',
    tier: 'beginner', days: 3, minutes: 50,
    why: 'Every pattern three times a week. For anyone under about a year of consistent training this beats any split, because the limit is practice rather than recovery.',
    sessions: [
      { name: 'Full Body A', patterns: ['squat', 'horizontal push', 'horizontal pull', 'core'] },
      { name: 'Full Body B', patterns: ['hinge', 'vertical push', 'vertical pull', 'carry'] },
      { name: 'Full Body C', patterns: ['lunge', 'horizontal push', 'horizontal pull', 'conditioning'] },
    ],
  },
  {
    id: 'upper-lower-4',
    name: 'Upper / Lower, 4 days',
    tier: 'intermediate', days: 4, minutes: 60,
    why: 'The most reliable split there is. Everything gets hit twice a week, which is where the evidence on frequency actually sits, and it survives missing a day.',
    sessions: [
      { name: 'Upper A', patterns: ['horizontal push', 'horizontal pull', 'vertical push', 'vertical pull'] },
      { name: 'Lower A', patterns: ['squat', 'hinge', 'lunge', 'core'] },
      { name: 'Upper B', patterns: ['vertical push', 'vertical pull', 'horizontal push', 'horizontal pull'] },
      { name: 'Lower B', patterns: ['hinge', 'squat', 'lunge', 'carry'] },
    ],
  },
  {
    id: 'push-pull-legs-6',
    name: 'Push / Pull / Legs, 6 days',
    tier: 'advanced', days: 6, minutes: 70,
    why: 'High volume, twice-weekly frequency, and it demands six real sessions. Worth it only if you already train consistently — done at four days a week it is just an upper/lower with gaps.',
    sessions: [
      { name: 'Push', patterns: ['horizontal push', 'vertical push', 'horizontal push'] },
      { name: 'Pull', patterns: ['vertical pull', 'horizontal pull', 'horizontal pull'] },
      { name: 'Legs', patterns: ['squat', 'hinge', 'lunge', 'core'] },
    ],
  },
  {
    id: 'minimal-2',
    name: 'Two days, everything',
    tier: 'beginner', days: 2, minutes: 45,
    why: 'For a genuinely busy week. Two full-body sessions hold nearly all of the progress three would have made — and a programme you actually complete beats a better one you abandon.',
    sessions: [
      { name: 'Whole Body A', patterns: ['squat', 'horizontal push', 'horizontal pull'] },
      { name: 'Whole Body B', patterns: ['hinge', 'vertical push', 'vertical pull'] },
    ],
  },
];

export function movementsFor(pattern, { equipment = null, tier = 'intermediate' } = {}) {
  const ceiling = TIER_RANK[tier] ?? 1;
  const owns = equipment?.length ? equipment.map(e => String(e).toLowerCase()) : null;

  return MOVEMENTS.filter(m => {
    if (m.pattern !== pattern) return false;
    if ((TIER_RANK[m.tier] ?? 1) > ceiling) return false;
    if (!owns) return true;
    // "full gym" is a claim to own everything; otherwise a movement is only
    // offered when the kit for it is actually there.
    if (owns.some(e => e.includes('full gym') || e.includes('gym'))) return true;
    return m.equipment.some(req => owns.some(e => e.includes(req) || req.includes(e)));
  });
}

// Which programme fits the person in front of you. Days available is the
// binding constraint, not ambition: prescribing six sessions to somebody with
// three is how a programme gets abandoned in week two.
export function pickProgramme({ days = null, tier = 'intermediate', equipment = null } = {}) {
  const ceiling = TIER_RANK[tier] ?? 1;
  const eligible = PROGRAMMES.filter(p => (TIER_RANK[p.tier] ?? 1) <= ceiling);
  const pool = eligible.length ? eligible : PROGRAMMES.filter(p => p.tier === 'beginner');

  const want = Number(days) || null;
  const best = pool.reduce((a, p) => {
    if (!a) return p;
    if (!want) return (TIER_RANK[p.tier] ?? 1) > (TIER_RANK[a.tier] ?? 1) ? p : a;
    // Never schedule more days than they said they have; among the rest, the
    // one closest to their number wins.
    const fits = x => (x.days <= want ? 0 : 1);
    if (fits(p) !== fits(a)) return fits(p) < fits(a) ? p : a;
    return Math.abs(p.days - want) < Math.abs(a.days - want) ? p : a;
  }, null);

  return best ? buildProgramme(best, { tier, equipment }) : null;
}

export function buildProgramme(programme, { tier = 'intermediate', equipment = null } = {}) {
  const beginner = tier === 'beginner';

  const sessions = programme.sessions.map(s => {
    const used = new Set();
    const exercises = s.patterns.map(pattern => {
      const options = movementsFor(pattern, { equipment, tier });
      const pick = options.find(m => !used.has(m.name)) || options[0];
      if (!pick) return null;
      used.add(pick.name);
      return {
        name: pick.name,
        pattern,
        // Volume by tier: fewer, cleaner sets while the movement is still being
        // learned; more once it is not.
        sets: beginner ? 3 : 4,
        reps: pattern === 'core' || pattern === 'carry' ? 12 : beginner ? 8 : 6,
        // No load, ever. progressionCall decides against real history, or the
        // coach prescribes an RPE.
        load_kg: null,
        rest_s: pattern === 'conditioning' ? 60 : beginner ? 120 : 150,
        muscles: pick.muscles,
        // A beginner gets told why. An advanced lifter gets left alone.
        cue: beginner || tier === 'intermediate' ? pick.cue : null,
        substitutions: options.filter(m => m.name !== pick.name).slice(0, 2).map(m => m.name),
      };
    }).filter(Boolean);

    return { name: `${s.name}`, kind: 'strength', exercises };
  });

  return {
    id: programme.id,
    name: programme.name,
    tier: programme.tier,
    days: programme.days,
    est_minutes: programme.minutes,
    why: programme.why,
    sessions,
    note: 'No weights are prescribed here on purpose — they come from your own history the first time you run each lift, or as an RPE if there is no history yet.',
  };
}
