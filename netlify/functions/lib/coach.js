// lib/coach.js
// The trainer standing next to you — before the set, and after it.
//
// The founder: "we have to get like a professional trainer, like you're having
// your own professional trainer... asking me questions in between reps. Say
// I'm about to do my next set — where are you with this, you can go a little
// harder today or a little softer. And when I say I'm done my first set, how'd
// it go, were you struggling. So I engage you."
//
// And the day that made it concrete: "I did 285 pounds on each side, I did
// eight, my full reps with ease. I added 25, second set, and I started to
// struggle a little bit. It felt fine."
//
// That sentence is a complete autoregulation event — an easy top set, load
// added, effort rose — and every part of it arrived as WORDS. The engine that
// acts on it (nextSetLoad) needs a number, and until now the conversion from
// words to that number was left to the language model: the tool description
// literally said '"that was easy" ≈ 6'.
//
// THAT IS THE INVENTED-CALORIE FAILURE, IN THE PLACE IT HURTS FASTEST. A model
// deciding that "felt fine" means RPE 6 is a model choosing how much weight
// goes on a bar. So the conversion moves here, to the server, against a
// published scale — and where the words genuinely do not say, it returns
// nothing rather than a plausible number, because an unreported effort never
// adds weight.
//
// THE SCALE IS REPS IN RESERVE, which is what coaches actually use: RPE 10 is
// nothing left, 9 is one more rep, 8 is two, and so on (the RIR-anchored RPE
// scale in common use since Zourdos et al. 2016). It is worth being exact
// about this because RIR is a question a lifter can actually answer — "how
// many more could you have got" — where a bare 1-to-10 is a vibe.

// Ordered MOST SPECIFIC FIRST. A phrase that names a number of reps left beats
// an adjective, and an adjective beats a vague reassurance — because "it felt
// fine" was said about a set the founder had just described as a struggle.
const EFFORT = [
  // Explicit reps in reserve. The best answer there is, and the one the
  // question is designed to produce.
  { re: /\b(\d+)\s*(?:reps?\s*)?(?:in\s+(?:the\s+)?(?:tank|reserve)|left|more|to\s+go|in\s+me)\b/i,
    rir: m => Math.min(5, parseInt(m[1], 10)) },
  { re: /\b(?:could(?:'ve| have)?\s+(?:done|got(?:ten)?)\s+)(\d+)\b/i,
    rir: m => Math.min(5, parseInt(m[1], 10)) },
  { re: /\brir\s*(\d+)\b/i, rir: m => Math.min(5, parseInt(m[1], 10)) },
  { re: /\brpe\s*(\d+(?:\.\d+)?)\b/i, rpe: m => Math.min(10, parseFloat(m[1])) },

  // Failure and its neighbours. Named first among the words because getting
  // these wrong is the direction that hurts.
  { re: /\b(fail(ed|ure)?|couldn'?t\s+(lock|finish|get)|missed\s+it|no\s+rep|had\s+to\s+(rack|drop|dump))\b/i,
    rpe: () => 10, failed: true },
  { re: /\b(nothing\s+left|everything\s+i\s+had|all\s+out|maximal|absolute\s+limit|dead\s+stop)\b/i,
    rpe: () => 10 },
  { re: /\b(grind(er|ing|ed)?|barely|scraped|just\s+got\s+it|ugly|slow(ed)?\s+down|stall(ed)?)\b/i,
    rpe: () => 9.5 },

  // The working range.
  { re: /\b(struggl(e|ed|ing)|start(ed|ing)?\s+to\s+(struggle|feel\s+it)|tough|hard(er)?\s+than|dug\s+in|heavy)\b/i,
    rpe: () => 9 },
  { re: /\b(solid|strong|good\s+set|clean|controlled|moved\s+well|sharp)\b/i, rpe: () => 8 },
  { re: /\b(comfortable|manageable|fine\s+but|nothing\s+special|steady)\b/i, rpe: () => 7 },
  { re: /\b(eas(y|ily)|with\s+ease|smooth|light|flew|no\s+(problem|issue|trouble)|breez|too\s+light|felt\s+like\s+nothing)\b/i,
    rpe: () => 6 },
];

/**
 * Their words about a set, on the scale the engine works in.
 *
 * @returns { rpe, rir, failed, said, basis } or { rpe: null } when the words
 *          do not actually report an effort. NULL IS A REAL ANSWER and the
 *          common one — "that's done", "logged it", "next" say nothing about
 *          how hard it was, and inventing a number for them is exactly what
 *          this function exists to stop.
 */
export function effortFromWords(text = '') {
  const t = String(text || '').trim();
  if (!t) return { rpe: null, rir: null, said: null };

  // EVERY match, not the first — because a real sentence carries more than one
  // signal and the founder's own did: "I started to struggle a little bit. It
  // felt fine." Struggle is the effort report; "fine" is reassurance.
  const hits = [];
  for (const rule of EFFORT) {
    const m = t.match(rule.re);
    if (!m) continue;
    const rpe = rule.rpe ? rule.rpe(m) : Math.max(4, 10 - rule.rir(m));
    hits.push({ rpe, failed: !!rule.failed, phrase: m[0] });
  }
  if (!hits.length) return { rpe: null, rir: null, said: t.slice(0, 200) };

  // WHEN SIGNALS CONFLICT, THE HARDER READING WINS. An overstated ease is the
  // one that puts weight on the bar; an overstated effort only holds it there.
  // Same asymmetry as every other estimate in this product: the error is
  // allowed to run in the safe direction and never the other.
  const worst = hits.reduce((a, h) => (h.rpe > a.rpe ? h : a), hits[0]);
  const conflicted = hits.some(h => Math.abs(h.rpe - worst.rpe) >= 2);

  return {
    rpe: worst.rpe,
    rir: Math.max(0, Math.round((10 - worst.rpe) * 10) / 10),
    failed: hits.some(h => h.failed) || undefined,
    said: t.slice(0, 200),
    matched: worst.phrase,
    // Said out loud when the sentence pulled two ways, so a person can correct
    // a reading rather than wonder why the weight did not move.
    ...(conflicted ? { conflicted: true, took: 'the harder reading' } : {}),
    basis: 'their own words, on the RIR-anchored RPE scale — 10 is nothing left, 9 is one more rep, 8 is two.',
  };
}

/**
 * The question before the set.
 *
 * ONE line, and it is a real question rather than a greeting: a trainer asks
 * where you are today because the answer changes the first load, and a rest
 * gap is the only moment somebody will answer it. Readiness gets the first
 * word when the body has already said something — the veto belongs before the
 * plan, exactly as it does at the session's start.
 */
export function beforeSet({ exercise = null, setNumber = 1, load = null,
                            ready = null, lastTime = null } = {}) {
  const first = setNumber <= 1;
  const soft = ready?.known && ready.state !== 'ready';

  const ask = first
    ? (soft
        // NEVER OFFERS "HARDER" ON A DAY THE BODY HAS FLAGGED. The founder
        // asked for "a little harder or a little softer"; on a strained day
        // only one of those is on the table, and offering both would let a
        // tool talk somebody into a session their own numbers argued against.
        ? 'Where are you with this today — want to keep it where it is, or take it down a touch?'
        : 'Where are you with this today — as it is, a little harder, or a little softer?')
    : 'Ready for the next one?';

  return {
    ask,
    ...(exercise ? { exercise } : {}),
    ...(load != null ? { opening_load_kg: load } : {}),
    ...(lastTime ? { last_time: lastTime } : {}),
    readiness_first: !!soft,
    say: [soft ? ready.say : null, ask].filter(Boolean).join(' '),
    note:
      'Ask this in ONE short line and then stop — they are standing at a rack holding a phone. ' +
      (soft ? 'The recovery line goes FIRST and it only ever means lighter; do not offer "harder" today. ' : '') +
      'If they answer with a direction, pass it to log_set as `adjust` on the next set. If they ignore it, ' +
      'hand over the load and say nothing more — a question that blocks the set is one they stop answering.',
  };
}

/**
 * The question after the set, and what to do with the answer.
 *
 * The founder: "how'd you go, were you struggling?" — asked because the answer
 * is the input the whole progression runs on, not because a coach is making
 * conversation. It is phrased as REPS LEFT because that is a question a person
 * can answer honestly mid-session, where "rate that out of ten" is a quiz.
 */
export function afterSet({ reps = null, target = null, hadEffort = false } = {}) {
  if (hadEffort) {
    return {
      ask: null,
      note: 'They already said how it felt — do NOT ask again. Relay the next load and stop.',
    };
  }
  const short = target != null && reps != null && reps < target;
  return {
    ask: short
      ? 'How did that one go — did it come apart, or just run out?'
      : 'How did that feel — how many more could you have got?',
    note:
      'Ask ONCE, in the same message as the count, and never as a separate turn. Pass their reply VERBATIM to ' +
      'log_set as `felt` — do NOT convert it to a number yourself. The server reads the words against the ' +
      'RIR scale, and it is what decides the next load: a wrong reading here is weight on a bar. ' +
      'If they do not answer, the load holds — that is deliberate, and it is why an unreported effort never ' +
      'adds weight.',
  };
}

// ── How professional coaches actually run this ──────────────────────────────
//
// The founder: "I need you to investigate what pro trainers would be doing...
// how pro trainers train to elite level, and then we could suggest that and
// I'll see if I want it or not."
//
// The last clause is the design. These are OFFERED and never imposed: a method
// somebody did not choose is a method they abandon in week two, and the whole
// product already refuses to prescribe for a stranger.
//
// HONEST PROVENANCE: this is established published methodology — the
// RIR-anchored RPE scale, double progression, top-set-and-back-offs, planned
// deloads — not a live survey of what any particular coach is doing this
// month. It is named as such wherever it is offered, for the same reason a
// calorie estimate is labelled: a method presented as insider knowledge when
// it is textbook is a small lie that makes the honest parts harder to believe.
export const METHODS = [
  {
    key: 'rir',
    name: 'Reps in reserve',
    what: 'After a set you say how many more you could have got. That number sets the next load.',
    why: 'It is the question a lifter can actually answer mid-session, and it is the input everything else here runs on. Already how WROUGHT works — this just makes it explicit.',
    costs: 'One short answer per set.',
    tier: 'any',
  },
  {
    key: 'top_backoff',
    name: 'Top set, then back-offs',
    what: 'One hard set at the day\'s best load, then two or three sets at roughly 10% less for the same reps.',
    why: 'The heavy single set drives the strength; the lighter sets give the volume that actually builds the muscle, without four maximal sets to recover from.',
    costs: 'Slightly longer sessions than straight sets.',
    tier: 'intermediate',
  },
  {
    key: 'double_progression',
    name: 'Double progression',
    what: 'Hold the weight until you hit the top of a rep range on every set, then add the smallest jump and start at the bottom of the range again.',
    why: 'Progress without ever guessing a weight. This is what WROUGHT already does between sessions.',
    costs: 'Feels slow, and is the reason it keeps working.',
    tier: 'any',
  },
  {
    key: 'planned_deload',
    name: 'A deload before you need one',
    what: 'Every fourth to sixth week: same lifts, same reps, about half the sets.',
    why: 'Anybody who waits until they feel like they need one takes it a fortnight late, as an injury. It is the single most skipped thing in training, which is why a block schedules it for you.',
    costs: 'A week that feels too easy. That is the point.',
    tier: 'any',
  },
  {
    key: 'wave',
    name: 'Wave loading',
    what: 'Three-week waves: moderate, harder, hardest, then step the whole wave up and repeat.',
    why: 'Gives a stall somewhere to go that is not simply more weight every week — which is the pattern that breaks first.',
    costs: 'Needs planning across weeks, so it wants a block rather than a single session.',
    tier: 'advanced',
  },
  {
    key: 'bar_speed',
    name: 'Watching bar speed',
    what: 'Stop the set when the bar visibly slows, rather than at a fixed rep count.',
    why: 'How elite lifters autoregulate day to day. It is the honest version of "listen to your body" — a slowing bar is observable, a feeling is not.',
    costs: 'Needs a judgement call, and WROUGHT cannot see it. Your read, recorded in your words.',
    tier: 'advanced',
  },
];

/**
 * The methods worth offering this lifter, and never more than a couple at once.
 *
 * A list of six is a menu nobody reads. Two, with what each costs, is a choice
 * somebody can actually make — and the tier gate is the same one the library
 * uses: an advanced method handed to a beginner is how good advice becomes a
 * bad session.
 */
export function methodsFor({ tier = 'intermediate', stalled = false, using = [] } = {}) {
  const RANK = { beginner: 0, intermediate: 1, advanced: 2, any: 0 };
  const ceiling = RANK[tier] ?? 1;
  const have = new Set(using);

  const pool = METHODS.filter(m => (RANK[m.tier] ?? 0) <= ceiling && !have.has(m.key));

  // A stalled lift changes what is worth raising: the methods that exist to
  // break a plateau go first, and only then the ones that are simply good
  // practice.
  const order = stalled
    ? ['top_backoff', 'wave', 'planned_deload', 'bar_speed', 'double_progression', 'rir']
    : ['rir', 'double_progression', 'planned_deload', 'top_backoff', 'bar_speed', 'wave'];

  const picked = pool.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)).slice(0, 2);

  return {
    offer: picked,
    provenance: 'Established published methodology — the RIR-anchored RPE scale, double progression, top-set-and-back-offs, planned deloads. Not a live survey of any particular coach.',
    note: picked.length
      ? 'Offer these as OPTIONS, in one or two short lines each, with what they cost. Never adopt one on their ' +
        'behalf and never present them as insider knowledge — they are textbook, and saying so is what makes the ' +
        'rest of the numbers here believable. If they want one, say so plainly and it changes how sessions are ' +
        'built from then on.'
      : 'Nothing new worth offering — do not repeat methods they are already running.',
  };
}
