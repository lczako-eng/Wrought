// netlify/functions/lib/intake.js
// The twenty things worth knowing, and why none of them is a form.
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
// So: THE TWENTY QUESTIONS EXIST. They are just never asked at once.
//
// This file is the list of what is worth knowing, checked against what is
// already on file. Two things then use it:
//
//   1. get_profile carries `still_unknown`, and the instruction is to pick AT
//      MOST ONE, only when the conversation is already near it — somebody
//      mentioning a bad knee is the moment to ask about injuries, and no other
//      moment is. Over a fortnight of ordinary use the list fills itself in
//      without a single interview.
//   2. Somebody who WANTS to sit down and do it can say so, and the assistant
//      walks the list. Available on demand, never imposed.
//
// THE FOUNDER OVERRODE HALF OF THAT, twice, and the second time is decisive:
// "we should put that as a stop place — we can't further any workouts until
// the questionnaire is finished." So the questionnaire is now a GATE, and the
// line it gates is drawn precisely:
//
//   WROUGHT never refuses to RECORD. A meal, a weight, a set somebody already
//   did — capture is the soul of the product and gating it would kill the
//   memory. log, log_set and the briefs stay open forever.
//
//   WROUGHT refuses to PRESCRIBE until it knows who it is prescribing for.
//   suggest_workout, start_session, programmes and start_block stop at the
//   gate until the questionnaire is finished — building a plan for a stranger
//   is guesswork wearing a coach's voice, and the founder is right that the
//   product should not pretend otherwise.
//
// "Finished" means every item answered — and "none" IS an answer. No sports,
// no medication, no injuries are all worth exactly as much as their opposites,
// and recording them is what lets the questionnaire actually end.

// Where each fact lives once it is known. `profile` fields are columns;
// everything else is a memory row in the named category, which is why this
// needs no migration and why free-text answers survive intact.
export const INTAKE = [
  // ── The five that arithmetic cannot run without ─────────────────────────
  { key: 'height_cm',      where: 'profile', asks: 'how tall they are', hard: true },
  { key: 'birth_year',     where: 'profile', asks: 'what year they were born', hard: true },
  { key: 'sex',            where: 'profile', asks: 'male or female, for the metabolic formula', hard: true },
  { key: 'weight',         where: 'event',   asks: 'what they weigh now', hard: true },
  { key: 'activity_level', where: 'profile', asks: 'how much they are on their feet in a normal day', hard: true },

  // ── The plan ────────────────────────────────────────────────────────────
  { key: 'intent',     where: 'goal',    asks: 'what they are actually after — losing, gaining, or both' },
  { key: 'plan_pace',  where: 'profile', asks: 'how fast they want it — gentle, steady or aggressive' },
  { key: 'plan_push',  where: 'profile', asks: 'how hard WROUGHT should chase them when they are behind' },
  { key: 'goal_weight', where: 'goal',   asks: 'whether they have a weight in mind, and by when' },

  // ── Training ────────────────────────────────────────────────────────────
  { key: 'train_days',   where: 'profile', asks: 'how many sessions a week they will honestly do' },
  { key: 'training_age', where: 'profile', asks: 'how long they have been training' },
  { key: 'equipment',    where: 'profile', asks: 'what kit they actually have access to' },
  { key: 'sports',       where: 'memory', category: 'training',
    asks: 'anything they do outside the gym — five-a-side, running, climbing' },
  { key: 'lifts',        where: 'memory', category: 'lifts',
    asks: 'roughly what they lift on the main movements, so the first session is not a guess' },

  // ── The body, and the things that quietly change everything ─────────────
  // Injuries and limitations are the highest-value item on this list. Never
  // programme around one that was never mentioned, and never treat one.
  { key: 'limitations', where: 'memory', category: 'health',
    asks: 'any injuries, joints or movements to work around' },
  { key: 'conditions',  where: 'memory', category: 'health',
    asks: 'anything a doctor is already managing that food or training affects — recorded, never advised on' },
  { key: 'medication',  where: 'memory', category: 'health',
    asks: 'whether anything they take affects appetite, weight or heart rate — recorded only, never advised on' },
  { key: 'sleep',       where: 'memory', category: 'health',
    asks: 'roughly what their sleep is like' },

  // ── Food, as it actually happens ────────────────────────────────────────
  { key: 'dietary',   where: 'profile', asks: 'anything they do not eat' },
  { key: 'cooking',   where: 'memory', category: 'food',
    asks: 'how they usually eat — cooking, takeaways, canteen, shifts' },
  { key: 'alcohol',   where: 'memory', category: 'food',
    asks: 'roughly how much they drink, since it is the most under-logged thing there is' },
  { key: 'weak_spot', where: 'memory', category: 'food',
    asks: 'where their eating actually falls apart — evenings, weekends, stress, the drive home' },

  // ── How they want to be spoken to ───────────────────────────────────────
  { key: 'bluntness',  where: 'profile', asks: 'how hard they want the verdict to hit' },
  { key: 'brief_hour', where: 'profile', asks: 'what time the nightly read should land' },
  { key: 'timezone',   where: 'profile', asks: 'where they are, so a day is their day' },
];

const HAS = {
  height_cm: p => p.profile?.height_cm != null,
  birth_year: p => p.profile?.birth_year != null,
  sex: p => !!p.profile?.sex,
  weight: p => p.weightKg != null,
  activity_level: p => !!p.profile?.activity_level,
  intent: p => !!p.intent,
  plan_pace: p => !!p.profile?.plan_pace,
  plan_push: p => !!p.profile?.plan_push,
  goal_weight: p => (p.goals || []).some(g => g.metric === 'weight_kg'),
  train_days: p => p.profile?.train_days != null,
  training_age: p => !!p.profile?.training_age,
  equipment: p => Array.isArray(p.profile?.equipment) && p.profile.equipment.length > 0,
  dietary: p => Array.isArray(p.profile?.dietary) && p.profile.dietary.length > 0,
  // Bluntness has a default, so it only counts as answered once they changed
  // it — otherwise the list would claim to know something nobody ever said.
  bluntness: p => !!p.profile?.bluntness && p.profile.bluntness !== 'honest',
  brief_hour: p => p.profile?.brief_hour != null,
  timezone: p => !!p.profile?.timezone && p.profile.timezone !== 'UTC',
};

/**
 * What is known, what is not, and the one thing worth asking next.
 *
 * Order matters: the hard five come first because arithmetic stops without
 * them, then limitations, because programming around an injury nobody
 * mentioned is the way this hurts somebody.
 */
export function intakeState({ profile = {}, goals = [], memory = [], weightKg = null, intent = null } = {}) {
  const ctx = { profile, goals, memory, weightKg, intent };
  const cats = new Set(memory.map(m => m.category));

  const known = [];
  const unknown = [];

  for (const item of INTAKE) {
    const answered = HAS[item.key]
      ? HAS[item.key](ctx)
      : item.where === 'memory' ? cats.has(item.category) : false;
    (answered ? known : unknown).push(item);
  }

  // Limitations jump the queue among the soft ones: never programme around an
  // injury that was never mentioned.
  const soft = unknown.filter(i => !i.hard);
  soft.sort((a, b) => (a.key === 'limitations' ? -1 : b.key === 'limitations' ? 1 : 0));
  const hard = unknown.filter(i => i.hard);
  const ordered = [...hard, ...soft];

  return {
    total: INTAKE.length,
    known: known.length,
    complete: unknown.length === 0,
    blocking: hard.map(i => i.asks),
    still_unknown: ordered.map(i => i.asks),
    // The one to ask if a natural moment turns up. One, not a list.
    ask_next: ordered.length ? ordered[0].asks : null,
    say: unknown.length
      ? `${known.length} of ${INTAKE.length} things known.`
      : `Everything worth knowing is on file.`,
    note: hard.length
      ? `${hard.length} of these BLOCK the arithmetic — ask for those together in one message the next time a number needs them, and not before.`
      : 'NEVER ask more than ONE of these at a time, and only when the conversation has already walked into it — somebody mentioning a sore knee is the moment to ask about injuries, and no other moment is. Do not work through the list, do not present it as a form, and do not mention that a list exists. Over a fortnight of ordinary use it fills itself in. The exception is somebody asking to be set up properly: then walk the whole thing, because they asked.',
  };
}

/**
 * The stop place. Null when training tools may run; otherwise the gate object
 * the tool returns instead of a workout.
 *
 * The questions go out in GROUPS, not one at a time — the in-passing doctrine
 * still governs ordinary conversation, but somebody standing at the gate asked
 * for a workout and the fastest way through is to finish. Loose answers are
 * fine: "weight loss and muscle building" is recomp, "none" closes a question
 * for good.
 */
export function intakeGate(state) {
  if (!state || state.complete) return null;
  const remaining = state.still_unknown || [];
  return {
    setup_required: true,
    answered: state.known,
    of: state.total,
    remaining,
    say: `Before WROUGHT builds you a workout it needs to finish getting to know you — ${state.known} of ${state.total} answered, ${remaining.length} to go.`,
    note: 'THE QUESTIONNAIRE IS A GATE, at the founder\'s explicit instruction: do NOT build, suggest or start a workout until it is finished. Run it conversationally — three or four questions per message, never the whole list at once, in the order given (the arithmetic five first, then injuries). Loose, combined answers are fine: "lose weight AND build muscle" is recomp. "None" is a real answer — record it (remember with the right category, or the profile field) so the question closes. Save every answer as it arrives: set_profile for profile fields, set_goal for intent and target weight, set_plan for pace and push, remember for the rest. When the list is done, call the training tool again in the same turn and hand them the workout without making them ask twice. Logging is NEVER gated — if they mention food or training they already did, record it immediately, gate or no gate.',
  };
}
