// netlify/functions/api-progress.js
// The dashboard's data endpoint.
//
// This exists so the web charts and the MCP brief cannot disagree. Both call
// into lib/wrought.js and lib/training.js and both get the same arithmetic. If
// the dashboard drew its own averages in JavaScript, the day would come when
// the chart says 151g of protein and the nightly verdict says 148, and on that
// day nobody believes either one again.

import {
  getAuthUser, getProfile, getGoals, getWindow, windowStatus,
  localDateFor, addDays, humanDuration, kgToLb, daysBetween,
  rangeFacts, summariseRange, dayFacts, careFlags, scoreGoals, supabase,
} from './lib/wrought.js';
import { orderInsight, earnedRoom, energyBalance, exerciseKey, deviceMatrix, weekdayPattern, focusCall, lastSession } from './lib/training.js';
import { blockPosition } from './lib/library.js';
import { nutritionTotals, composition, macroMatrix, yearOverYear } from './lib/nutrition.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_not_configured' }) };

  const user = await getAuthUser(event);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'sign_in_required' }) };

  const params = event.queryStringParameters || {};
  const span = Math.min(Math.max(parseInt(params.days, 10) || 30, 3), 400);

  const profile = await getProfile(user.id);
  const to   = params.to || localDateFor(profile.timezone);
  const from = addDays(to, -(span - 1));

  const [range, today, goals, win, setRows, sessions, routines, foodRows, brief] = await Promise.all([
    rangeFacts(user.id, profile, from, to),
    dayFacts(user.id, profile, to),
    getGoals(user.id),
    getWindow(user.id),
    supabase.from('wrought_sets')
      .select('exercise, exercise_key, reps, weight_kg, rpe, position, set_number, muscles, session_id, local_date, note')
      .eq('user_id', user.id).gte('local_date', from).lte('local_date', to)
      .order('logged_at', { ascending: false }).limit(3000)
      .then(r => r.data || []),
    supabase.from('wrought_sessions')
      .select('id, name, kind, local_date, started_at, ended_at, status')
      .eq('user_id', user.id).eq('status', 'done')
      .order('ended_at', { ascending: false }).limit(12)
      .then(r => r.data || []),
    supabase.from('wrought_routines')
      .select('name, kind, exercises, times_used, last_used_on')
      .eq('user_id', user.id).eq('active', true)
      .order('last_used_on', { ascending: false, nullsFirst: false })
      .then(r => r.data || []),
    supabase.from('wrought_events')
      .select('event_type, local_date, detail, estimated')
      .eq('user_id', user.id).in('event_type', ['food', 'drink'])
      .order('local_date', { ascending: false }).limit(8000)
      .then(r => r.data || []),
    supabase.from('wrought_briefs')
      .select('local_date, kind, verdict').eq('user_id', user.id)
      .order('local_date', { ascending: false }).limit(1).maybeSingle()
      .then(r => r.data),
  ]);

  // The running block, and how far through it they are. A missed week is a
  // missed week rather than a skipped one, so this counts sessions rather than
  // reading a date off the calendar.
  let blockView = null;
  const { data: blockRow } = await supabase.from('wrought_blocks')
    .select('id, name, weeks, days_per_week, plan').eq('user_id', user.id).eq('status', 'active').maybeSingle();
  if (blockRow) {
    const { count } = await supabase.from('wrought_sessions')
      .select('id', { count: 'exact', head: true }).eq('block_id', blockRow.id).eq('status', 'done');
    const pos = blockPosition(blockRow.plan, count || 0);
    const wk = blockRow.plan?.schedule?.[pos.week - 1];
    const nextUp = wk?.sessions?.[pos.day - 1];
    blockView = {
      running: !pos.complete,
      name: blockRow.name,
      week: pos.week, of_weeks: blockRow.weeks,
      session: pos.day, of_week: blockRow.days_per_week,
      sessions_done: pos.done, sessions_total: pos.total, percent: pos.pct,
      this_week_is: pos.intent,
      deload_weeks: blockRow.plan?.deload_weeks || [],
      up_next: nextUp ? { name: nextUp.name, exercises: nextUp.exercises.map(e => ({ name: e.name, sets: e.sets, reps: e.reps })) } : null,
      say: pos.say,
    };
  }

  const summary  = summariseRange(range, profile);
  const flags    = careFlags(range, profile);
  const imperial = profile.units === 'imperial';
  const w = kg => (kg == null ? null : imperial ? kgToLb(kg) : kg);

  // ── Energy, and the room it has earned ────────────────────────────────────
  let weightKg = today.body.weight_kg;
  if (weightKg == null) {
    const recent = range.days.filter(d => d.weight_kg != null).pop();
    weightKg = recent?.weight_kg ?? null;
  }

  const balance = energyBalance({
    profile, weightKg,
    caloriesIn: today.food.calories,
    activeCalories: today.device.active_calories,
    foodEstimated: today.food.estimated,
  });

  const calorieGoal = goals.find(g => g.metric === 'calories' && g.cadence === 'daily');
  const room = earnedRoom({
    days: range.days.slice(-7),
    dailyTarget: calorieGoal?.target_value != null ? Number(calorieGoal.target_value)
               : balance.known ? balance.calories_out : null,
    flags,
    honestyDays: range.days.slice(-7).filter(d => d.logged).length,
  });

  // ── Strength: best set ever seen per lift, and how it moved ───────────────
  // The dashboard's job here is the question people actually open a training
  // app to ask: is anything going up?
  //
  // Bodyweight work used to be dropped here for having no weight, which quietly
  // deleted press-ups, pull-ups, dips and every calisthenic from the one view
  // that answers "is anything going up?". They progress too — in reps. So a lift
  // is measured by load if it ever carried one, and by reps if it never did.
  const byLift = new Map();
  for (const s of setRows) {
    const k = s.exercise_key || exerciseKey(s.exercise);
    if (!byLift.has(k)) byLift.set(k, { name: s.exercise, sessions: new Map() });
    const lift = byLift.get(k);
    const id = s.session_id || s.local_date;
    const prev = lift.sessions.get(id);
    const kg = s.weight_kg == null ? null : Number(s.weight_kg);
    const reps = s.reps == null ? null : Number(s.reps);
    // The session's best set: heaviest when loaded, most reps when not.
    const better = !prev
      || (kg != null && (prev.weight_kg == null || kg > prev.weight_kg))
      || (kg == null && prev.weight_kg == null && (reps || 0) > (prev.reps || 0));
    if (better) lift.sessions.set(id, { weight_kg: kg, reps, date: s.local_date });
  }

  const lifts = [...byLift.entries()].map(([key, lift]) => {
    const points = [...lift.sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
    const loaded = points.some(p => p.weight_kg != null);
    const at = p => (loaded ? w(p.weight_kg) : p.reps) ?? 0;

    const best = points.reduce((a, p) => (at(p) > at(a) ? p : a), points[0]);
    const first = points[0], last = points[points.length - 1];
    return {
      key, name: lift.name,
      sessions: points.length,
      // What this lift is measured in, so the page can label a number rather
      // than print a bare one and leave the reader to guess.
      metric: loaded ? 'weight' : 'reps',
      unit: loaded ? (imperial ? 'lb' : 'kg') : 'reps',
      best:   { weight: w(best.weight_kg), reps: best.reps, date: best.date },
      latest: { weight: w(last.weight_kg), reps: last.reps, date: last.date },
      change: points.length > 1 ? Math.round((at(last) - at(first)) * 10) / 10 : null,
      // Both numbers ride along on every point: the question is never just
      // "how heavy" — 100kg for 3 and 100kg for 8 are different weeks.
      series: points.map(p => ({ date: p.date, value: at(p), weight: w(p.weight_kg), reps: p.reps })),
    };
  }).filter(l => l.sessions >= 2)
    .sort((a, b) => b.sessions - a.sessions);

  const notes = setRows.filter(s => s.note)
    .slice(0, 12)
    .map(s => ({ date: s.local_date, exercise: s.exercise, note: s.note }));

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      from, to, span_days: span,
      units: profile.units,
      weight_unit: imperial ? 'lb' : 'kg',
      today: {
        date: to,
        food: today.food,
        training: today.training,
        body: today.body,
        device: today.device,
        entries: today.log,
        balance,
      },
      earned_room: room,
      summary: {
        ...summary,
        sleep_avg_say: summary.sleep_avg_minutes ? humanDuration(summary.sleep_avg_minutes) : null,
      },
      goals: scoreGoals(goals, today, summary, profile),
      eating_window: windowStatus(win, profile.timezone),
      lifts,
      // The session itself, set by set. Everything else here is arithmetic
      // ABOUT training; this is the training.
      last_session: lastSession(sessions, setRows, { today: to, imperial }),
      // Where they are in the running block, if there is one. Counted from
      // sessions finished, never from the calendar.
      block: blockView,
      exercise_order: orderInsight(setRows),
      focus: focusCall(range.days, { today: to }),
      nutrition: {
        totals: nutritionTotals(foodRows, { today: to }),
        composition: composition(foodRows, { since: addDays(to, -89) }),
        macro_matrix: macroMatrix(foodRows, { weeks: 12, today: to }),
        year_over_year: yearOverYear(foodRows, { today: to }),
      },
      device_matrix: deviceMatrix(range.days),
      weekday: weekdayPattern(range.days),
      notes,
      sessions: sessions.map(s => ({
        name: s.name, kind: s.kind, date: s.local_date,
        minutes: s.ended_at && s.started_at
          ? Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000)) : null,
        days_ago: daysBetween(s.local_date, to),
      })),
      routines: routines.map(r => ({
        name: r.name, kind: r.kind,
        exercises: (r.exercises || []).length,
        times_used: r.times_used,
        days_since: r.last_used_on ? daysBetween(r.last_used_on, to) : null,
      })),
      series: {
        weight:   range.days.map(d => ({ date: d.date, value: w(d.weight_kg) })),
        calories: range.days.map(d => ({ date: d.date, value: d.calories })),
        protein:  range.days.map(d => ({ date: d.date, value: d.protein_g })),
        volume:   range.days.map(d => ({ date: d.date, value: d.volume_kg })),
        steps:    range.days.map(d => ({ date: d.date, value: d.steps })),
        sleep:    range.days.map(d => ({ date: d.date, value: d.sleep_minutes })),
      },
      latest_verdict: brief || null,
      care_flags: flags,
    }),
  };
};
