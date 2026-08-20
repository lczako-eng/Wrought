// netlify/functions/api-log.js
// The record itself, readable.
//
// Everything else on the dashboard is arithmetic about the log — matrices,
// trends, averages. This is the log. Day by day, newest first, with every meal
// and every set exactly as it was put in.
//
// It matters more than it looks. A product whose whole promise is "it
// remembers" has to let you go and look, or the memory is a claim rather than a
// fact. It is also the only way somebody catches a mis-heard entry from three
// weeks ago — "burrito" filed as "burrata" is invisible in an average and
// obvious in a log.
//
// Paginated by date rather than by row, because a day is the unit a person
// thinks in. Ask for 14 days before a cursor and you get 14 days, however many
// entries that turns out to be.

import {
  getAuthUser, getProfile, localDateFor, localMinutesFor, clockString,
  addDays, daysBetween, sayWeight, sayLength, kgToLb, humanDuration, supabase,
  insertEvents,
} from './lib/wrought.js';
import { parseQuickAdd } from './lib/quickadd.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const num = v => (Number.isFinite(+v) ? +v : 0);

function macroSplit(t) {
  const kcal = { protein: num(t.protein_g) * 4, carbs: num(t.carbs_g) * 4, fat: num(t.fat_g) * 9 };
  const sum = kcal.protein + kcal.carbs + kcal.fat;
  if (!sum) return null;
  const pct = v => Math.round((v / sum) * 1000) / 10;
  return {
    protein_pct: pct(kcal.protein),
    carbs_pct: pct(kcal.carbs),
    fat_pct: pct(kcal.fat),
    // Sugar is a SUBSET of carbs, never additional to them — it rides as its
    // own share of the carb block rather than a fourth slice.
    sugar_pct_of_carbs: num(t.carbs_g) ? Math.round((num(t.sugar_g) / num(t.carbs_g)) * 1000) / 10 : null,
  };
}

const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

const itemNumbers = (detail = {}) => {
  const n = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
  return {
    calories: n(detail.calories), protein_g: n(detail.protein_g),
    carbs_g: n(detail.carbs_g), sugar_g: n(detail.sugar_g), fat_g: n(detail.fat_g),
  };
};

// The day, read back off the STORED rows rather than assembled from what was
// just sent. Same doctrine as day_total on the connector side, and for the same
// reason: echoing the arguments back proves a write was composed, never that it
// landed. This is the only thing that proves the record holds it.
async function foodDay(userId, profile) {
  const date = localDateFor(profile.timezone);
  const { data } = await supabase.from('wrought_events')
    .select('id, event_type, occurred_at, summary, detail, estimated')
    .eq('user_id', userId).eq('local_date', date)
    .in('event_type', ['food', 'drink'])
    .order('occurred_at', { ascending: true }).limit(200);

  const rows = data || [];
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  let uncounted = 0;
  const items = rows.map(r => {
    const nums = itemNumbers(r.detail);
    for (const k of Object.keys(totals)) totals[k] += num(nums[k]);
    if (nums.calories == null) uncounted += 1;
    return {
      id: r.id, summary: r.summary, kind: r.event_type,
      at: clockString(localMinutesFor(profile.timezone, new Date(r.occurred_at))),
      estimated: !!r.estimated, ...nums,
    };
  });

  return {
    date,
    items,
    meals: items.length,
    ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v)])),
    // A total that looks low because something never got logged is a fact worth
    // stating, never a number to quietly inflate.
    meals_without_macros: uncounted,
  };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return reply(500, { error: 'server_not_configured' });

  const user = await getAuthUser(event);
  if (!user) return reply(401, { error: 'sign_in_required' });

  const q = event.queryStringParameters || {};
  const profile = await getProfile(user.id);

  // ── Writing: the website's own door onto the food log ─────────────────────
  //
  // Until this existed, wrought.fit could read a meal and not record one, so
  // an assistant that would not write left the person with nowhere to go. The
  // settled doctrine is that the website plus the connector are the complete
  // product; a log with no way to log was that promise not being kept.
  if (event.httpMethod === 'POST') {
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { payload = {}; }

    const parsed = parseQuickAdd(payload.text);
    if (!parsed.ok) return reply(400, { error: 'unparseable', say: parsed.why });

    let written;
    try {
      // source 'web' rather than 'agent', because "why is this not in my log"
      // is answered completely differently for something typed here and
      // something an assistant wrote.
      [written] = await insertEvents(user.id, profile, [parsed.event], {
        source: 'web', rawInput: String(payload.text).slice(0, 500),
      });
    } catch (e) {
      // A swallowed write error is worse than a crash — it looks exactly like
      // success, which is the failure this whole endpoint exists to end.
      return reply(500, { error: 'not_saved', say: `That did not save: ${e.message}` });
    }

    const day = await foodDay(user.id, profile);
    const nums = itemNumbers(written.detail);
    return reply(200, {
      ok: true,
      entry: { id: written.id, summary: written.summary, kind: written.event_type,
               local_date: written.local_date, estimated: written.estimated, ...nums },
      read: parsed.read,
      day,
      // The item, then the day, in that order — the order the person is
      // thinking in, and the only order in which a wrong figure is catchable.
      say: `${written.summary}${nums.calories != null ? ` — roughly ${nums.calories.toLocaleString()} kcal` : ''}. ` +
           `${day.calories.toLocaleString()} kcal logged today across ${day.meals} ${day.meals === 1 ? 'entry' : 'entries'}.`,
    });
  }

  // Correcting the record from the same door that writes it. Deliberately
  // limited to food and drink: a workout event owns derived rows in
  // wrought_sets, and deleting one here would leave a lift record standing on
  // training the log no longer contains. Retracting a session is the
  // connector's job, where that clean-up is already handled.
  if (event.httpMethod === 'DELETE') {
    let payload = {};
    try { payload = JSON.parse(event.body || '{}'); } catch { payload = {}; }
    const id = String(payload.id || '').trim();
    if (!id) return reply(400, { error: 'no_id' });

    // Scoped to the caller's own rows, and checked before the delete rather
    // than trusted to a filter — an id from a page is an id from a stranger
    // until the record says otherwise.
    const { data: row } = await supabase.from('wrought_events')
      .select('id, event_type, summary').eq('user_id', user.id).eq('id', id).maybeSingle();
    if (!row) return reply(404, { error: 'not_found', say: 'That entry is not on your record.' });
    if (row.event_type !== 'food' && row.event_type !== 'drink') {
      return reply(400, { error: 'not_removable',
        say: 'Only food and drink can be taken off from here. Ask your AI to retract anything else.' });
    }

    const { error } = await supabase.from('wrought_events')
      .delete().eq('user_id', user.id).eq('id', id);
    if (error) return reply(500, { error: 'not_removed', say: `That did not come off: ${error.message}` });

    const day = await foodDay(user.id, profile);
    return reply(200, { ok: true, removed: row.summary, day,
      say: `Took off ${row.summary}. ${day.calories.toLocaleString()} kcal logged today.` });
  }

  const span   = Math.min(Math.max(parseInt(q.days, 10) || 14, 1), 60);
  const before = q.before || localDateFor(profile.timezone);
  const from   = addDays(before, -(span - 1));

  const [events, sets, sessions, metrics] = await Promise.all([
    supabase.from('wrought_events')
      .select('id, event_type, occurred_at, local_date, summary, detail, estimated, source, raw_input')
      .eq('user_id', user.id).gte('local_date', from).lte('local_date', before)
      .order('occurred_at', { ascending: true }).limit(2000)
      .then(r => r.data || []),
    supabase.from('wrought_sets')
      .select('session_id, exercise, set_number, position, reps, weight_kg, rpe, note, local_date, logged_at')
      .eq('user_id', user.id).gte('local_date', from).lte('local_date', before)
      .order('logged_at', { ascending: true }).limit(4000)
      .then(r => r.data || []),
    supabase.from('wrought_sessions')
      .select('id, name, kind, local_date, started_at, ended_at, status')
      .eq('user_id', user.id).gte('local_date', from).lte('local_date', before)
      .then(r => r.data || []),
    supabase.from('wrought_metrics')
      .select('metric, value, unit, local_date, source')
      .eq('user_id', user.id).gte('local_date', from).lte('local_date', before)
      .limit(4000)
      .then(r => r.data || []),
  ]);

  const imperial = profile.units === 'imperial';
  const at = ts => clockString(localMinutesFor(profile.timezone, new Date(ts)));

  // Sets, grouped into the session they belong to. A workout read back as a
  // flat list of forty rows is unreadable; read back as four exercises with
  // their sets underneath, it is the session you actually did.
  const setsBySession = new Map();
  for (const s of sets) {
    const key = s.session_id || `loose-${s.local_date}`;
    if (!setsBySession.has(key)) setsBySession.set(key, []);
    setsBySession.get(key).push(s);
  }

  const sessionById = new Map(sessions.map(s => [s.id, s]));

  const groupSets = rows => {
    const byExercise = new Map();
    for (const s of rows) {
      if (!byExercise.has(s.exercise)) {
        byExercise.set(s.exercise, { exercise: s.exercise, position: s.position ?? 99, sets: [] });
      }
      byExercise.get(s.exercise).sets.push({
        n: s.set_number,
        reps: s.reps,
        weight: s.weight_kg == null ? null : (imperial ? kgToLb(Number(s.weight_kg)) : Number(s.weight_kg)),
        rpe: s.rpe == null ? null : Number(s.rpe),
        note: s.note || null,
      });
    }
    return [...byExercise.values()]
      .sort((a, b) => a.position - b.position)
      .map(e => ({
        ...e,
        volume: Math.round(e.sets.reduce((a, s) => a + num(s.reps) * num(s.weight), 0)),
        top: e.sets.reduce((a, s) => ((s.weight ?? 0) > (a?.weight ?? -1) ? s : a), null),
      }));
  };

  // ── Assemble, one day at a time ───────────────────────────────────────────
  const byDay = new Map();
  const dayOf = d => {
    if (!byDay.has(d)) byDay.set(d, {
      date: d,
      weekday: new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      days_ago: daysBetween(d, localDateFor(profile.timezone)),
      food: [], workouts: [], activity: [], body: [], other: [],
      totals: { calories: 0, protein_g: 0, carbs_g: 0, sugar_g: 0, fat_g: 0, estimated: false },
      device: {},
    });
    return byDay.get(d);
  };
  for (let d = from; d <= before; d = addDays(d, 1)) dayOf(d);

  for (const e of events) {
    const day = dayOf(e.local_date);
    const base = { id: e.id, at: at(e.occurred_at), summary: e.summary, estimated: e.estimated, source: e.source };

    if (e.event_type === 'food' || e.event_type === 'drink') {
      day.food.push({
        ...base,
        kind: e.event_type,
        items: e.detail?.items || null,
        calories: e.detail?.calories ?? null,
        protein_g: e.detail?.protein_g ?? null,
        carbs_g: e.detail?.carbs_g ?? null,
        sugar_g: e.detail?.sugar_g ?? null,
        fat_g: e.detail?.fat_g ?? null,
        categories: e.detail?.categories || [],
      });
      for (const k of ['calories', 'protein_g', 'carbs_g', 'sugar_g', 'fat_g']) {
        day.totals[k] += num(e.detail?.[k]);
      }
      if (e.estimated) day.totals.estimated = true;

    } else if (e.event_type === 'workout') {
      const sid = e.detail?.session_id;
      const rows = sid ? (setsBySession.get(sid) || []) : [];
      const session = sid ? sessionById.get(sid) : null;
      day.workouts.push({
        ...base,
        kind: e.detail?.kind || 'workout',
        minutes: e.detail?.minutes ?? null,
        muscles: e.detail?.muscles || [],
        volume_kg: e.detail?.volume_kg ?? null,
        distance_km: e.detail?.distance_km ?? null,
        calories: e.detail?.calories ?? null,
        // The training spike, carried to the readable log — a run's average
        // says how hard it was, and without it a watch session is a name and
        // a duration, which is the least interesting version of what happened.
        avg_hr: e.detail?.avg_hr ?? null,
        max_hr: e.detail?.max_hr ?? null,
        note: e.detail?.note || null,
        name: session?.name || e.summary,
        // The whole point: the session, set by set, exactly as it happened.
        exercises: groupSets(rows),
      });

    } else if (e.event_type === 'activity') {
      // A SHIFT IS NOT A SESSION. It sits with the training half of the day
      // because it is the other way calories leave, and it carries its own
      // hours and figure — "logged as activity" with no number is the whole
      // feature failing quietly. Never counted toward the weekly target and
      // never praised: it is a fact about the day.
      day.activity.push({ ...base, kind: 'activity',
        label: e.detail?.label || e.summary,
        hours: num(e.detail?.hours) || null,
        calories: num(e.detail?.kcal) || null });

    } else if (e.event_type === 'weight') {
      day.body.push({ ...base, kind: 'weight',
        value: sayWeight(num(e.detail?.value_kg), profile.units) });
    } else if (e.event_type === 'measurement') {
      day.body.push({ ...base, kind: 'measurement', site: e.detail?.metric,
        value: sayLength(num(e.detail?.value_cm), profile.units) });
    } else {
      day.other.push({ ...base, kind: e.event_type });
    }
  }

  // Sets logged without a matching workout event still belong to their day —
  // an abandoned session is still a record of work that was actually done.
  for (const [key, rows] of setsBySession) {
    if (!key.startsWith('loose-')) {
      const session = sessionById.get(key);
      if (session && session.status !== 'done') {
        const day = dayOf(session.local_date);
        day.workouts.push({
          id: key, at: at(session.started_at), name: session.name,
          kind: session.kind, summary: `${session.name} (unfinished)`,
          incomplete: true, minutes: null, muscles: [], exercises: groupSets(rows),
        });
      }
    }
  }

  for (const m of metrics) {
    const day = dayOf(m.local_date);
    const k = m.metric;
    day.device[k] = (day.device[k] || 0) + num(m.value);
    if (k === 'resting_hr' || k === 'hrv') day.device[k] = num(m.value);   // not additive
  }

  const days = [...byDay.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(d => ({
      ...d,
      totals: {
        ...Object.fromEntries(Object.entries(d.totals)
          .map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])),
        // The macro SPLIT, computed here rather than on the page. It is drawn
        // as a proportional bar, and a bar is a claim about the day — so it
        // comes off the same numbers the brief quotes rather than being worked
        // out again in the browser where the two could drift apart.
        //
        // By calories, not grams. Protein and carbs are 4 kcal a gram and fat
        // is 9, so a gram bar makes a high-fat day look like a low-fat one and
        // the picture argues with the total printed beside it.
        split: macroSplit(d.totals),
      },
      device: {
        ...d.device,
        sleep_say: d.device.sleep_minutes ? humanDuration(Math.round(d.device.sleep_minutes)) : null,
      },
      // A day with a shift on it and nothing else is not an empty day — that
      // was eight hours of somebody's life and several hundred calories.
      empty: !d.food.length && !d.workouts.length && !d.activity.length
             && !d.body.length && !d.other.length
             && !Object.keys(d.device).length,
    }));

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      from, to: before, days,
      units: profile.units,
      weight_unit: imperial ? 'lb' : 'kg',
      // Cursor for the next page back. A day is the unit people think in, so
      // pagination is by date rather than by row count.
      next_before: addDays(from, -1),
      has_more: days.some(d => !d.empty),
    }),
  };
};
