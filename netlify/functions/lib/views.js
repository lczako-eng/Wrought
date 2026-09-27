// netlify/functions/lib/views.js
// One workout, as something to LOOK at — composed once, printed twice.
//
// The founder, holding up ChatGPT drawing pictures in a chat: "Why can't our
// Wrought do this — show you weightlifting techniques... I want it showing
// techniques." What this server can honestly show is the workout and, beside
// each movement, a small figure doing the MOVEMENT plus the curated library's
// one-line cue. It can never say anything about how somebody performs it:
// WROUGHT cannot see anybody lift.
//
// ONE VIEW MODEL, TWO RENDERERS. `workoutView` builds `view` with every figure
// already a string; the chat widget prints it and `workoutMarkdown` prints it.
// Neither computes, so the card, the markdown and the spoken `say` can never
// quote two different things about the same workout.
//
// THE RULES, each with a test:
//
// - NO WEIGHT, ANYWHERE. Not from a live session, not from a typed reference,
//   not from a tradition. There is no key for one. `progressionCall` writes its
//   sentence in kilograms whatever the person's units, and under a care flag an
//   "add load" verdict is exactly the push a flag withholds — so the card leaves
//   the load to the rack screen and log_set, and says so in one line.
// - A CARE FLAG LEADS. The plan is a factual record, so it still shows, under a
//   REVIEW banner; no coach voice, no coach day, no push, no nudge rides on it.
// - A CREDIT ONLY THROUGH styleCredit, and a saved routine gets one only when
//   its name ends in exactly the tradition's tail — "Arnold chest day" is theirs
//   and credits nobody.
// - A CUE ONLY FROM A CURATED SOURCE. The library's line for the movement, or
//   the written tradition's own; a movement with neither gets none rather than
//   one invented, and an advanced lifter is left alone.
// - EVERY USER STRING IS ESCAPED where it is rendered: HTML in the widget,
//   Markdown here — a Markdown image in a routine's name would make a chat
//   client fetch a URL.

import { targetLabel, sessionProgress } from './warmup.js';
import { exerciseKey } from './training.js';
import { pictureFor, libraryCue } from './pictures.js';
import { STYLES, styleCredit } from './design.js';
import { spokenFlag } from './voice.js';

export const VIEW_VERSION = 1;
export const RACK_URL = 'https://wrought.fit/app.html#trainer';
export const VISIBLE_ROWS = 5;
export const PATTERN_NOTE = 'Shows the movement pattern — not your exact equipment.';
// Person-facing, every one: a card a person reads never names an internal
// tool. A test holds every string the view can carry to that.
export const LOADS_LIVE = 'The weight for each set is on the rack screen, or your assistant says it after each set — the card never shows one.';
export const LOADS_TYPED = "Weights aren't shown here — the rack screen works them out from your history; your own typed references stay on the Trainer tab.";
export const LOADS_NONE = 'Loads come from your own history when you train it — nothing here is a weight.';
export const EMPTY_SAY = 'No saved workouts yet — ask your assistant to build one and save it.';

/**
 * A saved name ending in exactly " (<lineage> tradition)" — how the written
 * sessions are saved, and the only way a routine earns a credit here.
 */
export function traditionOf(name) {
  const n = String(name || '');
  for (const [key, st] of Object.entries(STYLES)) {
    if (!st.lineage) continue;
    const tail = ` (${st.lineage} tradition)`;
    if (n.endsWith(tail) && n.length > tail.length) return { key, title: n.slice(0, -tail.length).trim() };
  }
  return null;
}

/**
 * THEIR COPY FIRST. A written tradition session is customisable — "add and
 * subtract workouts" — so the one to draw is the saved routine they edited,
 * found by the exact tail it is saved under, never the pristine original
 * with the movements they took out. Null when they have not saved it.
 */
export function traditionCopy(routines = [], key) {
  const st = STYLES[key];
  if (!st || !st.lineage) return null;
  const tail = ` (${st.lineage} tradition)`;
  return (routines || []).find(r => r && String(r.name || '').endsWith(tail)) || null;
}

// A WEIGHT TYPED INTO THE SETUP TEXT is a typed reference like any other, and
// the card shows none. "sled at 60kg" is the schema's own example of a detail,
// and "3x8 at 185" leaves "at 185" there (a bare number is never parsed as a
// load) — printed beside "nothing here is a weight", the card contradicted
// itself. The weight comes off the card's copy and the loads line says where
// their references live; the rest of their words stay, verbatim.
const UNIT_WEIGHT = /(?:(?:@|\bat)\s*)?\d+(?:[.,]\d+)?\s*(?:kgs?|kilos?|kilograms?|lbs?|pounds?)\b/i;
const BARE_LOAD = /^(?:(?:@|at)\s*)?\d+(?:[.,]\d+)?$/i;
export function detailForCard(detail) {
  const raw = String(detail ?? '').trim();
  if (!raw) return { detail: null, held: false };
  if (BARE_LOAD.test(raw)) return { detail: null, held: true };
  if (!UNIT_WEIGHT.test(raw)) return { detail: raw, held: false };
  const rest = raw.replace(new RegExp(UNIT_WEIGHT.source, 'gi'), ' ')
    .replace(/\s+/g, ' ').replace(/\s+([,;])/g, '$1').replace(/^[\s,;·—-]+|[\s,;·—-]+$/g, '').trim();
  return { detail: rest && !BARE_LOAD.test(rest) ? rest : null, held: true };
}

const restText = s => {
  const n = Number(s);
  if (!n || n < 0) return null;
  return n >= 120 && n % 60 === 0 ? `${n / 60} min rest` : `${n} s rest`;
};

/**
 * A running session as the view's input. Pure. The cursor is NEVER clamped to
 * the plan: recordSet moves it past the last movement when the last set is
 * in, and clamping it back read a finished session as the last movement's
 * "set 5 of 4".
 */
export function liveInput(session, sets = []) {
  const plan = Array.isArray(session?.plan) ? session.plan : [];
  const cursor = Math.max(0, Number(session?.cursor_index) || 0);
  const current = plan[cursor];
  const key = current ? (current.key || exerciseKey(current.name)) : null;
  const doneHere = key ? (sets || []).filter(x => (x.exercise_key || exerciseKey(x.exercise)) === key).length : 0;
  return {
    source: 'live', name: session?.name || null, subtitle: 'Running now', aim: session?.aim || null,
    movements: plan, live: { cursor, done_here: doneHere }, progress: sessionProgress(plan, sets || []),
  };
}

/**
 * The view. `movements` are already read for display (readMovement or a plan
 * entry); any `load_kg` on them is ignored. `live` carries the cursor and the
 * sets done on the current movement; `progress` is sessionProgress's own.
 */
export function workoutView({
  source = 'routine', name = null, subtitle = null, notes = null, aim = null,
  movements = [], taken_out = 0, flags = [], tier = null, curated = false,
  live = null, progress = null, empty = null,
} = {}) {
  // The lock-screen sentence says "Tap to review"; on a card and in a chat a
  // tap opens nothing of the kind, so the door is named instead — and the
  // reply offers review_intake_days first (workoutNext).
  const flag = (flags || []).length
    ? {
      title: 'REVIEW',
      say: String(spokenFlag(flags[0]) || flags[0].detail || 'Something on the record needs a look before any coaching.').replace(/\bTap to review\b/, 'To review:'),
      review: !!flags[0].needs_review,
    }
    : null;
  const out = Number(taken_out) || 0;

  if (!(movements || []).length) {
    // EVERY MOVEMENT TAKEN OUT is not "no saved workouts" — that sentence on
    // a memory product says the workout was lost. It is there, all of it out.
    const allOut = out && name ? `Every movement in ${name} is taken out — put one back on the Trainer tab.` : null;
    return {
      v: VIEW_VERSION, kind: 'workout', state: 'none', source,
      title: name ? String(name) : 'No workout to show', credit: null, credit_name: null,
      subtitle: null, notes: null, aim: null, flag, progress: null,
      exercises: [], visible_rows: VISIBLE_ROWS, more_label: null,
      taken_out_line: out ? `${out} taken out of this workout` : null,
      loads_line: LOADS_NONE, empty: empty ? String(empty) : allOut || EMPTY_SAY, links: { rack: RACK_URL },
    };
  }

  const trad = traditionOf(name);
  const st = trad ? STYLES[trad.key] : null;
  const advanced = tier === 'advanced';
  // Never clamped to the plan: a cursor past the last movement is a session
  // whose every set is in, and it reads as all done — never "set 5 of 4".
  const cursor = live ? Math.max(0, Number(live.cursor) || 0) : -1;
  let heldWeight = false;

  const exercises = movements.map((m, i) => {
    const pic = pictureFor(m.name);
    const status = live ? (i < cursor ? 'done' : i === cursor ? 'current' : 'to_come') : null;
    const doneHere = Number(live?.done_here) || 0;
    const sets = Number(m.sets) || 0;
    const shown = detailForCard(m.detail);
    if (shown.held) heldWeight = true;
    return {
      name: String(m.name || ''),
      picture: pic ? pic.id : null,
      picture_note: pic && pic.grain === 'pattern' ? PATTERN_NOTE : null,
      prescription: targetLabel(m),
      detail: shown.detail,
      // Rest belongs to sets. Timed work, a movement with no sets, and the
      // retired 3×8 default get none — normaliseMovement's 120 s was never
      // somebody's rest.
      rest: m.minutes || m.from_default || !sets ? null : restText(m.rest_s),
      // The curated library's line, or the written tradition's own. Never one
      // composed here, and nothing for somebody who asked to be left alone.
      cue: advanced ? null : (libraryCue(m.name) || (curated && m.cue ? String(m.cue) : null)),
      finisher: m.finisher ? 'Finisher' : null,
      status,
      tick: status === 'done' ? '[x]' : status === 'current' ? '[>]' : status ? '[ ]' : null,
      sets_text: status === 'current'
        ? (sets ? (doneHere < sets ? `set ${doneHere + 1} of ${sets}` : `all ${sets} sets in`) : (m.minutes ? 'running' : `set ${doneHere + 1}`))
        : null,
    };
  });

  const n = exercises.length;
  const typed = !live && (heldWeight || movements.some(m => m.load_kg != null && m.load_kg !== ''));
  // The folded card has to fit the 400px a chat host gives it, so each thing
  // standing above the list costs a row — decided here, never in the card.
  // Two rows is the floor: a REVIEW banner with a write-up above it is the
  // most a card carries, and three rows under that measured 431px at 360.
  const above = (flag ? 2 : 0) + (live && progress ? 1 : 0) + (notes || aim ? 1 : 0);
  const visible = Math.max(2, VISIBLE_ROWS - above);
  // WHICH rows show folded. A saved workout shows its first rows; a running
  // one shows a window around the movement on NOW — folding the current
  // movement behind "Show all" hid the one row the card is for.
  const start = live ? Math.max(0, Math.min(cursor - 1, n - visible)) : 0;
  exercises.forEach((e, i) => { e.folded = i < start || i >= start + visible; });
  return {
    v: VIEW_VERSION, kind: 'workout', state: 'ok', source,
    title: trad ? trad.title : String(name || 'Workout'),
    credit: st ? styleCredit(st) : null,
    credit_name: st ? st.lineage : null,
    subtitle: subtitle ? String(subtitle) : null,
    notes: notes ? String(notes) : null,
    aim: aim ? String(aim) : null,
    flag,
    progress: live && progress ? { percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)), text: String(progress.say || '') } : null,
    exercises,
    visible_rows: visible,
    more_label: n > visible ? `Show all ${n}` : null,
    taken_out_line: out ? `${out} taken out of this workout` : null,
    loads_line: live ? LOADS_LIVE : typed ? LOADS_TYPED : LOADS_NONE,
    links: { rack: RACK_URL },
  };
}

/**
 * What the reply offers next — for the model, never printed on the card. A
 * flag that asks for a review offers its door first; a workout with every
 * movement taken out offers the way to put one back, never "build one".
 */
export function workoutNext(view, { name = null, tradition = null } = {}) {
  const review = view?.flag?.review
    ? ['review_intake_days — ask which of the dates named were fully logged; never infer it']
    : [];
  if (!view || view.state === 'none') {
    const rest = view?.source === 'live' ? ['list_routines', 'start_session with one of them']
      : view?.taken_out_line ? ['the Trainer tab at https://wrought.fit/app.html#trainer puts a movement back', 'save_routine with add[] to add one']
        : ['design_workout', 'save_routine'];
    return [...review, ...rest];
  }
  const rest = view.source === 'live' ? ['log_set after every set', 'session_status']
    : view.source === 'tradition' && /^Not in your workouts/.test(view.subtitle || '')
      ? [`save_routine with tradition "${tradition}" to add it`, 'start_session once it is saved']
      : [`start_session with routine "${name}"`];
  return [...review, ...rest];
}

/** Markdown-safe: user text can never become a link, an image or a table cell. */
export function mdEsc(s) {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_[\]()!<>|#]/g, c => `\\${c}`);
}

/** The card as text, for a client that draws no widget. Prints the view. */
export function workoutMarkdown(view) {
  if (!view) return '';
  const lines = [];
  if (view.flag) lines.push(`**${mdEsc(view.flag.title)}** — ${mdEsc(view.flag.say)}`, '');
  lines.push(`**${mdEsc(view.title)}**${view.credit ? `, ${mdEsc(view.credit)}` : ''}`);
  if (view.subtitle) lines.push(mdEsc(view.subtitle));
  if (view.state === 'none') { lines.push('', mdEsc(view.empty || EMPTY_SAY)); return lines.join('\n'); }
  if (view.aim) lines.push(`Today: ${mdEsc(view.aim)}`);
  if (view.progress) lines.push(mdEsc(view.progress.text));
  if (view.notes) lines.push('', mdEsc(view.notes));
  lines.push('');
  for (const e of view.exercises) {
    const mark = e.status === 'done' ? '✓ ' : e.status === 'current' ? '▶ ' : e.status ? '○ ' : '';
    const bits = [e.prescription, e.rest, e.finisher, e.sets_text].filter(Boolean).map(mdEsc).join(' · ');
    lines.push(`- ${mark}**${mdEsc(e.name)}** — ${bits}${e.detail ? ` (${mdEsc(e.detail)})` : ''}`);
    if (e.cue) lines.push(`  ${mdEsc(e.cue)}`);
  }
  if (view.taken_out_line) lines.push('', mdEsc(view.taken_out_line));
  lines.push('', mdEsc(view.loads_line));
  lines.push(`Rack screen: ${view.links.rack}`);
  return lines.join('\n');
}

/** One spoken line: the flag first, the name with its credit, every movement once. */
export function workoutSay(view) {
  if (!view) return '';
  const lead = view.flag ? `${view.flag.say} ` : '';
  if (view.state === 'none') return `${lead}${view.empty || EMPTY_SAY}`.trim();
  const head = view.credit ? `${view.title}, ${view.credit}` : view.title;
  const list = view.exercises.map(e => `${e.name} — ${e.prescription}`).join('; ');
  if (view.progress) {
    const now = view.exercises.find(e => e.status === 'current');
    return `${lead}${head}: ${view.progress.text}${now ? ` Now: ${now.name}, ${now.sets_text}.` : ''} The plan: ${list}.`;
  }
  return `${lead}${head}: ${list}.${view.taken_out_line ? ` ${view.taken_out_line}.` : ''}`;
}
