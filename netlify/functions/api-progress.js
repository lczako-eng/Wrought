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
import { closeStaleSessions } from './lib/session.js';
import { allowed } from './lib/membership.js';
import { nutritionTotals, composition, macroMatrix, yearOverYear } from './lib/nutrition.js';
import { calendarDays, calendarRollups, calendarMissing, rangeRollup } from './lib/calendar.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

// Rolling windows, on the server like every other piece of arithmetic.
//
// Trends beat days — one bad Tuesday means nothing and four in a row is the
// whole story. Drawing only the daily line makes that impossible to see; the
// eye follows the spikes. So the mean rides alongside it, and it is computed
// here so the chart and the brief can never disagree about what the week was.

function rolling(values, window, mode = 'sum') {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    const nums = slice.filter(v => Number.isFinite(Number(v))).map(Number);
    if (!nums.length) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    return mode === 'sum' ? sum : Math.round(sum / nums.length);
  });
}

// A mean that IGNORES unlogged days rather than counting them as zero. Averaging
// a forgotten day in as nought manufactures a deficit out of forgetfulness —
// the same error the calendar is built to avoid, and it runs in the dangerous
// direction. Held back until the window has enough real days to mean anything.
function trailingMean(values, window) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    const nums = slice.filter(v => Number.isFinite(Number(v)) && Number(v) > 0).map(Number);
    if (nums.length < Math.min(3, window)) return null;
    return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
  });
}

// What the window is called, in the words somebody would use for it. "the last
// 365 days" is technically right and nobody says it.
function windowLabel(span) {
  if (span === 7)  return 'the last 7 days';
  if (span === 30) return 'the last 30 days';
  if (span >= 365) return 'the last year';
  return `the last ${span} days`;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (!supabase) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'server_not_configured' }) };

  const user = await getAuthUser(event);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'sign_in_required' }) };

  // Suspended accounts do not get the dashboard. They DO keep sign-in, the
  // profile screen and export — see lib/membership.js for why that line is
  // where it is.
  const gate = await allowed(user.id, 'api-progress');
  if (!gate.ok) return { statusCode: 402, headers: CORS, body: JSON.stringify(gate) };

  const params = event.queryStringParameters || {};
  // Min 1, not 3 — the founder asked for a one-day view, and a single day with
  // its items and totals is a perfectly answerable question.
  const span = Math.min(Math.max(parseInt(params.days, 10) || 30, 1), 400);

  const profile = await getProfile(user.id);

  // Before anything is read: file any session left running that plainly is not
  // running any more. Nobody says "end session" — they finish the last set and
  // leave — and until this existed those sets stayed in the set table while
  // every screen on this page called the day a rest day. Idempotent, and a
  // session genuinely in progress is untouched. See lib/session.js.
  await closeStaleSessions(user.id, profile);

  const to   = params.to || localDateFor(profile.timezone);
  const from = addDays(to, -(span - 1));

  // A WINDOW IS NOT A MEMORY — the same rule that already governs the weigh-in
  // lookup, applied to the one panel people open the app for.
  //
  // Sets used to be fetched over the selected range alone, so on the 1d view
  // "last night" had no sets attached and no previous session to compare
  // against: the panel drew a session with nothing in it, which reads exactly
  // like a workout that failed to save. Last night's session and the lift it is
  // set against are the record, not the window, so they get their own floor.
  // The range still governs everything that is genuinely a trend.
  const histFrom = addDays(to, -Math.max(span - 1, 59));

  const [range, today, goals, win, histSets, sessions, connections, routines, foodRows, brief, workoutRows] = await Promise.all([
    rangeFacts(user.id, profile, from, to),
    dayFacts(user.id, profile, to),
    getGoals(user.id),
    getWindow(user.id),
    supabase.from('wrought_sets')
      .select('exercise, exercise_key, reps, weight_kg, rpe, position, set_number, muscles, session_id, local_date, note')
      .eq('user_id', user.id).gte('local_date', histFrom).lte('local_date', to)
      .order('logged_at', { ascending: false }).limit(3000)
      .then(r => r.data || []),
    supabase.from('wrought_sessions')
      .select('id, name, kind, local_date, started_at, ended_at, status')
      .eq('user_id', user.id).eq('status', 'done')
      .order('ended_at', { ascending: false }).limit(12)
      .then(r => r.data || []),
    // Is the phone even talking, and is anything it sends landing?
    //
    // "Where are my workouts" has three possible answers — the phone never
    // sent, the server refused, or they are there and you are looking in the
    // wrong place — and until now none of them was visible from a screen.
    // Every /ingest call stamps last_sync_at, so this separates the first case
    // from the other two in one look.
    supabase.from('wrought_connections')
      .select('provider, mode, status, last_sync_at')
      .eq('user_id', user.id)
      .order('last_sync_at', { ascending: false, nullsFirst: false })
      .then(r => r.data || []),
    supabase.from('wrought_routines')
      .select('name, kind, tier, exercises, notes, est_minutes, times_used, last_used_on')
      .eq('user_id', user.id).eq('active', true)
      .order('last_used_on', { ascending: false, nullsFirst: false })
      .then(r => r.data || []),
    supabase.from('wrought_events')
      .select('event_type, local_date, summary, detail, estimated')
      .eq('user_id', user.id).in('event_type', ['food', 'drink'])
      .order('local_date', { ascending: false }).limit(8000)
      .then(r => r.data || []),
    supabase.from('wrought_briefs')
      .select('local_date, kind, verdict').eq('user_id', user.id)
      .order('local_date', { ascending: false }).limit(1).maybeSingle()
      .then(r => r.data),
    // Workouts that came from a DEVICE rather than being typed or dictated.
    // The one number that separates "the server refused them" from "the phone
    // never sent them", and it cost nothing to surface.
    supabase.from('wrought_events')
      .select('source, local_date, summary')
      .eq('user_id', user.id).eq('event_type', 'workout')
      .gte('local_date', from).lte('local_date', to).limit(500)
      .then(r => r.data || []),
  ]);

  // Everything that is a TREND stays bounded by the chosen range; only the
  // memory panels see further back.
  const setRows = histSets.filter(s => s.local_date >= from);

  // HAS THIS ACCOUNT EVER LOGGED ANYTHING — over all time, never over the
  // window. The first-run screen used to be decided from the loaded range,
  // which was harmless at 30 days and is a lie at one: somebody who has logged
  // for a month but has not said anything yet this morning would be shown the
  // brand-new-account page. On the one product whose whole promise is memory,
  // a screen saying "nothing here yet" to somebody with a month of history is
  // the worst thing this dashboard can do.
  const { count: everCount } = await supabase.from('wrought_events')
    .select('id', { count: 'exact', head: true }).eq('user_id', user.id);
  const hasHistory = (everCount || 0) > 0 || sessions.length > 0 || routines.length > 0;

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

  // The month laid out as squares, both halves of the sum on each one. Totals
  // count logged days only — see lib/calendar.js for why that is load-bearing
  // rather than fussy.
  const calDays = calendarDays({ days: range.days, foodRows, profile });
  const imperial = profile.units === 'imperial';
  const w = kg => (kg == null ? null : imperial ? kgToLb(kg) : kg);

  // ── Energy, and the room it has earned ────────────────────────────────────
  // The most recent weigh-in ANYWHERE, not the most recent one inside the
  // loaded window. Searching only the range meant that switching to the 1d
  // view — one day, usually with no weigh-in on it — lost the weight, so the
  // burn could not be computed and the whole five-facts form reappeared. It
  // read as the product having forgotten a height it knew perfectly well, on
  // the one screen where that is most alarming.
  let weightKg = today.body.weight_kg;
  if (weightKg == null) {
    const recent = range.days.filter(d => d.weight_kg != null).pop();
    weightKg = recent?.weight_kg ?? null;
  }
  if (weightKg == null) {
    const { data: lastWeight } = await supabase.from('wrought_events')
      .select('detail').eq('user_id', user.id).eq('event_type', 'weight')
      .order('occurred_at', { ascending: false }).limit(1);
    weightKg = lastWeight?.[0]?.detail?.value_kg ?? null;
  }

  const deviceExpected = connections.some(c =>
    c.last_sync_at && Date.now() - new Date(c.last_sync_at).getTime() < 3 * 86400000);

  const balance = energyBalance({
    profile, weightKg,
    caloriesIn: today.food.calories,
    activeCalories: today.device.active_calories,
    foodEstimated: today.food.estimated,
    workouts: today.training.entries,
    activities: today.activity.entries,
    deviceResting: today.device.resting_calories,
    deviceExpected,
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
      // Over all time, so a quiet morning on the 1d view can never be mistaken
      // for a brand new account.
      has_history: hasHistory,
      // The zone the days are being FILED under. The page compares it against
      // the browser's, because a wrong one puts a late meal on the wrong day
      // and quietly corrupts every total after it.
      timezone: profile.timezone,
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
      // The floored history, not the range — on the 1d view the session and the
      // lift it is compared against are usually both outside the window.
      last_session: lastSession(sessions, histSets, { today: to, imperial }),
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
      calendar: {
        days: calDays,
        rollups: calendarRollups(calDays),
        ...calendarMissing(profile, calDays),
      },
      // The chosen window as ONE running total, in and out, to this point.
      // "Look at the seven day — should be yesterday, today to this point."
      // Null on a one-day range: that day already has the hero above it, and a
      // running total over a single day is the same number twice.
      window: span > 1 ? rangeRollup(calDays, windowLabel(span)) : null,
      device_matrix: deviceMatrix(range.days),
      weekday: weekdayPattern(range.days),
      notes,
      sessions: sessions.map(s => ({
        name: s.name, kind: s.kind, date: s.local_date,
        minutes: s.ended_at && s.started_at
          ? Math.max(1, Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000)) : null,
        days_ago: daysBetween(s.local_date, to),
      })),
      // What has actually reached the server from a device, and when. Counted
      // over the loaded range so the answer moves with the window rather than
      // quoting all time and looking healthy on a dead week.
      devices: {
        connections: connections.map(c => ({
          provider: c.provider, mode: c.mode, status: c.status,
          last_sync_at: c.last_sync_at,
          hours_ago: c.last_sync_at
            ? Math.round((Date.now() - new Date(c.last_sync_at).getTime()) / 3600000) : null,
        })),
        // 'agent' is the assistant; anything else came off a device.
        workouts_total: workoutRows.length,
        workouts_from_device: workoutRows.filter(w => w.source && w.source !== 'agent').length,
        sources: [...new Set(workoutRows.map(w => w.source).filter(Boolean))],
      },
      routines: routines.map(r => ({
        name: r.name, kind: r.kind, tier: r.tier,
        exercises: (r.exercises || []).length,
        // The movements and the write-up, so a saved workout can be READ on the
        // website rather than only recited by the assistant. A routine you
        // cannot open is a name, and the founder asked for the procedure.
        movements: (r.exercises || []).map(e => ({
          name: e.name, sets: e.sets, reps: e.reps, cue: e.cue || null,
        })),
        sets: (r.exercises || []).reduce((a, e) => a + (Number(e.sets) || 0), 0),
        notes: r.notes || null,
        minutes: r.est_minutes || null,
        times_used: r.times_used,
        days_since: r.last_used_on ? daysBetween(r.last_used_on, to) : null,
      })),
      // What is already on file, so a form that fills a gap can show only the
      // gap. Asking again for a height it is holding is how a product looks
      // amnesiac when it is merely narrow.
      profile_known: {
        height_cm: profile.height_cm ?? null,
        birth_year: profile.birth_year ?? null,
        sex: profile.sex ?? null,
        activity_level: profile.activity_level ?? null,
        weight_kg: weightKg,
      },
      series: {
        weight:   range.days.map(d => ({ date: d.date, value: w(d.weight_kg) })),
        calories: range.days.map(d => ({ date: d.date, value: d.calories })),
        protein:  range.days.map(d => ({ date: d.date, value: d.protein_g })),
        volume:   range.days.map(d => ({ date: d.date, value: d.volume_kg })),
        steps:    range.days.map(d => ({ date: d.date, value: d.steps })),
        sleep:    range.days.map(d => ({ date: d.date, value: d.sleep_minutes })),
        // Sessions per week over time — the training progression line. A raw
        // per-day count is 0,1,0,0,1: a barcode, not a trend. A trailing
        // seven-day count IS "workouts a week" and it is the number the whole
        // expectation rests on, so watching it move is watching the plan work.
        sessions: rolling(range.days.map(d => (d.sessions > 0 ? 1 : 0)), 7, 'sum')
          .map((v, i) => ({ date: range.days[i].date, value: i >= 6 ? v : null })),
      },
      // The trend under the noise, computed here rather than in the browser.
      // One day's calories is salt and memory; the seven-day mean is the thing
      // a decision should be made against, and drawing both is what makes a
      // spiky line readable instead of decorative.
      trends: {
        calories: trailingMean(range.days.map(d => d.calories), 7)
          .map((v, i) => ({ date: range.days[i].date, value: v })),
        protein: trailingMean(range.days.map(d => d.protein_g), 7)
          .map((v, i) => ({ date: range.days[i].date, value: v })),
        weight: trailingMean(range.days.map(d => w(d.weight_kg)), 7)
          .map((v, i) => ({ date: range.days[i].date, value: v })),
      },
      // Where the line is supposed to sit. A calorie chart without the target
      // drawn on it shows movement but never says whether the movement is the
      // right way — which is the only question somebody actually has.
      targets: {
        calories: goals.find(g => g.metric === 'calories' && g.cadence === 'daily')?.target_value ?? null,
        protein:  goals.find(g => g.metric === 'protein_g' && g.cadence === 'daily')?.target_value ?? null,
      },
      latest_verdict: brief || null,
      care_flags: flags,
    }),
  };
};
