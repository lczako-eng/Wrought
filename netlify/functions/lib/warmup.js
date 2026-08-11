// netlify/functions/lib/warmup.js
// The five minutes before the first work set.
//
// The founder: "before workout really should ask that we're gonna start our
// workout — you know, they should recommend some stretches and so forth. You
// can always say skip it, but should be part of that package."
//
// Both halves of that matter. It has to be OFFERED, because nobody warms up on
// their own and the thing that gets skipped is always the thing nobody
// mentioned. And it has to be SKIPPABLE in one word, because a warm-up that
// stands between somebody and the bar is a warm-up they resent and then a
// session they stop starting.
//
// DYNAMIC BEFORE, STATIC AFTER. This is the one piece of real content here and
// it is not a style preference: holding a long static stretch immediately
// before a heavy set measurably reduces force production for the next
// half hour. So nothing below is a held stretch — it is movement through range,
// which is what actually prepares a joint. Static stretching is worth doing and
// belongs at the END, which is where it is offered.
//
// AND IT IS NEVER PHYSIOTHERAPY. A warm-up is not a fix for a painful shoulder,
// and prescribing one for a named injury is exactly the not-a-doctor line. When
// somebody has a limitation on file the warm-up is still offered, but the
// movement selection never claims to treat it.

const BLOCKS = {
  squat: {
    match: /squat|leg press|lunge|split|step[- ]?up|hack/i,
    moves: [
      'Bodyweight squats — 10, going a little deeper each one',
      'Hip circles — 5 each way, slowly',
      'Leg swings front to back — 10 a side, holding something',
    ],
  },
  hinge: {
    match: /deadlift|romanian|rdl|hinge|good morning|hip thrust|swing/i,
    moves: [
      'Glute bridges — 10, squeeze at the top',
      'Hip hinges with a broomstick or empty bar — 10',
      'Hamstring sweeps — 8 a side',
    ],
  },
  push: {
    match: /bench|press|push[- ]?up|dip|fly|chest|shoulder|overhead|ohp/i,
    moves: [
      'Arm circles — 10 forward, 10 back',
      'Band pull-aparts — 15 (or just squeeze the shoulder blades together)',
      'Push-ups — 8, slow, or on the knees',
    ],
  },
  pull: {
    match: /row|pull[- ]?up|chin|pulldown|lat|curl|face pull|shrug|back/i,
    moves: [
      'Dead hangs — 20 seconds, let the shoulders stretch out',
      'Scapular pulls — 8, just the shoulder blades, arms stay straight',
      'Cat-cow — 8 slow',
    ],
  },
  core: {
    match: /plank|crunch|core|ab|carry|farmer/i,
    moves: ['Dead bugs — 8 a side, slow', 'Bird dogs — 8 a side'],
  },
};

// Static, and only afterwards. Offered at the end of a session for the same
// reason the warm-up is offered at the start: it is the part everybody knows
// they should do and nobody does unprompted.
const COOLDOWN = [
  'Hold anything that worked hard for 30 seconds a side — quads, hamstrings, chest, lats',
  'Walk for two minutes rather than sitting straight down',
];

/**
 * A warm-up built from the session that is actually about to happen.
 *
 * Generic warm-ups get skipped because they are obviously generic — five
 * minutes of arm circles before a leg day is a reason to stop reading. This
 * reads the exercises in the plan and warms the patterns they use, which is
 * both correct and the thing that makes somebody actually do it.
 */
export function warmupFor(plan = [], { minutes = null, limitations = [] } = {}) {
  const names = plan.map(e => `${e.name || ''} ${(e.muscles || []).join(' ')}`).join(' | ');

  const picked = [];
  for (const [key, block] of Object.entries(BLOCKS)) {
    if (block.match.test(names)) picked.push({ key, moves: block.moves });
  }

  // Nothing matched — a sport session, a routine of oddly named machines. A
  // general warm-up is still better than none, and saying nothing here would
  // quietly drop the feature for exactly the sessions least likely to have one.
  const general = ['Five minutes easy on a bike, rower or just walking — enough to be slightly warm'];

  const moves = picked.length
    ? [general[0], ...picked.flatMap(p => p.moves)]
    : [...general, 'Arm circles and bodyweight squats — 10 of each'];

  // Trimmed rather than exhaustive. A twelve-item warm-up is a warm-up nobody
  // finishes, and the first three are the ones that matter.
  const trimmed = moves.slice(0, minutes && minutes <= 30 ? 4 : 6);

  return {
    minutes: trimmed.length <= 4 ? 4 : 6,
    moves: trimmed,
    patterns: picked.map(p => p.key),
    skippable: true,
    // Not static stretching, and the reason is worth one clause because it is
    // the opposite of what most people were taught at school.
    style: 'Movement through range, not held stretches — holding a stretch right before a heavy set costs you force for the next half hour. Save the holding for the end.',
    cooldown: COOLDOWN,
    ...(limitations.length ? {
      caution: 'They have a limitation on file. Warming up is not treatment for it — do not present any of this as fixing or rehabilitating anything, and if a movement touches the area, say to leave it out rather than working through it.',
    } : {}),
    say: `Warm-up, about ${trimmed.length <= 4 ? 4 : 6} minutes: ${trimmed.join('; ')}.`,
  };
}

/** How much of the session is actually done — sets, not exercises. */
export function sessionProgress(plan = [], setsDone = []) {
  const planned = plan.reduce((a, e) => a + (Number(e.sets) || 0), 0);

  const byExercise = plan.map(e => {
    const target = Number(e.sets) || 0;
    // Sets are matched on the exercise NAME as it was planned. A swap rewrites
    // the plan entry, so this stays right through a machine being taken.
    const done = setsDone.filter(s =>
      String(s.exercise || '').toLowerCase() === String(e.name || '').toLowerCase()).length;
    return {
      exercise: e.name,
      target: `${target}×${e.reps}`,
      sets: target,
      done: Math.min(done, target),
      complete: target > 0 && done >= target,
    };
  });

  const done = byExercise.reduce((a, e) => a + e.done, 0);
  // Uncapped would be wrong here in the other direction: extra sets are real
  // work but "112% complete" reads as a bug, so the bar fills and the count
  // stays honest underneath.
  const percent = planned ? Math.min(100, Math.round((done / planned) * 100)) : 0;

  return {
    sets_done: done,
    sets_planned: planned,
    percent,
    exercises: byExercise,
    exercises_complete: byExercise.filter(e => e.complete).length,
    say: planned
      ? `${percent}% through — ${done} of ${planned} sets.`
      : `${done} set${done === 1 ? '' : 's'} in.`,
  };
}
