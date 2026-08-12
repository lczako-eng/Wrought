// lib/prompt.js
// The one thing worth raising without being asked.
//
// The founder: "should be prompt in advice — the whole point of it is
// preemptive." He is right, and the gap was real. `plan_push` was stored, was
// shown back on the plan, and DROVE NOTHING: no instruction said what light,
// normal or relentless actually change about behaviour, and the level was not
// carried on any of the responses the model reads constantly. A setting called
// "how hard this thing chases you" that changes nothing when you set it is the
// worst kind of feature — it looks answered and is decoration.
//
// WHAT THIS CAN AND CANNOT BE. An MCP server can never make the assistant
// speak first; the protocol is strictly request/response. So preemptive here
// means: the moment they say ANYTHING — a meal, a weight, a question about
// something else entirely — the answer already carries the one thing worth
// raising. That is a real and large difference from waiting to be asked "how
// am I doing", which is a question people ask when they already suspect the
// answer.
//
// FIVE RULES, all of them load-bearing:
//
//   1. A CARE FLAG SILENCES IT COMPLETELY. Relentless is a setting, not a
//      licence. Somebody under-eating must not be chased about training volume.
//   2. ONE THING, NEVER A LIST. A nudge with three items in it is a lecture,
//      and the second one is never read.
//   3. NEVER GUILT. Sessions do not roll over. An impossible week is told it
//      will finish short rather than counted down to zero. No "you said you
//      would", no "only X left", no disappointment. Guilt is how a training log
//      dies, and a dead log is worth nothing to anybody.
//   4. THE LEVEL IS OBEYED EXACTLY. Somebody who asked for light and gets
//      chased anyway will turn the whole thing off, and they will be right to.
//   5. A WIN IS A NUDGE TOO. The most valuable unprompted sentence is not
//      "you're behind" — it is "that was your best run yet", said the day it
//      happens. That is the entire reason somebody goes out again tomorrow.

const LEVELS = { light: 0, normal: 1, relentless: 2 };

/**
 * @param push          'light' | 'normal' | 'relentless' | null (defaults normal)
 * @param flags         careFlags() output — anything here silences everything
 * @param trainingWeek  weekSoFar() output
 * @param plan          planRead() output
 * @param cardio        cardioProgress() output
 * @param day           dayFacts() output for today
 * @param voicePending  count of dictated entries not yet structured
 * @returns { say, kind, priority } or null — null means SAY NOTHING
 */
export function nextNudge({
  push = null, flags = [], trainingWeek = null, plan = null,
  cardio = null, day = null, voicePending = 0,
} = {}) {
  // Rule 1. Nothing here is appropriate beside a care flag, including the
  // cheerful ones — a personal best delivered to somebody who has eaten under
  // 1,200 for three days is encouragement pointed the wrong way.
  if (flags.length) return null;

  const level = LEVELS[push] ?? LEVELS.normal;

  // ── Wins first, always, at every level ────────────────────────────────────
  // Not gated by push: this is not chasing, and somebody who asked to be left
  // alone did not ask to be denied their own best run.
  if (cardio?.known && cardio.personal_best) {
    const r = (cardio.reads || []).find(x => x.personal_best);
    if (r) {
      return {
        kind: 'best',
        priority: 1,
        say: `Best ${r.kind} yet — ${r.latest.km}km at ${r.latest.pace}. Worth saying out loud.`,
      };
    }
  }

  // ── Things that are silently costing them a number ────────────────────────
  // Not chasing either: a fact about the record that they alone can fix, and
  // without which something they DID do counts for nothing.
  if (voicePending > 0) {
    return {
      kind: 'voice_pending',
      priority: 2,
      say: voicePending === 1
        ? 'One thing you dictated is still sitting as raw words — read it back into the log when you get a moment.'
        : `${voicePending} things you dictated are still sitting as raw words — worth reading them into the log.`,
    };
  }

  const untimed = (day?.training?.entries || []).filter(e => !e.detail?.minutes).length;
  if (untimed > 0) {
    return {
      kind: 'needs_duration',
      priority: 3,
      say: 'A session went in with no minutes on it, so it is counting nothing toward your burn. Roughly how long was it?',
    };
  }

  // ── The plan itself ───────────────────────────────────────────────────────
  // Asked once, not chased. Somebody with no plan has no target, and with no
  // target every other number on the screen is uninterpretable.
  if (plan && !plan.set && plan.missing?.length) {
    return {
      kind: 'no_plan',
      priority: 4,
      say: 'There is no plan set yet, so nothing here has a target to be measured against. One sentence sets it — what you are after, how fast, and how many days a week you will honestly train.',
    };
  }

  // ── The week ──────────────────────────────────────────────────────────────
  // Rule 4: the level decides whether this is raised at all.
  const w = trainingWeek;
  if (w && w.target) {
    if (w.met) return null;                       // Nothing to chase. Say nothing.

    const elapsed = Math.max(0, 7 - (w.days_left ?? 0));
    const short = w.target - w.done;

    // Rule 3. More sessions left than days to do them in is not a debt — it is
    // a week that will finish short, and saying so plainly is the honest
    // version. It is never counted down to zero and never apologised for.
    if (short > w.days_left) {
      // Only the two louder levels mention it at all; there is nothing
      // actionable left and repeating it is pure guilt.
      if (level < LEVELS.relentless) return null;
      return {
        kind: 'week_short',
        priority: 6,
        say: `This week will finish short of ${w.target} — there are not enough days left. Not a problem: next week starts clean and nothing carries over.`,
      };
    }

    // Behind the pace the week implies, rather than merely "not finished yet".
    //
    // WELL BEHIND IS A PROPORTION, NOT THE TAIL OF THE WEEK. The first version
    // defined it as "nothing done and three days left", which for anybody
    // training four days a week could never happen: by the time three days
    // remain with nothing done, the week is already arithmetically impossible
    // and the branch above has taken it. So `light` fired for nobody at all —
    // a setting that silently means "never" is worse than not offering it.
    const expected = w.target * (elapsed / 7);
    const behind = w.done < expected - 0.5;
    const wellBehind = w.done < expected / 2;

    const raise =
      level === LEVELS.relentless ? short > 0
      : level === LEVELS.normal   ? behind
      : /* light */                 wellBehind;

    if (raise) {
      return {
        kind: 'week_behind',
        priority: 7,
        say: `${w.done} of ${w.target} this week with ${w.days_left} day${w.days_left === 1 ? '' : 's'} left. Still comfortably doable — want a session?`,
      };
    }
  }

  return null;
}

/**
 * What the model is told to do with it. Kept beside the computation so a
 * changed rule and a changed instruction cannot drift apart.
 */
export function nudgeNote(nudge, push) {
  if (!nudge) {
    return 'Nothing to raise unprompted. Answer what they asked and stop — a coach who finds something to say every single time is one people stop listening to.';
  }
  const level = push || 'normal';
  return `Raise this ONCE, in ONE short line, AFTER answering what they actually asked — never instead of it, and never as an opener. ` +
    `Their push setting is "${level}" and this has already been filtered by it, so do not second-guess whether to mention it; ` +
    `do not add a second point, do not repeat it later in the same conversation, and do not express disappointment, urgency or ` +
    `expectation of any kind. Sessions never roll over and a missed week is information, not a debt.`;
}
