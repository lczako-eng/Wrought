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

import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';

export const SITE_URL = process.env.WROUGHT_SITE_URL || 'https://wrought.fit';
export const MODEL    = process.env.WROUGHT_MODEL || 'gpt-5.4-mini';

export const supabase = process.env.SUPABASE_URL
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// THE SDK IS LOADED ONLY IF IT IS ACTUALLY USED.
//
// This was a top-level `import OpenAI from 'openai'`, and because every
// function in the product imports this file, all of them bundled 7.7MB of a
// client the dashboard never calls. Netlify cold-starts a function by loading
// its bundle, so the website was paying for the parser on a request that could
// not possibly reach it — and a first load after a quiet hour is exactly when
// somebody decides the thing is slow.
//
// `openai` stays a truthy/falsy check everywhere it is used, so nothing at the
// call sites changes: it is null without a key, exactly as before, and the
// module is pulled in on first real use.
let _openaiClient = null;

export const openai = process.env.OPENAI_API_KEY
  ? {
      chat: {
        completions: {
          create: async (...args) => {
            if (!_openaiClient) {
              const { default: OpenAI } = await import('openai');
              _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            }
            return _openaiClient.chat.completions.create(...args);
          },
        },
      },
    }
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
      // A token we issued ourselves already passed the second factor at the
      // moment it was authorised — see oauth-authorize-complete.js. Re-checking
      // here would demand a code from ChatGPT, which has no way to ask for one.
      if (data?.user) return data.user;
    }
  } catch { /* fall through to JWT */ }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    if (!(await mfaSatisfied(data.user, token))) return null;
    return data.user;
  } catch { return null; }
}

// ── Two-factor, enforced where it actually matters ──────────────────────────
// A second factor the browser checks and the server does not is decoration. The
// password alone still produces a valid session JWT, and every endpoint here
// would take it — so the gate has to be on this side, on the one path that
// everything goes through.
//
// Supabase stamps `aal` on the session: aal1 means one factor was presented,
// aal2 means the second one actually was. The claim on its own proves nothing —
// somebody with no factors is legitimately aal1 forever — so it is only a
// failure when the account HAS a verified factor and the token says aal1.

const FACTOR_CACHE = new Map();          // user_id -> { has, until }
const FACTOR_TTL_MS = 5 * 60 * 1000;

function tokenClaims(jwt) {
  try {
    const payload = String(jwt).split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) || {};
  } catch { return {}; }
}

export async function hasVerifiedFactor(userId) {
  const hit = FACTOR_CACHE.get(userId);
  if (hit && hit.until > Date.now()) return hit.has;

  try {
    const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId });
    if (error) throw error;
    const has = (data?.factors || []).some(f => f.status === 'verified');
    FACTOR_CACHE.set(userId, { has, until: Date.now() + FACTOR_TTL_MS });
    return has;
  } catch {
    // The lookup failed. Prefer the last answer we actually got, even expired —
    // an outage must not quietly switch somebody's second factor off. With no
    // answer ever recorded, allow the request: locking every user out of their
    // own health record because an admin endpoint blinked is the worse failure,
    // and the vast majority have no second factor to bypass.
    return hit ? hit.has : false;
  }
}

// Exported so a freshly enrolled factor takes effect immediately rather than up
// to five minutes later.
export function forgetFactorCache(userId) { FACTOR_CACHE.delete(userId); }

export async function mfaSatisfied(user, jwt) {
  if (tokenClaims(jwt).aal === 'aal2') return true;
  return !(await hasVerifiedFactor(user.id));
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

// ── Fasting — the record, not the plan ──────────────────────────────────────
// The eating window above is a timetable. This is the train: what actually
// happened last night. Keeping them apart matters, because a product that reads
// the plan as the record ends up congratulating somebody for a fast they did not
// do — and once it has done that twice, none of its numbers mean anything.
//
// It is a trust system on purpose. "Stopped at eight, ate again at noon" is a
// complete entry, said the next morning, with nothing to press at either end. A
// tracker that needs a button at 8pm measures the evenings somebody remembered
// to open it — which is exactly how every food log dies.

export function fastLength(from, to) {
  if (!from || !to) return null;
  const f = minutesFromTime(from), t = minutesFromTime(to);
  // Crossing midnight is the ordinary case, not the exception: the fast that
  // matters runs from dinner to the next day. Equal times mean a full 24h.
  const mins = t > f ? t - f : (1440 - f) + t;
  return Math.round((mins / 60) * 10) / 10;
}

export function fastingSummary(rows = []) {
  const hours = rows
    .map(r => r?.detail?.hours)
    .filter(h => Number.isFinite(h) && h > 0);

  if (!hours.length) {
    return { count: 0, average_hours: null, longest_hours: null, say: 'No fasts logged yet.' };
  }

  const total   = hours.reduce((a, b) => a + b, 0);
  const average = Math.round((total / hours.length) * 10) / 10;
  const longest = Math.max(...hours);

  return {
    count: hours.length,
    average_hours: average,
    longest_hours: longest,
    // No target, no streak, no score. A fast is a thing that happened, and the
    // moment this starts grading them it becomes a reason to skip breakfast to
    // keep a number alive.
    say: hours.length === 1
      ? `One fast logged: ${hours[0]}h.`
      : `${hours.length} fasts logged, averaging ${average}h. Longest ${longest}h.`,
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

  // A shift the database refused to type is still a shift. Promoted here, at
  // the boundary, so every filter below sees what the row MEANS rather than
  // what a missing migration forced it to be stored as.
  const evs = withEffectiveTypes(events || []);
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

  // A meal with no calorie figure is UNKNOWN, not zero, and the difference is
  // the whole estimates doctrine. Summing nulls to zero is right for the
  // arithmetic and catastrophic for the sentence built on it: "0 calories
  // today" reads as a fact about a day somebody ate on. Counting the silent
  // meals is what lets the verdict say "macros unknown for one of them"
  // instead of stating a number that is confidently wrong.
  const mealsUncounted = meals.filter(e => e.detail?.calories == null).length;

  // Late eating — the number that actually explains a stalled week.
  const lastMeal = meals.length ? meals[meals.length - 1] : null;
  const lastMealMin = lastMeal ? localMinutesFor(profile.timezone, new Date(lastMeal.occurred_at)) : null;

  // Training, and — separately — work.
  const workouts = evs.filter(e => e.event_type === 'workout');
  const activities = evs.filter(e => e.event_type === 'activity');
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
      meals_uncounted: mealsUncounted,
      last_meal_at: lastMealMin != null ? clockString(lastMealMin) : null,
      last_meal_summary: lastMeal?.summary || null,
      say: !meals.length
        ? 'Nothing logged.'
        // Every meal silent: the total is not zero, it is unknown, and saying
        // zero here is the single easiest way to be confidently wrong.
        : mealsUncounted === meals.length
          ? `${meals.length} thing${meals.length === 1 ? '' : 's'} logged, no macros on ${meals.length === 1 ? 'it' : 'any of them'} yet — the total is unknown rather than zero.`
          : `${Math.round(food.calories)} kcal · ${Math.round(food.protein_g)}g protein · ${Math.round(food.carbs_g)}g carbs · ${Math.round(food.fat_g)}g fat` +
            (foodEstimated ? ' (estimated from what you described)' : '') +
            (mealsUncounted ? ` — and ${mealsUncounted} logged with no macros, so the real total is higher.` : ''),
    },
    training: {
      sessions: workouts.length,
      minutes: trainedMinutes,
      muscles,
      volume_kg: Math.round(volumeKg),
      summaries: workouts.map(w => w.summary),
      // The rows themselves, so the burn can be worked out from a watch's own
      // figure where there is one and from the minutes where there is not.
      entries: workouts.map(w => ({ id: w.id, event_type: 'workout', summary: w.summary, detail: w.detail || {} })),
      say: workouts.length
        ? `${workouts.length} session${workouts.length === 1 ? '' : 's'}, ${trainedMinutes} min` +
          (muscles.length ? ` — ${muscles.join(', ')}` : '')
        : 'Rest day (nothing logged).',
    },
    // Work and daily life — the third burn, and for anybody with a physical job
    // the biggest of the three. Deliberately NOT part of `training`: a shift is
    // not a session and must never count toward the weekly target or the matrix.
    activity: {
      count: activities.length,
      minutes: Math.round(activities.reduce((a, e) => a + num(e.detail?.hours) * 60, 0)),
      summaries: activities.map(a => a.summary),
      entries: activities.map(a => ({ id: a.id, event_type: 'activity', summary: a.summary, detail: a.detail || {} })),
      say: activities.length
        ? activities.map(a => a.summary).join('; ')
        : 'Nothing logged.',
    },
    body: {
      weight_kg: weightKg,
      weight_say: sayWeight(weightKg, units),
      body_fat_pct: metricAvg('body_fat_pct'),
    },
    device: {
      steps: metricSum('steps'),
      active_calories: metricSum('active_calories'),
      // Apple's own basal figure, when the watch sent one. Used as the resting
      // half of the burn so the pair stays in Apple's frame — see energyBalance.
      resting_calories: metricSum('resting_calories'),
      distance_km: metricSum('distance_km'),
      active_minutes: metricSum('active_minutes'),
      resting_hr: metricAvg('resting_hr'),
      hrv: metricAvg('hrv'),
      sleep_minutes: sleepMin,
      sleep_say: sleepMin ? humanDuration(sleepMin) : null,
      // EVERYTHING ELSE THE DEVICE SENT, whatever it was.
      //
      // The named fields above exist because something computes against them.
      // This is the other half of the founder's ask — "all the matrix that is
      // captured by this watch should be on that app, there's so many things"
      // — and it is deliberately generic: a metric added at the door shows up
      // on the dashboard the same day, with no second edit here and no third
      // one on the page. The alternative is a bespoke line per metric, which
      // is exactly how a hub stops accepting new things.
      readings: [...new Set(mets.map(m => m.metric))].map(name => {
        const rows = mets.filter(m => m.metric === name);
        // Counts and durations add up over a day; a heart rate does not.
        const cumulative = /calories|steps|distance|minutes|flights|water|hours/.test(name);
        const value = cumulative
          ? rows.reduce((a, m) => a + num(m.value), 0)
          : rows.reduce((a, m) => a + num(m.value), 0) / rows.length;
        return {
          metric: name,
          value: Math.round(value * 100) / 100,
          unit: rows[0].unit || '',
          samples: rows.length,
          cumulative,
        };
      }).sort((a, b) => a.metric.localeCompare(b.metric)),
      sources: [...new Set(mets.map(m => m.metric))].length ? [...new Set(evs.concat(mets).map(x => x.source).filter(Boolean))] : [],
    },
    // Each entry carries its OWN numbers, not just the day's sum. The founder's
    // complaint, exactly: "one steak's up to the right and the pizza's to the
    // left — should be altogether and then a total." A list of names with a
    // single total above it makes the total unauditable; you cannot see which
    // item is the 750 and which is the 300, so a mis-heard entry hides inside
    // an average forever.
    log: evs.map(e => ({
      id: e.id, type: e.event_type, at: clockString(localMinutesFor(profile.timezone, new Date(e.occurred_at))),
      summary: e.summary, estimated: e.estimated,
      calories:  e.detail?.calories  != null ? Math.round(num(e.detail.calories))  : null,
      protein_g: e.detail?.protein_g != null ? Math.round(num(e.detail.protein_g)) : null,
      carbs_g:   e.detail?.carbs_g   != null ? Math.round(num(e.detail.carbs_g))   : null,
      fat_g:     e.detail?.fat_g     != null ? Math.round(num(e.detail.fat_g))     : null,
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

  const evs = withEffectiveTypes(events || []), mets = metrics || [];
  const byDay = new Map();
  const dayOf = d => {
    if (!byDay.has(d)) byDay.set(d, {
      date: d, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
      meals: 0, sessions: 0, minutes: 0, volume_kg: 0,
      weights: [], steps: 0, sleep_minutes: 0, active_calories: 0,
      muscles: new Set(), logged: false,
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
    // Carried per day so the calendar can put a measured burn on each square.
    // A measurement always beats a multiplier, but only if it survives the trip.
    if (m.metric === 'active_calories') day.active_calories += num(m.value);
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
    active_calories: Math.round(d.active_calories) || null,
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
    // How full the ring is, computed here so the page draws rather than
    // calculates. An at_most goal fills as it is SPENT — a calorie ceiling at
    // 80% means 80% eaten, which is the direction that reads correctly at a
    // glance. Uncapped, because hiding an overshoot is the one thing a
    // progress ring must never do; the shade says over, the number says
    // by how much.
    const pct = +g.target_value === 0 ? 0
      : Math.max(0, Math.round((actual / +g.target_value) * 100));
    return {
      goal: g.goal, metric: g.metric, scored: true, hit,
      target: +g.target_value, actual: Math.round(actual * 10) / 10,
      percent: pct,
      over: g.direction === 'at_most' ? actual > +g.target_value : false,
      direction: g.direction || 'at_least',
      cadence: g.cadence || 'daily',
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
    case 'distance_km':  return g.cadence === 'weekly' ? summary?.distance_avg : day?.device?.distance_km;
    case 'active_minutes': return g.cadence === 'weekly' ? summary?.active_minutes_avg : day?.device?.active_minutes;
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

VAGUE MENTIONS ARE STILL EVENTS. This is caught constantly in passing, mid-conversation
about something else entirely, so most input is scraps rather than reports:
  "just did 10 push-ups"     -> workout, exercises [{name:"push-up", sets:1, reps:10}],
                                muscles ["chest","arms"], minutes null
  "doing my workout"          -> workout, kind null, minutes null, exercises []
                                 summary "workout"  — a training day recorded with no
                                 detail is worth far more than nothing
  "went for a run"            -> workout, kind "cardio", muscles ["full body"], rest null
  "had lunch"                 -> food, items ["lunch"], every macro null, estimated false
                                 — do NOT invent a calorie figure for an unnamed meal
  "slept badly"               -> sleep, minutes null, quality "poor"
  "knee's sore today"         -> symptom
Record what was actually said and leave every unknown null. NEVER pad a vague mention
into a specific one — a guessed 500-calorie "lunch" is worse than a lunch with no number,
because the guess silently poisons a weekly total and the null does not.

Rules:
- Split multiple things into separate events. "Eggs, then a 40 min lift, 182 on the scale" is three events.
- NEVER invent food, exercise or numbers the user did not mention. No filling in a "probable" lunch.
- Unit conversion: lb→kg (÷2.2046), in→cm (×2.54). Keep what they said in the summary.
- If you genuinely cannot classify something, emit one note event carrying their words. Never drop input.
- No commentary, no advice, no judgement. You are a parser.`;

// The connected model has already read the sentence — and the photograph, which
// this server never sees. Letting it hand the structured version straight over is
// both better and cheaper: better because it saw the plate, cheaper because there
// is no second model and therefore no API key. The contract is identical to
// parseLog's, so nothing downstream can tell the difference.
//
// insertEvents is the gate that matters — it validates the type, truncates the
// summary and insists detail is an object — so this only has to decide whether
// there is anything usable here at all, or whether to fall back to parsing.
export function eventsFromClient(raw) {
  if (!Array.isArray(raw)) return null;
  const usable = raw
    .filter(e => e && typeof e === 'object' && (e.event_type || e.summary))
    // A CLIENT MAY NOT DATE ITS OWN EVENTS. eventTimestamp honours an explicit
    // occurred_at because the SERVER's own callers (finaliseSession, the
    // bridge) genuinely know when a thing happened — but these objects come
    // from a language model, and a model that writes occurred_at midnight-UTC
    // files dinner on the wrong local day while everything looks logged. The
    // connector logs in real time; "at 9:30" travels as time_hint, which is
    // anchored in the user's own zone. Strip the field rather than trust it.
    .map(({ occurred_at, local_date, ...e }) => e);
  return usable.length ? usable : null;
}

// Words that name a mealtime rather than a food. "Had lunch" is genuinely
// unquantifiable and must stay null; "two pepperettes" is not, and logging it
// blank makes the entry nearly worthless. Telling those apart is what lets the
// server ASK for macros in the one case and never in the other.
const GENERIC_FOOD = new Set([
  'lunch', 'dinner', 'breakfast', 'brunch', 'supper', 'tea', 'snack', 'snacks',
  'meal', 'food', 'something', 'leftovers', 'takeaway', 'takeout', 'a meal',
]);

const named = s => {
  const t = String(s || '').trim().toLowerCase().replace(/^(a|an|some|the)\s+/, '');
  return t.length > 1 && !GENERIC_FOOD.has(t);
};

// A tool description is a hope; a line in the response is an instruction the
// model is reading at the moment it matters. When a named food lands with no
// calories on it, say so and ask for them — that is far more reliable than
// trusting guidance written into a schema the model skimmed once.
export function needsMacros(written = [], events = []) {
  const out = [];
  written.forEach((row, i) => {
    if (row.event_type !== 'food' && row.event_type !== 'drink') return;
    const detail = events[i]?.detail || {};
    if (detail.calories != null) return;

    const items = Array.isArray(detail.items) ? detail.items : [];
    // Named if any item is a real food, or if there are no items at all but the
    // summary itself names something.
    const isNamed = items.length ? items.some(named) : named(row.summary);
    if (isNamed) out.push({ id: row.id, summary: row.summary });
  });
  return out;
}

// A workout with no duration on it counts NOTHING toward calories out, and it
// does so silently — which is the same failure as a named food with no macros,
// in the one place people are least likely to notice. Somebody logs "chest and
// triceps", sees it in the log, and reasonably assumes their burn went up.
//
// The founder found this the direct way: a session put in through the assistant
// rather than measured by a watch has to count, and at 150kg it is worth
// several hundred calories, not nothing. The server can compute it from
// minutes — so minutes are what has to be asked for, once, in the same breath.
export function needsDuration(written = [], events = []) {
  const out = [];
  written.forEach((row, i) => {
    if (row.event_type !== 'workout') return;
    const detail = events[i]?.detail || {};
    // A watch's own figure beats anything derived, so a session that arrived
    // with calories on it needs nothing.
    if (detail.calories != null) return;
    if (Number(detail.minutes) > 0) return;
    out.push({ id: row.id, summary: row.summary });
  });
  return out;
}

// Finding the entry somebody means when they say "take the pizza off". Deleting
// is the one thing that cannot be undone, so this is deliberately literal: every
// meaningful word in what they said has to appear in the entry. Better to come
// back with nothing and ask than to quietly remove the wrong dinner.
// What is missing before the numbers can mean anything — carried on every read
// so the model meets it at the moment it would otherwise paper over the gap.
//
// The failure this exists to stop: asked "how many calories do I have left"
// with no target set, a model will happily answer "if we use 2,500 as your
// budget…". Nothing set 2,500. It is a plausible number in place of a real one,
// which is the exact shape of mistake this product cannot make — and it lets
// the setup question go unasked forever, because the gap never surfaces.
export function setupNeeded(profile, { hasWeight = false, hasCalorieGoal = false } = {}) {
  const missing = [
    !profile?.height_cm    ? 'height' : null,
    !profile?.birth_year   ? 'the year they were born' : null,
    !profile?.sex          ? 'male or female (for the metabolic formula)' : null,
    !hasWeight             ? 'a current weight' : null,
    !profile?.activity_level ? 'how much they are on their feet in a normal day' : null,
  ].filter(Boolean);

  if (!missing.length && hasCalorieGoal) return null;

  return {
    missing,
    has_calorie_target: hasCalorieGoal,
    say: missing.length
      ? `Setup is incomplete: ${missing.join(', ')}.`
      : 'No daily calorie target has been set.',
    // Written at the model, deliberately blunt, because the polite version gets
    // reasoned around.
    note: missing.length
      ? `ASK FOR THESE NOW, in ONE short message, all together, before answering anything that depends on them — then call set_profile and answer the original question. Do NOT invent a calorie target, a burn, or a "typical" figure to fill the gap: a made-up number here is worse than no answer, because it looks like a fact and quietly becomes the basis of every day after it.`
      : `There is no calorie target on file. Do NOT pick one yourself and do NOT say "if we use 2,500". Ask what they are aiming for, or offer to work one out from their weight and activity, then call set_goal.`,
  };
}

// THE SAME MEAL, COUNTED TWICE.
//
// The founder's day: ChatGPT re-logged three foods that were already on the
// record, noticed afterwards, and then "fixed" it by subtracting them in
// prose — "after removing the duplicate counting, your actual total today is
// about 1,760." The record still held 3,040. That is the mirror image of the
// missing-bagel failure and it is worse, because the number quoted in the
// conversation was right while the record it came from was wrong, so nothing
// looked broken and tomorrow the day is still double-counted.
//
// A DUPLICATED MEAL IS A DUPLICATED ENTRY, not an inflated sum. The row comes
// off, or nothing has been fixed.
//
// It only ever ASKS. Two coffees in a day is completely ordinary, and quietly
// deleting one because it matched a string would be far worse than counting
// it twice — so this names what looks doubled and leaves the decision with
// the person, exactly like every other retraction in this product.
export function duplicateItems(items = []) {
  const norm = s => String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const mins = t => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };

  const groups = new Map();
  for (const it of items) {
    if (it.type && it.type !== 'food' && it.type !== 'drink') continue;
    const k = norm(it.summary);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }

  const out = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const stamps = rows.map(r => mins(r.at)).filter(v => v != null).sort((a, b) => a - b);
    const gap = stamps.length > 1
      ? Math.min(...stamps.slice(1).map((v, i) => v - stamps[i])) : null;
    const each = rows[0].calories ?? null;
    out.push({
      summary: rows[0].summary,
      times: rows.length,
      at: rows.map(r => r.at).filter(Boolean),
      ids: rows.map(r => r.id).filter(Boolean),
      calories_each: each,
      // What comes off the day if it really is one meal counted twice. Stated
      // so the size of the mistake is visible rather than inferred.
      counted_extra: each != null ? each * (rows.length - 1) : null,
      minutes_apart: gap,
      // The one signal that separates a double-write from a second helping.
      // Minutes apart is a logging accident; hours apart is lunch and dinner.
      likely: gap != null && gap <= 20,
    });
  }
  return out;
}

// What the doubled rows are worth, added up where every other total is added
// up. The page must not do this itself: a figure drawn beside the day's total
// has to come off the same pass, or the two can drift and the caveat ends up
// arguing with the number it is explaining.
export function duplicateExtra(dups = []) {
  return Math.round(dups.reduce((a, x) => a + (Number(x.counted_extra) || 0), 0));
}

export function matchEntries(rows = [], query = '') {
  const stop = new Set(['the', 'that', 'this', 'and', 'for', 'was', 'were', 'from',
    'with', 'take', 'off', 'out', 'remove', 'delete', 'undo', 'retract', 'scratch',
    'log', 'logged', 'entry', 'actually', 'didnt', 'did', 'not', 'eat', 'ate', 'had']);

  const words = String(query).toLowerCase()
    .replace(/['’]/g, '')                   // didn't → didnt, so the stop list catches it
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !stop.has(w));
  if (!words.length) return [];

  // Best overlap wins, rather than demanding every word appear. People describe
  // an entry loosely — "the upper body session" against "40 minutes upper body"
  // — and requiring all of it matches nothing. Ties come back as ties, which is
  // what makes the caller stop and ask instead of guessing.
  const scored = rows.map(r => {
    const hay = `${r.summary || ''} ${r.raw_input || ''}`.toLowerCase();
    return { row: r, score: words.filter(w => hay.includes(w)).length };
  }).filter(s => s.score > 0);

  if (!scored.length) return [];
  const best = Math.max(...scored.map(s => s.score));
  return scored.filter(s => s.score === best).map(s => s.row);
}

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

// When an event actually happened, as one pure decision.
//
// THE BUG THIS FIXES COST A DAY ITS WORKOUT. finaliseSession has always passed
// occurred_at — the time of the session's last set — and insertEvents silently
// discarded it, stamping "now" instead. Invisible when the writer and the
// workout share a day; wrong the moment the stale-session sweep closes
// yesterday's session on today's dashboard load, which files yesterday's
// training under today. The founder caught it as "I didn't have a workout
// today — that was yesterday's, why is it even on today?" Same class of error
// as deriving local_date from UTC: the record is right about WHAT and wrong
// about WHEN, which corrupts both days at once.
export function eventTimestamp(e = {}, profile = {}, now = new Date()) {
  // An explicit timestamp from the caller wins — it is the one party that
  // actually knows when the thing happened.
  if (e.occurred_at) {
    const t = new Date(e.occurred_at);
    if (Number.isFinite(t.getTime())) return t;
  }
  if (e.time_hint && /^\d{1,2}:\d{2}$/.test(e.time_hint)) {
    // Anchor a stated time to today in the user's zone by nudging off "now".
    const wantMin = minutesFromTime(e.time_hint);
    const nowMin  = localMinutesFor(profile.timezone, now);
    return new Date(now.getTime() + (wantMin - nowMin) * 60000);
  }
  return now;
}

export async function insertEvents(userId, profile, parsedEvents, { source = 'agent', rawInput = null } = {}) {
  const now = new Date();
  const today = localDateFor(profile.timezone, now);

  const rows = parsedEvents.map(e => {
    const occurredAt = eventTimestamp(e, profile, now);
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

  const COLS = 'id, event_type, summary, local_date, estimated, detail, occurred_at';
  const { data, error } = await supabase.from('wrought_events').insert(rows).select(COLS);
  if (!error) return data || [];

  // A MISSING MIGRATION MUST NEVER COST SOMEBODY THE WRITE.
  //
  // This is the 015 lesson, which was written down and then not applied here.
  // 'activity' was added to VALID_TYPES on 19 August so a shift would stop
  // being filed as a note — correct, and it quietly assumed 013 had been run.
  // It had not. The database's check constraint rejects the row, insertEvents
  // throws, and `log` does not catch it, so THE WHOLE CALL FAILS: a sentence
  // mentioning a shift and a meal loses the meal too. That is strictly worse
  // than the bug being fixed, and it is a regression I introduced.
  //
  // So: if the type is what the database refused, downgrade only the types a
  // later migration introduced, keep what was intended on the row so the
  // repair sweep can put it back, and retry. Nothing is lost, and the caller
  // is told rather than left to wonder why the burn is short.
  const plan = degradePlan(rows, error.message || error);
  if (!plan) throw new Error(String(error.message || error));

  const { data: saved, error: retryErr } = await supabase
    .from('wrought_events').insert(plan.rows).select(COLS);
  if (retryErr) throw new Error(retryErr.message);

  const out = saved || [];
  // Carried on the array so no caller's .map or [0] changes shape.
  out.degraded = plan.degraded;
  return out;
}

/**
 * Whether a failed insert can be saved by downgrading a type the database has
 * not been taught yet — and what to write instead.
 *
 * Pure, and separate from the insert, because a test that has to stub a module
 * namespace cannot fail: ES namespaces are sealed, the stub silently does
 * nothing, and the assertion passes against broken code. That happened here
 * once already. This shape is testable with no database at all.
 *
 * @returns { rows, degraded } to retry with, or null to rethrow
 */
export function degradePlan(rows = [], errorMessage = '') {
  const msg = String(errorMessage || '');
  if (!/constraint|check|invalid input/i.test(msg)) return null;

  const risky = rows.filter(r => LATE_TYPES.has(r.event_type));
  if (!risky.length) return null;

  const intended = [...new Set(risky.map(r => r.event_type))];
  return {
    rows: rows.map(r => (LATE_TYPES.has(r.event_type)
      ? { ...r, event_type: 'note',
          detail: { ...(r.detail || {}), _intended_type: r.event_type } }
      : r)),
    degraded: {
      types: intended,
      migration: intended.includes('activity') ? '013_wrought_work.sql' : '004_wrought_fasting.sql',
      say: `Recorded, but stored as a note rather than ${intended.join(' or ')} — the database has not had that type added yet, so it will not count toward the day's totals until the migration is run. Nothing was lost.`,
    },
  };
}

// Event types a migration AFTER 001 introduced. These are the only ones a
// database can legitimately refuse while everything else still works, so they
// are the only ones that get downgraded rather than losing the write.
const LATE_TYPES = new Set(['activity', 'fast']);

// THE LIST HAS TO MATCH THE CHECK CONSTRAINT, and for a while it did not.
//
// 013 added 'activity' to the database — a shift, a garden, a house move: real
// expenditure that is not training. This set was never updated, and anything
// not in it is silently rewritten to 'note' rather than rejected. So every
// logged shift went in as a note: dayFacts filters on event_type 'activity'
// and found none, the burn from four hours at the petting zoo counted for
// nothing, and the entry still appeared in the log — as a note — so it looked
// saved. A tolerant writer beside a stricter reader is the most expensive
// combination there is, because nothing anywhere errors.
//
// There is a test that reads the constraint out of schema/013 and asserts this
// set is exactly equal to it.
export const VALID_TYPES = new Set(['food','drink','workout','weight','measurement','sleep','symptom','mood','supplement','note','fast','activity']);

// THE OTHER HALF OF DEGRADING — a row that was written down must be READ back up.
//
// `degradePlan` stops a missing migration costing somebody the write: a shift
// lands as a `note` carrying `_intended_type: 'activity'`, and nothing is lost.
// That was only ever half the job, and the missing half is the half the person
// can see. Every reader still filters on `event_type === 'activity'`, so the
// shift is on the record, visible in the log, and worth ZERO in the burn —
// which is precisely the bug degrading was meant to end, surviving one layer
// further in.
//
// `refileMistypedActivity` cannot rescue it either: it repairs by writing
// event_type = 'activity', and on a database without 013 the same constraint
// refuses that too. So until the SQL is run, the readers are the ONLY way those
// hours can count — and the SQL needs a laptop, which is not a thing somebody
// standing in a gym has.
//
// THE FINGERPRINT IS THE SAME ONE, DELIBERATELY. `log_activity` is the only
// thing in this product that writes key, met, hours and kcal onto one detail
// object; a note somebody actually dictated carries none of them. This is the
// exact predicate `refileMistypedActivity` already trusts to perform an
// IRREVERSIBLE update, so reading with it is strictly safer than what ships.
// Matching on the summary text would re-type a genuine note about a workday and
// there is no undo for that, which is why neither of them ever looks at prose.
//
// It reads, and never writes. The stored row stays exactly as it is, so running
// 013 later still repairs it properly and nothing here has to be unwound.
const shiftDetail = d => d && typeof d === 'object' &&
  d.key != null && d.met != null &&
  Number.isFinite(Number(d.hours)) && Number.isFinite(Number(d.kcal));

/**
 * The type an event MEANS, which is not always the type it is stored under.
 *
 * Only ever promotes `note` — the one type the writer downgrades TO. Anything
 * already carrying a real type is returned untouched, so this can never
 * reclassify a meal, a workout or a weigh-in.
 */
export function effectiveType(event) {
  const stored = event?.event_type;
  if (stored !== 'note') return stored;
  const d = event.detail;
  // What the writer recorded it as before the database refused it.
  if (d && typeof d === 'object' && LATE_TYPES.has(d._intended_type)) return d._intended_type;
  // And the shifts that predate the writer knowing 'activity' at all — they
  // carry no _intended_type, only the shape log_activity gave them.
  if (shiftDetail(d)) return 'activity';
  return 'note';
}

/**
 * Events with their meant type on them, for every reader that filters by type.
 *
 * Applied at the boundary rather than at each comparison: there are three
 * filters today and the next one added would not know to ask.
 */
export function withEffectiveTypes(events = []) {
  return (events || []).map(e => {
    const t = effectiveType(e);
    return t === e?.event_type ? e : { ...e, event_type: t, stored_type: e.event_type };
  });
}

export async function rememberFact(userId, fact, category = 'general') {
  const { error } = await supabase.from('wrought_memory')
    .insert([{ user_id: userId, fact: String(fact).slice(0, 500), category }]);
  if (error) throw new Error(error.message);
  return true;
}
