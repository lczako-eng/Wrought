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
import { orderInsight, earnedRoom, energyBalance, exerciseKey, deviceMatrix, weekdayPattern } from './lib/training.js';

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

  const [range, today, goals, win, setRows, sessions, routines, brief] = await Promise.all([
    rangeFacts(user.id, profile, from, to),
    dayFacts(user.id, profile, to),
    getGoals(user.id),
    getWindow(user.id),
    supabase.from('wrought_sets')
      .select('exercise, exercise_key, reps, weight_kg, rpe, position, session_id, local_date, note')
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
    supabase.from('wrought_briefs')
      .select('local_date, kind, verdict').eq('user_id', user.id)
      .order('local_date', { ascending: false }).limit(1).maybeSingle()
      .then(r => r.data),
  ]);

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
  const byLift = new Map();
  for (const s of setRows) {
    if (s.weight_kg == null) continue;
    const k = s.exercise_key || exerciseKey(s.exercise);
    if (!byLift.has(k)) byLift.set(k, { name: s.exercise, sessions: new Map() });
    const lift = byLift.get(k);
    const id = s.session_id || s.local_date;
    const prev = lift.sessions.get(id);
    if (!prev || Number(s.weight_kg) > Number(prev.weight_kg)) {
      lift.sessions.set(id, { weight_kg: Number(s.weight_kg), reps: s.reps, date: s.local_date });
    }
  }

  const lifts = [...byLift.entries()].map(([key, lift]) => {
    const points = [...lift.sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
    const best = points.reduce((a, p) => (p.weight_kg > a.weight_kg ? p : a), points[0]);
    const first = points[0], last = points[points.length - 1];
    return {
      key, name: lift.name,
      sessions: points.length,
      best: { weight: w(best.weight_kg), reps: best.reps, date: best.date },
      latest: { weight: w(last.weight_kg), reps: last.reps, date: last.date },
      change: points.length > 1 ? Math.round((w(last.weight_kg) - w(first.weight_kg)) * 10) / 10 : null,
      series: points.map(p => ({ date: p.date, value: w(p.weight_kg) })),
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
      exercise_order: orderInsight(setRows),
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
