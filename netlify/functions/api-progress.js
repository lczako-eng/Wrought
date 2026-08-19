// netlify/functions/api-progress.js
// The dashboard's data endpoint.
//
// This exists so the web charts and the MCP brief cannot disagree. Both call
// into lib/wrought.js and lib/training.js and both get the same arithmetic. If
// the dashboard drew its own averages in JavaScript, the day would come when
// the chart says 151g of protein and the nightly verdict says 148, and on that
// day nobody believes either one again.

import {
  getAuthUser, getProfile, getGoals, getWindow, windowStatus, fastingSummary, getMemory,
  localDateFor, addDays, humanDuration, kgToLb, daysBetween,
  rangeFacts, summariseRange, dayFacts, careFlags, scoreGoals, supabase,
} from './lib/wrought.js';
import { orderInsight, earnedRoom, energyBalance, exerciseKey, deviceMatrix, weekdayPattern, focusCall, lastSession,
         weekSoFar, readiness, targetOptions, estimatedMax, liftTrend, readMovement, backfillDerivedSets } from './lib/training.js';
import { planRead } from './lib/plan.js';
import { intakeState } from './lib/intake.js';
import { formWatch, cardioProgress } from './lib/form.js';
import { nextNudge } from './lib/prompt.js';
import { blockPosition } from './lib/library.js';
import { closeStaleSessions, workoutList, backfillCompletion, refileMisdated } from './lib/session.js';
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
  // The membership check and the profile both need only the user id, so they
  // go together rather than one behind the other.
  const [gate, profile] = await Promise.all([
    allowed(user.id, 'api-progress'),
    getProfile(user.id),
  ]);
  if (!gate.ok) return { statusCode: 402, headers: CORS, body: JSON.stringify(gate) };

  const params = event.queryStringParameters || {};
  // Min 1, not 3 — the founder asked for a one-day view, and a single day with
  // its items and totals is a perfectly answerable question.
  const span = Math.min(Math.max(parseInt(params.days, 10) || 30, 1), 400);

  // Before anything is read: file any session left running that plainly is not
  // running any more, and derive sets for any workout event the bridge has
  // never touched — the training logged while the connector was still refusing
  // sessions is sitting on those events, and "none of the exercises landed" is
  // what that looks like from the outside. Both are one cheap read when there
  // is nothing to do. Independent of each other, so they run together.
  await Promise.all([
    closeStaleSessions(user.id, profile),
    backfillDerivedSets(user.id),
  ]);
  // AFTER the stale sweep, because the sweep is what files the event a
  // completion gets stamped onto. One read per call once the backlog is done.
  await Promise.all([backfillCompletion(user.id), refileMisdated(user.id, profile)]);

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

  // EVERYTHING THAT DOES NOT DEPEND ON ANOTHER ANSWER GOES IN ONE BATCH.
  //
  // These used to be a chain: the run-up range, the block, the all-time count,
  // the last weigh-in, the cardio rows and the fasts were each awaited on their
  // own line, one after the next, after this batch had already finished. Every
  // one of them is a full round trip to Supabase from a Netlify function, and
  // none of them needed anything the others returned — so the page sat there
  // paying ten latencies end to end for work that could all happen at once.
  // "It takes a while to load" was not the queries being slow. It was them
  // queueing.
  const [range, today, goals, win, histSets, sessions, connections, routines, foodRows, brief, workoutRows,
         recentRaw, blockRow, everCount, lastWeightRow, cardioRows, fastRows] = await Promise.all([
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

    // The thirty-day run-up care flags, the week, recovery and earned room all
    // need. Null when the selected range already covers it — see below.
    span >= 30 ? Promise.resolve(null) : rangeFacts(user.id, profile, addDays(to, -29), to),

    // The running block.
    supabase.from('wrought_blocks')
      .select('id, name, weeks, days_per_week, plan')
      .eq('user_id', user.id).eq('status', 'active').maybeSingle()
      .then(r => r.data),

    // Has this account ever logged anything, over ALL time — so a quiet
    // morning on the 1d view can never be mistaken for a brand new account.
    supabase.from('wrought_events')
      .select('id', { count: 'exact', head: true }).eq('user_id', user.id)
      .then(r => r.count || 0),

    // The most recent weigh-in ANYWHERE. Fetched unconditionally rather than
    // as a fallback: one small indexed row costs less than the extra serial
    // round trip it used to take when the window had no weigh-in on it.
    supabase.from('wrought_events')
      .select('detail').eq('user_id', user.id).eq('event_type', 'weight')
      .order('occurred_at', { ascending: false }).limit(1)
      .then(r => r.data?.[0]?.detail?.value_kg ?? null),

    // Runs, rides and swims, read as a progression.
    supabase.from('wrought_events')
      .select('local_date, summary, detail')
      .eq('user_id', user.id).eq('event_type', 'workout')
      .gte('local_date', addDays(to, -119)).lte('local_date', to)
      .order('local_date', { ascending: true }).limit(400)
      .then(r => r.data || []),

    // The record of a fast. Never graded.
    supabase.from('wrought_events')
      .select('local_date, summary, detail')
      .eq('user_id', user.id).eq('event_type', 'fast')
      .order('local_date', { ascending: false }).limit(60)
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
  const hasHistory = everCount > 0 || sessions.length > 0 || routines.length > 0;

  // The running block, and how far through it they are. A missed week is a
  // missed week rather than a skipped one, so this counts sessions rather than
  // reading a date off the calendar.
  let blockView = null;
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

  // A WINDOW IS NOT A MEMORY — the third and most important place.
  //
  // Care flags, the week's count, recovery and earned room are not trends over
  // whatever stretch happens to be selected; they are facts about right now
  // that need a run-up to be computable at all. Read off the SELECTED range
  // they break in two different ways on the 1d view the dashboard now opens on:
  //
  //   - care flags need three logged days and a fortnight, so on one day they
  //     CANNOT FIRE. They are the one thing that outranks everything else in
  //     this product, and a screen where they are structurally silent is the
  //     worst version of this bug.
  //   - the week's session count read off one day reports one day. That is not
  //     a missing number, it is a WRONG one, on the figure the whole plan rests
  //     on — and a wrong number is worse than no number.
  //
  // So they get their own thirty days, whatever the buttons say. Only fetched
  // again when the selected range is shorter than that.
  const recent = recentRaw || range;

  const flags    = careFlags(recent, profile);

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
    const lastInRange = recent.days.filter(d => d.weight_kg != null).pop();
    weightKg = lastInRange?.weight_kg ?? null;
  }
  if (weightKg == null) weightKg = lastWeightRow;

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
    days: recent.days.slice(-7),
    dailyTarget: calorieGoal?.target_value != null ? Number(calorieGoal.target_value)
               : balance.known ? balance.calories_out : null,
    flags,
    honestyDays: recent.days.slice(-7).filter(d => d.logged).length,
  });

  // ── Strength: best set ever seen per lift, and how it moved ───────────────
  // The dashboard's job here is the question people actually open a training
  // app to ask: is anything going up?
  //
  // Bodyweight work used to be dropped here for having no weight, which quietly
  // deleted press-ups, pull-ups, dips and every calisthenic from the one view
  // that answers "is anything going up?". They progress too — in reps. So a lift
  // is measured by load if it ever carried one, and by reps if it never did.
  //
  // A PERSONAL RECORD IS MEMORY, NOT A WINDOW — the same rule as the weigh-in
  // and as last night's session, in its third place. Built from the floored
  // history rather than the selected range, so "what is my best bench" has the
  // same answer on the 1d view as on the 30d one. A record that changes when
  // you press a range button is not a record.
  const byLift = new Map();
  for (const s of histSets) {
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

  // THE MAX, ESTIMATED AND SAID TO BE. "Should be recording my max for each
  // one." A best SET is the honest record — 235 for 4 is a fact — but it
  // cannot be compared against 175 for 8, which is the whole problem with
  // reading a training log. Epley converts both to the same scale.
  //
  // It is labelled an estimate everywhere it appears, it is NEVER programmed
  // from, and nothing here ever suggests going and testing a real one: a max
  // attempt is the single most dangerous thing an app can talk somebody into,
  // and the estimate exists precisely so nobody needs to.
  //
  // Reps are capped at 12 because Epley diverges badly above that — a set of
  // 20 would produce a confident and absurd number.
  const e1rm = estimatedMax;

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
      // The heaviest single set ever seen, and the best estimated max — which
      // is often a different session, because 100×5 beats 105×2.
      max: (() => {
        if (!loaded) return null;
        const withE = points.map(p => ({ ...p, e: e1rm(p.weight_kg, p.reps) })).filter(p => p.e != null);
        if (!withE.length) return null;
        const top = withE.reduce((a, p) => (p.e > a.e ? p : a), withE[0]);
        return {
          estimated_1rm: imperial ? kgToLb(top.e) : top.e,
          from: { weight: w(top.weight_kg), reps: top.reps, date: top.date },
          unit: imperial ? 'lb' : 'kg',
          // Said on every single read of it.
          basis: 'Epley, from a real set — an estimate, never a tested max.',
          latest_1rm: (() => {
            const l = e1rm(last.weight_kg, last.reps);
            return l == null ? null : (imperial ? kgToLb(l) : l);
          })(),
        };
      })(),
      latest: { weight: w(last.weight_kg), reps: last.reps, date: last.date },
      // The verdict on the curve — climbing, holding, or levelled, with the
      // wall answered by structure. Computed in lib/training.js so the panel
      // and any tool that carries it can never disagree.
      trend: loaded ? liftTrend(points, {
        fmt: v => imperial ? `${kgToLb(v)} lb` : `${v} kg`,
      }) : null,
      change: points.length > 1 ? Math.round((at(last) - at(first)) * 10) / 10 : null,
      // Both numbers ride along on every point: the question is never just
      // "how heavy" — 100kg for 3 and 100kg for 8 are different weeks.
      series: points.map(p => ({ date: p.date, value: at(p), weight: w(p.weight_kg), reps: p.reps })),
    };
  }).filter(l => l.sessions >= 2)
    .sort((a, b) => b.sessions - a.sessions);

  // ── The things that were only ever answerable through the assistant ───────
  //
  // Every one of these was already computed and had no panel: the plan, the
  // week's expectation, the run progression, readiness, the form watch, the
  // fast. A memory product that cannot SHOW you what it knows is asking for
  // trust it has not earned — and the founder asked for several of them in
  // exactly those words ("I need to see it").
  //
  // Nothing new is calculated here. These are the same functions the MCP tools
  // call, with the same inputs, so a panel and a verdict can never disagree.
  const plan = planRead({ profile, goals, weightKg });

  // The questionnaire, visible. The founder kept asking where the setup was
  // and the honest answer was "inside a tool response" — a gate nobody can
  // SEE is indistinguishable from a product that never asks. This is the same
  // intakeState the training tools now stop on.
  const memory = await getMemory(user.id);
  const setup = intakeState({ profile, goals, memory, weightKg, intent: plan.intent });

  // The expectation, on the table rather than in a notification. Sessions never
  // roll over and a missed week is information, never a debt — see weekSoFar.
  const trainingWeek = weekSoFar(recent.days, { today: to, target: profile.train_days || null });

  // The body's veto, read against their own fortnight. It only ever SOFTENS:
  // "ready" means train as planned and nothing more.
  // Today against their own fortnight — which a one-day window cannot contain.
  const ready = readiness({ days: recent.days.slice(-15), today: to });

  // A run read as a progression rather than a list. Best is over a COMPARABLE
  // distance, and a flat pace is named as the wall without being scolded.
  const cardio = cardioProgress(cardioRows);

  // EVERY workout, from wherever it came, as one list.
  //
  // "I still don't see individual workouts." Recent sessions was built from
  // wrought_sessions alone — the sessions the assistant runs, set by set — so
  // every run and ride off the watch was missing from it while sitting in the
  // record the whole time. cardioRows is already 120 days of workout events, so
  // this costs nothing extra.
  const workouts = workoutList(sessions, cardioRows, { today: to, limit: 20 });

  // The same one line the assistant gets, on the screen. Preemptive is not a
  // conversation feature — somebody who opened the dashboard is exactly as
  // entitled to be told the one thing worth knowing without asking for it.
  const nudge = nextNudge({
    push: profile.plan_push || null,
    flags, trainingWeek, plan, cardio, day: today,
  });

  // The shadow technique leaves in the record — never a claim about the lifter,
  // because nothing here can see them lift. Only ever softens.
  const form = formWatch({ sets: histSets });

  // The record of a fast, never a plan and never a score.
  const fasting = fastingSummary(fastRows);

  // AND THE NUMBER THAT STOPS ONE BEING INVENTED. With no daily calorie goal
  // the Targets panel used to say "ask your assistant" — a vacuum, and a model
  // handed a vacuum invents. The same options get_profile carries now sit on
  // the screen: computed, floored at 1,200, held under the care-flag rate, and
  // none of them set by being shown.
  const calorieGoalSet = goals.some(g => g.metric === 'calories' && g.cadence === 'daily');
  const noTargetSet = calorieGoalSet ? null : targetOptions({ profile, weightKg });

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
      // The plan, stated. The target NEVER travels without its maintenance and
      // the weekly rate — a number alone is a rule handed down.
      plan,
      // The questionnaire: what is answered, what is not, and that training
      // waits on it. The same state the tools gate on, so the screen and the
      // refusal can never disagree.
      setup: {
        answered: setup.known, of: setup.total, complete: setup.complete,
        remaining: setup.still_unknown,
      },
      // What has and has not been done this week, against what was agreed.
      training_week: trainingWeek,
      // The body's veto. Softens only, never spurs, and never a diagnosis.
      readiness: ready,
      // Runs, as a progression. "I need to see where my walls are."
      cardio,
      // Every workout, however it arrived — the watch's and the assistant's.
      workouts,
      // The one thing worth raising unprompted. Null means say nothing.
      nudge,
      // The shadow, never a claim about technique.
      form,
      // The record of a fast. Never graded.
      fasting,
      // Defensible numbers where a model used to reach for a plausible one.
      no_target_set: noTargetSet,
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
        // Through the same normaliser as both saving doors, which also carries
        // minutes and detail — without them a treadmill walk on the Record tab
        // rendered as a rep scheme nobody chose, and the stored 3×8 artifact
        // from the old default kept being read back as if somebody meant it.
        movements: (r.exercises || []).map(e => {
          const m = readMovement(e);
          return { name: m.name, sets: m.sets, reps: m.reps, minutes: m.minutes, detail: m.detail, cue: m.cue };
        }),
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
