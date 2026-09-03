// lib/integrity.js
// The record, checked against itself — what looks wrong, said plainly, with a
// door to fix each one.
//
// This file exists because of how the last month went. Duplicate sets from a
// re-told workout, an incline press keyed as the overhead press, a workout
// filed on the wrong day, a shift typed as a note, a session with no minutes
// on it counting for nothing — every one was found by a person reading a
// screenshot or a row, and every one had been sitting in the record silently
// for days. The repair sweeps that fix them are scattered across the reads and
// say nothing when they run.
//
// A memory product whose memory can be quietly wrong is worse than one with
// no memory, because it looks right. So this is one read over the last month
// that names what the arithmetic cannot use — a meal with no calories, a
// workout with no minutes, a set that landed twice, a scale nobody has stood
// on — and hands each one back with its ids and the way to fix it.
//
// WHAT IT NEVER DOES. It never fixes anything on its own. Two coffees in a
// day is ordinary, a six-hour hike is a real workout, and an identical set
// three minutes apart can be a genuine repeat. It ASKS, with the evidence, and
// the person — who knows — taps or says the word. And it never grades: a
// record with gaps is a record with gaps, not a failing.

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

// Sets that are the same set written twice: same session (or day), same lift,
// same reps and weight, stamped within a few seconds of each other. Sets
// minutes apart with the same numbers are ordinary training and are left alone.
export const DUPLICATE_SET_WINDOW_MS = 5000;

export function duplicateSets(sets = []) {
  const groups = new Map();
  for (const s of sets || []) {
    if (!s || s.reps == null && s.weight_kg == null) continue;
    const k = [s.session_id || s.local_date || '', s.exercise_key || s.exercise || '', s.reps ?? '', s.weight_kg ?? ''].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const out = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const sorted = rows.slice().sort((a, b) => new Date(a.logged_at || 0) - new Date(b.logged_at || 0));
    const extra = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = Math.abs(new Date(sorted[i].logged_at || 0) - new Date(sorted[i - 1].logged_at || 0));
      if (gap <= DUPLICATE_SET_WINDOW_MS) extra.push(sorted[i]);
    }
    if (!extra.length) continue;
    out.push({
      exercise: sorted[0].exercise || sorted[0].exercise_key,
      date: sorted[0].local_date || null,
      reps: sorted[0].reps ?? null, weight_kg: sorted[0].weight_kg ?? null,
      kept_id: sorted[0].id ?? null,
      extra_ids: extra.map(r => r.id).filter(Boolean),
      count: extra.length,
    });
  }
  return out;
}

/**
 * @param days      rangeFacts days over the last ~30 (for the weigh-in gap)
 * @param sets      wrought_sets rows over the last ~30 days: id, exercise, exercise_key, reps, weight_kg, session_id, local_date, logged_at, muscles
 * @param workouts  workout EVENTS over the last ~30 days: id, local_date, summary, detail, source
 * @param food      food/drink events over the last ~14 days: id, local_date, summary, detail
 * @param todayDups duplicateItems() over today's log (already computed for the day panel)
 * @param today     the person's local date
 */
export function recordCheck({ days = [], sets = [], workouts = [], food = [], todayDups = [], today = null } = {}) {
  const issues = [];
  const cut14 = today ? addDaysStr(today, -13) : null;

  // ── The record is WRONG: doubled rows ────────────────────────────────────
  const dupSets = duplicateSets(sets);
  if (dupSets.length) {
    const extra = dupSets.reduce((a, d) => a + d.count, 0);
    issues.push({
      kind: 'duplicate_sets', severity: 'wrong',
      count: extra,
      items: dupSets.slice(0, 8).map(d => ({
        what: `${d.exercise} — ${d.reps ?? '?'} × ${d.weight_kg ?? 'bw'} on ${d.date}`,
        kept_id: d.kept_id, extra_ids: d.extra_ids,
      })),
      say: `${extra} set${extra === 1 ? '' : 's'} landed twice within seconds — the same lift, reps and weight — and ${extra === 1 ? 'is' : 'are'} counting in your lift record, your max and your volume.`,
      fix: { web: 'Remove the extra', tool: 'record_check with drop_set_ids', ids: dupSets.flatMap(d => d.extra_ids) },
    });
  }
  if ((todayDups || []).length) {
    const n = todayDups.reduce((a, d) => a + (d.times - 1), 0);
    issues.push({
      kind: 'duplicate_food', severity: 'ask',
      count: n,
      items: todayDups.map(d => ({ what: `${d.summary} × ${d.times}${d.likely ? ' (minutes apart — likely one meal counted twice)' : ''}`, ids: d.ids })),
      say: `${todayDups.map(d => `"${d.summary}" is on today ${d.times} times`).join('; ')}. Two coffees is ordinary; a meal logged twice is not.`,
      fix: { web: 'Remove on the day panel', tool: 'undo_last, or amend_last on the extra' },
    });
  }

  // ── The record is INCOMPLETE: rows the arithmetic cannot use ─────────────
  const foodNoKcal = (food || []).filter(f => (f.event_type === 'food' || f.event_type === 'drink' || !f.event_type)
    && (f.detail?.calories == null) && (!cut14 || f.local_date >= cut14));
  if (foodNoKcal.length) {
    issues.push({
      kind: 'food_uncounted', severity: 'gap',
      count: foodNoKcal.length,
      items: foodNoKcal.slice(0, 8).map(f => ({ id: f.id, date: f.local_date, what: f.summary })),
      say: `${foodNoKcal.length} thing${foodNoKcal.length === 1 ? '' : 's'} you ate in the last fortnight ${foodNoKcal.length === 1 ? 'has' : 'have'} no calories on ${foodNoKcal.length === 1 ? 'it' : 'them'}, so ${foodNoKcal.length === 1 ? 'it counts' : 'they count'} for nothing in every total and in what the scale is read against.`,
      fix: { web: 'Say roughly what it was to your assistant, or remove it', tool: 'amend_last / structure_entries with the calories' },
    });
  }
  const untimed = (workouts || []).filter(w => {
    const d = w.detail || {};
    return d.calories == null && !(num(d.minutes) > 0) && !(num(d.distance_km) > 0);
  });
  if (untimed.length) {
    issues.push({
      kind: 'workout_uncounted', severity: 'gap',
      count: untimed.length,
      items: untimed.slice(0, 8).map(w => ({ id: w.id, date: w.local_date, what: w.summary })),
      say: `${untimed.length} workout${untimed.length === 1 ? '' : 's'} ${untimed.length === 1 ? 'has' : 'have'} no minutes on ${untimed.length === 1 ? 'it' : 'them'} and ${untimed.length === 1 ? 'counts' : 'count'} for nothing toward calories out.`,
      fix: { web: 'Say how long it was to your assistant', tool: 'amend_last with the minutes' },
    });
  }
  const long = (workouts || []).filter(w => num(w.detail?.minutes) >= 150 && !w.detail?.session_id && (w.source || 'agent') === 'agent');
  if (long.length) {
    issues.push({
      kind: 'workout_long', severity: 'ask',
      count: long.length,
      items: long.slice(0, 8).map(w => ({ id: w.id, date: w.local_date, what: `${w.summary} — ${w.detail.minutes} min` })),
      say: `${long.length} workout${long.length === 1 ? '' : 's'} ${long.length === 1 ? 'runs' : 'run'} over two and a half hours. If that was a shift rather than training, it is being clamped to what the watch saw and counted toward your training week.`,
      fix: { web: 'Log as work', tool: 'log_activity, then undo the workout' },
    });
  }
  const noMuscle = (sets || []).filter(s => !Array.isArray(s.muscles) || !s.muscles.length).length;
  if (noMuscle && sets.length) {
    issues.push({
      kind: 'sets_no_muscle', severity: 'info',
      count: noMuscle,
      say: `${noMuscle} of ${sets.length} sets carry no muscle group, so the weekly dose per muscle cannot count them.`,
      fix: { tool: 'nothing to do by hand — sets logged from a saved workout carry their muscles; ad-hoc ones can be told ("that was chest")' },
    });
  }

  // ── The record is STALE: the corrector has no point ──────────────────────
  const weighed = (days || []).filter(d => d.weight_kg != null);
  const lastWeigh = weighed.length ? weighed[weighed.length - 1].date : null;
  const since = lastWeigh && today ? daysBetween(lastWeigh, today) : (today && days.length ? days.length : null);
  if (since != null && since > 14) {
    issues.push({
      kind: 'weigh_in_gap', severity: 'gap',
      count: since,
      say: lastWeigh
        ? `${since} days since the last weigh-in. The scale is what corrects every target, and it has no point to work from.`
        : 'No weigh-in in the last month. The scale is what corrects every target, and it has no point to work from.',
      fix: { web: 'A weight on the hero panel', tool: 'log_weight' },
    });
  }

  const order = { wrong: 0, ask: 1, gap: 2, info: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const acting = issues.filter(i => i.severity !== 'info');

  return {
    checked: today,
    clean: acting.length === 0,
    count: acting.length,
    issues,
    say: acting.length
      ? `${acting.length} thing${acting.length === 1 ? '' : 's'} in the record worth a look: ${acting.map(i => i.say).join(' ')}`
      : 'Nothing in the last month looks wrong or is counting for nothing.',
    note: 'Say what is listed, in its own words, with the fix beside each. NEVER fix anything on your own from this read — two coffees in a day is ordinary and a long hike is a real workout; the person decides, and the doors are named. Never a remark about how the gaps got there.',
  };
}

function addDaysStr(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
