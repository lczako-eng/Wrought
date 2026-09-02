// netlify/functions/lib/intake.js
// The things worth knowing, why most of them never block anything, and why
// the ones that do are asked one at a time with something to tap.
//
// The founder: "your intake plan should have at least 20 questions about your
// health and what you work out."
//
// He is right that more context makes better coaching, and wrong about the
// delivery — and the two halves of that are worth separating carefully,
// because the settled doctrine is "five facts, asked once, together, never as
// an opener", and twenty questions at signup is the single most reliable way
// to make somebody close the tab. Every abandoned health app on earth has a
// twenty-question onboarding.
//
// So: THE QUESTIONS EXIST. They are just never asked at once.
//
// THE FOUNDER OVERRODE HALF OF THAT, twice, and the second time is decisive:
// "we should put that as a stop place — we can't further any workouts until
// the questionnaire is finished." So part of the questionnaire is a GATE, and
// the line it gates is drawn precisely:
//
//   WROUGHT never refuses to RECORD. A meal, a weight, a set somebody already
//   did — capture is the soul of the product and gating it would kill the
//   memory. log, log_set and the briefs stay open forever.
//
//   WROUGHT refuses to PRESCRIBE until it knows who it is prescribing for.
//   suggest_workout, design_workout, programmes, start_block and start_session
//   WITH NO ROUTINE NAMED stop at the gate — building a plan for a stranger is
//   guesswork wearing a coach's voice.
//
//   AND THE LINE MOVED TWICE, ON HIS CALL. First: a saved workout runs
//   whatever the questionnaire says — that is their own plan, not WROUGHT
//   prescribing. Second, and the one this file is shaped around: the gate
//   blocked a mat workout over alcohol intake and takeaway habits. "A lot of
//   that stuff there is kind of irrelevant, so I don't see why it's stopping
//   you from getting a workout." He is right. THE GATE IS ONLY WHAT BUILDING A
//   WORKOUT ACTUALLY NEEDS: the five facts the arithmetic runs on, the plan
//   (what for, how fast, how hard to chase), the training commitment (strength
//   sessions, stamina sessions, minutes a week — the terms notifications are
//   built on), the tier, the kit, and anything to work around. Everything
//   about food habits, sleep, medication, sports and how blunt to be is still
//   worth knowing and is picked up in passing — it never stands between
//   somebody and a session.
//
// HOW THE GATE ASKS. One question per message, with something to tap — a
// numbered menu in the conversation, buttons on the website — saved the moment
// it is answered, and the tool that saves it hands back the next one. "OK, you
// have outstanding questions, let's finish this: here's a question. After you
// answer it, it saves it." The old shape (four per message, saved via four
// different tools) produced a screenshot of all fifteen dumped at once and
// "I'll get those locked in" with nothing written. A tool result carrying the
// next question is the one surface a model cannot skip.
//
// "Finished" means every GATING item answered — and "none" IS an answer. No
// injuries is worth exactly as much as an injury, and recording it is what
// lets the questionnaire actually end.

// The web page and the assistant both need to know where to send somebody to
// do this on a screen. One constant, so the two doors name the same place.
export const SETUP_URL = 'https://wrought.fit/app.html#setup';

// Shared option lists — the labels are what a person sees on a button and
// what a model reads in a numbered menu, so they are written for a person.
const YESNO_NONE = { none: true };
const COUNT = Array.from({ length: 7 }, (_, i) => ({ v: i, label: i === 6 ? '6 or more' : String(i) }));

// Where each fact lives once it is known. `profile` fields are columns;
// `goal` items are goal rows; `event` is a weigh-in; everything else is a
// memory row in the named category, which is why the soft half needs no
// migration and why free-text answers survive intact.
//
// `gate` is whether BUILDING a workout waits on it. `hard` is the older, narrower
// marker: the five the arithmetic cannot run without, still asked together in
// one message the first time a number needs them.
//
// `kind`: choice (tap one), number (type one, with a unit), text (say it, with
// "none" as a real answer where marked), list (several, comma separated or
// tapped from quick picks).
export const INTAKE = [
  // ── The five that arithmetic cannot run without ─────────────────────────
  { key: 'height_cm', gate: true, hard: true, where: 'profile', kind: 'number', unit: 'cm', alt_unit: 'in',
    ask: 'How tall are you', asks: 'how tall they are', hint: '190 cm, or 6\'3' },
  { key: 'birth_year', gate: true, hard: true, where: 'profile', kind: 'number',
    ask: 'What year were you born', asks: 'what year they were born', hint: 'four digits' },
  { key: 'sex', gate: true, hard: true, where: 'profile', kind: 'choice',
    ask: 'Male or female — it changes the metabolic formula', asks: 'male or female, for the metabolic formula',
    options: [{ v: 'male', label: 'Male' }, { v: 'female', label: 'Female' }] },
  { key: 'weight', gate: true, hard: true, where: 'event', kind: 'number', unit: 'kg', alt_unit: 'lb',
    ask: 'What do you weigh at the moment', asks: 'what they weigh now', hint: '84 kg, or 185 lb' },
  { key: 'activity_level', gate: true, hard: true, where: 'profile', kind: 'choice',
    ask: 'How much are you on your feet in a normal day', asks: 'how much they are on their feet in a normal day',
    options: [
      { v: 'sedentary', label: 'Desk job, little walking' },
      { v: 'light', label: 'Some walking' },
      { v: 'moderate', label: 'On my feet a fair bit' },
      { v: 'very', label: 'Physical job, most of the day' },
    ] },

  // ── Anything to work around — asked before the plan, because programming
  //    around an injury nobody mentioned is how this hurts somebody ─────────
  { key: 'limitations', gate: true, where: 'memory', category: 'health', kind: 'text', ...YESNO_NONE,
    ask: 'Any injuries, joints or movements to work around', asks: 'any injuries, joints or movements to work around',
    none_fact: 'No injuries, joints or movements to work around' },

  // ── The plan ────────────────────────────────────────────────────────────
  { key: 'intent', gate: true, where: 'goal', kind: 'choice',
    ask: 'What are you actually after', asks: 'what they are actually after — losing, gaining, or both',
    options: [
      { v: 'lose', label: 'Lose fat' },
      { v: 'gain', label: 'Build muscle' },
      { v: 'recomp', label: 'Both — lose fat and build muscle' },
      { v: 'maintain', label: 'Hold where I am' },
    ] },
  { key: 'plan_pace', gate: true, where: 'profile', kind: 'choice',
    ask: 'How fast do you want it', asks: 'how fast they want it — gentle, steady or aggressive',
    options: [
      { v: 'gentle', label: 'Gentle — slow, the kind people finish' },
      { v: 'steady', label: 'Steady — the default' },
      { v: 'aggressive', label: 'Aggressive — the fast end of safe, hungrier' },
    ] },
  { key: 'plan_push', gate: true, where: 'profile', kind: 'choice',
    ask: 'How hard should WROUGHT chase you when you are behind', asks: 'how hard WROUGHT should chase them when they are behind',
    options: [
      { v: 'light', label: 'Light — only when it really matters' },
      { v: 'normal', label: 'Normal' },
      { v: 'relentless', label: 'Relentless — bring it up every time' },
    ] },

  // ── The commitment — in the terms the notifications are built on ────────
  { key: 'strength_per_week', gate: true, where: 'profile', kind: 'choice', options: COUNT,
    ask: 'How many muscle-building sessions a week will you honestly do',
    asks: 'how many strength (muscle-building) sessions a week they will honestly do' },
  { key: 'cardio_per_week', gate: true, where: 'profile', kind: 'choice', options: COUNT,
    ask: 'How many stamina sessions a week — running, cycling, rowing, sport',
    asks: 'how many stamina (cardio) sessions a week they will honestly do' },
  { key: 'minutes_per_week', gate: true, where: 'profile', kind: 'number', unit: 'min',
    quick: [60, 90, 120, 150, 180, 240, 300, 360],
    ask: 'How many minutes a week, in total, will you commit to training',
    asks: 'how many minutes a week in total they will commit to training', hint: '180 is three hours' },

  // ── The rest of what a session needs ────────────────────────────────────
  { key: 'training_age', gate: true, where: 'profile', kind: 'choice',
    ask: 'How long have you been training', asks: 'how long they have been training',
    options: [
      { v: 'beginner', label: 'New to it — under a year' },
      { v: 'intermediate', label: 'A while — one to three years' },
      { v: 'advanced', label: 'Years' },
    ] },
  { key: 'equipment', gate: true, where: 'profile', kind: 'list',
    quick: ['full gym', 'dumbbells', 'barbell', 'kettlebell', 'bands', 'machines', 'cables', 'treadmill', 'bike', 'rower', 'bodyweight only'],
    ask: 'What kit have you actually got access to', asks: 'what kit they actually have access to' },

  // ── Picked up in passing — never at the gate ────────────────────────────
  { key: 'goal_weight', where: 'goal', kind: 'text',
    ask: 'Have you got a weight in mind, and by when', asks: 'whether they have a weight in mind, and by when' },
  { key: 'sports', where: 'memory', category: 'training', kind: 'text', ...YESNO_NONE,
    ask: 'Anything you do outside the gym — five-a-side, running, climbing',
    asks: 'anything they do outside the gym — five-a-side, running, climbing',
    none_fact: 'Nothing regular outside the gym' },
  { key: 'lifts', where: 'memory', category: 'lifts', kind: 'text', ...YESNO_NONE,
    ask: 'Roughly what do you lift on the main movements',
    asks: 'roughly what they lift on the main movements, so the first session is not a guess',
    none_fact: 'No main-lift numbers to go on yet' },
  { key: 'conditions', where: 'memory', category: 'health', kind: 'text', ...YESNO_NONE,
    ask: 'Anything a doctor is already managing that food or training affects',
    asks: 'anything a doctor is already managing that food or training affects — recorded, never advised on',
    none_fact: 'Nothing under a doctor that food or training affects' },
  { key: 'medication', where: 'memory', category: 'health', kind: 'text', ...YESNO_NONE,
    ask: 'Does anything you take affect appetite, weight or heart rate',
    asks: 'whether anything they take affects appetite, weight or heart rate — recorded only, never advised on',
    none_fact: 'Nothing taken that affects appetite, weight or heart rate' },
  { key: 'sleep', where: 'memory', category: 'health', kind: 'text',
    ask: 'What is your sleep usually like', asks: 'roughly what their sleep is like' },
  { key: 'dietary', where: 'profile', kind: 'list', ...YESNO_NONE,
    quick: ['vegetarian', 'vegan', 'no pork', 'no dairy', 'gluten free', 'no shellfish'],
    ask: 'Anything you do not eat', asks: 'anything they do not eat' },
  { key: 'cooking', where: 'memory', category: 'food', kind: 'text',
    ask: 'How do you usually eat — cooking, takeaways, canteen, shifts',
    asks: 'how they usually eat — cooking, takeaways, canteen, shifts' },
  { key: 'alcohol', where: 'memory', category: 'food', kind: 'text', ...YESNO_NONE,
    ask: 'Roughly how much do you drink', asks: 'roughly how much they drink, since it is the most under-logged thing there is',
    none_fact: 'Does not drink' },
  { key: 'weak_spot', where: 'memory', category: 'food', kind: 'text',
    ask: 'Where does your eating actually fall apart — evenings, weekends, stress, the drive home',
    asks: 'where their eating actually falls apart — evenings, weekends, stress, the drive home' },
  { key: 'bluntness', where: 'profile', kind: 'choice',
    ask: 'How hard do you want the verdict to hit', asks: 'how hard they want the verdict to hit',
    options: [{ v: 'gentle', label: 'Gentle' }, { v: 'honest', label: 'Honest' }, { v: 'brutal', label: 'Brutal' }] },
  { key: 'brief_hour', where: 'profile', kind: 'number', unit: 'h',
    ask: 'What time should the nightly read land', asks: 'what time the nightly read should land', hint: '21 for nine at night' },
  { key: 'timezone', where: 'profile', kind: 'text',
    ask: 'Where are you, so a day is your day', asks: 'where they are, so a day is their day', hint: 'America/Toronto' },
];

// The gating list, in the order it is asked. The five facts first because the
// arithmetic stops without them, then what to work around, then the plan, the
// commitment, and the kit.
export const GATE_KEYS = INTAKE.filter(i => i.gate).map(i => i.key);

const HAS = {
  height_cm: p => p.profile?.height_cm != null,
  birth_year: p => p.profile?.birth_year != null,
  sex: p => !!p.profile?.sex,
  weight: p => p.weightKg != null,
  activity_level: p => !!p.profile?.activity_level,
  intent: p => !!p.intent,
  plan_pace: p => !!p.profile?.plan_pace,
  plan_push: p => !!p.profile?.plan_push,
  goal_weight: p => (p.goals || []).some(g => g.metric === 'weight_kg' && g.target_value != null),
  strength_per_week: p => p.profile?.strength_per_week != null,
  cardio_per_week: p => p.profile?.cardio_per_week != null,
  minutes_per_week: p => p.profile?.minutes_per_week != null,
  training_age: p => !!p.profile?.training_age,
  equipment: p => Array.isArray(p.profile?.equipment) && p.profile.equipment.length > 0,
  dietary: p => Array.isArray(p.profile?.dietary) && p.profile.dietary.length > 0,
  // Bluntness has a default, so it only counts as answered once they changed
  // it — otherwise the list would claim to know something nobody ever said.
  bluntness: p => !!p.profile?.bluntness && p.profile.bluntness !== 'honest',
  brief_hour: p => p.profile?.brief_hour != null,
  timezone: p => !!p.profile?.timezone && p.profile.timezone !== 'UTC',
};

// What is on file for the profile-backed items, so a screen can show the
// current answer rather than an empty box beside a tick.
const VALUE = {
  weight: p => p.weightKg,
  intent: p => p.intent,
};
function valueOf(item, ctx) {
  if (VALUE[item.key]) return VALUE[item.key](ctx) ?? null;
  if (item.where === 'profile') return ctx.profile?.[item.key] ?? null;
  return null;
}

/**
 * One question, ready to say. The options are numbered so a person can answer
 * "2" and the menu is a sentence rather than a form.
 */
export function askLine(item) {
  if (!item) return '';
  const q = `${item.ask}?`;
  if (item.kind === 'choice' && item.options) {
    return `${q} ${item.options.map((o, i) => `${i + 1} · ${o.label}`).join('  ')}`;
  }
  const bits = [];
  if (item.quick?.length) bits.push(`e.g. ${item.quick.slice(0, 5).join(', ')}`);
  else if (item.hint) bits.push(`e.g. ${item.hint}`);
  if (item.none) bits.push('or "none"');
  return bits.length ? `${q} (${bits.join(' — ')})` : q;
}

/**
 * What is known, what is not, and the one thing worth asking next.
 *
 * Two lists come out of this and they mean different things:
 *   - `gate`: the questions that stand between somebody and a BUILT workout.
 *     Complete when all of them are answered. This is what the tools stop on.
 *   - `still_unknown`: everything, gating or not, in the order worth asking —
 *     for get_profile's one-in-passing pick, and for somebody who ASKS to be
 *     set up properly.
 */
export function intakeState({ profile = {}, goals = [], memory = [], weightKg = null, intent = null } = {}) {
  const ctx = { profile, goals, memory, weightKg, intent };
  const cats = new Set(memory.map(m => m.category));

  const known = [];
  const unknown = [];
  const questions = [];

  for (const item of INTAKE) {
    const answered = HAS[item.key]
      ? HAS[item.key](ctx)
      : item.where === 'memory' ? cats.has(item.category) : false;
    (answered ? known : unknown).push(item);
    questions.push({
      key: item.key, ask: item.ask, kind: item.kind, gate: !!item.gate,
      options: item.options || null, quick: item.quick || null,
      unit: item.unit || null, alt_unit: item.alt_unit || null,
      none: !!item.none, hint: item.hint || null,
      known: answered, value: answered ? valueOf(item, ctx) : null,
    });
  }

  // Limitations jump the queue among the soft ones: never programme around an
  // injury that was never mentioned. (Among the gating ones it is already
  // placed right after the five facts.)
  const soft = unknown.filter(i => !i.hard);
  soft.sort((a, b) => (a.key === 'limitations' ? -1 : b.key === 'limitations' ? 1 : 0));
  const hard = unknown.filter(i => i.hard);
  const ordered = [...hard, ...soft];

  const gateItems = INTAKE.filter(i => i.gate);
  const gateUnknown = ordered.filter(i => i.gate);
  const next = gateUnknown[0] || null;

  return {
    total: INTAKE.length,
    known: known.length,
    complete: unknown.length === 0,
    blocking: hard.map(i => i.asks),
    still_unknown: ordered.map(i => i.asks),
    // The same questions in the second person, ready to be said out loud. The
    // `asks` forms are written FOR A MODEL to read — "what they are actually
    // after" — and reading one of those to a person is baffling. Two forms,
    // one list, so they cannot drift apart.
    still_unknown_asked: ordered.map(i => i.ask),
    // The one to ask if a natural moment turns up. One, not a list.
    ask_next: ordered.length ? ordered[0].asks : null,
    // THE GATE. What building a workout waits on, and nothing else.
    gate: {
      total: gateItems.length,
      known: gateItems.length - gateUnknown.length,
      complete: gateUnknown.length === 0,
      remaining: gateUnknown.map(i => i.asks),
      next: next ? questionOf(next) : null,
    },
    // Every question with its options and what is on file — for a screen.
    questions,
    setup_url: SETUP_URL,
    say: unknown.length
      ? `${known.length} of ${INTAKE.length} things known.`
      : `Everything worth knowing is on file.`,
    note: hard.length
      ? `${hard.length} of these BLOCK the arithmetic — ask for those together in one message the next time a number needs them, and not before.`
      : 'NEVER ask more than ONE of these at a time, and only when the conversation has already walked into it — somebody mentioning a sore knee is the moment to ask about injuries, and no other moment is. Do not work through the list, do not present it as a form, and do not mention that a list exists. Over a fortnight of ordinary use it fills itself in. The exception is somebody asking to be set up properly: then walk the whole thing, because they asked.',
  };
}

export function questionOf(item) {
  if (!item) return null;
  return {
    key: item.key, ask: item.ask, kind: item.kind,
    options: item.options ? item.options.map((o, i) => ({ n: i + 1, v: o.v, label: o.label })) : null,
    quick: item.quick || null, unit: item.unit || null, alt_unit: item.alt_unit || null,
    none: !!item.none, hint: item.hint || null,
    line: askLine(item),
  };
}

export function intakeItem(key) {
  return INTAKE.find(i => i.key === key) || null;
}

/**
 * The stop place. Null when training tools may run; otherwise the gate object
 * the tool returns instead of a workout.
 *
 * ONE QUESTION, WITH SOMETHING TO TAP, SAVED BY answer_setup — which hands
 * back the next one. That loop is the founder's spec ("here's a question,
 * after you answer it, it saves it") and it is structural: a model cannot skip
 * reading the result of the call it just made, so the next question always
 * arrives, and it cannot dump the list because it never holds the list.
 */
export function intakeGate(state) {
  if (!state || !state.gate || state.gate.complete) return null;
  const g = state.gate;
  const q = g.next;
  const left = g.remaining.length;

  return {
    setup_required: true,
    answered: g.known,
    of: g.total,
    remaining: g.remaining,
    // The ONLY question to ask in this message.
    question: q,
    ask_now: q ? [q.ask] : [],
    answer_with: 'answer_setup',
    setup_url: SETUP_URL,
    say: `Quick — ${g.known} of ${g.total} done, ${left} to go, then the workout. ${q?.line || ''} ` +
      `Or do them all on one screen: ${SETUP_URL}`,
    note: `ASK EXACTLY THE ONE QUESTION IN question.line, IN THIS MESSAGE, with its numbered options, and nothing else first — a gate that only announces itself is a dead end. When they answer, call answer_setup with the key and their answer (a number picks that option; loose words are fine — "lose weight AND build muscle" is recomp; "None" is a real answer that closes its question). answer_setup SAVES it and returns the NEXT question: ask that one, and only that one. If they volunteer several answers in one message, pass them all to answer_setup in one call — still ask only one question back. NEVER list the remaining questions, never say how many are left beyond the count here, and never say an answer is saved unless answer_setup returned it in saved. Only ${g.total} questions gate a workout — the ones about food habits, sleep, medication and sports never do, so do not ask those here. THE QUESTIONNAIRE IS A GATE, at the founder's explicit instruction: do NOT build, suggest or start a workout until answer_setup returns complete: true — then call the training tool again in the same turn and hand them the workout without making them ask twice. They can also finish it on the website at ${SETUP_URL}; offer that link as a markdown hyperlink once. Logging is NEVER gated — food, weight or training they already did gets recorded immediately, gate or no gate.`,
  };
}
