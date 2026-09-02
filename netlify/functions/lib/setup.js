// netlify/functions/lib/setup.js
// ONE write path for a questionnaire answer, shared by the assistant's
// answer_setup tool and the website's api-setup door.
//
// The recordSet lesson, applied to setup: two copies of "what does this answer
// do to the record" would drift, and the drift shows up as the website saying
// a question is answered while the assistant asks it again. So the parsing and
// the writing live here, and both doors keep only their phrasing.
//
// NOTHING HERE INVENTS A NUMBER. An answer is parsed — "6'3" becomes 190.5,
// "2" picks the second option, "none" closes a question — and refused with a
// sentence when it cannot be read. A refused answer is reported by key, so a
// screen says which box and a model asks the one question again rather than
// re-running the list.

import {
  supabase, getProfile, getGoals, getMemory, insertEvents, rememberFact, lbToKg, inToCm,
} from './wrought.js';
import { setBodyGoal, setMetricGoal, intentFrom } from './goals.js';
import { PACES, PUSH, ACTIVITY } from './training.js';
import { INTAKE, intakeItem, intakeState, GATE_KEYS } from './intake.js';

const NONE = /^\s*(none|no|nothing|nope|nah|n\/a|no injuries|nothing to work around|not really|none at all)\s*[.!]?\s*$/i;

// Columns 023 adds. On a database without it these are dropped from the save
// and REPORTED, never thrown: a schema change and the code depending on it do
// not ship together, and a save that loses the whole patch because one column
// is missing is the regression this file's own doctrine names.
const COMMITMENT_COLS = ['strength_per_week', 'cardio_per_week', 'minutes_per_week', 'track', 'sport'];

/**
 * Read one answer against its question. Pure.
 * Returns { ok: true, value, display } or { ok: false, why }.
 */
export function parseAnswer(item, raw) {
  if (!item) return { ok: false, why: 'not a question WROUGHT asks' };
  const s = raw == null ? '' : String(raw).trim();

  if (item.none && NONE.test(s)) return { ok: true, value: null, none: true, display: 'none' };

  switch (item.kind) {
    case 'choice': {
      const opts = item.options || [];
      const low = s.toLowerCase();
      // AN EXACT VALUE WINS BEFORE A MENU NUMBER. The commitment counts have
      // numeric values (0..6) and numbered menu positions (1..7): "3" to "how
      // many strength sessions" means three sessions, not the third option,
      // and the website sends the value itself. Only when nothing is valued
      // that way does a bare number pick a menu position.
      const exact = opts.find(o => String(o.v).toLowerCase() === low);
      if (exact) return { ok: true, value: exact.v, display: exact.label };
      const n = parseInt(s, 10);
      if (/^\d+$/.test(s) && n >= 1 && n <= opts.length) {
        const o = opts[n - 1];
        return { ok: true, value: o.v, display: o.label };
      }
      // A one-word answer matches a label's first word ("aggressive" →
      // "Aggressive — the fast end of safe"). Only one word: "lose weight and
      // build muscle" must reach the combined read below, not match "Lose fat"
      // on its first word and drop the second half of the sentence.
      const oneWord = !/\s/.test(low);
      const hit = opts.find(o => o.label.toLowerCase() === low)
        || (oneWord ? opts.find(o => o.label.toLowerCase().split(/\s|—/)[0] === low && low.length > 1) : null);
      if (hit) return { ok: true, value: hit.v, display: hit.label };
      // Loose combined answers for intent: "lose weight and build muscle" is
      // recomp — read BEFORE any substring match, or "lose" wins on its own
      // and the second half of what they said is dropped on the floor.
      if (item.key === 'intent') {
        const lose = /lose|cut|drop|fat|slim|lean/i.test(s), gain = /gain|build|muscle|bulk|bigger|stronger/i.test(s);
        if (lose && gain) return { ok: true, value: 'recomp', display: 'Both — lose fat and build muscle' };
        if (lose) return { ok: true, value: 'lose', display: 'Lose fat' };
        if (gain) return { ok: true, value: 'gain', display: 'Build muscle' };
        if (/maintain|hold|stay|keep/i.test(s)) return { ok: true, value: 'maintain', display: 'Hold where I am' };
      }
      const loose = opts.find(o => low.includes(String(o.v).toLowerCase()) && String(o.v).length > 2);
      if (loose) return { ok: true, value: loose.v, display: loose.label };
      if (item.key === 'plan_push' && /stop nagging|leave me|light|gentle|easy/i.test(s)) return { ok: true, value: 'light', display: 'Light' };
      if (item.key === 'plan_push' && /relentless|hard|chase|every time|push me/i.test(s)) return { ok: true, value: 'relentless', display: 'Relentless' };
      if (item.key === 'training_age') {
        if (/new|beginner|just start|never|first/i.test(s)) return { ok: true, value: 'beginner', display: 'New to it' };
        if (/year|advanced|long|decade|forever|ages/i.test(s)) return { ok: true, value: 'advanced', display: 'Years' };
        if (/while|some|bit|month|intermediate/i.test(s)) return { ok: true, value: 'intermediate', display: 'A while' };
      }
      // A count ("3", "three", "3 days") for the commitment counts.
      if (/_per_week$/.test(item.key)) {
        const c = countFrom(s);
        if (c != null) { const v = Math.min(c, 6); return { ok: true, value: v, display: opts.find(o => o.v === v)?.label || String(v) }; }
      }
      return { ok: false, why: `pick one: ${opts.map((o, i) => `${i + 1} ${o.label}`).join(', ')}` };
    }

    case 'number': {
      if (item.key === 'height_cm') {
        const cm = heightCm(s);
        return cm ? { ok: true, value: cm, display: `${cm} cm` } : { ok: false, why: 'a height like 190 cm or 6\'3' };
      }
      if (item.key === 'weight') {
        const m = s.match(/(\d+(?:\.\d+)?)\s*(kg|kilos?|kilograms?|lbs?|pounds?)?/i);
        if (!m) return { ok: false, why: 'a weight like 84 kg or 185 lb' };
        const n = Number(m[1]);
        const unit = /lb|pound/i.test(m[2] || '') ? 'lb' : 'kg';
        const kg = unit === 'lb' ? lbToKg(n) : Math.round(n * 100) / 100;
        if (kg < 20 || kg > 400) return { ok: false, why: 'a weight between 20 and 400 kg' };
        return { ok: true, value: kg, unit, reported: `${n} ${unit}`, display: `${n} ${unit}` };
      }
      if (item.key === 'birth_year') {
        const m = s.match(/\b(19\d\d|20\d\d)\b/);
        const yr = m ? Number(m[1]) : NaN;
        const now = new Date().getUTCFullYear();
        if (!Number.isFinite(yr) || yr < now - 110 || yr > now - 10) return { ok: false, why: 'a four-digit year' };
        return { ok: true, value: yr, display: String(yr) };
      }
      if (item.key === 'minutes_per_week') {
        const mins = minutesFrom(s);
        if (mins == null || mins < 0 || mins > 3000) return { ok: false, why: 'minutes a week, like 180 — or hours, like 3 hours' };
        return { ok: true, value: mins, display: `${mins} min` };
      }
      if (item.key === 'brief_hour') {
        const h = hourFrom(s);
        if (h == null) return { ok: false, why: 'an hour, 0 to 23 — 21 for nine at night' };
        return { ok: true, value: h, display: `${h}:00` };
      }
      const n = Number(s.replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? { ok: true, value: n, display: String(n) } : { ok: false, why: 'a number' };
    }

    case 'list': {
      const parts = s.split(/,|;|\band\b|\n|\+/).map(x => x.trim().toLowerCase()).filter(Boolean);
      if (!parts.length) return { ok: false, why: 'a list — "dumbbells, bands" — or "none"' };
      return { ok: true, value: parts.slice(0, 20).map(x => x.slice(0, 60)), display: parts.join(', ') };
    }

    case 'text':
    default: {
      if (item.key === 'timezone') {
        try { new Intl.DateTimeFormat('en', { timeZone: s }); return { ok: true, value: s, display: s }; }
        catch { return { ok: false, why: 'a timezone like America/Toronto' }; }
      }
      if (!s) return { ok: false, why: 'a few words' };
      return { ok: true, value: s.slice(0, 500), display: s.slice(0, 80) };
    }
  }
}

function heightCm(s) {
  const ft = s.match(/(\d)\s*(?:'|ft|feet|foot)\s*(\d{1,2})?/i);
  if (ft) return Math.round((Number(ft[1]) * 12 + Number(ft[2] || 0)) * 2.54 * 10) / 10;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(cm|centimet|in|inch|m\b)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = (m[2] || '').toLowerCase();
  let cm;
  if (u.startsWith('in')) cm = inToCm(n);
  else if (u === 'm' || (!u && n < 3)) cm = Math.round(n * 1000) / 10;
  else if (!u && n < 100) cm = inToCm(n);   // "75" with no unit is inches, not a 75cm adult
  else cm = Math.round(n * 10) / 10;
  return cm >= 100 && cm <= 250 ? cm : null;
}

const WORDS = { zero: 0, none: 0, one: 1, once: 1, two: 2, twice: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
function countFrom(s) {
  const m = s.match(/\d+/);
  if (m) return Number(m[0]);
  const w = s.toLowerCase().match(/\b(zero|none|one|once|two|twice|three|four|five|six|seven)\b/);
  return w ? WORDS[w[1]] : null;
}

function minutesFrom(s) {
  const h = s.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\b/i);
  const m = s.match(/(\d+)\s*(m|min|mins|minutes?)\b/i);
  if (h || m) return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0));
  const n = s.match(/\d+/);
  if (!n) return null;
  const v = Number(n[0]);
  return v <= 12 ? v * 60 : v;   // "3" a week is hours; "180" is minutes
}

function hourFrom(s) {
  const m = s.match(/(\d{1,2})(?::\d\d)?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = (m[2] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h <= 11 && /night|evening/i.test(s)) h += 12;
  return h >= 0 && h <= 23 ? h : null;
}

/**
 * The state the gate reads, built from the record. Mirrors the tool layer's
 * planFacts so the website and the assistant stop on the same answer.
 */
export async function setupState(userId) {
  const [profile, goals, memory, { data: recent }] = await Promise.all([
    getProfile(userId), getGoals(userId), getMemory(userId),
    supabase.from('wrought_events').select('detail').eq('user_id', userId)
      .eq('event_type', 'weight').order('occurred_at', { ascending: false }).limit(1),
  ]);
  const weightKg = recent?.[0]?.detail?.value_kg ?? null;
  return intakeState({ profile, goals, memory, weightKg, intent: intentFrom(goals) });
}

/**
 * Save answers. `answers` is an array of { key, answer } or an object keyed by
 * question. Every answer that parses is written; every one that does not is
 * reported by key with the reason. Returns the refreshed state as well, so the
 * caller reads the record back rather than echoing what it sent.
 */
export async function applyAnswers(userId, answers) {
  const list = Array.isArray(answers)
    ? answers
    : Object.entries(answers || {}).map(([key, answer]) => ({ key, answer }));

  const saved = [], rejected = [], not_saved = [];
  const patch = {};
  let weight = null, intent = null, goalWeight = null;
  const facts = [];

  for (const { key, answer } of list) {
    const item = intakeItem(String(key || '').trim());
    if (!item) { rejected.push({ key, why: 'not a question WROUGHT asks' }); continue; }
    const r = parseAnswer(item, answer);
    if (!r.ok) { rejected.push({ key: item.key, why: r.why }); continue; }

    switch (item.where) {
      case 'profile': {
        if (r.none) {
          // "None" on a list column is a real answer — store it as such so the
          // question closes, rather than leaving the column empty and asking again.
          patch[item.key] = item.kind === 'list' ? ['none'] : null;
        } else if (item.key === 'plan_pace' && !PACES[r.value]) { rejected.push({ key, why: 'gentle, steady or aggressive' }); continue; }
        else if (item.key === 'plan_push' && !PUSH[r.value]) { rejected.push({ key, why: 'light, normal or relentless' }); continue; }
        else if (item.key === 'activity_level' && !(r.value in ACTIVITY)) { rejected.push({ key, why: 'one of the four' }); continue; }
        else patch[item.key] = r.value;
        // A sport puts them on the athlete track; "none" is the general track.
        // Either answer closes the question.
        if (item.key === 'sport') { patch.track = r.none ? 'general' : 'athlete'; if (r.none) patch.sport = 'none'; }
        saved.push({ key: item.key, value: patch[item.key], display: r.display });
        break;
      }
      case 'event': { weight = r; saved.push({ key: 'weight', value: r.value, display: r.display }); break; }
      case 'goal': {
        if (item.key === 'intent') intent = r.value;
        else goalWeight = r;
        saved.push({ key: item.key, value: r.value, display: r.display });
        break;
      }
      case 'memory': {
        facts.push({ category: item.category, fact: r.none ? item.none_fact : r.value, key: item.key });
        saved.push({ key: item.key, value: r.none ? 'none' : r.value, display: r.display });
        break;
      }
      default: rejected.push({ key, why: 'nowhere to put that' });
    }
  }

  // ── The commitment adds up to the old number ──────────────────────────
  // train_days is what weekSoFar, the brief and every "N of M this week" read.
  // Strength plus stamina IS that number, so it is written in the same save.
  const cur = (patch.strength_per_week != null || patch.cardio_per_week != null)
    ? await getProfile(userId) : null;
  if (cur) {
    const s = patch.strength_per_week ?? cur.strength_per_week;
    const c = patch.cardio_per_week ?? cur.cardio_per_week;
    if (s != null && c != null) patch.train_days = Math.max(1, Math.min(14, Number(s) + Number(c)));
  }

  // ── Profile ───────────────────────────────────────────────────────────
  if (Object.keys(patch).length) {
    const row = { ...patch, user_id: userId, updated_at: new Date().toISOString() };
    let { error } = await supabase.from('wrought_profile').upsert(row, { onConflict: 'user_id' });
    if (error && COMMITMENT_COLS.some(k => k in row) && /schema cache|could not find|does not exist/i.test(error.message || '')) {
      // A door must be correct before the SQL runs. Save the rest, say which
      // part did not land and why.
      for (const k of COMMITMENT_COLS) if (k in row) { not_saved.push(k); delete row[k]; }
      delete row.train_days;
      ({ error } = await supabase.from('wrought_profile').upsert(row, { onConflict: 'user_id' }));
    }
    if (error) {
      for (const k of Object.keys(patch)) rejected.push({ key: k, why: error.message });
      // Drop them from saved — nothing landed.
      for (const k of Object.keys(patch)) { const i = saved.findIndex(x => x.key === k); if (i >= 0) saved.splice(i, 1); }
    } else {
      for (const k of not_saved) { const i = saved.findIndex(x => x.key === k); if (i >= 0) saved.splice(i, 1); }
    }
  }

  // ── The weigh-in — an event, not a column ─────────────────────────────
  if (weight) {
    const profile = await getProfile(userId);
    try {
      await insertEvents(userId, profile, [{
        event_type: 'weight', summary: weight.reported,
        detail: { value_kg: weight.value, reported: weight.reported }, estimated: false,
      }], { rawInput: weight.reported, source: 'setup' });
    } catch (e) {
      rejected.push({ key: 'weight', why: e.message });
      const i = saved.findIndex(x => x.key === 'weight'); if (i >= 0) saved.splice(i, 1);
    }
  }

  // ── The body goal — computed, paced, floored — after the facts it needs ─
  if (intent) {
    const done = await setBodyGoal(userId, { intent, pace: patch.plan_pace || null });
    if (done.error) {
      rejected.push({ key: 'intent', why: done.error === 'setup_needed'
        ? `needs ${(done.missing || []).join(', ') || 'the five facts'} first` : done.error });
      const i = saved.findIndex(x => x.key === 'intent'); if (i >= 0) saved.splice(i, 1);
    }
  }
  if (goalWeight && !goalWeight.none) {
    const m = String(goalWeight.value).match(/(\d+(?:\.\d+)?)\s*(kg|lb|lbs|pounds?)?/i);
    if (m) {
      const n = Number(m[1]); const kg = /lb|pound/i.test(m[2] || '') ? lbToKg(n) : n;
      const dateM = String(goalWeight.value).match(/\b(20\d\d-\d\d-\d\d)\b/);
      const goals = await getGoals(userId);
      const body = goals.find(g => g.metric === 'weight_kg');
      if (body) {
        await supabase.from('wrought_goals').update({ target_value: kg, target_date: dateM?.[1] || body.target_date || null }).eq('id', body.id);
      } else {
        await supabase.from('wrought_goals').insert([{ user_id: userId, goal: `Reach ${n} ${m[2] || 'kg'}`, metric: 'weight_kg',
          direction: 'reach', target_value: kg, target_unit: 'kg', cadence: 'once', target_date: dateM?.[1] || null }]);
      }
    } else {
      rejected.push({ key: 'goal_weight', why: 'a weight, with a date if there is one' });
      const i = saved.findIndex(x => x.key === 'goal_weight'); if (i >= 0) saved.splice(i, 1);
    }
  }

  // ── Memory — their words, or the stated "none" ────────────────────────
  for (const f of facts) {
    try { await rememberFact(userId, f.fact, f.category); }
    catch (e) {
      rejected.push({ key: f.key, why: e.message });
      const i = saved.findIndex(x => x.key === f.key); if (i >= 0) saved.splice(i, 1);
    }
  }

  const state = await setupState(userId);
  return { saved, rejected, not_saved, state };
}

export { INTAKE, GATE_KEYS };
