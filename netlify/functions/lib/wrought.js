// netlify/functions/lib/wrought.js
// WROUGHT — the engine.
//
// Everything that counts, compares or judges lives here, deliberately apart
// from the protocol layer. Two reasons:
//
//   1. The MCP server and the web dashboard must never disagree. If the brief
//      says 148g of protein and the chart says 151, the product is dead. One
//      implementation, two callers.
//   2. Arithmetic is testable without a network. The harness imports this file
//      directly and never speaks HTTP.
//
// The rule that governs this whole file: the server computes, the model
// relays. Never hand a language model three numbers and hope it subtracts
// correctly — hand it the answer and a sentence to say.

import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';

export const SITE_URL = process.env.WROUGHT_SITE_URL || 'https://wrought.fit';
export const MODEL    = process.env.WROUGHT_MODEL || 'gpt-5.4-mini';

export const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

export const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ── Time ────────────────────────────────────────────────────────────────────
// A day is a day where the user is standing. Everything groups on local_date,
// so every one of these takes a timezone and none of them touch the host clock.

export function localDateFor(tz, when = new Date()) {
  // en-CA formats as YYYY-MM-DD, which is exactly the Postgres date literal.
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(when);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(when);
  }
}

export function localMinutesFor(tz, when = new Date()) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(when);
    const h = +p.find(x => x.type === 'hour').value;
    const m = +p.find(x => x.type === 'minute').value;
    return h * 60 + m;
  } catch { return when.getUTCHours() * 60 + when.getUTCMinutes(); }
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

export function clockString(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function minutesFromTime(t) {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function humanDuration(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// ── Units ───────────────────────────────────────────────────────────────────
// Storage is metric, always. These exist so the user hears their own units
// read back at them and never has to do the conversion in their head.

export const kgToLb = kg => Math.round(kg * 2.2046226 * 10) / 10;
export const lbToKg = lb => Math.round(lb / 2.2046226 * 100) / 100;
export const cmToIn = cm => Math.round(cm / 2.54 * 10) / 10;
export const inToCm = i  => Math.round(i * 2.54 * 10) / 10;

export function sayWeight(kg, units) {
  if (kg == null) return null;
  return units === 'imperial' ? `${kgToLb(kg)} lb` : `${Math.round(kg * 10) / 10} kg`;
}

export function sayWeightDelta(kg, units) {
  if (kg == null) return null;
  const v = units === 'imperial' ? kgToLb(Math.abs(kg)) : Math.round(Math.abs(kg) * 10) / 10;
  const u = units === 'imperial' ? 'lb' : 'kg';
  if (Math.abs(kg) < 0.05) return `flat`;
  return `${kg < 0 ? 'down' : 'up'} ${v} ${u}`;
}

export function sayLength(cm, units) {
  if (cm == null) return null;
  return units === 'imperial' ? `${cmToIn(cm)} in` : `${Math.round(cm * 10) / 10} cm`;
}

// ── Auth ────────────────────────────────────────────────────────────────────
// Two ways in, both landing on a Supabase user:
//   1. An OAuth access token we issued (stored hashed) — this is the path that
//      makes "Sign in with Wrought" appear inside ChatGPT and Claude.
//   2. A raw Supabase session JWT, pasted from the web app. Unglamorous, works
//      in every client on earth, and is the fallback when a connector's OAuth
//      implementation is having a bad day.

export async function getAuthUser(event) {
  const h = event.headers?.authorization || event.headers?.Authorization || '';
  if (!h.startsWith('Bearer ') || !supabase) return null;
  const token = h.slice(7).trim();
  if (!token) return null;

  try {
    const hash = createHash('sha256').update(token).digest('base64url');
    const { data: row } = await supabase.from('wrought_oauth_tokens')
      .select('user_id, expires_at').eq('token_hash', hash).maybeSingle();
    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      const { data } = await supabase.auth.admin.getUserById(row.user_id);
      if (data?.user) return data.user;
    }
  } catch { /* fall through to JWT */ }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    return error ? null : data?.user || null;
  } catch { return null; }
}

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = t => createHash('sha256').update(t).digest('base64url');

// ── Profile ─────────────────────────────────────────────────────────────────

const DEFAULT_PROFILE = {
  timezone: 'America/Toronto', units: 'metric', height_cm: null, birth_year: null,
  sex: null, training_age: null, equipment: null, train_days: null, dietary: null,
  bluntness: 'honest', notes: null,
};

export async function getProfile(userId) {
  const { data } = await supabase.from('wrought_profile').select('*').eq('user_id', userId).maybeSingle();
  return { ...DEFAULT_PROFILE, ...(data || {}), user_id: userId, _exists: !!data };
}

export async function getMemory(userId, category) {
  let q = supabase.from('wrought_memory').select('fact, category, confidence, created_at')
    .eq('user_id', userId).eq('active', true).order('created_at', { ascending: false }).limit(40);
  if (category) q = q.eq('category', category);
  const { data } = await q;
  return data || [];
}

export async function getGoals(userId) {
  const { data } = await supabase.from('wrought_goals').select('*')
    .eq('user_id', userId).eq('active', true).order('created_at', { ascending: false });
  return data || [];
}

export async function getWindow(userId) {
  const { data } = await supabase.from('wrought_eating_window').select('*')
    .eq('user_id', userId).maybeSingle();
  return data || null;
}

// ── The eating window ───────────────────────────────────────────────────────
// Snacking is a time problem before it is a food problem. Nobody eats 900
// calories of crisps at 2pm — they do it at 11pm standing at the counter with
// the fridge door open. So the window gets its own arithmetic, and the answer
// is always a countdown rather than a lecture.

export function windowStatus(win, tz, now = new Date()) {
  if (!win || !win.active) return null;
  const nowMin  = localMinutesFor(tz, now);
  const opens   = minutesFromTime(win.opens_at);
  const closes  = minutesFromTime(win.closes_at);
  const overnight = closes < opens;                       // e.g. 18:00 → 02:00
  const open = overnight ? (nowMin >= opens || nowMin < closes)
                         : (nowMin >= opens && nowMin < closes);

  let minutesLeft = null, minutesUntilOpen = null;
  if (open) {
    minutesLeft = closes > nowMin ? closes - nowMin : (1440 - nowMin) + closes;
  } else {
    minutesUntilOpen = opens > nowMin ? opens - nowMin : (1440 - nowMin) + opens;
  }

  return {
    open,
    opens_at: win.opens_at, closes_at: win.closes_at,
    strictness: win.strictness,
    now_local: clockString(nowMin),
    minutes_left: minutesLeft,
    minutes_until_open: minutesUntilOpen,
    say: open
      ? `Window is open until ${win.closes_at} — ${humanDuration(minutesLeft)} left.`
      : `Window is shut. It opens at ${win.opens_at}, in ${humanDuration(minutesUntilOpen)}.`,
  };
}

// ── Reading a day ───────────────────────────────────────────────────────────
// One function, every number for one calendar day, already added up. The brief,
// the dashboard and the coach all call this and therefore cannot disagree.

const num = v => (Number.isFinite(+v) ? +v : 0);

export async function dayFacts(userId, profile, date) {
  const [{ data: events }, { data: metrics }] = await Promise.all([
    supabase.from('wrought_events')
      .select('id, event_type, occurred_at, summary, detail, estimated, source')
      .eq('user_id', userId).eq('local_date', date).order('occurred_at', { ascending: true }),
    supabase.from('wrought_metrics')
      .select('metric, value, unit, measured_at')
      .eq('user_id', userId).eq('local_date', date),
  ]);

  const evs = events || [];
  const mets = metrics || [];
  const units = profile.units;

  // Food — every calorie from a plain-English meal is an inference, and the
  // whole product's credibility rests on saying so.
  const meals = evs.filter(e => e.event_type === 'food' || e.event_type === 'drink');
  const food = meals.reduce((a, e) => ({
    calories:  a.calories  + num(e.detail?.calories),
    protein_g: a.protein_g + num(e.detail?.protein_g),
    carbs_g:   a.carbs_g   + num(e.detail?.carbs_g),
    fat_g:     a.fat_g     + num(e.detail?.fat_g),
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  const foodEstimated = meals.some(e => e.estimated);

  // Late eating — the number that actually explains a stalled week.
  const lastMeal = meals.length ? meals[meals.length - 1] : null;
  const lastMealMin = lastMeal ? localMinutesFor(profile.timezone, new Date(lastMeal.occurred_at)) : null;

  // Training
  const workouts = evs.filter(e => e.event_type === 'workout');
  const trainedMinutes = workouts.reduce((a, e) => a + num(e.detail?.minutes), 0);
  const muscles = [...new Set(workouts.flatMap(e => e.detail?.muscles || []))];
  const volumeKg = workouts.reduce((a, e) =>
    a + (e.detail?.exercises || []).reduce((b, x) =>
      b + num(x.sets) * num(x.reps) * num(x.weight_kg), 0), 0);

  // Weight — a hand-logged number and a smart scale are the same fact.
  const weightEvents = evs.filter(e => e.event_type === 'weight')
    .map(e => num(e.detail?.value_kg)).filter(Boolean);
  const weightMetrics = mets.filter(m => m.metric === 'weight_kg').map(m => num(m.value));
  const allWeights = [...weightEvents, ...weightMetrics];
  const weightKg = allWeights.length
    ? Math.round((allWeights.reduce((a, b) => a + b, 0) / allWeights.length) * 100) / 100
    : null;

  const metricSum = name => {
    const rows = mets.filter(m => m.metric === name);
    return rows.length ? rows.reduce((a, m) => a + num(m.value), 0) : null;
  };
  const metricAvg = name => {
    const rows = mets.filter(m => m.metric === name);
    return rows.length ? Math.round((rows.reduce((a, m) => a + num(m.value), 0) / rows.length) * 10) / 10 : null;
  };

  const sleepMin = metricSum('sleep_minutes')
    ?? (evs.find(e => e.event_type === 'sleep') ? num(evs.find(e => e.event_type === 'sleep').detail?.minutes) : null);

  return {
    date,
    logged: evs.length > 0 || mets.length > 0,
    entries: evs.length,
    food: {
      ...roundMacros(food),
      meals: meals.length,
      estimated: foodEstimated,
      last_meal_at: lastMealMin != null ? clockString(lastMealMin) : null,
      last_meal_summary: lastMeal?.summary || null,
      say: meals.length
        ? `${Math.round(food.calories)} kcal · ${Math.round(food.protein_g)}g protein · ${Math.round(food.carbs_g)}g carbs · ${Math.round(food.fat_g)}g fat` +
          (foodEstimated ? ' (estimated from what you described)' : '')
        : 'Nothing logged.',
    },
    training: {
      sessions: workouts.length,
      minutes: trainedMinutes,
      muscles,
      volume_kg: Math.round(volumeKg),
      summaries: workouts.map(w => w.summary),
      say: workouts.length
        ? `${workouts.length} session${workouts.length === 1 ? '' : 's'}, ${trainedMinutes} min` +
          (muscles.length ? ` — ${muscles.join(', ')}` : '')
        : 'Rest day (nothing logged).',
    },
    body: {
      weight_kg: weightKg,
      weight_say: sayWeight(weightKg, units),
      body_fat_pct: metricAvg('body_fat_pct'),
    },
    device: {
      steps: metricSum('steps'),
      active_calories: metricSum('active_calories'),
      resting_hr: metricAvg('resting_hr'),
      hrv: metricAvg('hrv'),
      sleep_minutes: sleepMin,
      sleep_say: sleepMin ? humanDuration(sleepMin) : null,
      sources: [...new Set(mets.map(m => m.metric))].length ? [...new Set(evs.concat(mets).map(x => x.source).filter(Boolean))] : [],
    },
    log: evs.map(e => ({
      id: e.id, type: e.event_type, at: clockString(localMinutesFor(profile.timezone, new Date(e.occurred_at))),
      summary: e.summary, estimated: e.estimated,
    })),
  };
}

function roundMacros(f) {
  return {
    calories:  Math.round(f.calories),
    protein_g: Math.round(f.protein_g),
    carbs_g:   Math.round(f.carbs_g),
    fat_g:     Math.round(f.fat_g),
  };
}

// ── Reading a stretch of days ───────────────────────────────────────────────
// Trends beat days. One bad Tuesday means nothing; four bad Tuesdays in a row
// is the entire story, and it is the only thing worth changing behaviour over.

export async function rangeFacts(userId, profile, fromDate, toDate) {
  const [{ data: events }, { data: metrics }] = await Promise.all([
    supabase.from('wrought_events')
      .select('event_type, local_date, occurred_at, summary, detail, estimated')
      .eq('user_id', userId).gte('local_date', fromDate).lte('local_date', toDate)
      .order('local_date', { ascending: true }),
    supabase.from('wrought_metrics')
      .select('metric, value, local_date')
      .eq('user_id', userId).gte('local_date', fromDate).lte('local_date', toDate),
  ]);

  const evs = events || [], mets = metrics || [];
  const byDay = new Map();
  const dayOf = d => {
    if (!byDay.has(d)) byDay.set(d, {
      date: d, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
      meals: 0, sessions: 0, minutes: 0, volume_kg: 0,
      weights: [], steps: 0, sleep_minutes: 0, muscles: new Set(), logged: false,
    });
    return byDay.get(d);
  };

  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) dayOf(d);

  for (const e of evs) {
    const day = dayOf(e.local_date);
    day.logged = true;
    if (e.event_type === 'food' || e.event_type === 'drink') {
      day.calories  += num(e.detail?.calories);
      day.protein_g += num(e.detail?.protein_g);
      day.carbs_g   += num(e.detail?.carbs_g);
      day.fat_g     += num(e.detail?.fat_g);
      day.meals     += 1;
    }
    if (e.event_type === 'workout') {
      day.sessions += 1;
      day.minutes  += num(e.detail?.minutes);
      day.volume_kg += (e.detail?.exercises || []).reduce((b, x) =>
        b + num(x.sets) * num(x.reps) * num(x.weight_kg), 0);
      for (const m of (e.detail?.muscles || [])) day.muscles.add(m);
    }
    if (e.event_type === 'weight') {
      const w = num(e.detail?.value_kg); if (w) day.weights.push(w);
    }
    if (e.event_type === 'sleep') day.sleep_minutes += num(e.detail?.minutes);
  }

  for (const m of mets) {
    const day = dayOf(m.local_date);
    day.logged = true;
    if (m.metric === 'weight_kg')     day.weights.push(num(m.value));
    if (m.metric === 'steps')         day.steps += num(m.value);
    if (m.metric === 'sleep_minutes') day.sleep_minutes += num(m.value);
  }

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
    date: d.date,
    logged: d.logged,
    calories: Math.round(d.calories) || null,
    protein_g: Math.round(d.protein_g) || null,
    carbs_g: Math.round(d.carbs_g) || null,
    fat_g: Math.round(d.fat_g) || null,
    meals: d.meals,
    sessions: d.sessions,
    minutes: d.minutes,
    volume_kg: Math.round(d.volume_kg) || null,
    weight_kg: d.weights.length
      ? Math.round((d.weights.reduce((a, b) => a + b, 0) / d.weights.length) * 100) / 100 : null,
    steps: d.steps || null,
    sleep_minutes: d.sleep_minutes || null,
    muscles: [...d.muscles],
  }));

  return { from: fromDate, to: toDate, days };
}

const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

// A weight trend is not "today minus last Monday" — bodyweight swings two
// kilos on salt, sleep and a salty dinner alone, and reacting to a single
// reading is the most common way people quit.
//
// The rate comes from least squares over the real dates rather than from
// comparing the first half's average to the second half's. That earlier method
// is tempting and wrong: the two half-means sit only about half a span apart,
// so dividing their difference by the full span halves the answer. A genuine
// 0.42 kg/week loss reported as 0.22 is exactly the error that lets somebody
// crash-diet while being told the rate looks sensible — which is also what
// decides whether careFlags fires. Regression uses every point and gets the
// slope right on unevenly spaced weigh-ins too.
export function weightTrend(days, units) {
  const pts = days.filter(d => d.weight_kg != null);
  if (pts.length < 2) {
    return { direction: 'unknown', per_week_kg: null, points: pts.length,
      say: pts.length ? 'Only one weigh-in in this stretch — not enough to call a trend.'
                      : 'No weigh-ins in this stretch.' };
  }

  const x = pts.map(p => daysBetween(pts[0].date, p.date));
  const y = pts.map(p => p.weight_kg);
  const xBar = avg(x), yBar = avg(y);
  const denom = x.reduce((a, xi) => a + (xi - xBar) ** 2, 0);
  const slopePerDay = denom ? x.reduce((a, xi, i) => a + (xi - xBar) * (y[i] - yBar), 0) / denom : 0;
  const perWeek = slopePerDay * 7;

  // The endpoints quoted back are still rolling averages, because a single
  // first and last reading is exactly the noise this function exists to ignore.
  const half  = Math.ceil(pts.length / 2);
  const early = avg(pts.slice(0, half).map(p => p.weight_kg));
  const late  = avg(pts.slice(-half).map(p => p.weight_kg));

  const direction = Math.abs(perWeek) < 0.15 ? 'flat' : perWeek < 0 ? 'down' : 'up';
  return {
    direction,
    per_week_kg: Math.round(perWeek * 100) / 100,
    first: r1(early), last: r1(late), points: pts.length,
    say: direction === 'flat'
      ? `Weight is holding steady around ${sayWeight(late, units)}.`
      : `Trending ${direction} about ${sayWeight(Math.abs(perWeek), units)} a week — averaging ${sayWeight(late, units)} now vs ${sayWeight(early, units)} at the start.`,
  };
}

// The "matrix": muscle group against week. This is the chart that shows you
// have not trained legs since March without anybody having to say it.
export function trainingMatrix(days) {
  const weeks = new Map();
  for (const d of days) {
    if (!d.sessions) continue;
    const wk = weekKey(d.date);
    if (!weeks.has(wk)) weeks.set(wk, {});
    for (const m of d.muscles) weeks.get(wk)[m] = (weeks.get(wk)[m] || 0) + 1;
  }
  const allMuscles = [...new Set(days.flatMap(d => d.muscles))].sort();
  const weekKeys = [...weeks.keys()].sort();
  return {
    muscles: allMuscles,
    weeks: weekKeys,
    grid: weekKeys.map(w => ({ week: w, counts: Object.fromEntries(allMuscles.map(m => [m, weeks.get(w)[m] || 0])) })),
    neglected: allMuscles.filter(m => {
      const recent = weekKeys.slice(-2);
      return recent.length && recent.every(w => !(weeks.get(w)[m]));
    }),
  };
}

function weekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;            // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function summariseRange(range, profile) {
  const days = range.days;
  const loggedDays  = days.filter(d => d.logged);
  const fedDays     = days.filter(d => d.calories);
  const trainedDays = days.filter(d => d.sessions > 0);
  const units = profile.units;

  return {
    span_days: days.length,
    days_logged: loggedDays.length,
    adherence_pct: days.length ? Math.round((loggedDays.length / days.length) * 100) : 0,
    calories_avg: Math.round(avg(fedDays.map(d => d.calories)) || 0) || null,
    protein_avg:  Math.round(avg(fedDays.map(d => d.protein_g)) || 0) || null,
    carbs_avg:    Math.round(avg(fedDays.map(d => d.carbs_g)) || 0) || null,
    fat_avg:      Math.round(avg(fedDays.map(d => d.fat_g)) || 0) || null,
    training_days: trainedDays.length,
    training_minutes: trainedDays.reduce((a, d) => a + d.minutes, 0),
    sessions_per_week: days.length ? r1((trainedDays.length / days.length) * 7) : null,
    volume_kg: trainedDays.reduce((a, d) => a + (d.volume_kg || 0), 0) || null,
    steps_avg: Math.round(avg(days.filter(d => d.steps).map(d => d.steps)) || 0) || null,
    sleep_avg_minutes: Math.round(avg(days.filter(d => d.sleep_minutes).map(d => d.sleep_minutes)) || 0) || null,
    weight: weightTrend(days, units),
    matrix: trainingMatrix(days),
    longest_streak: longestStreak(days),
    current_streak: currentStreak(days),
  };
}

function longestStreak(days) {
  let best = 0, run = 0;
  for (const d of days) { run = d.logged ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

function currentStreak(days) {
  let run = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].logged) run++; else break;
  }
  return run;
}

// ── Goals ───────────────────────────────────────────────────────────────────
// Scoring is arithmetic, never opinion. Hit or missed, by how much, in the
// user's own units. The prose comes later and separately.

export function scoreGoals(goals, day, summary, profile) {
  return goals.map(g => {
    const actual = goalActual(g, day, summary);
    if (actual == null || g.target_value == null) {
      return { goal: g.goal, metric: g.metric || null, scored: false,
               say: `${g.goal} — nothing logged to measure it against.` };
    }
    const hit = g.direction === 'at_most' ? actual <= +g.target_value
              : g.direction === 'reach'   ? Math.abs(actual - +g.target_value) < 0.5
              : actual >= +g.target_value;
    const gap = Math.round((actual - +g.target_value) * 10) / 10;
    return {
      goal: g.goal, metric: g.metric, scored: true, hit,
      target: +g.target_value, actual: Math.round(actual * 10) / 10,
      gap, unit: g.target_unit || '',
      say: hit
        ? `${g.goal} — hit it (${Math.round(actual)}${g.target_unit || ''} vs ${g.target_value}).`
        : `${g.goal} — missed by ${Math.abs(gap)}${g.target_unit || ''} (${Math.round(actual)} vs ${g.target_value}).`,
    };
  });
}

function goalActual(g, day, summary) {
  switch (g.metric) {
    case 'protein_g':    return g.cadence === 'weekly' ? summary?.protein_avg  : day?.food?.protein_g;
    case 'calories':     return g.cadence === 'weekly' ? summary?.calories_avg : day?.food?.calories;
    case 'steps':        return g.cadence === 'weekly' ? summary?.steps_avg    : day?.device?.steps;
    case 'workout_days': return summary?.training_days ?? null;
    case 'sleep_minutes':return g.cadence === 'weekly' ? summary?.sleep_avg_minutes : day?.device?.sleep_minutes;
    case 'weight_kg':    return day?.body?.weight_kg ?? summary?.weight?.last ?? null;
    default:             return null;
  }
}

// ── Care flags ──────────────────────────────────────────────────────────────
// A blunt training app pointed at food and bodyweight can do real harm, and
// "be honest" is not a licence to push someone somewhere dangerous. These are
// computed server-side so no model has to notice on its own, and when one
// fires the instructions require the coaching to stop and the tone to change.
// Getting this wrong is the only way this product genuinely hurts somebody.

export function careFlags(range, profile) {
  const flags = [];
  const days = range.days;
  const fed = days.filter(d => d.calories);

  const veryLow = fed.filter(d => d.calories < 1200);
  if (fed.length >= 3 && veryLow.length >= 3) {
    flags.push({
      flag: 'very_low_intake',
      detail: `${veryLow.length} of the last ${fed.length} logged days came in under 1,200 kcal.`,
      guidance: 'Stop coaching intake down. Do not suggest a further deficit, a fast, or a lower target under any framing. Say plainly that this is under what a body needs to run on, and that a doctor or dietitian is the right person for it.',
    });
  }

  const w = weightTrend(days, profile.units);
  if (w.per_week_kg != null && w.per_week_kg < -1.2) {
    flags.push({
      flag: 'rapid_loss',
      detail: `Weight is falling about ${Math.abs(w.per_week_kg)} kg a week.`,
      guidance: 'That is faster than is usually sustainable or safe. Do not celebrate the rate. Suggest easing the deficit and mention that fast loss costs muscle, and flag seeing a professional if it is unintentional.',
    });
  }

  const trained = days.filter(d => d.sessions > 0);
  if (days.length >= 14 && trained.length >= days.length - 1) {
    flags.push({
      flag: 'no_rest',
      detail: `Trained on ${trained.length} of the last ${days.length} days with essentially no rest.`,
      guidance: 'Rest is where the adaptation happens. Recommend a genuine rest day rather than more volume.',
    });
  }

  return flags;
}

// ── Parsing what a person actually said ─────────────────────────────────────
// The single most important function in the product. If logging costs more
// than one sentence, nobody does it, and a health app nobody opens is worth
// exactly nothing. One line in, structured rows out.
//
// Two rules that never bend: never invent something the user did not say, and
// never present an inferred number as a measured one.

const PARSE_SYSTEM = `You convert a person's plain-English log of their day into structured events for a fitness journal.

Return JSON: {"events": [ ... ]}. Each event:
  event_type   one of: food, drink, workout, weight, measurement, sleep, symptom, mood, supplement, note
  summary      a short natural sentence in the user's own register ("two eggs and black coffee")
  detail       typed payload, see below
  estimated    true if ANY number in detail was inferred rather than stated
  time_hint    "HH:MM" in 24h local time if the user indicated when, else null

detail by type:
  food / drink   {items: [string], calories: int, protein_g: int, carbs_g: int,
                  sugar_g: int, fibre_g: int, fat_g: int, sat_fat_g: int,
                  categories: [string]}
                 Estimate macros from typical portions. ALWAYS set estimated true unless
                 the user gave the numbers themselves.
                 sugar_g is ADDED + free sugars plus the sugar in fruit and juice — the
                 number people actually want to see. It is a subset of carbs_g, never
                 additional to it.
                 categories describes what the meal WAS, chosen from exactly:
                   meat, fish, egg, dairy, vegetable, fruit, grain, legume, nuts,
                   fried, sweets, alcohol, ultra_processed
                 Include every one that genuinely applies and none that does not — a
                 chicken burrito bowl is [meat, grain, vegetable, dairy]. These are
                 counted in meals, never weighed, so err toward what a person would say
                 the meal contained rather than trace ingredients.
  workout        {kind: "strength"|"cardio"|"mobility"|"sport", minutes: int,
                  muscles: [string from: chest, back, shoulders, arms, legs, glutes, core, full body],
                  exercises: [{name, sets, reps, weight_kg}]}
                 Convert stated weights to kg. If they said "bench 3x8 at 80" assume kg unless
                 the number and context clearly imply lb.
  weight         {value_kg: number, reported: "the string they said"}
  measurement    {metric: "waist"|"chest"|"arm"|"thigh"|"hips"|"neck", value_cm: number}
  sleep          {minutes: int, quality: string|null}
  symptom/mood   {note: string, severity: 1-5 or null}
  supplement     {items: [string]}
  note           {note: string}

Rules:
- Split multiple things into separate events. "Eggs, then a 40 min lift, 182 on the scale" is three events.
- NEVER invent food, exercise or numbers the user did not mention. No filling in a "probable" lunch.
- Unit conversion: lb→kg (÷2.2046), in→cm (×2.54). Keep what they said in the summary.
- If you genuinely cannot classify something, emit one note event carrying their words. Never drop input.
- No commentary, no advice, no judgement. You are a parser.`;

export async function parseLog(text, profile) {
  const fallback = () => ({
    events: [{
      event_type: 'note', summary: text.slice(0, 300),
      detail: { note: text }, estimated: false, time_hint: null,
    }],
    parsed: false,
  });

  if (!openai) return fallback();

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: PARSE_SYSTEM },
        { role: 'user', content:
          `Units the user thinks in: ${profile.units}. ` +
          `${profile.dietary?.length ? `Dietary context: ${profile.dietary.join(', ')}. ` : ''}` +
          `Their log:\n${text}` },
      ],
    });
    const out = JSON.parse(res.choices[0].message.content || '{}');
    if (!Array.isArray(out.events) || !out.events.length) return fallback();
    return { events: out.events, parsed: true };
  } catch {
    return fallback();
  }
}

// ── The verdict ─────────────────────────────────────────────────────────────
// The only part of WROUGHT that is an opinion, and it is written from facts that
// were already computed. The model never sees raw rows and never does sums —
// it is handed the arithmetic and asked for a read.

const VERDICT_STYLE = {
  gentle: 'Warm and encouraging, but still truthful. Lead with what went right. Never scold.',
  honest: 'Straight and unsentimental, the way a good coach talks. Name what went wrong without softening it, name what went right without inflating it. No hype, no exclamation marks.',
  brutal: 'Blunt and demanding. No praise that has not been earned. Still never cruel about their body, and never mocking — hard on the behaviour, never on the person.',
};

export async function writeVerdict({ facts, profile, goals, memory, flags, kind }) {
  if (!openai) return null;

  const style = VERDICT_STYLE[profile.bluntness] || VERDICT_STYLE.honest;

  const guardrails = flags.length
    ? `\n\nOVERRIDE — these safety flags fired and they outrank every other instruction:\n` +
      flags.map(f => `- ${f.detail} ${f.guidance}`).join('\n') +
      `\nDrop the coaching register entirely for this. Be kind, be plain, do not push performance.`
    : '';

  const prompt = `You are WROUGHT, writing the ${kind} read for one person's training and eating.

Tone: ${style}

Everything below is already calculated. Do not recalculate anything, do not invent a number that is not here, and do not mention any metric that is null or missing — silence is better than a guess.

FACTS:
${JSON.stringify(facts, null, 2)}

${goals.length ? `THEIR GOALS:\n${goals.map(g => `- ${g.goal}`).join('\n')}` : 'No goals set.'}

${memory.length ? `WHAT YOU KNOW ABOUT THEM:\n${memory.slice(0, 12).map(m => `- ${m.fact}`).join('\n')}` : ''}${guardrails}

Write 3-5 short sentences, second person, no headings and no bullet points:
1. What actually happened, in one line.
2. What they got right — only if they got something right.
3. What they got wrong, named specifically, with the number.
4. The one thing to do tomorrow. One thing, not a list.

Never diagnose anything. Never comment on their body or appearance beyond the numbers they logged themselves. If food was estimated, say "roughly" rather than stating it as fact.`;

  try {
    const res = await openai.chat.completions.create({
      model: MODEL, temperature: 0.4, max_tokens: 320,
      messages: [{ role: 'user', content: prompt }],
    });
    return res.choices[0].message.content.trim();
  } catch { return null; }
}

// ── Writing ─────────────────────────────────────────────────────────────────

export async function insertEvents(userId, profile, parsedEvents, { source = 'agent', rawInput = null } = {}) {
  const now = new Date();
  const today = localDateFor(profile.timezone, now);

  const rows = parsedEvents.map(e => {
    let occurredAt = now;
    if (e.time_hint && /^\d{1,2}:\d{2}$/.test(e.time_hint)) {
      // Anchor a stated time to today in the user's zone by nudging off "now".
      const wantMin = minutesFromTime(e.time_hint);
      const nowMin  = localMinutesFor(profile.timezone, now);
      occurredAt = new Date(now.getTime() + (wantMin - nowMin) * 60000);
    }
    return {
      user_id: userId,
      event_type: VALID_TYPES.has(e.event_type) ? e.event_type : 'note',
      occurred_at: occurredAt.toISOString(),
      local_date: localDateFor(profile.timezone, occurredAt) || today,
      summary: String(e.summary || '').slice(0, 500) || 'logged',
      detail: e.detail && typeof e.detail === 'object' ? e.detail : {},
      estimated: !!e.estimated,
      source,
      raw_input: rawInput,
    };
  });

  const { data, error } = await supabase.from('wrought_events').insert(rows).select('id, event_type, summary, local_date, estimated');
  if (error) throw new Error(error.message);
  return data || [];
}

const VALID_TYPES = new Set(['food','drink','workout','weight','measurement','sleep','symptom','mood','supplement','note']);

export async function rememberFact(userId, fact, category = 'general') {
  const { error } = await supabase.from('wrought_memory')
    .insert([{ user_id: userId, fact: String(fact).slice(0, 500), category }]);
  if (error) throw new Error(error.message);
  return true;
}
